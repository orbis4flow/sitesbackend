/* ============================================================
   Deposits
   Both rails follow the same shape:

     1. Write a pending payment row FIRST, with our own reference.
     2. Ask the provider to collect.
     3. Return; the balance does not move.

   Step 1 comes before step 2 on purpose. If the provider succeeds but
   our response never arrives, the callback still finds a row to settle.
   The other order loses money.

   Nothing in this file credits an account. Only a verified webhook does,
   through settle_deposit() in the database.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import { admin, quietly } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { paymentLimiter } from '../middleware/rateLimit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { env } from '../config/env.js';
import { newReference } from '../lib/reference.js';
import { events } from '../lib/events.js';
import * as demo from '../services/mpesaDemo.js';
import { normalisePhone } from '../lib/phone.js';
import * as paystack from '../services/paystack.js';
import * as payhero from '../services/payhero.js';
import { siteHost } from '../lib/site.js';

const router = Router();

/* The rail collects shillings; the customer was quoted dollars. The
   limits are checked in what actually arrives and stated in what they
   typed, so the message answers the question they are holding. */
const usdOf = minor => (Number(minor) / 100 / env.USD_RATE_KES).toFixed(2);

const amountMinor = z.coerce.number().int()
  .refine(v => v >= env.MIN_DEPOSIT_MINOR,
    `Minimum deposit is ${usdOf(env.MIN_DEPOSIT_MINOR)} USD`)
  .refine(v => v <= env.MAX_DEPOSIT_MINOR,
    `Maximum deposit is ${usdOf(env.MAX_DEPOSIT_MINOR)} USD`);

async function createPending({ userId, provider, amount_minor, currency, phone, prefix, site }) {
  const reference = newReference(prefix || (provider === 'payhero' ? 'MP' : 'CD'));
  const row = {
    user_id: userId,
    direction: 'deposit',
    provider,
    reference,
    amount_minor,
    currency,
    phone: phone || null,
    status: 'pending',
    /* Which site the deposit was made through (sql/020_site_domains.sql). */
    domain_host: site || null
  };
  let { data, error } = await admin.from('payments').insert(row).select().single();
  /* Before the migration has run the column does not exist. A deposit
     must never fail over a label, so it goes in without one. */
  if (error && /domain_host/.test(error.message || '')) {
    delete row.domain_host;
    ({ data, error } = await admin.from('payments').insert(row).select().single());
  }

  if (error) throw new Error(`could not record payment: ${error.message}`);
  return data;
}

