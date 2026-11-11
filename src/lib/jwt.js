/* ============================================================
   Checking a session token without asking Supabase

   Every signed-in request used to call Supabase Auth to ask whether its
   token was valid: one extra network round trip per request, and with
   no time limit on it, one stalled call could hold a request for most of
   a minute.

   Supabase signs access tokens with a key pair and publishes the public
   half. So the signature, the expiry and the audience can be checked
   here, in about a millisecond, against a key fetched once and cached.

   What that gives up: a token is trusted until it expires (an hour at
   most) even if the session behind it was signed out a minute ago. The
   routes where that matters, payouts and changing a password or name,
   use requireAuthStrict, which still asks Supabase every time.
   ============================================================ */
import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader } from 'jose';
import { env } from '../config/env.js';

const issuer = env.SUPABASE_URL.replace(/\/+$/, '') + '/auth/v1';

/* Fetched on first use and cached; refetched at most every ten minutes
   when a token arrives signed with a key it has not seen (key rotation). */
const jwks = createRemoteJWKSet(new URL(issuer + '/.well-known/jwks.json'), {
  cooldownDuration: 10 * 60 * 1000,
  cacheMaxAge: 60 * 60 * 1000,
  timeoutDuration: 5000
});

/* True when this token can be checked locally at all. A project still on
   a shared secret (HS256) cannot publish its key, so those tokens go the
   old way, through Supabase. */
export function canVerifyLocally(token) {
  try {
    const { alg } = decodeProtectedHeader(token);
    return !!alg && alg !== 'HS256';
  } catch (e) {
    return false;
  }
}

/* Resolves to a user shaped like the one Supabase Auth returns, for the
   fields the routes read: id, email, user_metadata, app_metadata.
   Throws if the token is not valid. */
export async function verifyAccessToken(token) {
  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience: 'authenticated'
  });
  if (!payload.sub) throw new Error('token has no subject');
  return {
    id: payload.sub,
    email: payload.email || null,
    phone: payload.phone || null,
    role: payload.role,
    user_metadata: payload.user_metadata || {},
    app_metadata: payload.app_metadata || {},
    session_id: payload.session_id || null
  };
}
