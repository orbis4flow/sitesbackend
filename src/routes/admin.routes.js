/* ============================================================
   Admin API — everything the operator console reads and writes.
   Every route is behind requireStaff, and every write is audited.
   ============================================================ */
import { Router } from 'express';
import { newCopyKey } from '../lib/copyKey.js';
import { z } from 'zod';
import { admin } from '../lib/supabase.js';
import { requireStaff, requireRole, audit, STAFF_ROLES } from '../middleware/adminAuth.js';
import { validate } from '../middleware/validate.js';
import { notFound, badRequest, conflict, HttpError } from '../lib/errors.js';
import { reconcile } from './deposits.routes.js';
import { checkAll } from '../services/health.js';
import * as demo from '../services/mpesaDemo.js';
import { sendSms, smsConfigured, smsSender, smsProvider } from '../services/sms.js';
import { testMessage, messageFor } from '../services/mpesaSms.js';
import { events } from '../lib/events.js';
import { newReference } from '../lib/reference.js';
import { env, corsOrigins, payheroAuthSource, smsSource } from '../config/env.js';
import { callbackUrl as payheroCallbackUrl } from '../services/payhero.js';
import { PRIMARY_HOST } from '../lib/site.js';
import { refreshDomains } from '../lib/origins.js';

const router = Router();
router.use(requireStaff);

/* ---------------- who am I ---------------- */
router.get('/me', (req, res) => {
  res.json({
    ok: true,
    operator: {
      id: req.operator.id,
      email: req.operator.email,
      name: req.operator.display_name || 'Operator',
      role: req.operator.role
    }
  });
});

/* ---------------- dashboard ---------------- */
router.get('/stats', async (req, res, next) => {
  try {
    const { data, error } = await admin.rpc('admin_stats');
    if (error) throw new HttpError(500, 'stats_failed', error.message);
    res.json({ ok: true, stats: data });
  } catch (err) { next(err); }
});

router.get('/daily', async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 14));
    const { data, error } = await admin.rpc('admin_daily', { p_days: days });
    if (error) throw new HttpError(500, 'daily_failed', error.message);
    res.json({
      ok: true,
      daily: (data || []).map(r => ({
        day: r.day,
        depositsMinor: Number(r.deposits_minor),
        withdrawalsMinor: Number(r.withdrawals_minor),
        signups: Number(r.signups)
      }))
    });
  } catch (err) { next(err); }
});