/* ---------------- M-Pesa, via PayHero ---------------- */
router.post('/mpesa',
  requireAuth,
  paymentLimiter,
  /* Either a number typed on the sheet, or none at all — which means
     "the one on my account". The browser is never given those digits
     back, so it could not send them even if it wanted to; this is what
     it sends instead. */
  validate(z.object({
    amountMinor,
    phone: z.string().min(6, 'Enter your M-Pesa number').optional(),
    usePhoneOnFile: z.boolean().optional(),
    currency: z.string().length(3).default('KES')
  })),
  async (req, res, next) => {
    let payment;
    try {
      const { data: profile } = await admin
        .from('profiles').select('country,display_name,phone')
        .eq('id', req.user.id).single();

      const typed = req.body.phone && !req.body.usePhoneOnFile;
      const source = typed ? req.body.phone : profile?.phone;

      if (!source) {
        throw badRequest('There is no number on your account yet', {
          phone: 'Enter the number to pay from'
        });
      }

      const phone = normalisePhone(source, profile?.country || 'KE');
      if (!phone) throw badRequest(
        typed
          ? 'That phone number does not look right'
          : 'The number saved on your account does not look right. Change it in Account.',
        { phone: 'Enter the number in full, for example 0712345678' });

      /* The fork. A VIP settles against the companion handset instead of
         against PayHero, and the customer's browser never knows the
         difference: same endpoint, same request, same shape back. The
         decision is made here, from the database, rather than being
         something the client can ask for. */
      if (await demo.tierOf(req.user.id) === 'vip') {
        return depositFromHandset(req, res, { phone, profile });
      }

      /* PayHero switched off: straight to Paystack. */
      if (env.MPESA_PRIMARY === 'paystack') {
        return await promptViaPaystack(req, res, {
          phone,
          amountMinor: req.body.amountMinor,
          currency: req.body.currency,
          because: 'primary',
          replaces: null
        });
      }

      try {
        payment = await createPending({
          site: siteHost(req),
          userId: req.user.id,
          provider: 'payhero',
          amount_minor: req.body.amountMinor,
          currency: req.body.currency,
          phone
        });

        const result = await payhero.stkPush({
          phone,
          amountMinor: payment.amount_minor,
          reference: payment.reference,
          name: profile?.display_name
        });

        await admin.from('payments')
          .update({
            provider_ref: result?.reference || result?.CheckoutRequestID || null,
            raw: result
          })
          .eq('id', payment.id);

        /* Recorded on the way out, not only when it breaks. "The push was
           accepted and here is exactly what they said" is the line that
           settles an argument about whether a prompt was ever sent. */
        events.info('payhero', 'STK push accepted for ' + phone.slice(0, 6) + '***', {
          userId: req.user.id,
          reference: payment.reference,
          context: { amountMinor: payment.amount_minor, response: result }
        });

        return res.status(202).json({
          ok: true,
          status: 'pending',
          rail: 'payhero',
          reference: payment.reference,
          message: 'Check your phone for the M-Pesa prompt and enter your PIN.'
        });
      } catch (err) {
        /* A refusal means the push never left, so the row is closed. A
           timeout is different: the prompt may still arrive and be paid,
           so that row stays open and settles like any other if it is. */
        if (payment && !err.timedOut) {
          await quietly(admin.rpc('fail_payment', {
            p_payment_id: payment.id,
            p_reason: err.message?.slice(0, 300) || 'stk push failed',
            p_raw: null
          }));
        }
        events.error('payhero', 'STK push failed: ' + (err.message || 'unknown') +
          (env.MPESA_FALLBACK === 'paystack' ? ', trying Paystack' : ''), {
          userId: req.user.id,
          reference: payment?.reference,
          context: { amountMinor: req.body.amountMinor, timedOut: !!err.timedOut }
        });

        if (env.MPESA_FALLBACK !== 'paystack') throw err;
        return await promptViaPaystack(req, res, {
          phone,
          amountMinor: req.body.amountMinor,
          currency: req.body.currency,
          because: err.timedOut ? 'payhero_timeout' : 'payhero_failed',
          replaces: payment?.reference || null
        });
      }
    } catch (err) {
      next(err);
    }
  });

/* ---------------- M-Pesa, via Paystack ----------------
   The fallback. Used when PayHero cannot send the prompt, and when the
   customer says the prompt never arrived. A payment row of its own, so
   the two attempts never share a reference, and it settles through the
   Paystack webhook and verify call exactly as a card payment does. */
async function promptViaPaystack(req, res, { phone, amountMinor, currency, because, replaces }) {
  let payment;
  try {
    payment = await createPending({
      site: siteHost(req),
      userId: req.user.id,
      provider: 'paystack',
      amount_minor: amountMinor,
      currency: currency || 'KES',
      phone,
      prefix: 'MP'
    });

    const result = await paystack.chargeMpesa({
      /* Paystack will not charge without an email. An account signed up
         by phone may not have one, so it gets a stand-in on our domain. */
      email: req.user.email || `${req.user.id}@customers.${env.BRAND_DOMAIN}`,
      amountMinor: payment.amount_minor,
      currency: payment.currency,
      phone,
      reference: payment.reference,
      metadata: { user_id: req.user.id, payment_id: payment.id, rail: 'mpesa', because, replaces }
    });

    await admin.from('payments')
      .update({
        provider_ref: result?.reference || null,
        raw: { rail: 'mpesa', because, replaces, response: result }
      })
      .eq('id', payment.id);

    events.info('paystack', 'M-Pesa prompt sent through Paystack for ' + phone.slice(0, 6) + '***', {
      userId: req.user.id,
      reference: payment.reference,
      context: { amountMinor, because, replaces, status: result?.status }
    });

    return res.status(202).json({
      ok: true,
      status: 'pending',
      rail: 'paystack',
      reference: payment.reference,
      message: result?.display_text ||
        'Check your phone for the M-Pesa prompt and enter your PIN.'
    });
  } catch (err) {
    if (payment) {
      await quietly(admin.rpc('fail_payment', {
        p_payment_id: payment.id,
        p_reason: err.message?.slice(0, 300) || 'paystack m-pesa failed',
        p_raw: null
      }));
    }
    events.error('paystack', 'M-Pesa through Paystack failed: ' + (err.message || 'unknown'), {
      userId: req.user.id,
      reference: payment?.reference,
      context: { amountMinor, because, replaces }
    });
    throw err;
  }
}

