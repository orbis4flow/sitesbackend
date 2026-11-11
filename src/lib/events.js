/* ============================================================
   System events
   The log the console reads. Writing one must never be the reason a
   request fails — every call here swallows its own errors — and it must
   never be the reason a secret leaks, so context is filtered on the way
   in rather than trusted at the call site.

   What belongs here: things an operator would act on. A refused origin,
   a provider that timed out, a webhook that failed its signature, a
   deposit that could not be recorded. Not request logs; those are on
   stdout and nobody reads them twice.
   ============================================================ */
import { admin } from './supabase.js';

/* Anything whose name suggests a credential is dropped rather than
   redacted, so a later reader cannot mistake a redaction for a value
   that was never there. Long strings are trimmed: a whole provider
   payload in a log line is how a card number ends up in a database. */
const SECRET = /(key|secret|token|password|authorization|signature|pin)/i;

function clean(value, depth) {
  if (value == null) return value;
  if (typeof value === 'string') return value.length > 500 ? value.slice(0, 500) + '…' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 3) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 20).map(v => clean(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET.test(k)) continue;
      out[k] = clean(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Record an event. Never throws, never awaits anything the caller needs.
 *
 * @param {'info'|'warn'|'error'} level
 * @param {string} source    'paystack' | 'payhero' | 'deposits' | 'cors' | ...
 * @param {string} message   one line, written for whoever reads it at 2am
 * @param {object} [extra]   { context, userId, reference }
 */
export function logEvent(level, source, message, extra = {}) {
  const row = {
    level,
    source,
    message: String(message || '').slice(0, 500),
    context: extra.context ? clean(extra.context, 0) : null,
    user_id: extra.userId || null,
    reference: extra.reference || null
  };

  admin.from('system_events').insert(row).then(
    ({ error }) => { if (error) console.error('system_events insert failed:', error.message); },
    err => console.error('system_events insert threw:', err?.message)
  );
}

export const events = {
  info: (source, message, extra) => logEvent('info', source, message, extra),
  warn: (source, message, extra) => logEvent('warn', source, message, extra),
  error: (source, message, extra) => logEvent('error', source, message, extra)
};
