/* ============================================================
   Paystack — card deposits
   Docs: https://paystack.com/docs/api/transaction/

   Two things matter here and nowhere else in the codebase:

   1. Amount is in the currency's minor unit. KES 100 is 10000. Sending
      100 would charge one shilling and nobody would notice until a
      customer complained.
   2. The webhook signature is an HMAC SHA-512 of the RAW request body.
      Parse the body first and the bytes change, the signature fails,
      and every deposit silently stops settling. See webhooks.routes.js
      for the express.raw mounting that keeps this working.
   ============================================================ */
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { upstream } from '../lib/errors.js';

const API = 'https://api.paystack.co';

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
 * Start a card payment. Returns the hosted checkout URL to send the
 * person to; we never see their card number, which keeps this service
 * out of PCI scope.
 */
export async function initializeTransaction({ email, amountMinor, currency, reference, metadata }) {
  return call('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email,
      amount: amountMinor,              // already minor units
      currency,
      reference,
      callback_url: `${env.APP_URL}/index.html?deposit=${encodeURIComponent(reference)}`,
      metadata: metadata || {}
    })
  });
}

/**
 * Send an M-Pesa prompt through Paystack. The fallback for when PayHero
 * cannot: same customer, same amount, same phone.
 * Docs: https://paystack.com/docs/payments/payment-channels/#mobile-money
 *
 * Amount is KES in cents, which is what Paystack wants. The phone goes
 * as +254722000000: their docs say "0722000000 should be sent as
 * +254722000000". (The JSON example on the same page shows it without
 * the plus, and Paystack answered that with "invalid phone number".)
 * Needs a Paystack account for a Kenyan business, charging in KES.
 *
 * Paystack answers "pay_offline" when the prompt is on its way, and the
 * charge settles through the same webhook and verify call a card does.
 */
export async function chargeMpesa({ email, amountMinor, currency, phone, reference, metadata }) {
  const data = await call('/charge', {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      email,
      amount: amountMinor,
      currency: currency || 'KES',
      reference,
      mobile_money: { phone: paystackPhone(phone), provider: 'mpesa' },
      metadata: metadata || {}
    })
  });
  if (data && ['failed', 'abandoned'].includes(String(data.status))) {
    throw upstream(data.gateway_response || data.message || 'M-Pesa declined the request');
  }
  return data;
}

/* Any form of a Kenyan number to +2547XXXXXXXX: 0712.., 712.., 254712..,
   +254712... */
function paystackPhone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('254')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return '+254' + d;
}

/**
 * Ask Paystack what actually happened. The webhook is the trigger, but
 * this is the truth: we re-verify before crediting so a forged or
 * replayed callback cannot invent a successful payment.
 */
export async function verifyTransaction(reference) {
  return call(`/transaction/verify/${encodeURIComponent(reference)}`);
}

/**
 * Constant-time signature check. A plain === leaks timing information
 * about how much of the digest matched.
 */
export function verifySignature(rawBody, signature) {
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha512', env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