/* ---------------- "the prompt never came" ----------------
   The waiting screen offers this after a while. The first attempt is
   left open, since a late prompt can still be paid, and a new prompt goes
   out through Paystack for the same amount to the same phone. */
router.post('/mpesa/:reference/resend',
  requireAuth,
  paymentLimiter,
  async (req, res, next) => {
    try {
      const { data: first } = await admin
        .from('payments').select('*')
        .eq('reference', req.params.reference)
        .eq('user_id', req.user.id)
        .maybeSingle();

      if (!first || first.direction !== 'deposit' || !first.phone) throw notFound('No such payment');
      if (first.status === 'success') {
        throw badRequest('That payment has already gone through.');
      }
      if (env.MPESA_FALLBACK !== 'paystack') {
        throw badRequest('Resending is not available right now. Try again in a moment.');
      }

      return await promptViaPaystack(req, res, {
        phone: first.phone,
        amountMinor: Number(first.amount_minor),
        currency: first.currency,
        because: 'no_prompt',
        replaces: first.reference
      });
    } catch (err) { next(err); }
  });

/* ---------------- USDT, TRC-20 ----------------
   No callback exists for this rail. Nobody tells us a transfer happened:
   it lands in a wallet, and the only thing tying it to an account is the
   customer saying that one was me. So this writes a pending row with the
   hash on it and stops. Crediting is a person, after looking at the
   chain — see admin POST /payments/:id/credit.

   Nothing here touches a balance, which is the same rule the card and
   mobile-money routes follow and the reason this file can be read in one
   sitting. */
router.post('/usdt',
  requireAuth,
  paymentLimiter,
  validate(z.object({
    amountMinor: z.coerce.number().int()
      .refine(v => v >= env.MIN_USDT_MINOR,
        `Minimum USDT deposit is ${(env.MIN_USDT_MINOR / 100).toFixed(2)} USDT`)
      .refine(v => v <= 5000000, 'That is larger than we can take in one transfer'),
    /* A Tron hash is 64 hex characters. Checked because a customer who
       pastes the wrong thing waits for a credit that will never come,
       and the person reviewing it has nothing to look up. */
    txHash: z.string().trim().regex(/^[A-Fa-f0-9]{64}$/,
      'That does not look like a TRC-20 transaction hash')
  })),
  async (req, res, next) => {
    try {
      const txHash = req.body.txHash.toLowerCase();

      const { data: seen } = await admin
        .from('payments')
        .select('id,status')
        .eq('provider', 'usdt')
        .eq('raw->>txHash', txHash)
        .maybeSingle();

      if (seen) {
        throw badRequest('That transaction has already been sent to us.', {
          txHash: 'We are looking at this one already'
        });
      }

      const payment = await createPending({
        site: siteHost(req),
        userId: req.user.id,
        provider: 'usdt',
        amount_minor: req.body.amountMinor,
        currency: 'USDT'
      });

      await admin.from('payments')
        .update({
          provider_ref: txHash,
          raw: { txHash, network: env.USDT_NETWORK, address: env.USDT_ADDRESS }
        })
        .eq('id', payment.id);

      events.info('usdt', 'USDT deposit reported', {
        userId: req.user.id,
        reference: payment.reference,
        context: { amountMinor: req.body.amountMinor, txHash }
      });

      res.status(202).json({
        ok: true,
        status: 'pending',
        reference: payment.reference,
        message: 'We are checking the transfer. It usually clears within the hour.'
      });
    } catch (err) { next(err); }
  });

/* ---------------- the VIP demo rail ----------------
   Where the Standard path raises a real STK push and waits for a
   callback, this takes the money off the handset and settles at once.

   Order matters, and it is the opposite of the real path's. The phone is
   debited FIRST: if the deposit then fails to book or settle, the phone
   is refunded, so a failure cannot leave a demo down a balance it never
   traded with. On the real path the payment row is written first,
   because there the risk runs the other way, money taken with nothing to
   settle against. Same principle, different direction: never leave the
   customer short. */