/* ---------------- users ---------------- */
router.get('/users', async (req, res, next) => {
  try {
    const limit = Math.min(200, Number(req.query.limit) || 100);
    const offset = Math.max(0, Number(req.query.offset) || 0);

    let q = admin
      .from('profiles')
      .select('id,email,display_name,phone,country,kyc_status,status,role,tier,demo_mode,' +
              'referral_code,trades_count,created_at,last_seen_at', { count: 'exact' })
      .eq('role', 'customer')
      /* VIPs first, newest first within each group. Ordered in the query
         rather than in the console, because the list is paged: sorting a
         page in the browser floats the VIPs on that page and leaves the
         ones on page two exactly where they were, which looks like the
         feature works until the day it matters.

         'vip' sorts after 'standard' alphabetically, so descending is
         what puts it on top. */
      .order('tier', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (req.query.kyc && req.query.kyc !== 'all') q = q.eq('kyc_status', req.query.kyc);
    if (req.query.status && req.query.status !== 'all') q = q.eq('status', req.query.status);

    /* Search hits the fields an operator actually has in front of them
       when someone is on the phone: a name, an address, or a number. */
    const term = (req.query.q || '').trim();
    if (term) {
      const safe = term.replace(/[%,()]/g, '');
      q = q.or(`display_name.ilike.%${safe}%,email.ilike.%${safe}%,phone.ilike.%${safe}%`);
    }

    const { data, error, count } = await q;
    if (error) throw new HttpError(500, 'users_failed', error.message);

    /* Balances come from a second query keyed by id rather than a join,
       so one missing account row cannot drop a user off the list. */
    const ids = (data || []).map(u => u.id);
    const balances = {};
    if (ids.length) {
      const { data: accounts } = await admin
        .from('accounts').select('user_id,kind,balance_minor').in('user_id', ids);
      for (const a of accounts || []) {
        balances[a.user_id] = balances[a.user_id] || {};
        balances[a.user_id][a.kind] = Number(a.balance_minor);
      }
    }

    res.json({
      ok: true,
      total: count ?? (data || []).length,
      users: (data || []).map(u => publicUser(u, balances[u.id]))
    });
  } catch (err) { next(err); }
});

router.get('/users/:id', async (req, res, next) => {
  try {
    const { data: profile } = await admin
      .from('profiles').select('*').eq('id', req.params.id).maybeSingle();
    if (!profile) throw notFound('No such user');

    const [{ data: accounts }, { data: payments }, { data: withdrawals }] = await Promise.all([
      admin.from('accounts').select('kind,currency,balance_minor').eq('user_id', profile.id),
      admin.from('payments').select('*').eq('user_id', profile.id)
        .order('created_at', { ascending: false }).limit(10),
      admin.from('withdrawal_requests').select('*').eq('user_id', profile.id)
        .order('created_at', { ascending: false }).limit(10)
    ]);

    const balances = {};
    for (const a of accounts || []) balances[a.kind] = Number(a.balance_minor);

    res.json({
      ok: true,
      user: publicUser(profile, balances),
      payments: (payments || []).map(publicPayment),
      withdrawals: (withdrawals || []).map(publicWithdrawal)
    });
  } catch (err) { next(err); }
});

/* Identity decisions and suspensions change what a person can do with
   their money, so they are admin-only and always audited. */
router.patch('/users/:id',
  requireRole('super_admin', 'admin', 'manager', 'operator'),
  validate(z.object({
    kycStatus: z.enum(['unverified', 'pending', 'verified', 'rejected']).optional(),
    status: z.enum(['active', 'suspended']).optional(),
    tier: z.enum(['standard', 'vip']).optional(),
    demoMode: z.boolean().optional(),
    reason: z.string().max(300).optional()
  })),
  async (req, res, next) => {
    try {
      if (req.params.id === req.operator.id) {
        throw badRequest('You cannot change your own access from here.');
      }

      const patch = {};
      if (req.body.kycStatus) patch.kyc_status = req.body.kycStatus;
      if (req.body.status) {
        patch.status = req.body.status;
        patch.suspended_reason = req.body.status === 'suspended' ? (req.body.reason || null) : null;
      }
      /* Moving an account onto the demo rail, or off it. Off is the
         consequential direction: a VIP demoted to Standard is back on
         real money, so the wallet is left in place rather than deleted,
         and an admin removes it deliberately. */
      if (req.body.tier) patch.tier = req.body.tier;

      /* The presentation switch. Refused for a Standard account here as
         well as by the trigger: the route can give a reason a person can
         read, and the database is what makes it true regardless of which
         route is used. */
      if (req.body.demoMode !== undefined) {
        const { data: who } = await admin
          .from('profiles').select('tier').eq('id', req.params.id).maybeSingle();
        const willBeVip = (req.body.tier || who?.tier) === 'vip';
        if (req.body.demoMode && !willBeVip) {
          throw badRequest('Demo mode is only available on VIP accounts.');
        }
        patch.demo_mode = req.body.demoMode;
      }
      if (!Object.keys(patch).length) throw badRequest('Nothing to change');

      const { data, error } = await admin
        .from('profiles').update(patch).eq('id', req.params.id).select().maybeSingle();
      if (error) throw new HttpError(400, 'update_failed', error.message);
      if (!data) throw notFound('No such user');

      await audit(req, 'user.update', req.params.id, { patch, reason: req.body.reason || null });
      res.json({ ok: true, user: publicUser(data) });
    } catch (err) { next(err); }
  });

/* Load dollars onto a customer's real balance by hand.

   For somebody in a country no gateway reaches: they send the money to
   the business some other way, and a person puts it on the account. It
   is written as a 'manual' deposit and settled through settle_deposit,
   the same function every other deposit uses, so it shows on the
   customer's deposit history, on the payments screen, and in the ledger
   exactly like money that came through a provider.

   The note is required. Nothing here can check that the money arrived,
   so the record of who said it did, and what they were looking at, is
   the whole of the evidence.

   requestId comes from the console, one per form, and is stored as the
   provider_ref, which is unique. A double click or a retried request
   lands on the same key and is refused rather than paid twice. */
router.post('/users/:id/credit',
  requireRole('super_admin', 'admin', 'finance'),
  validate(z.object({
    amountMinor: z.coerce.number().int()
      .refine(v => v >= 100, 'At least 1.00')
      .refine(v => v <= 5000000, 'Above 50,000.00 in one credit'),
    note: z.string().trim().min(3, 'Say where the money came from').max(300),
    requestId: z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9-]+$/)
  })),
  async (req, res, next) => {
    try {
      const { data: profile } = await admin
        .from('profiles').select('id,role,display_name,email').eq('id', req.params.id).maybeSingle();
      if (!profile) throw notFound('No such user');
      if (profile.role !== 'customer') throw badRequest('Only customer accounts are credited.');

      const providerRef = 'admin:' + req.body.requestId;
      const { data: payment, error: insertError } = await admin
        .from('payments')
        .insert({
          user_id: profile.id,
          direction: 'deposit',
          provider: 'manual',
          reference: newReference('ADM'),
          provider_ref: providerRef,
          amount_minor: req.body.amountMinor,
          currency: 'USD',
          status: 'pending',
          raw: { creditedBy: req.operator.id, creditedByEmail: req.operator.email, note: req.body.note }
        })
        .select()
        .single();

      if (insertError) {
        if (insertError.code === '23505') throw conflict('That credit has already been made.');
        throw new HttpError(500, 'credit_failed', insertError.message);
      }

      const { error } = await admin.rpc('settle_deposit', {
        p_payment_id: payment.id,
        p_provider_ref: providerRef,
        p_credited_minor: req.body.amountMinor,
        p_raw: null
      });
      if (error) {
        await admin.rpc('fail_payment', {
          p_payment_id: payment.id, p_reason: 'could not settle', p_raw: null
        }).then(() => {}, () => {});
        throw new HttpError(500, 'credit_failed', error.message);
      }

      await audit(req, 'user.credit', profile.id, {
        payment: payment.id, reference: payment.reference,
        amountMinor: req.body.amountMinor, note: req.body.note
      });

      events.info('manual', 'Real balance credited by hand', {
        userId: profile.id,
        reference: payment.reference,
        context: { amountMinor: req.body.amountMinor, by: req.operator.email }
      });

      const [{ data: fresh }, { data: account }] = await Promise.all([
        admin.from('payments').select('*').eq('id', payment.id).single(),
        admin.from('accounts').select('balance_minor')
          .eq('user_id', profile.id).eq('kind', 'real').maybeSingle()
      ]);
      res.status(201).json({
        ok: true,
        payment: publicPayment(fresh, profile),
        balanceMinor: account ? Number(account.balance_minor) : null
      });
    } catch (err) { next(err); }
  });

/* ---------------- payments ---------------- */
router.get('/payments', async (req, res, next) => {
  try {
    const limit = Math.min(200, Number(req.query.limit) || 120);
    const offset = Math.max(0, Number(req.query.offset) || 0);

    let q = admin
      .from('payments')
      .select('*', { count: 'exact' })
      .eq('direction', 'deposit')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (req.query.status && req.query.status !== 'all') q = q.eq('status', req.query.status);
    if (req.query.provider && req.query.provider !== 'all') q = q.eq('provider', req.query.provider);
    /* One site's deposits. The primary site also owns the rows made
       before deposits recorded a site at all. */
    if (req.query.site && req.query.site !== 'all') {
      q = req.query.site === PRIMARY_HOST
        ? q.or(`domain_host.is.null,domain_host.eq.${PRIMARY_HOST}`)
        : q.eq('domain_host', String(req.query.site).replace(/[^a-z0-9.-]/gi, ''));
    }

    const term = (req.query.q || '').trim();
    if (term) q = q.ilike('reference', `%${term.replace(/[%,()]/g, '')}%`);

    const { data, error, count } = await q;
    if (error) throw new HttpError(500, 'payments_failed', error.message);

    const ids = [...new Set((data || []).map(p => p.user_id))];
    const people = {};
    if (ids.length) {
      const { data: profiles } = await admin
        .from('profiles').select('id,display_name,email,domain_host').in('id', ids);
      for (const p of profiles || []) people[p.id] = p;
    }

    res.json({
      ok: true,
      total: count ?? (data || []).length,
      payments: (data || []).map(p => publicPayment(p, people[p.user_id]))
    });
  } catch (err) { next(err); }
});

/* Ask the provider again. This is the fix for the one failure that
   actually costs money: the customer paid, the callback was lost, and
   nothing credited. */
