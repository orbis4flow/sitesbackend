/* ============================================================
   Supabase clients
   Two of them, on purpose:

   admin  - service-role key, bypasses row level security. Used for
            everything that moves money. Must never leave this process.
   asUser - anon key plus the caller's access token, so row level
            security applies. Used when reading a user's own data, which
            means a bug in a filter cannot leak another user's rows.
   ============================================================ */
import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

/* Every call to Supabase has a time limit. Without one, a call that
   stalls on a dead connection holds the request that made it for most of
   a minute, which the customer sees as the app hanging. A read that times
   out or drops is tried once more on a fresh connection; a write is not,
   because a write that timed out may still have happened. */
const TIMEOUT_MS = 12000;

async function fetchWithTimeout(input, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const idempotent = method === 'GET' || method === 'HEAD';

  const attempt = () => {
    const timer = AbortSignal.timeout(TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timer]) : timer;
    return fetch(input, { ...init, signal });
  };

  try {
    return await attempt();
  } catch (err) {
    const callerAborted = init.signal && init.signal.aborted;
    if (!idempotent || callerAborted) throw err;
    return attempt();
  }
}

const base = {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { fetch: fetchWithTimeout }
};

export const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, base);

/* A client with no session, for sign-up / sign-in / reset flows. */
export const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, base);

export function asUser(accessToken) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    ...base,
    global: { fetch: fetchWithTimeout, headers: { Authorization: `Bearer ${accessToken}` } }
  });
}

/* Run a query or rpc for its side effect and never let it throw. Query
   builders from supabase-js are thenables, not Promises, so they have no
   .catch of their own: `admin.rpc(...).catch(...)` is itself a TypeError,
   which used to replace the real error with a 500 on the way out of a
   failed payment. */
export function quietly(query) {
  return Promise.resolve(query).then(r => r, () => null);
}
