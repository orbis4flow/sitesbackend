/* ============================================================
   Money
   Everything is an integer number of minor units. Conversions happen
   once, here, so there is a single place to check when a figure looks
   wrong.
   ============================================================ */
import { env } from '../config/env.js';

export function toMinor(amount) {
  return Math.round(Number(amount) * 100);
}

export function fromMinor(minor) {
  return Number(minor) / 100;
}

export function formatMinor(minor, currency = 'KES') {
  return `${(Number(minor) / 100).toFixed(2)} ${currency}`;
}

/* Local currency in, trading balance (USD) out. A fixed rate is fine for
   launch, but swap this for a rates feed before volumes grow — a stale
   rate is a slow leak in one direction or the other. */
/* USDT is quoted one for one with the dollar. It is written here rather
   than assumed at the call site, so a rail added later cannot silently
   fall through to the shilling rate. */
const RATES = { KES: () => env.USD_RATE_KES, USD: () => 1, USDT: () => 1 };

export function localToUsdMinor(amountMinor, currency = 'KES') {
  const rate = (RATES[currency] || RATES.KES)();
  return Math.round(Number(amountMinor) / rate);
}

export function usdMinorToLocal(usdMinor, currency = 'KES') {
  const rate = (RATES[currency] || RATES.KES)();
  return Math.round(Number(usdMinor) * rate);
}
