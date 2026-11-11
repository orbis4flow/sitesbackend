/* ============================================================
   Authentication
   The browser holds a Supabase access token.

   requireAuth checks it here, against Supabase's published signing key
   (see lib/jwt.js): no network call, so a signed-in request costs what
   the route costs and nothing more.

   requireAuthStrict asks Supabase every time, so a session signed out
   elsewhere stops working immediately rather than when its token
   expires. It is for the routes where that difference is money or the
   keys to the account: payouts, and changing the password or name.
   ============================================================ */
import { admin, asUser } from '../lib/supabase.js';
import { unauthorized } from '../lib/errors.js';
import { canVerifyLocally, verifyAccessToken } from '../lib/jwt.js';

function bearer(req) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (!token || scheme.toLowerCase() !== 'bearer') return null;
  return token;
}

/* The slow, authoritative check. */
async function askSupabase(token) {
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

/* The fast check, falling back to Supabase only for a token that cannot
   be checked here (a project still signing with a shared secret). */
export async function userForToken(token) {
  if (canVerifyLocally(token)) {
    try {
      return await verifyAccessToken(token);
    } catch (e) {
      /* Expired is a plain answer: not a session. Anything else (a key
         not fetched yet, a claim shaped differently than expected) is
         asked of Supabase rather than refused, so a surprise here can
         only make a request slower, never lock somebody out. */
      if (e && (e.code === 'ERR_JWT_EXPIRED' || e.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED')) return null;
      return askSupabase(token);
    }
  }
  return askSupabase(token);
}

function attach(req, user, token) {
  req.user = user;
  req.accessToken = token;
  req.db = asUser(token);      // reads run under row level security
}

export async function requireAuth(req, _res, next) {
  try {
    const token = bearer(req);
    if (!token) throw unauthorized();
    const user = await userForToken(token);
    if (!user) throw unauthorized('That session has expired. Sign in again.');
    attach(req, user, token);
    next();
  } catch (err) {
    next(err);
  }
}

export async function requireAuthStrict(req, _res, next) {
  try {
    const token = bearer(req);
    if (!token) throw unauthorized();
    const user = await askSupabase(token);
    if (!user) throw unauthorized('That session has expired. Sign in again.');
    attach(req, user, token);
    next();
  } catch (err) {
    next(err);
  }
}

/* Attaches the user when a token is present, but does not demand one. */
export async function optionalAuth(req, _res, next) {
  try {
    const token = bearer(req);
    if (!token) return next();
    const user = await userForToken(token);
    if (user) attach(req, user, token);
    next();
  } catch (err) {
    next();
  }
}
