/* ============================================================
   Copy trading

   Switched on per account with a key staff issue from the console.
   The key is checked, spent and the account flagged in one database
   transaction (redeem_copy_key in sql/015), so the same key cannot be
   used twice however the requests race.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { admin } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { events } from '../lib/events.js';
import { newCopyKey } from '../lib/copyKey.js';

const router = Router();

/* A key is short enough to guess at, so guessing is made slow. Keyed by
   IP here; the route below also needs a signed-in account. */
const keyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many attempts. Try again shortly.' } }
});

router.post('/activate',
  keyLimiter,
  requireAuth,
  validate(z.object({ key: z.string().trim().min(4).max(64) })),
  async (req, res, next) => {
    try {
      const { error } = await admin.rpc('redeem_copy_key', {
        p_user_id: req.user.id,
        p_key: req.body.key
      });

      if (error) {
        const msg = error.message || '';
        if (msg.includes('KEY_USED')) {
          throw conflict('That key has already been used on another account.', { key: 'Already used' });
        }
        if (msg.includes('KEY_INVALID')) {
          throw badRequest('That key is not valid. Check it and try again.', { key: 'Not valid' });
        }
        throw new HttpError(500, 'activate_failed', msg);
      }

      events.info('copy', 'Copy trading activated with a key', { userId: req.user.id });
      res.json({ ok: true, copyActive: true });
    } catch (err) { next(err); }
  });

/* Whether this account has copy trading on. /auth/session carries the
   same flag; this is for a page that only needs this one fact. */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await req.db
      .from('profiles').select('copy_active,tier').eq('id', req.user.id).single();
    if (error) throw new HttpError(500, 'copy_failed', error.message);
    /* VIP accounts hand out the keys, so they never need one. */
    res.json({ ok: true, copyActive: !!data?.copy_active || data?.tier === 'vip' });
  } catch (err) { next(err); }
});

/* ---------------- a VIP's own keys ----------------
   VIP accounts hand out copy-trading keys of their own. Each works once,
   on one account, like a key made in the console. A VIP always has one
   ready: if every key they made has been used, a fresh one is made the
   next time they look. */
const VIP_UNUSED_MAX = 5;
const makeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many attempts. Try again shortly.' } }
});

async function requireVip(req) {
  const { data } = await admin
    .from('profiles').select('tier').eq('id', req.user.id).maybeSingle();
  if (data?.tier !== 'vip') throw forbidden('Copy-trading keys are for VIP accounts.');
}

function myKey(k) {
  return {
    id: k.id,
    key: k.key,
    createdAt: k.created_at,
    redeemedAt: k.redeemed_at,
    status: k.revoked_at ? 'revoked' : k.redeemed_by ? 'used' : 'unused'
  };
}

async function listMine(userId) {
  const { data, error } = await admin
    .from('copy_keys').select('*')
    .eq('created_by', userId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new HttpError(500, 'keys_failed', error.message);
  return data || [];
}

async function makeKey(userId) {
  const { data, error } = await admin
    .from('copy_keys')
    .insert({ key: newCopyKey(), note: 'VIP key', created_by: userId })
    .select().single();
  if (error) throw new HttpError(500, 'keys_failed', error.message);
  return data;
}

function summary(rows) {
  return {
    keys: rows.filter(k => !k.revoked_at).slice(0, 20).map(myKey),
    activated: rows.filter(k => k.redeemed_by).length
  };
}

router.get('/keys', requireAuth, async (req, res, next) => {
  try {
    await requireVip(req);
    let rows = await listMine(req.user.id);
    /* One ready to share when every key has been used, but not straight
       after the VIP deactivated their last one: they asked for it gone,
       and a new one appearing in its place would undo that. */
    const latest = rows[0];
    if (!rows.some(k => !k.redeemed_by && !k.revoked_at) && !(latest && latest.revoked_at)) {
      rows = [await makeKey(req.user.id), ...rows];
    }
    res.json({ ok: true, ...summary(rows) });
  } catch (err) { next(err); }
});

router.post('/keys', makeLimiter, requireAuth, async (req, res, next) => {
  try {
    await requireVip(req);
    const rows = await listMine(req.user.id);
    const unused = rows.filter(k => !k.redeemed_by && !k.revoked_at).length;
    if (unused >= VIP_UNUSED_MAX) {
      throw conflict('You have ' + unused + ' unused keys. Share those before making more.');
    }
    const made = await makeKey(req.user.id);
    events.info('copy', 'VIP made a copy-trading key', { userId: req.user.id });
    res.status(201).json({ ok: true, key: myKey(made), ...summary([made, ...rows]) });
  } catch (err) { next(err); }
});

/* ---------------- regenerate and deactivate ----------------
   Both only on a key this VIP made that nobody has used yet. A used key
   has done its job: the account that entered it keeps copy trading, and
   taking it away is a decision for the console, not for whoever shared
   the key. */
async function ownUnused(req) {
  const { data, error } = await admin
    .from('copy_keys').select('*')
    .eq('id', req.params.id)
    .eq('created_by', req.user.id)
    .maybeSingle();
  if (error) throw new HttpError(500, 'keys_failed', error.message);
  if (!data) throw notFound('No such key');
  if (data.revoked_at) throw conflict('That key is already deactivated.');
  if (data.redeemed_by) throw conflict('That key has already been used, so it cannot be changed.');
  return data;
}

/* A new code in place of the old one. The old code stops working the
   moment this returns, which is the point: a key shown on a shared
   screen can be made useless without losing its place in the list. The
   update is conditional on the key still being unused, so it cannot race
   somebody redeeming it. */
router.post('/keys/:id/regenerate', makeLimiter, requireAuth, async (req, res, next) => {
  try {
    await requireVip(req);
    await ownUnused(req);
    const { data, error } = await admin
      .from('copy_keys')
      .update({ key: newCopyKey(), created_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('created_by', req.user.id)
      .is('redeemed_by', null)
      .is('revoked_at', null)
      .select().maybeSingle();
    if (error) throw new HttpError(500, 'keys_failed', error.message);
    if (!data) throw conflict('That key was used a moment ago, so it was not changed.');

    events.info('copy', 'VIP regenerated a copy-trading key', { userId: req.user.id });
    res.json({ ok: true, key: myKey(data), ...summary(await listMine(req.user.id)) });
  } catch (err) { next(err); }
});

router.post('/keys/:id/deactivate', makeLimiter, requireAuth, async (req, res, next) => {
  try {
    await requireVip(req);
    await ownUnused(req);
    const { data, error } = await admin
      .from('copy_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('created_by', req.user.id)
      .is('redeemed_by', null)
      .is('revoked_at', null)
      .select().maybeSingle();
    if (error) throw new HttpError(500, 'keys_failed', error.message);
    if (!data) throw conflict('That key was used a moment ago, so it was not deactivated.');

    events.info('copy', 'VIP deactivated a copy-trading key', { userId: req.user.id });
    res.json({ ok: true, ...summary(await listMine(req.user.id)) });
  } catch (err) { next(err); }
});

export default router;
