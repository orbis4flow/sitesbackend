/* A copy-trading key: twelve characters from an alphabet with no 0/O or
   1/I/L in it, grouped in fours, so a key read out over the phone
   arrives as it was sent. Used by the console and by VIP accounts. */
import { randomInt } from 'node:crypto';

const KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newCopyKey() {
  let out = '';
  for (let i = 0; i < 12; i++) {
    if (i && i % 4 === 0) out += '-';
    out += KEY_ALPHABET[randomInt(KEY_ALPHABET.length)];
  }
  return out;
}
