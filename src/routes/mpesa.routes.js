/* ============================================================
   The M-Pesa clone handset

   Everything the companion app calls. The phone has no Supabase session
   and no account: it types a PIN once, is given a device token, and
   presents that token from then on. The token is the whole of its
   identity, which is why it is issued by the database rather than
   derived from anything the phone chooses.

   These routes move a prop balance and nothing else. The trading side of
   the rail lives in deposits.routes.js, where a VIP's deposit is settled
   against this wallet instead of against a real provider.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { badRequest } from '../lib/errors.js';
import { events } from '../lib/events.js';
import * as demo from '../services/mpesaDemo.js';

const router = Router();

/* The gate as middleware, so it runs before validate() rather than
   after it. Ordered the other way, an unlinked caller learns the shape
   of the request body before being told it cannot make one. */
async function handset(req, _res, next) {
  try {
    req.wallet = await demo.requireHandset(req);
    next();
  } catch (err) { next(err); }
}

/* ---------------- link ----------------
   The PIN is the only thing the phone knows. A wrong PIN and an
   unassigned PIN get the same answer, so the endpoint cannot be used to
   discover which PINs exist. Rate limited for the same reason. */
router.post('/link',
  authLimiter,
  validate(z.object({ pin: z.string().regex(/^\d{4}$/, 'Enter the four digit PIN') })),
  async (req, res, next) => {
    try {
      const wallet = await demo.linkByPin(req.body.pin);
      if (!wallet) {
        events.warn('mpesa-demo', 'Handset tried to link with an unknown PIN');
        throw badRequest('That PIN is not recognised.');
      }

      events.info('mpesa-demo', 'Handset linked to a wallet', {
        userId: wallet.userId
      });

      const view = await demo.handsetView(wallet);
      res.json({ ok: true, deviceToken: wallet.deviceToken, account: view });
    } catch (err) { next(err); }
  });

/* ---------------- read ----------------
   One call, because the home screen polls: balance, Fuliza and the
   statement together rather than three round trips on a handset that
   may be on mobile data. */
router.get('/account', handset, async (req, res, next) => {
  try {
    res.json({ ok: true, account: await demo.handsetView(req.wallet) });
  } catch (err) { next(err); }
});

/* ---------------- agent withdrawal ----------------
   Money leaving the phone at an agent. Nothing on the trading side
   moves: this is the handset spending its own balance, which is what
   makes a later deposit from it meaningful. */
router.post('/agent-withdraw',
  handset,
  validate(z.object({
    amountMinor: z.coerce.number().int().positive(),
    agent: z.string().max(60).optional()
  })),
  async (req, res, next) => {
    try {
      const wallet = req.wallet;
      const { amountMinor, agent } = req.body;

      const out = await demo.move({
        userId: wallet.userId,
        kind: 'AGENT_WITHDRAWAL',
        amountMinor,
        direction: 'OUT',
        title: 'Withdraw at agent',
        subtitle: agent || 'Agent withdrawal'
      });

      res.json({ ok: true, ...out, account: await demo.handsetView(await demo.walletFor(wallet.userId)) });
    } catch (err) { next(err); }
  });

/* ---------------- receive ----------------
   Money arriving on the phone, so a demo can show a wallet being topped
   up rather than only spent. Fuliza is repaid first, inside the
   database function. */
router.post('/receive',
  handset,
  validate(z.object({
    amountMinor: z.coerce.number().int().positive(),
    from: z.string().max(60).optional()
  })),
  async (req, res, next) => {
    try {
      const wallet = req.wallet;
      const { amountMinor, from } = req.body;

      const out = await demo.move({
        userId: wallet.userId,
        kind: 'RECEIVE',
        amountMinor,
        direction: 'IN',
        title: 'Received money',
        subtitle: from || 'Deposit'
      });

      res.json({ ok: true, ...out, account: await demo.handsetView(await demo.walletFor(wallet.userId)) });
    } catch (err) { next(err); }
  });

/* ---------------- reset ----------------
   Between rehearsals: back to the opening balance with an empty
   statement and no overdraft. The device token survives, so the handset
   stays linked and nobody has to re-enter a PIN on stage. */
router.post('/reset',
  handset,
  validate(z.object({
    balanceMinor: z.coerce.number().int().min(0).optional()
  })),
  async (req, res, next) => {
    try {
      const fresh = await demo.resetWallet(req.wallet.userId, req.body.balanceMinor ?? null);
      res.json({ ok: true, account: await demo.handsetView(fresh) });
    } catch (err) { next(err); }
  });

export default router;