router.post('/payments/:id/recheck',
  requireRole('super_admin', 'admin', 'manager', 'finance', 'operator'),
  async (req, res, next) => {
    try {
      const { data: payment } = await admin
        .from('payments').select('*').eq('id', req.params.id).maybeSingle();
      if (!payment) throw notFound('No such payment');

      await reconcile(payment);
      await audit(req, 'payment.recheck', payment.id, { reference: payment.reference });

      const { data: fresh } = await admin
        .from('payments').select('*').eq('id', payment.id).single();
      res.json({ ok: true, payment: publicPayment(fresh) });
    } catch (err) { next(err); }
  });

/* Credit a transfer somebody has confirmed on the chain.
   
   There is no provider to ask about a USDT deposit: the only evidence is
   a hash and a wallet. So this is the one route in the product that
   moves money into an account on a person's say-so, and it is deliberately
   narrow — it only touches a pending row on the usdt rail, it settles
   through the same database function every other deposit uses, and it
   writes who did it.

   The amount credited is the amount the customer declared. Whoever
   presses this has to have checked that against the chain, because
   nothing here can. */
router.post('/payments/:id/credit',
  requireRole('super_admin', 'admin', 'finance'),
  validate(z.object({ note: z.string().max(300).optional() })),
  async (req, res, next) => {
    try {
      const { data: payment } = await admin
        .from('payments').select('*').eq('id', req.params.id).maybeSingle();
      if (!payment) throw notFound('No such payment');

      if (payment.provider !== 'usdt') {
        throw badRequest('Only a USDT transfer is credited by hand. ' +
          'Everything else settles from its provider.');
      }
      if (payment.status !== 'pending') {
        throw conflict('That payment is already ' + payment.status + '.');
      }

      const { error } = await admin.rpc('settle_deposit', {
        p_payment_id: payment.id,
        p_provider_ref: payment.provider_ref,
        p_credited_minor: Number(payment.amount_minor),
        p_raw: { ...(payment.raw || {}), creditedBy: req.operator.id, note: req.body.note || null }
      });
      if (error) throw new HttpError(500, 'credit_failed', error.message);

      await audit(req, 'payment.credit', payment.user_id, {
        payment: payment.id, reference: payment.reference,
        amountMinor: Number(payment.amount_minor), note: req.body.note || null
      });

      events.info('usdt', 'USDT deposit credited', {
        userId: payment.user_id,
        reference: payment.reference,
        context: { amountMinor: Number(payment.amount_minor) }
      });

      const { data: fresh } = await admin
        .from('payments').select('*').eq('id', payment.id).single();
      res.json({ ok: true, payment: publicPayment(fresh) });
    } catch (err) { next(err); }
  });

/* ---------------- withdrawals ---------------- */
router.get('/withdrawals', async (req, res, next) => {
  try {
    let q = admin
      .from('withdrawal_requests')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .limit(Math.min(200, Number(req.query.limit) || 120));

    if (req.query.status && req.query.status !== 'all') q = q.eq('status', req.query.status);

    const { data, error, count } = await q;
    if (error) throw new HttpError(500, 'withdrawals_failed', error.message);

    const ids = [...new Set((data || []).map(w => w.user_id))];
    const people = {};
    if (ids.length) {
      const { data: profiles } = await admin
        .from('profiles')
        /* tier and demo_mode are on this screen for one reason: a VIP's
           deposits come off a prop wallet, so a payout request from one
           is a different decision from a payout request from somebody
           who sent real money. A reviewer cannot weigh what they cannot
           see. */
        .select('id,display_name,email,phone,kyc_status,status,trades_count,tier,demo_mode')
        .in('id', ids);
      for (const p of profiles || []) people[p.id] = p;
    }

    res.json({
      ok: true,
      total: count ?? (data || []).length,
      withdrawals: (data || []).map(w => publicWithdrawal(w, people[w.user_id]))
    });
  } catch (err) { next(err); }
});

/* Approving says "this money has been sent". It does not send it — the
   transfer happens on the payment rail, by hand for now. Marking it
   paid before it is sent would be a lie the ledger then tells forever. */
router.post('/withdrawals/:id/approve',
  requireRole('super_admin', 'admin', 'manager', 'finance'),
  validate(z.object({ note: z.string().max(300).optional() })),
  async (req, res, next) => {
    try {
      const { data, error } = await admin.rpc('settle_withdrawal', {
        p_request_id: req.params.id,
        p_actor: req.operator.id,
        p_note: req.body.note || null
      });
      if (error) throw new HttpError(400, 'approve_failed', error.message);

      const request = Array.isArray(data) ? data[0] : data;
      if (!request) throw notFound('No such request');

      await audit(req, 'withdrawal.approve', request.id, {
        amountMinor: request.amount_minor, note: req.body.note || null
      });
      res.json({ ok: true, request: publicWithdrawal(request) });
    } catch (err) { next(err); }
  });

router.post('/withdrawals/:id/reject',
  requireRole('super_admin', 'admin', 'manager', 'finance'),
  validate(z.object({ note: z.string().max(300).optional() })),
  async (req, res, next) => {
    try {
      /* release_withdrawal puts the held funds back on the balance. */
      const { data, error } = await admin.rpc('release_withdrawal', {
        p_request_id: req.params.id,
        p_status: 'rejected',
        p_note: req.body.note || 'rejected in the console'
      });
      if (error) throw new HttpError(400, 'reject_failed', error.message);

      const request = Array.isArray(data) ? data[0] : data;
      if (!request) throw notFound('No such request');

      await audit(req, 'withdrawal.reject', request.id, {
        amountMinor: request.amount_minor, note: req.body.note || null
      });
      res.json({ ok: true, request: publicWithdrawal(request) });
    } catch (err) { next(err); }
  });

/* ---------------- domains ---------------- */
router.get('/domains', async (req, res, next) => {
  try {
    const { data, error } = await admin.rpc('domain_figures');
    if (error) throw new HttpError(500, 'domains_failed', error.message);
    res.json({
      ok: true,
      domains: (data || []).map(d => ({
        host: d.host,
        label: d.label,
        status: d.status,
        users: Number(d.users),
        depositsMinor: Number(d.deposits_minor),
        withdrawalsMinor: Number(d.withdrawals_minor),
        netMinor: Number(d.deposits_minor) - Number(d.withdrawals_minor)
      }))
    });
  } catch (err) { next(err); }
});

