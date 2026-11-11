import { randomBytes } from 'node:crypto';

/* Our own reference for a payment. Sent to the provider, echoed back on
   the callback, and unique in the payments table — which is what makes a
   replayed webhook land on the row it already settled. */
export function newReference(prefix = 'NX') {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = randomBytes(4).toString('hex').toUpperCase();
  return `${prefix}-${stamp}-${rand}`;
}
