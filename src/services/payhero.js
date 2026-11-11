/* ============================================================
   PayHero — M-Pesa STK push
   Docs: https://payhero.co.ke (dashboard → API)

   PayHero authenticates with HTTP Basic: base64(api_username:api_password).

   IMPORTANT: unlike Paystack, PayHero does not sign its callbacks. There
   is nothing in the payload that proves it came from them. Two things
   compensate, and both matter:

     1. The callback URL carries a secret path token, derived from a key
        only this server holds, that only we and PayHero know. A caller
        without it is rejected.
     2. We never trust the amount or status in the callback body. It is
        treated purely as a nudge to go and ask PayHero what happened,
        and the answer from that query is what settles the payment.

   Amounts: PayHero takes whole shillings, NOT cents. Everything else in
   this codebase is in minor units, so the conversion happens here and
   is the only place it should ever happen.
   ============================================================ */
import { env, payheroToken, payheroCallbackSecret } from '../config/env.js';
import { upstream } from '../lib/errors.js';

async function call(path, options = {}) {
  if (!payheroToken) {
    throw upstream('M-Pesa is not configured on this server');
  }

  let res;
  try {
    res = await fetch(`${env.PAYHERO_BASE_URL}${path}`, {
      ...options,
      headers: {
        Authorization: `Basic ${payheroToken}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
  } catch (cause) {
    /* Too slow is worth telling apart from unreachable: a push that
       timed out may still reach the phone, so its payment row is left
       open rather than failed. */
    if (cause && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) {
      const err = upstream('The M-Pesa provider took too long to answer');
      err.timedOut = true;
      throw err;
    }
    throw upstream('Could not reach the M-Pesa provider');
  }

  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }

  if (!res.ok) {
    throw upstream(body.error_message || body.message || `PayHero returned ${res.status}`);
  }

  /* A 200 is not a yes. PayHero answers a refused request with HTTP 200
     and success:false in the body, so trusting the status code alone
     means telling somebody to check their phone for a prompt that was
     never sent — and they wait, and nothing ever arrives, and there is
     no error anywhere to explain it. */
  if (body && body.success === false) {
    throw upstream(body.error_message || body.message || 'M-Pesa refused the request');
  }
  return body;
}

/**
 * Send the STK prompt to the customer's handset.
 *
 * @param {string} phone      254XXXXXXXXX
 * @param {number} amountMinor  cents — converted to shillings here
 * @param {string} reference  our reference, echoed back on the callback
 */
export async function stkPush({ phone, amountMinor, reference, name }) {
  const amount = Math.round(amountMinor / 100);   // PayHero wants shillings
  const channelId = Number(env.PAYHERO_CHANNEL_ID);

  /* Without a channel there is no account for the money to land in.
     PayHero has been known to accept the request anyway and do nothing
     with it, which is the worst possible answer, so refuse it here. */
  if (!channelId) {
    throw upstream('M-Pesa is not finished being set up on this server');
  }

  const body = await call('/payments', {
    method: 'POST',
    signal: AbortSignal.timeout(env.PAYHERO_PUSH_TIMEOUT_MS),
    body: JSON.stringify({
      amount,
      phone_number: phone,
      channel_id: channelId,
      provider: 'm-pesa',
      external_reference: reference,
      customer_name: name || undefined,
      callback_url: callbackUrl()
    })
  });

  /* Accepted means they gave us something to track it by. A response
     with no handle in it is not a queued push, whatever it says. */
  const handle = body?.CheckoutRequestID || body?.checkout_request_id ||
                 body?.reference || body?.transaction_reference;
  const status = String(body?.status || '').toUpperCase();

  if (!handle && !['QUEUED', 'PENDING', 'SUCCESS'].includes(status)) {
    throw upstream(body?.error_message || body?.message ||
      'M-Pesa did not accept the request');
  }
  if (['FAILED', 'CANCELLED', 'CANCELED'].includes(status)) {
    throw upstream(body?.error_message || 'M-Pesa declined the request');
  }

  return body;
}

/**
 * The authoritative answer. Called after a callback arrives, and also by
 * the reconcile job for payments whose callback never showed up — mobile
 * money callbacks do get lost, and a deposit that silently never lands
 * is the worst failure this system can have.
 */
export async function transactionStatus(reference) {
  return call(`/transaction-status?reference=${encodeURIComponent(reference)}`);
}

/**
 * The same question, asked with each handle we hold for the payment.
 *
 * This exists because "reference" means two different things. We send
 * PayHero an external_reference of our own (MP-xxxx) and they hand back
 * a CheckoutRequestID of theirs, and which one /transaction-status wants
 * has not been consistent. Asking with ours alone is how a payment the
 * customer actually made sits pending forever: the lookup finds nothing,
 * nothing is settled, and no error is raised because "not found" is a
 * perfectly good answer to a question about the wrong reference.
 *
 * Returns the first answer that names a status, and the handle that got
 * it, so the log can say which one worked.
 */
export async function findTransaction(payment) {
  const handles = [payment.provider_ref, payment.reference]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);

  let lastError = null;

  for (const handle of handles) {
    let body;
    try {
      body = await transactionStatus(handle);
    } catch (err) {
      lastError = err;
      continue;
    }
    const info = readCallback(body);
    if (info.status) return { body, info, handle };
  }

  if (lastError) throw lastError;
  return { body: null, info: null, handle: null };
}

export function callbackUrl() {
  return `${env.API_URL}/webhooks/payhero/${payheroCallbackSecret}`;
}

/**
 * PayHero's payload shape has varied between accounts and versions, so
 * pull the few fields we need defensively rather than assuming one
 * layout. Everything here is a hint only — status is confirmed by
 * transactionStatus() before any money moves.
 */
export function readCallback(body) {
  const r = body?.response || body?.data || body || {};
  return {
    reference: r.ExternalReference || r.external_reference || r.reference || null,
    providerRef: r.MpesaReceiptNumber || r.mpesa_receipt_number ||
                 r.third_party_reference || r.provider_reference ||
                 r.CheckoutRequestID || r.transaction_reference || null,
    /* transaction-status answers with transaction_status or Status
       depending on the account; the callback uses Status. Take whichever
       is present. */
    status: String(r.Status || r.status ||
                   r.transaction_status || r.TransactionStatus || '').toLowerCase(),
    amount: r.Amount ?? r.amount ?? null,
    phone: r.Phone || r.phone_number || null
  };
}

/* Deliberately a list and not a pattern. Money moves on a match here, so
   a word PayHero starts using that we do not know should leave a payment
   unsettled and an entry in the log — which a person reads and adds —
   rather than being swept in by a regex that also matches
   "unsuccessful". */
export function isSuccess(status) {
  return ['success', 'completed', 'successful', 'complete', 'paid']
    .includes(String(status || '').toLowerCase());
}

export function isFailure(status) {
  return ['failed', 'failure', 'cancelled', 'canceled', 'timeout',
          'expired', 'reversed', 'declined', 'unsuccessful']
    .includes(String(status || '').toLowerCase());
}
