/* ============================================================
   Withdrawals
   A request holds the funds immediately, then waits for a human.
   Standard withdrawals continue through the normal payout flow.

   VIP demo withdrawals are different:
   - Trading balance is held in USD minor units.
   - The demo handset operates in KES minor units.
   - A fixed demo FX rate converts USD -> KES.
   - No real-money payout is performed on the demo rail.
   ============================================================ */

import { Router } from 'express';
import { z } from 'zod';
import { admin, quietly } from '../lib/supabase.js';
import { requireAuth, requireAuthStrict } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { paymentLimiter } from '../middleware/rateLimit.js';
import {
  badRequest,
  forbidden,
  notFound,
  conflict,
  HttpError
} from '../lib/errors.js';
import { env } from '../config/env.js';
import { formatMinor } from '../lib/money.js';
import { normalisePhone } from '../lib/phone.js';
import { events } from '../lib/events.js';
import * as demo from '../services/mpesaDemo.js';

const router = Router();

/*
 * VIP DEMO FX
 * --------------------------------------------------------------------------
 * The trading account is denominated in USD minor units.
 * The demo handset is denominated in KES minor units.
 *
 * Example:
 *   $10.00 = 1000 USD minor units
 *   1000 × 129 = 129000 KES minor units
 *   129000 / 100 = Ksh1,290.00
 *
 * This is deliberately fixed for the demo so the result is deterministic.
 */
const DEMO_USD_KES_RATE = 129;

/* ============================================================
   Create withdrawal
   ============================================================ */

router.post(
  '/',
  requireAuthStrict,
  paymentLimiter,
  validate(
    z.object({
      amountMinor: z.coerce
        .number()
        .int()
        .refine(
          v => v >= env.MIN_WITHDRAWAL_MINOR,
          `Minimum withdrawal is ${formatMinor(
            env.MIN_WITHDRAWAL_MINOR,
            'USD'
          )}`
        ),

      method: z
        .enum(['mpesa', 'bank', 'card', 'usdt'])
        .default('mpesa'),

      phone: z.string().optional(),

      /* "Pay it to the number on my account." */
      onFile: z.boolean().optional(),

      /* Country selected by the customer. */
      country: z.string().length(2).optional(),

      bank: z
        .object({
          accountName: z.string().min(2),
          accountNumber: z.string().min(4),
          bankCode: z.string().min(2)
        })
        .optional(),

      /*
       * Bank, name and account number.
       * A payout is a transfer into an account, not a reverse card charge.
       */
      card: z
        .object({
          bank: z.string().min(2).max(80),
          name: z.string().min(2).max(80),
          account: z.string().regex(/^[0-9]{6,20}$/)
        })
        .optional(),

      address: z.string().min(20).max(120).optional(),

      network: z.string().max(40).optional()
    })
  ),

  async (req, res, next) => {
    try {
      const { data: profile } = await admin
        .from('profiles')
        .select('kyc_status,country,phone,tier')
        .eq('id', req.user.id)
        .single();

      /*
       * VIP accounts use the presentation-only demo rail.
       *
       * The trading balance is still debited through the normal
       * withdrawal hold, but the corresponding value is credited
       * to the demo handset instead of being sent to a real
       * payment provider.
       */
      if (profile?.tier === 'vip') {
        return withdrawToHandset(req, res, { profile });
      }

      /*
       * Standard accounts require verified identity before withdrawal.
       */
      if (profile?.kyc_status !== 'verified') {
        throw forbidden(
          'Verify your identity before your first withdrawal.'
        );
      }

      let destination;

      /* ----------------------------------------------------------
         M-Pesa
         ---------------------------------------------------------- */

      if (req.body.method === 'mpesa') {
        /*
         * If "onFile" is selected, ignore any phone supplied
         * alongside it and use the account number.
         */
        const asked = req.body.onFile ? null : req.body.phone;

        const phone = normalisePhone(
          asked || profile.phone,
          req.body.country || profile.country || 'KE'
        );

        if (!phone) {
          throw badRequest(
            asked
              ? 'We need the M-Pesa number to pay out to'
              : 'There is no number on your account yet. Add one in Account.',
            {
              phone:
                'Enter the number in full, for example 0712345678'
            }
          );
        }

        destination = { phone };

      /* ----------------------------------------------------------
         Bank/card-style payout
         ---------------------------------------------------------- */

      } else if (req.body.method === 'card') {
        if (!req.body.card) {
          throw badRequest('Tell us where to send it', {
            card:
              'Enter the bank, the name and the account number'
          });
        }

        destination = req.body.card;

      /* ----------------------------------------------------------
         USDT
         ---------------------------------------------------------- */

      } else if (req.body.method === 'usdt') {
        if (!req.body.address) {
          throw badRequest('Enter the wallet address', {
            address:
              'A payout to the wrong address cannot be reversed'
          });
        }

        destination = {
          address: req.body.address,
          network: req.body.network || 'TRC-20'
        };

      /* ----------------------------------------------------------
         Bank
         ---------------------------------------------------------- */

      } else {
        if (!req.body.bank) {
          throw badRequest(
            'Enter the bank account details'
          );
        }

        destination = req.body.bank;
      }

      /*
       * One open withdrawal at a time.
       */
      const { data: existing } = await admin
        .from('withdrawal_requests')
        .select('id')
        .eq('user_id', req.user.id)
        .in('status', ['pending', 'approved'])
        .limit(1);

      if (existing?.length) {
        throw conflict(
          'You already have a withdrawal in progress. It will clear within the hour.'
        );
      }

      /*
       * Standard withdrawal:
       *
       * amountMinor remains USD minor units.
       */
      const { data, error } = await admin.rpc(
        'hold_for_withdrawal',
        {
          p_user_id: req.user.id,
          p_amount_minor: req.body.amountMinor,
          p_method: req.body.method,
          p_destination: destination
        }
      );

      if (error) {
        if (/insufficient funds/i.test(error.message)) {
          throw badRequest(
            'That is more than your available balance',
            {
              amountMinor: 'Not enough funds'
            }
          );
        }

        throw new HttpError(
          400,
          'withdrawal_failed',
          error.message
        );
      }

      const request = Array.isArray(data)
        ? data[0]
        : data;

      return res.status(201).json({
        ok: true,
        request: publicRequest(request),
        message:
          'Requested. Payouts are reviewed and sent within the hour.'
      });

    } catch (err) {
      next(err);
    }
  }
);


