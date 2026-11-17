/* ============================================================
   Paystack — card deposits, through Paystack Inline
   Docs: https://paystack.com/docs/payments/accept-payments/

   The server opens each transaction with the secret key and hands the
   browser only its access code. The browser opens Paystack's own popup
   with that code, so the card number and CVV are typed into Paystack's
   frame and never reach this service or the site. Nothing is credited
   from the browser: the webhook and verifyTransaction() decide.

   Two things matter here:
   1. Amount is in the currency's minor unit. KES 100 is 10000.
   2. The webhook signature is an HMAC SHA-512 of the RAW request body,
      which is why server.js mounts express.raw for /webhooks/paystack.
   ============================================================ */
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { upstream } from '../lib/errors.js';

const API = 'https://api.paystack.co';

/* Card deposits are off until a secret key is set on the service. */
export function configured() {
  return !!env.PAYSTACK_SECRET_KEY;
}

async function call(path, options = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
  } catch (cause) {
    throw upstream('Could not reach Paystack');
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status === false) {
    throw upstream(body.message || `Paystack returned ${res.status}`);
  }
  return body.data;
}

/**
 * Open a card transaction. Returns { access_code, reference, ... }; the
 * access code is what the browser resumes in the Paystack popup.
 */
export async function initializeTransaction({ email, amountMinor, currency, reference, metadata }) {
  return call('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email,
      amount: amountMinor,              // already minor units
      currency,
      reference,
      channels: ['card'],
      metadata: metadata || {}
    })
  });
}

/**
 * Ask Paystack what actually happened. The webhook is the trigger, but
 * this is the truth: re-verified before crediting, so a forged or
 * replayed callback cannot invent a successful payment.
 */
export async function verifyTransaction(reference) {
  return call(`/transaction/verify/${encodeURIComponent(reference)}`);
}

/** Constant-time signature check. */
export function verifySignature(rawBody, signature) {
  if (!signature || !env.PAYSTACK_SECRET_KEY) return false;
  const expected = crypto
    .createHmac('sha512', env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
