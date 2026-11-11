/* ============================================================
   Automated runs

   A run has no fixed number of contracts. It carries on until its
   running profit reaches the target or its running loss reaches the
   stop, and the server keeps that count: the terminal opens a run here,
   records each contract against it through POST /trades with its runId,
   and reads the run's status off that response to know whether to place
   the next one.

   The rules are stored when the run opens, so changing the settings in
   the browser halfway through does not move the goalposts of a run that
   is already going.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import { admin } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { HttpError, notFound } from '../lib/errors.js';

const router = Router();

export function publicRun(r) {
  if (!r) return null;
  return {
    id: r.id,
    account: r.account_kind,
    status: r.status,
    takeProfitMinor: Number(r.take_profit_minor),
    stopLossMinor: Number(r.stop_loss_minor),
    multiplier: Number(r.multiplier),
    baseStakeMinor: Number(r.base_stake_minor),
    trades: r.trades,
    wins: r.wins,
    losses: r.losses,
    pnlMinor: Number(r.pnl_minor),
    startedAt: r.started_at,
    endedAt: r.ended_at
  };
}

/* ---------------- open a run ----------------
   Any run this account still has open is closed first: one terminal,
   one run, and a run left "running" by a closed tab must not keep
   counting contracts that belong to the next one. */
router.post('/',
  requireAuth,
  validate(z.object({
    accountKind: z.enum(['real', 'demo']).default('demo'),
    takeProfitMinor: z.coerce.number().int().min(1).max(100000000),
    stopLossMinor: z.coerce.number().int().min(1).max(100000000),
    multiplier: z.coerce.number().min(1).max(5).default(1),
    baseStakeMinor: z.coerce.number().int().min(1).max(500000)
  })),
  async (req, res, next) => {
    try {
      await admin
        .from('auto_runs')
        .update({ status: 'stopped', ended_at: new Date().toISOString() })
        .eq('user_id', req.user.id)
        .eq('status', 'running');

      const { data, error } = await admin
        .from('auto_runs')
        .insert({
          user_id: req.user.id,
          account_kind: req.body.accountKind,
          take_profit_minor: req.body.takeProfitMinor,
          stop_loss_minor: req.body.stopLossMinor,
          multiplier: req.body.multiplier,
          base_stake_minor: req.body.baseStakeMinor
        })
        .select()
        .single();

      if (error) throw new HttpError(500, 'run_failed', error.message);
      res.status(201).json({ ok: true, run: publicRun(data) });
    } catch (err) { next(err); }
  });

/* ---------------- read one ---------------- */
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await req.db
      .from('auto_runs').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw new HttpError(500, 'run_failed', error.message);
    if (!data) throw notFound('No such run');
    res.json({ ok: true, run: publicRun(data) });
  } catch (err) { next(err); }
});

/* ---------------- stop by hand ----------------
   Only a run that is still going. One that already reached its target
   or stop keeps the reason it ended on. */
router.post('/:id/stop', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await admin
      .from('auto_runs')
      .update({ status: 'stopped', ended_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .eq('status', 'running')
      .select()
      .maybeSingle();
    if (error) throw new HttpError(500, 'run_failed', error.message);

    if (data) return res.json({ ok: true, run: publicRun(data) });

    const { data: row } = await req.db
      .from('auto_runs').select('*').eq('id', req.params.id).maybeSingle();
    if (!row) throw notFound('No such run');
    res.json({ ok: true, run: publicRun(row) });
  } catch (err) { next(err); }
});

export default router;
