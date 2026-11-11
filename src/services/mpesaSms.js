

import crypto from 'node:crypto';
import { sendSmsLogged, smsConfigured } from './sms.js';
import { events } from '../lib/events.js';
import { env } from '../config/env.js';

/* Trading side of the demo rail. */
const BRAND = env.BRAND_NAME;
const MERCHANT = `${BRAND} Markets Ltd`;
const SIGN_OFF = 'Amount  you can transact within the day is 489,800.00. Sell all your balances now https://saf.to/7Kp2x';

/* Format minor units as Kenyan shillings.
   Example: 400000 -> Ksh4,000.00 */
function kes(minor) {
  return 'Ksh' + (Number(minor || 0) / 100).toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

/*
 * Compact Kenyan-style timestamp.

 * Example:
 * 25/9/26 at 5:15 AM
 *
 * Always uses Nairobi time regardless of server timezone.
 */
function stamp(at) {
  const when = at ? new Date(at) : new Date();

  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    day: 'numeric',
    month: 'numeric',
    year: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  })
    .formatToParts(when)
    .reduce((acc, x) => {
      acc[x.type] = x.value;
      return acc;
    }, {});

  return `${p.day}/${p.month}/${p.year} at ${p.hour}:${p.minute} ${p.dayPeriod.toUpperCase()}`;
}

/*
 * transaction reference.

 * Starts with U to give the demo a familiar transaction-reference
 * appearance while remaining our own reference.

 * Same transaction -> same reference.
 */
function novRef(tx) {
  const seed = String(
    tx.reference ||
    tx.id ||
    tx.at ||
    Date.now()
  );

  return (
    'U' +
    crypto
      .createHash('sha1')
      .update(seed)
      .digest('hex')
      .slice(0, 10)
      .toUpperCase()
  );
}

/*
 * 254712345678 -> 071****678
 * 0712345678   -> 071****678
 */
function maskedNumber(phone) {
  const d = String(phone || '').replace(/\D/g, '');

  if (d.length < 9) return '';

  const local = d.startsWith('254')
    ? '0' + d.slice(3)
    : d;

  return local.slice(0, 3) + '****' + local.slice(-3);
}

/*
 * Extract first name from wallet holder.
 */
function firstName(wallet) {
  const n = String(
    wallet?.holderName ||
    wallet?.name ||
    ''
  )
    .trim()
    .split(/\s+/)[0];

  if (!n || /m-?pesa/i.test(n)) {
    return 'Customer';
  }

  return n;
}

/*
 * Overdraft information, if applicable.
 */
function overdraftLine(usedMinor) {
  if (!usedMinor || usedMinor <= 0) {
    return '';
  }

  return ` Overdraft outstanding is ${kes(usedMinor)}.`;
}

/**
 * Generate the SMS for one wallet transaction.
 *
 * Example RECEIVE:
 *
 * U7A31F8C92D Confirmed. You have received Ksh4,000.00
 * from Julius Lokorono 071****582 on 25/9/26 at 5:15 AM.
 * ${BRAND} Wallet balance is Ksh4,000.00. Trade smart with Kivo.
 *
 * @param {object} tx
 * @param {object} wallet
 * @param {number} fulizaUsedMinor
 */