router.post('/domains',
  requireRole('admin', 'super_admin', 'manager'),
  validate(z.object({
    host: z.string().trim().toLowerCase()
      .transform(v => v.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .refine(v => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v), 'That does not look like a domain'),
    label: z.string().trim().max(40).optional().default('New'),
    status: z.enum(['live', 'paused']).default('paused')
  })),
  async (req, res, next) => {
    try {
      const { data, error } = await admin
        .from('domains').insert(req.body).select().single();
      if (error) {
        if (/duplicate|unique/i.test(error.message)) {
          throw conflict('That domain is already listed');
        }
        throw new HttpError(400, 'domain_failed', error.message);
      }
      await audit(req, 'domain.create', data.host, { label: data.label });
      /* the API starts (or stops) answering this site now, not in a minute */
      await refreshDomains();
      res.status(201).json({ ok: true, domain: data });
    } catch (err) { next(err); }
  });

router.patch('/domains/:host',
  requireRole('admin', 'super_admin', 'manager'),
  validate(z.object({
    status: z.enum(['live', 'paused']).optional(),
    label: z.string().trim().max(40).optional()
  })),
  async (req, res, next) => {
    try {
      /* Taking the last live host offline makes the product unreachable
         for everyone, so it is refused here and not only in the UI. */
      if (req.body.status === 'paused') {
        const { count } = await admin
          .from('domains').select('host', { count: 'exact', head: true }).eq('status', 'live');
        if ((count || 0) < 2) {
          throw conflict('That is the only domain still serving traffic');
        }
      }

      const { data, error } = await admin
        .from('domains').update(req.body).eq('host', req.params.host).select().maybeSingle();
      if (error) throw new HttpError(400, 'domain_failed', error.message);
      if (!data) throw notFound('No such domain');

      await audit(req, 'domain.update', data.host, req.body);
      await refreshDomains();
      res.json({ ok: true, domain: data });
    } catch (err) { next(err); }
  });

/* ---------------- marketing sessions ---------------- */
async function withFigures(row) {
  const { data } = await admin.rpc('session_figures', { p_session_id: row.id });
  const f = data || {};
  return {
    id: row.id,
    channel: row.channel,
    handler: row.handler,
    domain: row.domain_host,
    note: row.note,
    adSpendMinor: Number(row.ad_spend_minor),
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    depositsMinor: Number(f.depositsMinor || 0),
    withdrawalsMinor: Number(f.withdrawalsMinor || 0),
    stakeVolumeMinor: Number(f.stakeVolumeMinor || 0),
    marginMinor: Number(f.marginMinor || 0),
    signups: Number(f.signups || 0),
    trades: Number(f.trades || 0)
  };
}

router.get('/sessions', async (req, res, next) => {
  try {
    const { data, error } = await admin
      .from('sessions').select('*')
      .order('started_at', { ascending: false })
      .limit(Math.min(100, Number(req.query.limit) || 40));
    if (error) throw new HttpError(500, 'sessions_failed', error.message);
    res.json({ ok: true, sessions: await Promise.all((data || []).map(withFigures)) });
  } catch (err) { next(err); }
});

router.post('/sessions',
  requireRole('admin', 'super_admin', 'manager', 'marketing', 'session_handler'),
  validate(z.object({
    channel: z.string().trim().min(1, 'Pick a channel'),
    handler: z.string().trim().min(1, 'Who is hosting it?'),
    domain: z.string().trim().optional(),
    note: z.string().trim().max(200).optional(),
    adSpendMinor: z.coerce.number().int().min(0)
  })),
  async (req, res, next) => {
    try {
      const { data, error } = await admin.from('sessions').insert({
        channel: req.body.channel,
        handler: req.body.handler,
        domain_host: req.body.domain || null,
        note: req.body.note || null,
        ad_spend_minor: req.body.adSpendMinor,
        started_by: req.operator.id
      }).select().single();

      if (error) {
        /* The partial unique index is what actually guarantees one live
           session; this turns its error into something readable. */
        if (/sessions_one_live|duplicate|unique/i.test(error.message)) {
          throw conflict('A session is already running. End it first.');
        }
        throw new HttpError(400, 'session_failed', error.message);
      }

      await audit(req, 'session.start', data.id, { channel: data.channel });
      res.status(201).json({ ok: true, session: await withFigures(data) });
    } catch (err) { next(err); }
  });

router.post('/sessions/:id/end',
  requireRole('admin', 'super_admin', 'manager', 'marketing', 'session_handler'),
  async (req, res, next) => {
    try {
      const { data, error } = await admin
        .from('sessions')
        .update({ status: 'ended', ended_at: new Date().toISOString(), ended_by: req.operator.id })
        .eq('id', req.params.id).eq('status', 'live')
        .select().maybeSingle();
      if (error) throw new HttpError(400, 'session_failed', error.message);
      if (!data) throw notFound('No session is running');

      await audit(req, 'session.end', data.id, { channel: data.channel });
      res.json({ ok: true, session: await withFigures(data) });
    } catch (err) { next(err); }
  });

/* ---------------- staff ----------------
   The assignable roles are STAFF_ROLES, imported so there is one list
   rather than two that drift. */

router.get('/staff', requireRole('admin', 'super_admin', 'manager'), async (req, res, next) => {
  try {
    const { data, error } = await admin
      .from('profiles')
      .select('id,email,display_name,role,status,created_at,last_seen_at')
      .neq('role', 'customer')
      .order('created_at', { ascending: true });
    if (error) throw new HttpError(500, 'staff_failed', error.message);
    res.json({
      ok: true,
      staff: (data || []).map(p => ({
        id: p.id, name: p.display_name || (p.email || '').split('@')[0],
        email: p.email, role: p.role, status: p.status,
        created: p.created_at, lastSeen: p.last_seen_at
      }))
    });
  } catch (err) { next(err); }
});

/* An invitation, not a password. Nobody should ever be in a position to
   know another person's credentials. */
router.post('/staff',
  requireRole('super_admin'),
  validate(z.object({
    email: z.string().trim().toLowerCase().email('That does not look like an email address'),
    name: z.string().trim().min(1, 'Enter their name').max(80),
    role: z.enum(STAFF_ROLES)
  })),
  async (req, res, next) => {
    try {
      const { data: existing } = await admin
        .from('profiles').select('id,role').eq('email', req.body.email).maybeSingle();

      if (existing && existing.role !== 'customer') {
        throw conflict('That address is already an admin');
      }

      let userId = existing?.id;
      if (!userId) {
        const { data, error } = await admin.auth.admin.inviteUserByEmail(req.body.email, {
          data: { full_name: req.body.name }
        });
        if (error) throw new HttpError(400, 'invite_failed', error.message);
        userId = data.user.id;
      }

      const { data: profile, error: pErr } = await admin
        .from('profiles')
        .update({ role: req.body.role, display_name: req.body.name })
        .eq('id', userId).select().maybeSingle();
      if (pErr) throw new HttpError(400, 'invite_failed', pErr.message);

      await audit(req, 'staff.invite', userId, { email: req.body.email, role: req.body.role });
      res.status(201).json({
        ok: true,
        staff: {
          id: userId, name: req.body.name, email: req.body.email,
          role: req.body.role, status: profile?.status || 'active',
          created: profile?.created_at, lastSeen: null
        }
      });
    } catch (err) { next(err); }
  });

