/* ============================================================
   Celcom Africa — one SMS gateway

   Credentials in, "was it accepted" out. Nothing here knows what an
   M-Pesa message looks like (that is mpesaSms.js) and nothing here
   decides whether this gateway is the one being used (that is sms.js,
   which holds both providers and picks between them).

   Every gateway in this folder answers the same four questions —
   configured(), sender(), send(), check() — so sms.js can hold them in a
   list and try them in order without knowing one from the other.

   The API is documented at celcomafrica.com. The reply is a JSON
   envelope with a responses[] array, and the code key is spelled
   "response-code" in most of them and "respose-code" in some, which is
   their typo rather than ours, so both are read.
   ============================================================ */
import { env } from '../config/env.js';

export const label = 'Celcom';
const TIMEOUT_MS = 8000;

/* Credentials and a sender ID, or there is nothing to send with. Partial
   configuration counts as none: a half-set gateway that fails on every
   message is worse than one that never tries, and sms.js would rather
   fall through to the other provider than hold a broken one. */
export function configured() {
  return !!(env.CELCOM_API_KEY && env.CELCOM_PARTNER_ID && env.CELCOM_SHORTCODE);
}

export function sender() {
  return env.CELCOM_SHORTCODE || null;
}

/* Their code lives under one of two spellings, and arrives as a string
   as often as a number. */
function codeOf(entry) {
  const raw = entry?.['response-code'] ?? entry?.['respose-code'] ?? entry?.code;
  return Number(raw);
}

/**
 * Send one message to one handset.
 *
 * @param {string} mobile   already normalised by sms.js: 2547xxxxxxxx
 * @param {string} message  the text, as the handset will read it
 * @returns {Promise<{ok:boolean,status:string,detail:string,messageId?:*}>}
 *          status is 'sent', 'refused' (it answered, and said no) or
 *          'down' (it did not answer). Never throws.
 */
export async function send(mobile, message) {
  const body = {
    apikey: env.CELCOM_API_KEY,
    partnerID: env.CELCOM_PARTNER_ID,
    shortcode: env.CELCOM_SHORTCODE,
    mobile,
    message
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${env.CELCOM_BASE_URL}/sendsms/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* handled below */ }

    if (!parsed) {
      return {
        ok: false,
        status: res.ok ? 'refused' : 'down',
        detail: `HTTP ${res.status}: ${text.slice(0, 160) || 'empty reply'}`
      };
    }

    /* A single send still comes back inside the array. */
    const entry = Array.isArray(parsed.responses) ? parsed.responses[0] : parsed;
    const code = codeOf(entry);
    const detail = entry?.['response-description'] ||
                   entry?.['respose-description'] || `code ${code}`;

    if (code === 200) {
      return { ok: true, status: 'sent', detail, messageId: entry?.messageid ?? null };
    }
    /* 1001–1010 are their credential and balance errors; all of them are
       an answer, so none of them is 'down'. */
    return { ok: false, status: 'refused', detail: `${detail} (${code || 'no code'})` };
  } catch (err) {
    return {
      ok: false,
      status: 'down',
      detail: err?.name === 'AbortError'
        ? `No answer within ${TIMEOUT_MS / 1000}s`
        : (err?.message || 'Unreachable')
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- health ----------------
   Celcom publishes no status endpoint, so this asks the delivery-report
   endpoint about a message ID that cannot exist. What is being tested is
   whether the gateway answers and whether it accepts the credentials —
   that the lookup finds nothing is the expected result, not a failure.
   The same shape as the PayHero probe next door, for the same reason. */
export async function check() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${env.CELCOM_BASE_URL}/getdlr/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        apikey: env.CELCOM_API_KEY,
        partnerID: env.CELCOM_PARTNER_ID,
        messageID: '0'
      }),
      signal: controller.signal
    });

    const text = await res.text();

    if (res.status === 401 || res.status === 403) {
      return { status: 'auth', detail: 'API key rejected' };
    }
    if (res.status >= 500) return { status: 'down', detail: `HTTP ${res.status}` };
    if (/invalid.*(api|key|partner)/i.test(text)) {
      return { status: 'auth', detail: 'API key rejected' };
    }
    return { status: 'live', detail: `Celcom, sender ${env.CELCOM_SHORTCODE}` };
  } catch (err) {
    return {
      status: 'down',
      detail: err?.name === 'AbortError'
        ? `No answer within ${TIMEOUT_MS / 1000}s`
        : (err?.message || 'Unreachable')
    };
  } finally {
    clearTimeout(timer);
  }
}