/* ============================================================
   VIP DEMO WITHDRAWAL
   ============================================================

   Flow:

   Trading balance
        |
        | USD minor units
        v
   hold_for_withdrawal()
        |
        | fixed demo FX conversion
        v
   KES minor units
        |
        v
   mpesa_demo_move()
        |
        v
   demo handset
        |
        v
   SMS notification

   Example:

   $10.00
      |
      v
   1000 USD minor
      |
      v
   × 129
      |
      v
   129000 KES minor
      |
      v
   Ksh1,290.00
   ============================================================ */

async function withdrawToHandset(req, res, next) {
  /*
   * IMPORTANT:
   *
   * This is the amount denominated in the trading account's
   * currency: USD minor units.
   */
  const usdAmountMinor = req.body.amountMinor;

  /*
   * Convert USD minor units into KES minor units.
   *
   * Because both currencies use 100 minor units per major unit:
   *
   *   USD minor × KES/USD rate = KES minor
   *
   * Example:
   *
   *   1000 × 129 = 129000
   *
   * which represents Ksh1,290.00.
   */
  const kesAmountMinor = Math.round(
    usdAmountMinor * DEMO_USD_KES_RATE
  );

  /* ----------------------------------------------------------
     1. Hold the USD amount on the trading balance.
     ---------------------------------------------------------- */

  const { data, error } = await admin.rpc(
    'hold_for_withdrawal',
    {
      p_user_id: req.user.id,

      /*
       * This MUST remain the original USD amount.
       * The trading ledger is not a KES ledger.
       */
      p_amount_minor: usdAmountMinor,

      p_method: 'mpesa_demo',

      p_destination: {
        rail: 'mpesa_demo'
      }
    }
  );

  if (error) {
    if (/insufficient funds/i.test(error.message)) {
      throw badRequest(
        'That is more than your available balance',
        {
          amountMinor: 'Not enough funds'
        }
      );
    }

    throw new HttpError(
      400,
      'withdrawal_failed',
      error.message
    );
  }

  const request = Array.isArray(data)
    ? data[0]
    : data;

  /* ----------------------------------------------------------
     2. Credit the demo handset in KES.
     ---------------------------------------------------------- */

  let moved;

  try {
    moved = await demo.move({
      userId: req.user.id,

      kind: 'WITHDRAWAL',

      /*
       * IMPORTANT:
       *
       * demo.move() operates on the KES wallet.
       * Therefore we send kesAmountMinor, NOT usdAmountMinor.
       */
      amountMinor: kesAmountMinor,

      direction: 'IN',

      title: `Received from ${env.BRAND_NAME}`,

      subtitle: 'Trading withdrawal'
    });

  } catch (err) {

    /*
     * The USD amount was already held.
     *
     * If the handset cannot be credited, release that USD hold
     * so the customer's trading balance is restored.
     */
    await quietly(
      admin.rpc('release_withdrawal', {
        p_request_id: request.id,
        p_status: 'cancelled',
        p_note:
          'demo rail could not credit the handset'
      })
    );

    events.error(
      'mpesa-demo',
      'Withdrawal failed after the balance was held, released: ' +
        (err.message || 'unknown'),
      {
        userId: req.user.id,

        context: {
          usdAmountMinor,
          kesAmountMinor,
          demoFxRate: DEMO_USD_KES_RATE
        }
      }
    );

    throw err;
  }

  /* ----------------------------------------------------------
     3. Settle the demo withdrawal.
     ---------------------------------------------------------- */

  await quietly(
    admin.rpc('settle_withdrawal', {
      p_request_id: request.id,
      p_actor: null,
      p_note:
        `Paid to the ${env.BRAND_NAME} demo handset`
    })
  );

  /* ----------------------------------------------------------
     4. Log the demo movement.
     ---------------------------------------------------------- */

  events.info(
    'mpesa-demo',
    'VIP withdrawal paid onto the handset',
    {
      userId: req.user.id,

      context: {
        usdAmountMinor,
        kesAmountMinor,
        demoFxRate: DEMO_USD_KES_RATE,
        balanceAfterMinor: moved.balanceMinor
      }
    }
  );

  /* ----------------------------------------------------------
     5. Respond.
     ---------------------------------------------------------- */

  return res.status(201).json({
    ok: true,

    status: 'paid',

    rail: 'demo',

    request: publicRequest(request),

    handset: {
      balanceMinor: moved.balanceMinor,
      fulizaUsedMinor: moved.fulizaUsedMinor
    },

    message:
      `Sent to the ${env.BRAND_NAME} demo handset. It is on the phone now.`
  });
}