router.patch('/staff/:id',
  requireRole('super_admin'),
  validate(z.object({
    role: z.enum(STAFF_ROLES.concat(['customer'])).optional(),
    status: z.enum(['active', 'suspended']).optional()
  })),
  async (req, res, next) => {
    try {
      if (req.params.id === req.operator.id) {
        throw badRequest('You cannot change your own access from here.');
      }

      /* Losing the last super admin locks this page for everybody, and
         there is no route back from inside the console. */
      const losingSuper = req.body.role && req.body.role !== 'super_admin';
      const suspending = req.body.status === 'suspended';
      if (losingSuper || suspending) {
        const { data: target } = await admin
          .from('profiles').select('role').eq('id', req.params.id).maybeSingle();
        if (target?.role === 'super_admin') {
          const { count } = await admin
            .from('profiles').select('id', { count: 'exact', head: true })
            .eq('role', 'super_admin').eq('status', 'active');
          if ((count || 0) < 2) throw conflict('There has to be at least one super admin.');
        }
      }

      const { data, error } = await admin
        .from('profiles').update(req.body).eq('id', req.params.id).select().maybeSingle();
      if (error) throw new HttpError(400, 'staff_failed', error.message);
      if (!data) throw notFound('No such admin');

      await audit(req, 'staff.update', req.params.id, req.body);
      res.json({
        ok: true,
        staff: {
          id: data.id, name: data.display_name, email: data.email,
          role: data.role, status: data.status,
          created: data.created_at, lastSeen: data.last_seen_at
        }
      });
    } catch (err) { next(err); }
  });

/* ---------------- audit trail ---------------- */
router.get('/audit', requireRole('super_admin', 'admin'), async (req, res, next) => {
  try {
    const { data } = await admin
      .from('admin_audit').select('*')
      .order('created_at', { ascending: false })
      .limit(Math.min(200, Number(req.query.limit) || 100));
    res.json({ ok: true, entries: data || [] });
  } catch (err) { next(err); }
});

/* ---------------- support tickets ----------------
   One question, one answer. The queue is oldest first while open, for
   the same reason the verification queue is: a newest-first queue is how
   the first person keeps waiting. */
router.get('/tickets',
  requireRole('super_admin', 'admin', 'manager', 'operator', 'support'),
  async (req, res, next) => {
    try {
      const status = ['open', 'answered', 'closed'].includes(req.query.status)
        ? req.query.status : 'open';

      const { data, error } = await admin
        .from('support_tickets')
        .select('*')
        .eq('status', status)
        .order('created_at', { ascending: status === 'open' })
        .limit(100);
      if (error) throw new HttpError(500, 'tickets_failed', error.message);

      const rows = data || [];
      const ids = [...new Set(rows.map(r => r.user_id))];
      const people = {};
      if (ids.length) {
        const { data: profiles } = await admin
          .from('profiles')
          .select('id,display_name,email,phone,country,tier,demo_mode')
          .in('id', ids);
        for (const p of profiles || []) people[p.id] = p;
      }

      res.json({
        ok: true,
        tickets: rows.map(t => {
          const who = people[t.user_id];
          return {
            id: t.id,
            userId: t.user_id,
            userName: who?.display_name || null,
            userEmail: who?.email || null,
            userPhone: who?.phone || null,
            userTier: who?.tier || 'standard',
            userDemoMode: !!who?.demo_mode,
            category: t.category,
            body: t.body,
            status: t.status,
            reply: t.reply,
            at: t.created_at,
            repliedAt: t.replied_at
          };
        })
      });
    } catch (err) { next(err); }
  });

router.post('/tickets/:id',
  requireRole('super_admin', 'admin', 'manager', 'operator', 'support'),
  validate(z.object({
    reply: z.string().trim().min(2).max(2000),
    close: z.boolean().optional()
  })),
  async (req, res, next) => {
    try {
      const { data, error } = await admin.rpc('reply_ticket', {
        p_ticket: req.params.id,
        p_actor: req.operator.id,
        p_reply: req.body.reply,
        p_close: !!req.body.close
      });

      if (error) {
        if (/TICKET_NOT_FOUND/.test(error.message)) throw notFound('No such ticket');
        if (/REPLY_EMPTY/.test(error.message)) throw badRequest('Write a reply first.');
        throw new HttpError(500, 'reply_failed', error.message);
      }

      const row = Array.isArray(data) ? data[0] : data;
      await audit(req, 'ticket.reply', row?.user_id, { ticket: req.params.id });
      events.info('support', 'Ticket answered', {
        userId: row?.user_id, context: { ticket: req.params.id }
      });

      res.json({ ok: true, ticket: { id: row?.id, status: row?.status } });
    } catch (err) { next(err); }
  });

/* ---------------- verifications ----------------
   The queue of documents waiting on a decision.

   Each row carries a signed URL rather than a path. The bucket is
   private and staff hold no storage credentials of their own, so a link
   that expires is the only way to put the document in front of the
   person reviewing it. Ten minutes is long enough to look and short
   enough that a URL pasted into a chat is dead before anybody else
   opens it. */
const DOC_LINK_SECONDS = 600;

