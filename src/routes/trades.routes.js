/* ============================================================
   Trade history

   Read and record settled contracts, so a person's history follows them
   between devices instead of living in one browser's localStorage.

   Contracts are still decided in the browser, so a row here is the
   client's account of what happened. It used to stop there — the row was
   recorded and never allowed near a balance — which meant a loss never
   reached the server and a withdrawal was held against the deposit, so
   the business paid out money the customer had already lost.

   Settled trades on the real account now move the balance, through
   settle_trade(), which checks the arithmetic it can check and cannot
   check the one thing that matters most. Read the header of
   sql/014_trade_balance.sql before relying on any of it.

   The list and the record both run as the signed-in user through req.db,
   so row level security enforces "your own" rather than a filter in this
   file that somebody could later forget. The balance movement is the
   exception: it goes through the service role, because a customer's own
   token must never be able to call a function that credits them.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import { admin } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { HttpError } from '../lib/errors.js';
import { events } from '../lib/events.js';
import { publicRun } from './runs.routes.js';

const router = Router();

/* Amounts arrive in minor units, like every other amount in this API. */
const tradeSchema = z.object({
  clientRef: z.string().min(1).max(64),
  accountKind: z.enum(['real', 'demo']).default('demo'),
  symbol: z.string().min(1).max(32),
  symbolName: z.string().max(120).optional(),
  contractType: z.string().min(1).max(32),
  side: z.string().max(32).optional(),
  barrier: z.coerce.number().int().min(0).max(9).nullable().optional(),
  stakeMinor: z.coerce.number().int().min(0),
  payoutMinor: z.coerce.number().int().min(0).default(0),
  profitMinor: z.coerce.number().int(),
  currency: z.string().length(3).default('USD'),
  /* sold: closed before its last tick, for what it was worth then;
     payoutMinor is what it was sold for. Needs sql/018. */
  status: z.enum(['won', 'lost', 'sold']),
  ticks: z.coerce.number().int().min(0).max(100).optional(),
  entrySpot: z.coerce.number().optional(),
  exitSpot: z.coerce.number().optional(),
  openedAt: z.coerce.date(),
  settledAt: z.coerce.date(),
  /* Staged by the presentation mode rather than played on the published
     odds. Tagged so the console's own figures can tell a demonstration
     from the business: a win rate that quietly includes staged wins is a
     number nobody can use. */
  demoMode: z.boolean().optional(),
  /* The automated run this contract was placed by, if any. Its P/L is
     moved by this contract and the run's status comes back in the
     response, which is how the terminal knows whether to carry on. */
  runId: z.string().uuid().optional()
});

function publicTrade(t) {
  return {
    id: t.id,
    ref: t.client_ref,
    account: t.account_kind,
    symbol: t.symbol,
    symbolName: t.symbol_name,
    type: t.contract_type,
    side: t.side,
    barrier: t.barrier,
    stakeMinor: t.stake_minor,
    payoutMinor: t.payout_minor,
    profitMinor: t.profit_minor,
    currency: t.currency,
    status: t.status,
    demoMode: !!t.demo_mode,
    ticks: t.ticks,
    openedAt: t.opened_at,
    settledAt: t.settled_at
  };
}

/* ---------------- list ----------------
   Newest first, paged by cursor rather than offset: a history grows at
   the end being read from, and an offset silently repeats rows when it
   does. */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    let q = req.db
      .from('trades')
      .select('*')
      .order('settled_at', { ascending: false })
      .limit(limit + 1);

    if (req.query.account === 'real' || req.query.account === 'demo') {
      q = q.eq('account_kind', req.query.account);
    }
    if (req.query.before) {
      const before = new Date(req.query.before);
      if (!isNaN(before)) q = q.lt('settled_at', before.toISOString());
    }

    const { data, error } = await q;
    if (error) throw new HttpError(500, 'history_failed', error.message);

    const rows = data || [];
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;

    res.json({
      ok: true,
      trades: page.map(publicTrade),
      /* The cursor is the last row's timestamp: ask for what settled
         before it. */
      nextBefore: more && page.length ? page[page.length - 1].settled_at : null
    });
  } catch (err) { next(err); }
});

/* ---------------- record ----------------
   Accepts one or many. The browser sends a batch on load — everything it
   has that the server has not seen — and one at a time after that.

   Re-sending is expected and harmless: (user_id, client_ref) is unique,
   so a retry over a flaky connection conflicts rather than duplicating,
   and a conflict is reported as success because the row is there, which
   is what the caller wanted. */