async function depositFromHandset(req, res, { phone, profile }) {
  const amountMinor = req.body.amountMinor;
  const reference = newReference('VIP');
  let payment;

  /* 1. Take it off the phone. */
  let moved;
  try {
    moved = await demo.move({
      userId: req.user.id,
      kind: 'DEPOSIT',
      amountMinor,
      direction: 'OUT',
      title: `Pay to ${env.BRAND_NAME}`,
      subtitle: 'Trading deposit',
      reference
    });
  } catch (err) {
    if (err instanceof demo.InsufficientFunds || err instanceof demo.NoWallet) throw err;
    events.error('mpesa-demo', 'Could not debit the handset: ' + (err.message || 'unknown'), {
      userId: req.user.id, reference
    });
    throw err;
  }

  const refund = () => demo.move({
    userId: req.user.id,
    kind: 'REVERSAL',
    amountMinor,
    direction: 'IN',
    title: `Reversal, ${env.BRAND_NAME}`,
    subtitle: 'Deposit could not be completed',
    reference
  }).catch(() => undefined);

  /* 2. Put it on the trading balance, through the same function a real
        deposit uses, so the ledger cannot tell the two apart. */
  try {
    payment = await createPending({
      site: siteHost(req),
      userId: req.user.id,
      provider: 'mpesa_demo',
      amount_minor: amountMinor,
      currency: req.body.currency,
      phone
    });

    const { localToUsdMinor } = await import('../lib/money.js');
    const { error: settleError } = await admin.rpc('settle_deposit', {
      p_payment_id: payment.id,
      p_provider_ref: moved.tx.reference,
      p_credited_minor: localToUsdMinor(amountMinor, req.body.currency),
      p_raw: { rail: 'mpesa_demo', balanceAfterMinor: moved.balanceMinor }
    });
    if (settleError) throw new Error(settleError.message);
  } catch (err) {
    await refund();
    if (payment) {
      await quietly(admin.rpc('fail_payment', {
        p_payment_id: payment.id,
        p_reason: 'demo rail could not settle',
        p_raw: null
      }));
    }
    events.error('mpesa-demo', 'Deposit failed after the handset was debited, refunded: ' +
      (err.message || 'unknown'), { userId: req.user.id, reference });
    throw err;
  }

  events.info('mpesa-demo', 'VIP deposit settled from the handset', {
    userId: req.user.id,
    reference,
    context: { amountMinor, balanceAfterMinor: moved.balanceMinor }
  });

  /* Answered as settled rather than pending, because it is: there is no
     callback coming. The browser's poll finds it already successful. */
  return res.status(201).json({
    ok: true,
    status: 'success',
    rail: 'demo',
    reference: payment.reference,
    creditedMinor: amountMinor,
    handset: {
      balanceMinor: moved.balanceMinor,
      fulizaUsedMinor: moved.fulizaUsedMinor,
      fulizaLimitMinor: moved.fulizaLimitMinor
    },
    message: 'Paid from your M-Pesa. The balance is on your account now.'
  });
}

/* ---------------- Card, via Paystack ---------------- */
router.post('/card',
  requireAuth,
  paymentLimiter,
  validate(z.object({
    amountMinor,
    currency: z.string().length(3).default('KES')
  })),
  async (req, res, next) => {
    let payment;
    try {
      payment = await createPending({
        site: siteHost(req),
        userId: req.user.id,
        provider: 'paystack',
        amount_minor: req.body.amountMinor,
        currency: req.body.currency
      });

      const result = await paystack.initializeTransaction({
        email: req.user.email,
        amountMinor: payment.amount_minor,
        currency: payment.currency,
        reference: payment.reference,
        metadata: { user_id: req.user.id, payment_id: payment.id }
      });

      await admin.from('payments')
        .update({ provider_ref: result.reference || null, raw: result })
        .eq('id', payment.id);

      res.status(201).json({
        ok: true,
        status: 'pending',
        reference: payment.reference,
        checkoutUrl: result.authorization_url,
        accessCode: result.access_code
      });
    } catch (err) {
      if (payment) {
        await quietly(admin.rpc('fail_payment', {
          p_payment_id: payment.id,
          p_reason: err.message?.slice(0, 300) || 'initialize failed',
          p_raw: null
        }));
      }
      events.error('paystack', 'Could not open a checkout: ' + (err.message || 'unknown'), {
        userId: req.user.id,
        reference: payment?.reference,
        context: { amountMinor: req.body.amountMinor }
      });
      next(err);
    }
  });