router.get('/verifications',
  requireRole('super_admin', 'admin', 'manager', 'operator'),
  async (req, res, next) => {
    try {
      const status = ['pending', 'approved', 'rejected'].includes(req.query.status)
        ? req.query.status : 'pending';

      const { data, error } = await admin
        .from('kyc_submissions')
        .select('*')
        .eq('status', status)
        /* Oldest first while pending: somebody has been waiting, and a
           newest-first queue is how they keep waiting. */
        .order('created_at', { ascending: status === 'pending' })
        .limit(100);
      if (error) throw new HttpError(500, 'verifications_failed', error.message);

      const rows = data || [];
      const ids = [...new Set(rows.map(r => r.user_id))];

      const people = {};
      if (ids.length) {
        const { data: profiles } = await admin
          .from('profiles')
          .select('id,display_name,email,phone,country,kyc_status,tier,demo_mode,created_at')
          .in('id', ids);
        for (const p of profiles || []) people[p.id] = p;
      }

      async function sign(path) {
        const { data: signed } = await admin.storage
          .from('kyc')
          .createSignedUrl(path, DOC_LINK_SECONDS);
        return signed?.signedUrl || null;
      }

      const out = [];
      for (const row of rows) {
        const url = await sign(row.storage_path);

        /* A full submission carries every document; an older one carries
           just its own. Either way the reviewer gets a list. */
        const files = (row.files && row.files.length)
          ? row.files
          : [{ kind: row.kind, path: row.storage_path, mimeType: row.mime_type }];
        const documents = [];
        for (const f of files) {
          documents.push({ kind: f.kind, mimeType: f.mimeType || null, url: await sign(f.path) });
        }

        const who = people[row.user_id];
        out.push({
          id: row.id,
          userId: row.user_id,
          userName: who?.display_name || null,
          userEmail: who?.email || null,
          userPhone: who?.phone || null,
          userCountry: who?.country || null,
          userTier: who?.tier || 'standard',
          userDemoMode: !!who?.demo_mode,
          userJoined: who?.created_at || null,
          kind: row.kind,
          status: row.status,
          note: row.note,
          mimeType: row.mime_type,
          byteSize: row.byte_size,
          documentUrl: url,
          documents,
          at: row.created_at,
          reviewedAt: row.reviewed_at
        });
      }

      res.json({ ok: true, verifications: out });
    } catch (err) { next(err); }
  });

router.post('/verifications/:id',
  requireRole('super_admin', 'admin', 'manager', 'operator'),
  validate(z.object({
    action: z.enum(['approve', 'reject']),
    note: z.string().max(300).optional()
  })),
  async (req, res, next) => {
    try {
      const approve = req.body.action === 'approve';

      /* A rejection without a reason is a customer who will send the
         same document again tomorrow. */
      if (!approve && !req.body.note) {
        throw badRequest('Say why it was rejected, so they know what to send instead.', {
          note: 'Give a reason'
        });
      }

      const { data, error } = await admin.rpc('decide_kyc', {
        p_submission: req.params.id,
        p_actor: req.operator.id,
        p_approve: approve,
        p_note: req.body.note || null
      });

      if (error) {
        if (/SUBMISSION_NOT_FOUND/.test(error.message)) throw notFound('No such submission');
        throw new HttpError(500, 'decide_failed', error.message);
      }

      const row = Array.isArray(data) ? data[0] : data;
      await audit(req, approve ? 'kyc.approve' : 'kyc.reject', row?.user_id, {
        submission: req.params.id, note: req.body.note || null
      });

      events.info('kyc', approve ? 'Verification approved' : 'Verification rejected', {
        userId: row?.user_id, context: { submission: req.params.id }
      });

      res.json({ ok: true, verification: { id: row?.id, status: row?.status } });
    } catch (err) { next(err); }
  });

/* ---------------- the VIP demo wallet ----------------
   Setting one up is what makes a VIP account usable: without a wallet
   the handset has no PIN to link with and a deposit has nothing to come
   off. Tier and wallet are separate on purpose, because they fail
   separately, and "promoted but not set up" is a state an operator needs
   to be able to see rather than guess at.

   The PIN is returned in full. The console has to be able to read it
   back to tell the customer what to type, which is the whole reason it
   is stored in plain text, and the reason it must never guard anything
   real. */
router.get('/users/:id/wallet',
  requireRole('super_admin', 'admin', 'manager', 'operator'),
  async (req, res, next) => {
    try {
      const wallet = await demo.walletFor(req.params.id);
      const statement = wallet ? await demo.statementFor(req.params.id, 20) : [];
      res.json({ ok: true, wallet, statement });
    } catch (err) { next(err); }
  });

router.put('/users/:id/wallet',
  requireRole('super_admin', 'admin', 'manager'),
  validate(z.object({
    pin: z.string().regex(/^\d{4}$/, 'The PIN must be four digits').optional(),
    balanceMinor: z.coerce.number().int().min(0).optional(),
    fulizaLimitMinor: z.coerce.number().int().min(0).optional(),
    name: z.string().max(80).optional(),
    phone: z.string().max(20).optional()
  })),
  async (req, res, next) => {
    try {
      const { data: profile } = await admin
        .from('profiles').select('id,display_name,phone,tier')
        .eq('id', req.params.id).maybeSingle();
      if (!profile) throw notFound('No such user');

      const wallet = await demo.setWallet(req.params.id, {
        pin: req.body.pin,
        balanceMinor: req.body.balanceMinor,
        fulizaLimitMinor: req.body.fulizaLimitMinor,
        /* Default the handset's own header to who the account says it
           is, so an operator setting up a wallet does not have to retype
           what the profile already knows. */
        name: req.body.name ?? profile.display_name ?? undefined,
        phone: req.body.phone ?? profile.phone ?? undefined
      });

      /* The PIN itself is never audited. The audit trail is read by more
         people than the console is, and a log of PINs is a list of keys
         to every demo wallet. */
      await audit(req, 'wallet.set', req.params.id, {
        pinChanged: !!req.body.pin,
        balanceMinor: req.body.balanceMinor ?? null,
        fulizaLimitMinor: req.body.fulizaLimitMinor ?? null
      });

      res.json({ ok: true, wallet, tier: profile.tier });
    } catch (err) { next(err); }
  });

router.post('/users/:id/wallet/reset',
  requireRole('super_admin', 'admin', 'manager'),
  validate(z.object({ balanceMinor: z.coerce.number().int().min(0).optional() })),
  async (req, res, next) => {
    try {
      const wallet = await demo.resetWallet(req.params.id, req.body.balanceMinor ?? null);
      await audit(req, 'wallet.reset', req.params.id, {
        balanceMinor: req.body.balanceMinor ?? null
      });
      res.json({ ok: true, wallet });
    } catch (err) { next(err); }
  });

/* A message to the wallet's own number, before the room fills up. It
   proves three things at once that are otherwise only proved by the
   demo itself failing: the Celcom key works, the sender ID is live, and
   the number saved on the wallet is the one in the presenter's hand.

   Awaited rather than fired and forgotten, unlike every other send on
   this rail: the operator pressed a button to find out, so they are
   told what happened, including when it went wrong. */