export function messageFor(
  tx,
  wallet,
  fulizaUsedMinor = 0
) {
  const reference = novRef(tx);
  const when = stamp(tx.at);
  const amount = kes(Math.abs(tx.amountMinor));
  const balance = kes(tx.balanceAfterMinor);
  const owed = overdraftLine(fulizaUsedMinor);

  const number = maskedNumber(wallet?.phone);
  const from = (tx.subtitle || '').trim();

  switch (tx.kind) {

    /*
     * Money leaving ${BRAND} Wallet for the trading account.
     */

    case 'DEPOSIT':
      return (
        `${reference} Confirmed. ` +
        `${amount} sent to ${MERCHANT}` +
        `${number ? ` from ${number}` : ''} ` +
        `on ${when}. ` +
        `New M-PESA balance is ${balance}.` +
        `${owed} ${SIGN_OFF}`
      );

    /*
     * Money coming back from the trading account.
     */
    case 'WITHDRAWAL':
      return (
        `${reference} Confirmed. ` +
        `You have received ${amount}  ` +
        `from ${MERCHANT} on ${when}. ` +
        `New M-PESA balance is ${balance}.` +
        `${owed} ${SIGN_OFF}`
      );

    /*
     * Money received from another person.
     */
    case 'RECEIVE':
      return (
        `${reference} Confirmed. ` +
        `You have received ${amount} from ` +
        `${from || 'a sender'}` +
        `${number ? ` ${number}` : ''} ` +
        `on ${when}. ` +
        `${BRAND} Wallet balance is ${balance}.` +
        `${owed} ${SIGN_OFF}`
      );

    /*
     * Cash withdrawn at an agent.
     */
    case 'AGENT_WITHDRAWAL':
      return (
        `${reference} Confirmed. ` +
        `You have withdrawn ${amount} from your ${BRAND} Wallet ` +
        `at ${from || 'an agent'} on ${when}. ` +
        `${BRAND} Wallet balance is ${balance}.` +
        `${owed} ${SIGN_OFF}`
      );

    /*
     * Failed payment returned to wallet.
     */
    case 'REVERSAL':
      return (
        `${reference} Reversed. ` +
        `Your payment of ${amount} to ${MERCHANT} ` +
        `could not be completed and has been returned ` +
        `to your ${BRAND} Wallet on ${when}. ` +
        `${BRAND} Wallet balance is ${balance}.` +
        `${owed} ${SIGN_OFF}`
      );

    /*
     * Overdraft repayment.
     */
    case 'FULIZA_REPAY':
      return (
        `${reference} Confirmed. ` +
        `${amount} of your ${BRAND} Wallet overdraft ` +
        `has been repaid on ${when}. ` +
        `${BRAND} Wallet balance is ${balance}.` +
        `${owed} ${SIGN_OFF}`
      );

    /*
     * Fallback for unknown transaction types.
     */
    default:
      return (
        `${reference} Confirmed. ` +
        `${amount} has moved on your ${BRAND} Wallet ` +
        `on ${when}. ` +
        `${BRAND} Wallet balance is ${balance}.` +
        `${owed} ${SIGN_OFF}`
      );
  }
}

/**
 * Send the notification after the wallet movement succeeds.
 *
 * The SMS failing must NOT reverse the transaction.
 */
export async function notifyMovement(wallet, moved) {
  try {
    if (!smsConfigured()) {
      return {
        ok: false,
        status: 'off'
      };
    }

    if (!wallet?.phone) {
      events.warn(
        'sms',
        'No number on this demo wallet, nothing sent',
        {
          userId: wallet?.userId,
          reference: moved?.tx?.reference
        }
      );

      return {
        ok: false,
        status: 'off',
        detail: 'Wallet has no phone number'
      };
    }

    return await sendSmsLogged(
      wallet.phone,

      messageFor(
        moved.tx,
        wallet,
        moved.fulizaUsedMinor
      ),

      {
        userId: wallet.userId,
        reference: moved.tx.reference,
        what: `a ${BRAND} Wallet ${String(
          moved.tx.kind
        ).toLowerCase()} text`
      }
    );

  } catch (err) {

    /*
     * SMS failure must never bring down the demo
     * or undo a completed wallet transaction.
     */
    events.error(
      'sms',
      'Wallet text threw: ' +
        (err?.message || 'unknown'),
      {
        userId: wallet?.userId
      }
    );

    return {
      ok: false,
      status: 'down',
      detail: err?.message || 'unknown'
    };
  }
}

/*
 * Test SMS sent by an operator.

 * This is not a transaction.
 */
export function testMessage(name) {
  const first =
    String(name || '')
      .trim()
      .split(/\s+/)[0] || 'Customer';

  return (
    `${BRAND} Wallet test. Dear ${first}, ` +
    `your ${BRAND} Wallet SMS notifications are set up ` +
    `and will arrive on this number.`
  );
}

export { MERCHANT };