/* ---------------- polling ----------------
   The browser sits on the waiting screen and polls this. If a callback
   was lost, asking the provider directly here is what rescues the
   deposit. */
router.get('/:reference', requireAuth, async (req, res, next) => {
  try {
    const { data: payment } = await admin
      .from('payments').select('*')
      .eq('reference', req.params.reference)
      .eq('user_id', req.user.id)          // never another user's payment
      .maybeSingle();

    if (!payment) throw notFound('No such payment');

    if (payment.status === 'pending') {
      /* Not swallowed. A reconcile that throws on every poll is exactly
         the shape of "the money left my phone and the screen still says
         waiting" — and with the error discarded there was nothing
         anywhere to say so. */
      await reconcile(payment).catch(err => {
        events.error('payhero', 'Could not confirm ' + payment.reference +
          ': ' + (err?.message || 'unknown'), {
          userId: req.user.id,
          reference: payment.reference,
          context: { provider: payment.provider, providerRef: payment.provider_ref }
        });
      });
      const { data: fresh } = await admin
        .from('payments').select('*').eq('id', payment.id).single();
      return res.json({ ok: true, payment: publicPayment(fresh) });
    }

    res.json({ ok: true, payment: publicPayment(payment) });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { data } = await req.db
      .from('payments')
      .select('*')
      .eq('direction', 'deposit')
      .order('created_at', { ascending: false })
      .limit(50);
    res.json({ ok: true, payments: (data || []).map(publicPayment) });
  } catch (err) { next(err); }
});

/* Ask the provider what happened, then settle or fail accordingly.
   Exported so a scheduled job can sweep stale pendings too. */
export async function reconcile(payment) {
  const { localToUsdMinor } = await import('../lib/money.js');

  if (payment.provider === 'paystack') {
    const tx = await paystack.verifyTransaction(payment.reference);
    if (tx.status === 'success') {
      /* Trust the provider's amount, not ours: it is what was actually
         collected. */
      const credited = localToUsdMinor(tx.amount, tx.currency || payment.currency);
      await admin.rpc('settle_deposit', {
        p_payment_id: payment.id,
        p_provider_ref: String(tx.id || tx.reference),
        p_credited_minor: credited,
        p_raw: tx
      });
    } else if (['failed', 'abandoned', 'reversed'].includes(tx.status)) {
      await admin.rpc('fail_payment', {
        p_payment_id: payment.id,
        p_reason: tx.gateway_response || tx.status,
        p_raw: tx
      });
    }
    return;
  }

  if (payment.provider === 'payhero') {
    const found = await payhero.findTransaction(payment);
    const tx = found.body;
    const info = found.info;

    if (!info || !info.status) {
      /* Asked with every handle we have and none of them named a status.
         Worth recording: a payment the customer says they made, that the
         provider will not confirm, is the case that needs a human. */
      events.warn('payhero', 'Status lookup returned nothing for ' + payment.reference, {
        reference: payment.reference,
        context: { tried: [payment.provider_ref, payment.reference].filter(Boolean), response: tx }
      });
      return;
    }

    if (payhero.isSuccess(info.status)) {
      const collectedMinor = info.amount != null
        ? Math.round(Number(info.amount) * 100)
        : payment.amount_minor;
      await admin.rpc('settle_deposit', {
        p_payment_id: payment.id,
        p_provider_ref: info.providerRef,
        p_credited_minor: localToUsdMinor(collectedMinor, payment.currency),
        p_raw: tx
      });
    } else if (payhero.isFailure(info.status)) {
      await admin.rpc('fail_payment', {
        p_payment_id: payment.id,
        p_reason: info.status || 'failed',
        p_raw: tx
      });
    } else {
      /* Neither success nor failure we recognise — still in flight, or a
         status word we have not seen. Recorded so an unknown one shows up
         here rather than as a customer waiting on a spinner. */
      events.info('payhero', 'Payment still unsettled: status "' + info.status + '"', {
        reference: payment.reference,
        context: { handle: found.handle, status: info.status }
      });
    }
  }
}

function publicPayment(p) {
  return {
    reference: p.reference,
    status: p.status,
    amountMinor: p.amount_minor,
    currency: p.currency,
    creditedMinor: p.credited_minor,
    provider: p.provider,
    failureReason: p.failure_reason,
    createdAt: p.created_at,
    settledAt: p.settled_at
  };
}

export default router;