/* ============================================================
   List withdrawals
   ============================================================ */

router.get(
  '/',
  requireAuth,
  async (req, res, next) => {
    try {
      const { data } = await req.db
        .from('withdrawal_requests')
        .select('*')
        .order('created_at', {
          ascending: false
        })
        .limit(50);

      res.json({
        ok: true,
        requests: (data || []).map(publicRequest)
      });

    } catch (err) {
      next(err);
    }
  }
);


/* ============================================================
   Get one withdrawal
   ============================================================ */

router.get(
  '/:id',
  requireAuth,
  async (req, res, next) => {
    try {
      const { data } = await req.db
        .from('withdrawal_requests')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();

      if (!data) {
        throw notFound('No such request');
      }

      res.json({
        ok: true,
        request: publicRequest(data)
      });

    } catch (err) {
      next(err);
    }
  }
);


/* ============================================================
   Cancel withdrawal
   ============================================================ */

router.post(
  '/:id/cancel',
  requireAuth,
  async (req, res, next) => {
    try {
      const { data: existing } = await admin
        .from('withdrawal_requests')
        .select('id,user_id,status')
        .eq('id', req.params.id)
        .maybeSingle();

      if (
        !existing ||
        existing.user_id !== req.user.id
      ) {
        throw notFound('No such request');
      }

      if (existing.status !== 'pending') {
        throw conflict(
          'That request is already being processed.'
        );
      }

      const { data, error } = await admin.rpc(
        'release_withdrawal',
        {
          p_request_id: req.params.id,
          p_status: 'cancelled',
          p_note:
            'cancelled by the account holder'
        }
      );

      if (error) {
        throw new HttpError(
          400,
          'cancel_failed',
          error.message
        );
      }

      res.json({
        ok: true,
        request: publicRequest(
          Array.isArray(data)
            ? data[0]
            : data
        )
      });

    } catch (err) {
      next(err);
    }
  }
);


/* ============================================================
   Public withdrawal representation
   ============================================================ */

function publicRequest(r) {
  return {
    id: r.id,
    amountMinor: r.amount_minor,
    currency: r.currency,
    method: r.method,
    status: r.status,
    createdAt: r.created_at,
    settledAt: r.settled_at
  };
}


export default router;