router.post('/users/:id/wallet/test-sms',
  requireRole('super_admin', 'admin', 'manager'),
  validate(z.object({ phone: z.string().max(20).optional() })),
  async (req, res, next) => {
    try {
      if (!smsConfigured()) {
        throw badRequest('No SMS gateway is configured. Set either the three ' +
          'CELCOM_ settings or AFRICASTALKING_USERNAME and ' +
          'AFRICASTALKING_API_KEY on the API.');
      }

      const wallet = await demo.walletFor(req.params.id);
      if (!wallet) throw notFound('That account has no demo wallet yet');

      const to = req.body.phone || wallet.phone;
      if (!to) {
        throw badRequest('This wallet has no phone number. Add one before testing.', {
          phone: 'Required'
        });
      }

      const out = await sendSms(to, testMessage(wallet.holderName));
      await audit(req, 'wallet.test_sms', req.params.id, {
        to, status: out.status, provider: out.provider || null
      });

      if (!out.ok) {
        events.warn('sms', 'Test message refused: ' + out.detail, {
          userId: req.params.id, context: { to }
        });
      }

      res.json({
        ok: out.ok,
        status: out.status,
        detail: out.detail,
        provider: out.provider || smsProvider(),
        sender: smsSender(),
        to
      });
    } catch (err) { next(err); }
  });