router.post('/',
  requireAuth,
  validate(z.object({
    trades: z.array(tradeSchema).min(1).max(200)
  })),
  async (req, res, next) => {
    try {
      const rows = req.body.trades.map(t => ({
        user_id: req.user.id,
        client_ref: t.clientRef,
        account_kind: t.accountKind,
        symbol: t.symbol,
        symbol_name: t.symbolName || null,
        contract_type: t.contractType,
        side: t.side || null,
        barrier: t.barrier ?? null,
        stake_minor: t.stakeMinor,
        payout_minor: t.payoutMinor,
        profit_minor: t.profitMinor,
        currency: t.currency,
        status: t.status,
        ticks: t.ticks ?? null,
        entry_spot: t.entrySpot ?? null,
        exit_spot: t.exitSpot ?? null,
        opened_at: t.openedAt.toISOString(),
        settled_at: t.settledAt.toISOString(),
        demo_mode: !!t.demoMode,
        run_id: t.runId || null
      }));

      /* ignoreDuplicates: a re-send is not an error. */
      const { data, error } = await req.db
        .from('trades')
        .upsert(rows, { onConflict: 'user_id,client_ref', ignoreDuplicates: true })
        .select();

      if (error) throw new HttpError(500, 'record_failed', error.message);

      /* Now the money. Only contracts on the real account, only ones
         this call actually inserted — a re-send returns nothing from the
         upsert above, and settle_trade is idempotent besides, so a
         replay cannot pay the same win twice.

         Applied one at a time rather than in a batch: a contract the
         function refuses is a contract worth naming in the logs, and one
         bad row must not take the rest of somebody's history down with
         it. */
      let balance = null;
      const refused = [];

      /* A real trade from before this account existed cannot be this
         account's. The browser used to send whatever history it held,
         including the last person's on a shared device, and their wins
         landed on this balance. Refused here whatever the browser does. */
      const { data: me } = await admin
        .from('profiles').select('created_at').eq('id', req.user.id).maybeSingle();
      const bornAt = me?.created_at ? new Date(me.created_at).getTime() : null;

      for (const row of (data || [])) {
        if (row.account_kind !== 'real') continue;
        if (bornAt && new Date(row.opened_at).getTime() < bornAt - 60000) {
          refused.push({ ref: row.client_ref, reason: 'TRADE_BEFORE_ACCOUNT' });
          events.warn('trades', 'Refused a real trade from before the account existed', {
            userId: req.user.id,
            context: { clientRef: row.client_ref, openedAt: row.opened_at, accountCreated: me.created_at }
          });
          continue;
        }
        const { data: after, error: moveError } = await admin.rpc('settle_trade', {
          p_user_id: req.user.id,
          p_client_ref: row.client_ref,
          p_type: row.contract_type,
          p_stake_minor: Number(row.stake_minor),
          p_payout_minor: Number(row.payout_minor),
          /* A sale is applied like a win at the price it was sold for:
             payout - stake, which is negative when it was sold below the
             stake. Reporting it as a loss took the whole stake. */
          p_won: row.status === 'won' || row.status === 'sold'
        });

        if (moveError) {
          refused.push({ ref: row.client_ref, reason: moveError.message });
          events.error('trades', 'Trade not applied to the balance: ' + moveError.message, {
            userId: req.user.id,
            context: {
              clientRef: row.client_ref, type: row.contract_type,
              stakeMinor: Number(row.stake_minor), payoutMinor: Number(row.payout_minor),
              status: row.status
            }
          });
          continue;
        }
        balance = after == null ? balance : Number(after);
      }

      /* The runs these contracts belong to. Only rows this call
         inserted, so a re-sent contract never counts towards its run
         twice. Every run touched is reported, including one a re-send
         did not move, so the terminal always gets an answer. */
      const runs = {};
      for (const row of (data || [])) {
        if (!row.run_id) continue;
        const { data: run, error: runError } = await admin.rpc('apply_run_trade', {
          p_run_id: row.run_id,
          p_user_id: req.user.id,
          p_profit_minor: Number(row.profit_minor)
        });
        if (runError) {
          events.warn('runs', 'Trade not applied to its run: ' + runError.message, {
            userId: req.user.id, context: { clientRef: row.client_ref, runId: row.run_id }
          });
          continue;
        }
        runs[row.run_id] = publicRun(Array.isArray(run) ? run[0] : run);
      }
      const asked = [...new Set(req.body.trades.map(t => t.runId).filter(Boolean))]
        .filter(id => !runs[id]);
      if (asked.length) {
        const { data: rest } = await req.db.from('auto_runs').select('*').in('id', asked);
        (rest || []).forEach(r => { runs[r.id] = publicRun(r); });
      }

      res.status(201).json({
        ok: true,
        runs: Object.values(runs),
        recorded: (data || []).length,
        sent: rows.length,
        /* The balance after, so the terminal can correct itself without
           a second round trip. */
        balanceMinor: balance,
        refused: refused.length ? refused : undefined
      });
    } catch (err) { next(err); }
  });

export default router;
