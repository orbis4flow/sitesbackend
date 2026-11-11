/* ============================================================
   Webhooks — the only place a balance is allowed to grow.

   Rules that hold for every handler here:

     * Answer 200 quickly, even on rubbish input. A provider that gets a
       500 retries for hours; a provider that gets a 200 stops. Failures
       we care about are logged, not signalled back.
     * Never trust the body. Paystack's is signed, so it is at least
       authentic — but we still re-verify with the API before crediting.
       PayHero's is not signed at all, so it is treated as a nudge only.
     * Settlement runs inside settle_deposit(), which is idempotent. A
       replayed delivery changes nothing.
   ============================================================ */
import { Router } from 'express';
import { admin } from '../lib/supabase.js';
import { payheroCallbackSecret } from '../config/env.js';
import { events } from '../lib/events.js';
import * as payhero from '../services/payhero.js';
import { reconcile } from './deposits.routes.js';

const router = Router();

/* ---------------- PayHero ----------------
   Authenticated by a secret in the path, because PayHero does not sign
   its callbacks. The body is never trusted for status or amount — it
   only tells us which payment to go and ask about. */
router.post('/payhero/:secret', async (req, res) => {
  if (req.params.secret !== payheroCallbackSecret) {
    req.log?.warn('payhero callback with a bad secret');
    events.warn('payhero', 'Callback rejected: wrong secret in the path', {
      context: { hint: 'the URL in the PayHero dashboard may be stale' }
    });
    return res.status(404).json({ ok: false });
  }

  res.status(200).json({ ok: true });

  try {
    const info = payhero.readCallback(req.body);
    if (!info.reference) {
      req.log?.warn({ body: req.body }, 'payhero callback with no reference');
      return;
    }

    const { data: payment } = await admin
      .from('payments').select('*').eq('reference', info.reference).maybeSingle();

    if (!payment) {
      req.log?.warn({ reference: info.reference }, 'payhero callback for unknown reference');
      events.error('payhero', 'Callback for a reference we have no record of', {
        reference: info.reference
      });
      return;
    }

    await admin.from('payments').update({ raw: req.body }).eq('id', payment.id);
    await reconcile(payment);
  } catch (err) {
    req.log?.error({ err }, 'payhero callback processing failed');
    events.error('payhero', 'Callback processing failed: ' + err.message);
  }
});

export default router;