router.delete('/users/:id/wallet',
  requireRole('super_admin', 'admin'),
  async (req, res, next) => {
    try {
      await demo.clearWallet(req.params.id);
      await audit(req, 'wallet.clear', req.params.id, null);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

/* ---------------- copy-trading keys ----------------
   A key switches copy trading on for the one account that redeems it.
   Made here, handed to the customer by whoever is talking to them, and
   spent by POST /copy/activate. VIP accounts make their own through
   /copy/keys; those show here too, made by the VIP's address. */

function publicCopyKey(k, emails) {
  return {
    id: k.id,
    key: k.key,
    note: k.note,
    createdAt: k.created_at,
    createdBy: emails[k.created_by] || null,
    redeemedAt: k.redeemed_at,
    redeemedBy: k.redeemed_by || null,
    redeemedByEmail: emails[k.redeemed_by] || null,
    revokedAt: k.revoked_at,
    status: k.revoked_at ? 'revoked' : k.redeemed_by ? 'used' : 'unused'
  };
}

async function emailsFor(ids) {
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return {};
  const { data } = await admin.from('profiles').select('id,email').in('id', want);
  const map = {};
  (data || []).forEach(p => { map[p.id] = p.email; });
  return map;
}

const KEY_ROLES = ['super_admin', 'admin', 'manager', 'operator'];

router.get('/copy-keys', requireRole(...KEY_ROLES), async (req, res, next) => {
  try {
    const { data, error } = await admin
      .from('copy_keys').select('*')
      .order('created_at', { ascending: false })
      .limit(Math.min(500, Number(req.query.limit) || 200));
    if (error) throw new HttpError(500, 'keys_failed', error.message);

    const rows = data || [];
    const emails = await emailsFor(rows.flatMap(k => [k.created_by, k.redeemed_by]));
    res.json({ ok: true, keys: rows.map(k => publicCopyKey(k, emails)) });
  } catch (err) { next(err); }
});

router.post('/copy-keys',
  requireRole(...KEY_ROLES),
  validate(z.object({
    count: z.coerce.number().int().min(1).max(50).default(1),
    note: z.string().trim().max(200).optional()
  })),
  async (req, res, next) => {
    try {
      const rows = Array.from({ length: req.body.count }, () => ({
        key: newCopyKey(),
        note: req.body.note || null,
        created_by: req.operator.id
      }));
      const { data, error } = await admin.from('copy_keys').insert(rows).select();
      if (error) throw new HttpError(500, 'keys_failed', error.message);

      /* The keys themselves are not audited: the audit trail is read by
         more people than this page is, and a key in it is a key anyone
         reading could spend. */
      await audit(req, 'copy_key.create', null, { count: rows.length, note: req.body.note || null });

      const emails = { [req.operator.id]: req.operator.email };
      res.status(201).json({ ok: true, keys: (data || []).map(k => publicCopyKey(k, emails)) });
    } catch (err) { next(err); }
  });

router.post('/copy-keys/:id/revoke',
  requireRole(...KEY_ROLES),
  async (req, res, next) => {
    try {
      const { data, error } = await admin
        .from('copy_keys')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .is('redeemed_by', null)
        .is('revoked_at', null)
        .select()
        .maybeSingle();
      if (error) throw new HttpError(500, 'keys_failed', error.message);
      if (!data) throw conflict('Only an unused key can be revoked.');

      await audit(req, 'copy_key.revoke', data.id, null);
      res.json({ ok: true, key: publicCopyKey(data, {}) });
    } catch (err) { next(err); }
  });

/* ---------------- system ----------------
   What is up, and what has gone wrong lately. Staff-wide rather than
   admin-only: the person who notices a deposit is not arriving is
   usually the one answering the customer, not the one with the keys. */
router.get('/health', async (req, res, next) => {
  try {
    const services = await checkAll();
    res.json({
      ok: true,
      services,
      app: {
        env: env.NODE_ENV,
        apiUrl: env.API_URL,
        appUrl: env.APP_URL,
        corsOrigins,
        uptimeSeconds: Math.round(process.uptime()),
        minDepositMinor: env.MIN_DEPOSIT_MINOR,
        maxDepositMinor: env.MAX_DEPOSIT_MINOR,
        usdRateKes: env.USD_RATE_KES,
        /* Where the M-Pesa credentials came from, never what they are.
           Two env vars configure the same thing, so which one won is
           worth being able to see. */
        payheroAuth: payheroAuthSource,
        payheroChannel: env.PAYHERO_CHANNEL_ID || null,
        /* Which SMS gateway will be used and why, in the same words the
           boot log prints. Never a key, only where it came from. */
        smsGateway: smsSource,
        smsProvider: smsProvider(),
        smsSender: smsSender(),
        webhooks: {
          paystack: `${env.API_URL}/webhooks/paystack`,
          payhero: payheroCallbackUrl()
        }
      },
      checkedAt: new Date().toISOString()
    });
  } catch (err) { next(err); }
});

/* ---------------- the test bench ----------------
   Send one message to one number, with nothing else attached: no wallet,
   no account, no movement. The console's test page uses this to answer
   "can this deployment text at all", which is a different question from
   "is this customer's handset set up" and needs a different answer when
   it fails.

   Two kinds, and the choice matters before a presentation:
     plain  — says what it is, for checking a key and a number
     mpesa  — the real confirmation wording, for rehearsing the thing an
              audience will actually read

   Rate limited by role rather than by count: this spends real credit,
   and a page with a Run button is a page somebody will lean on. */
router.post('/system/test-sms',
  requireRole('super_admin', 'admin', 'manager'),
  validate(z.object({
    phone: z.string().min(6).max(20),
    kind: z.enum(['plain', 'mpesa']).optional().default('plain'),
    name: z.string().max(80).optional()
  })),
  async (req, res, next) => {
    try {
      if (!smsConfigured()) {
        throw badRequest('No SMS gateway is configured. Set either the three ' +
          'CELCOM_ settings or AFRICASTALKING_USERNAME and ' +
          'AFRICASTALKING_API_KEY on the API.');
      }

      const holder = req.body.name || 'there';
      const message = req.body.kind === 'mpesa'
        /* A sample built here rather than read from a wallet: the test
           must not depend on a customer existing, and the figures are
           obviously round so nobody mistakes the rehearsal for a real
           receipt sitting in a statement. */
        ? messageFor({
            kind: 'DEPOSIT',
            amountMinor: -500000,
            balanceAfterMinor: 4500000,
            reference: demo.demoReference(),
            subtitle: '',
            at: new Date().toISOString()
          }, { holderName: holder }, 0)
        : testMessage(holder);

      const out = await sendSms(req.body.phone, message);

      await audit(req, 'system.test_sms', null, {
        to: req.body.phone, kind: req.body.kind,
        status: out.status, provider: out.provider || null
      });

      if (!out.ok) {
        events.warn('sms', 'Test message from the console was not sent: ' + out.detail, {
          context: { to: req.body.phone, provider: out.provider || null, status: out.status }
        });
      }

      /* Answered 200 even when the gateway refused: the request worked,
         and the refusal is the result being reported. A 500 here would
         reach the page as "that did not work" and throw away the one
         sentence worth reading. */
      res.json({
        ok: out.ok,
        status: out.status,
        detail: out.detail,
        provider: out.provider || smsProvider(),
        sender: smsSender(),
        gateway: smsSource,
        messageId: out.messageId || null,
        to: req.body.phone,
        message
      });
    } catch (err) { next(err); }
  });

router.get('/logs', async (req, res, next) => {
  try {
    const limit = Math.min(200, Number(req.query.limit) || 100);
    let q = admin.from('system_events').select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (req.query.level && req.query.level !== 'all') q = q.eq('level', req.query.level);
    if (req.query.source && req.query.source !== 'all') q = q.eq('source', req.query.source);
    if (req.query.q) q = q.ilike('message', `%${String(req.query.q).slice(0, 80)}%`);

    const { data, error } = await q;
    if (error) throw new HttpError(500, 'logs_failed', error.message);

    res.json({
      ok: true,
      entries: (data || []).map(e => ({
        id: e.id,
        level: e.level,
        source: e.source,
        message: e.message,
        context: e.context,
        reference: e.reference,
        userId: e.user_id,
        at: e.created_at
      }))
    });
  } catch (err) { next(err); }
});

/* ---------------- shapes ---------------- */
function publicUser(u, balances) {
  return {
    id: u.id,
    name: u.display_name || (u.email || '').split('@')[0],
    email: u.email,
    phone: u.phone,
    country: u.country,
    kyc: u.kyc_status,
    status: u.status,
    tier: u.tier || 'standard',
    demoMode: !!u.demo_mode,
    role: u.role,
    referralCode: u.referral_code,
    trades: u.trades_count || 0,
    balanceMinor: balances?.real ?? 0,
    demoMinor: balances?.demo ?? 0,
    joined: u.created_at,
    lastSeen: u.last_seen_at
  };
}

function publicPayment(p, person) {
  return {
    id: p.id,
    reference: p.reference,
    userId: p.user_id,
    userName: person?.display_name || null,
    userEmail: person?.email || null,
    provider: p.provider,
    providerLabel: p.provider === 'payhero' ? 'M-Pesa'
      : p.provider === 'usdt' ? 'USDT'
      : p.provider === 'manual' ? 'Admin credit' : 'Card',
    method: p.provider === 'payhero' ? 'mpesa'
      : p.provider === 'usdt' ? 'usdt'
      : p.provider === 'manual' ? 'manual' : 'card',
    /* Who loaded it and why, for a credit made by hand. */
    note: p.provider === 'manual' ? (p.raw?.note || null) : null,
    creditedBy: p.provider === 'manual' ? (p.raw?.creditedByEmail || null) : null,
    /* The hash is the whole of the evidence on a chain transfer, so it
       goes to the screen where somebody decides whether to credit it. */
    txHash: p.provider === 'usdt' ? (p.raw?.txHash || null) : null,
    network: p.provider === 'usdt' ? (p.raw?.network || null) : null,
    amountMinor: Number(p.amount_minor),
    currency: p.currency,
    creditedMinor: p.credited_minor == null ? null : Number(p.credited_minor),
    status: p.status,
    failureReason: p.failure_reason,
    /* The site it was made through. Older rows, and credits made by
       hand, fall back to the site the account was opened on. */
    site: p.domain_host || person?.domain_host || PRIMARY_HOST,
    created: p.created_at,
    settled: p.settled_at
  };
}

/* One line naming where the money is going, whichever rail it is on.
   The reviewer's screen used to assume a phone number and print a bare
   "+" for anything else, which is worse than nothing on the one screen
   where somebody is about to send money somewhere. */
function destinationLabel(d) {
  if (!d) return '';
  if (d.phone) return '+' + d.phone;
  if (d.account) return [d.bank, d.account, d.name].filter(Boolean).join(' · ');
  if (d.last4) return 'Card •••• ' + d.last4 + (d.name ? ' · ' + d.name : '');
  if (d.address) return (d.network || 'USDT') + ' · ' + d.address;
  if (d.accountNumber) return d.accountNumber + (d.bankCode ? ' · ' + d.bankCode : '');
  return '';
}

function publicWithdrawal(w, person) {
  return {
    id: w.id,
    userId: w.user_id,
    userName: person?.display_name || null,
    userEmail: person?.email || null,
    userKyc: person?.kyc_status || null,
    userStatus: person?.status || null,
    userPhone: person?.phone || null,
    userTrades: person?.trades_count || 0,
    /* A VIP funded from the prop wallet, and whether their wins were
       staged. A reviewer looking at a payout request needs both: the
       amounts look identical either way. */
    userTier: person?.tier || 'standard',
    userDemoMode: !!person?.demo_mode,
    amountMinor: Number(w.amount_minor),
    currency: w.currency,
    method: w.method,
    destination: destinationLabel(w.destination),
    destinationPhone: w.destination?.phone || null,
    status: w.status,
    created: w.created_at,
    settled: w.settled_at
  };
}

export default router;
