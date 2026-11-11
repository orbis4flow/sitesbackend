/* ============================================================
   Sending a text

   One door, two gateways behind it. Everything that wants to send a
   message calls this file and never names a provider, so adding a third
   one later is a line in the list below rather than an edit anywhere
   else.

   The order in that list is the preference, and it is deliberate:

     1. Celcom      — the registered sender ID, the one a demo should go
                      out under
     2. Africa's Talking — a sandbox account can be had in a minute,
                      which makes it what a rail is tested on before the
                      real credentials exist

   So Celcom wins when both are set, Africa's Talking is used when only
   it is, and with neither the rail runs silently. Nothing here ever
   falls back mid-send: a provider that answered and refused has given an
   answer, and quietly re-sending the same message through the other one
   is how a customer gets the same receipt twice.

   Two rules, both learned the hard way on rails like this one:

     * sending must never be the reason a request fails. Every call here
       resolves — a refused SMS is logged, not thrown, because a deposit
       that settled is still a deposit that settled.
     * not configured is a state, not an error. With no credentials this
       reports 'off' and the demo runs in silence, which is what a laptop
       with no .env should do.
   ============================================================ */
import * as celcom from './celcom.js';
import * as africastalking from './africastalking.js';
import { events } from '../lib/events.js';
import { normalisePhone } from '../lib/phone.js';
import { env } from '../config/env.js';

const GATEWAYS = [celcom, africastalking];

/** Whichever is configured, in order of preference. null when none is. */
export function gateway() {
  /* SMS_PROVIDER picks one outright, when that one is set up. */
  const forced = { celcom, africastalking }[env.SMS_PROVIDER];
  if (forced && forced.configured()) return forced;
  return GATEWAYS.find(g => g.configured()) || null;
}

export function smsConfigured() {
  return !!gateway();
}

/** What a message will say it came from, or null when nothing can send. */
export function smsSender() {
  const g = gateway();
  return g ? g.sender() : null;
}

/** 'Celcom' | "Africa's Talking" | null — for the console and the logs. */
export function smsProvider() {
  const g = gateway();
  return g ? g.label : null;
}

/**
 * Send one message to one handset. Never throws.
 *
 * @returns {Promise<{ok, status, detail, provider?, messageId?}>} where
 * status is 'sent', 'off' (nothing configured), 'refused' (a gateway
 * answered and said no) or 'down' (it did not answer).
 */
export async function sendSms(to, message) {
  const g = gateway();
  if (!g) {
    return { ok: false, status: 'off', detail: 'No SMS gateway is configured' };
  }

  /* Normalised once, here, so neither gateway has to guess what shape a
     number arrived in and the two cannot disagree about it. */
  const mobile = normalisePhone(to, 'KE');
  if (!mobile) {
    return { ok: false, status: 'refused', provider: g.label, detail: `Not a phone number: ${to}` };
  }

  const out = await g.send(mobile, String(message || '').slice(0, 900));
  return { ...out, provider: g.label };
}

/**
 * Send, and write the outcome to the event log. The caller gets the
 * result back but is expected to ignore it: this is the fire-and-forget
 * door, used by anything on a money path.
 */
export async function sendSmsLogged(to, message, { userId, reference, what } = {}) {
  const out = await sendSms(to, message);

  if (out.status === 'off') return out;          /* silence is configured */

  if (out.ok) {
    events.info('sms', `Sent ${what || 'a message'} to the handset`, {
      userId, reference,
      context: { to, provider: out.provider, status: out.status, messageId: out.messageId }
    });
  } else {
    events.warn('sms', `Could not send ${what || 'a message'}: ${out.detail}`, {
      userId, reference, context: { to, provider: out.provider, status: out.status }
    });
  }
  return out;
}

/* ---------------- health ----------------
   The gateway that would be used, not every gateway that could be: a
   console tile answers "can this send right now", and a second provider
   nobody is sending through is noise on a page read at 2am. */
export async function checkSms() {
  const started = Date.now();
  const g = gateway();
  if (!g) return { status: 'off', detail: 'No SMS gateway is configured', ms: 0 };

  try {
    const out = await g.check();
    return { ...out, ms: Date.now() - started };
  } catch (err) {
    return {
      status: 'down',
      detail: `${g.label}: ${err?.message || 'Unreachable'}`,
      ms: Date.now() - started
    };
  }
}
