/* ============================================================
   Dependency health

   Answers one question per dependency: can this service talk to it right
   now? Each probe is the cheapest authenticated call that proves the
   whole path — DNS, TLS, credentials — because a check that only pings a
   hostname reports "up" for a service whose keys were rotated yesterday.

   Three states, and the difference matters:
     live   — reachable and the credentials were accepted
     auth   — reachable, credentials refused. A key problem, not an outage.
     down   — did not answer. Usually theirs, sometimes the network.
     off    — not configured here at all.

   Every probe is time-boxed. A hanging dependency must not hang the
   console page that is asking about it.
   ============================================================ */
import { admin } from '../lib/supabase.js';
import { env, payheroToken } from '../config/env.js';
import { checkSms } from './sms.js';

const TIMEOUT_MS = 6000;

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

async function timed(fn) {
  const started = Date.now();
  try {
    const out = await fn();
    return { ...out, ms: Date.now() - started };
  } catch (err) {
    return {
      status: err?.name === 'AbortError' ? 'down' : 'down',
      detail: err?.name === 'AbortError'
        ? `No answer within ${TIMEOUT_MS / 1000}s`
        : (err?.message || 'Unreachable'),
      ms: Date.now() - started
    };
  }
}

/* Supabase: a real query against a real table. select('id', head, count)
   reads no rows but exercises PostgREST, the connection pool and the
   service-role key. */
export function checkSupabase() {
  return timed(async () => {
    const { error, count } = await admin
      .from('profiles')
      .select('id', { count: 'exact', head: true });
    if (error) {
      return {
        status: /jwt|key|unauthor/i.test(error.message) ? 'auth' : 'down',
        detail: error.message
      };
    }
    return { status: 'live', detail: `${count ?? 0} profiles` };
  });
}

/* Paystack: /balance is authenticated, cheap, and returns something an
   operator actually wants to see. A wrong key gives 401, which is a
   different problem from Paystack being down. */
export function checkPaystack() {
  return timed(async () => {
    if (!env.PAYSTACK_SECRET_KEY) return { status: 'off', detail: 'No secret key set' };
    const t = withTimeout(TIMEOUT_MS);
    try {
      const res = await fetch('https://api.paystack.co/balance', {
        headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` },
        signal: t.signal
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) return { status: 'auth', detail: 'Secret key rejected' };
      if (!res.ok) return { status: 'down', detail: body.message || `HTTP ${res.status}` };

      const first = Array.isArray(body.data) ? body.data[0] : null;
      return {
        status: 'live',
        detail: first
          ? `${first.currency} ${(Number(first.balance || 0) / 100).toLocaleString()}`
          : 'Authenticated',
        mode: env.PAYSTACK_SECRET_KEY.startsWith('sk_live') ? 'live' : 'test'
      };
    } finally { t.done(); }
  });
}

/* PayHero: no status endpoint, so ask about a reference that cannot
   exist. Credentials being accepted is the signal — whether the lookup
   finds anything is beside the point. 401/403 means the Basic token is
   wrong; anything else that answers means the service is up. */
export function checkPayhero() {
  return timed(async () => {
    if (!payheroToken) return { status: 'off', detail: 'No API credentials set' };
    const t = withTimeout(TIMEOUT_MS);
    try {
      const res = await fetch(
        `${env.PAYHERO_BASE_URL}/transaction-status?reference=healthcheck-nonexistent`,
        { headers: { Authorization: `Basic ${payheroToken}` }, signal: t.signal }
      );
      if (res.status === 401 || res.status === 403) {
        return { status: 'auth', detail: 'API credentials rejected' };
      }
      if (res.status >= 500) return { status: 'down', detail: `HTTP ${res.status}` };
      return {
        status: 'live',
        detail: env.PAYHERO_CHANNEL_ID
          ? `Channel ${env.PAYHERO_CHANNEL_ID}`
          : 'Authenticated, no channel set'
      };
    } finally { t.done(); }
  });
}

/* Not a dependency — the state of the deposits actually in flight. A
   payment pending for an hour means a callback never arrived, which is
   the failure worth catching early. */
export function checkPayments() {
  return timed(async () => {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const { data, error } = await admin
      .from('payments')
      .select('id,status,created_at')
      .eq('status', 'pending')
      .lt('created_at', hourAgo)
      .limit(50);
    if (error) return { status: 'down', detail: error.message };
    const n = (data || []).length;
    return {
      status: n === 0 ? 'live' : 'warn',
      detail: n === 0 ? 'Nothing stuck' : `${n} pending over an hour`
    };
  });
}

export async function checkAll() {
  const [supabase, paystack, payhero, sms, payments] = await Promise.all([
    checkSupabase(), checkPaystack(), checkPayhero(), checkSms(), checkPayments()
  ]);
  return { supabase, paystack, payhero, sms, payments };
}
