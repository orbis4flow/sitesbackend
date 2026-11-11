/* ============================================================
   Phone numbers
   People type 0712..., +254712..., 254 712 345 678. The provider wants
   one shape. Normalise once at the edge so nothing downstream has to
   guess.
   ============================================================ */
const DIAL = { KE: '254', UG: '256', TZ: '255', RW: '250', NG: '234', GH: '233', ZA: '27' };
const LEN = { KE: 9, UG: 9, TZ: 9, RW: 9, NG: 10, GH: 9, ZA: 9 };

/* Which of the countries we reach a full international number belongs
   to. Longest code first, so 254 is not mistaken for 25 of something.
   Returns null when it matches none of them, which is the honest answer
   for a number on a rail we do not have. */
function countryOf(digits) {
  const codes = Object.keys(DIAL).sort((a, b) => DIAL[b].length - DIAL[a].length);
  for (const cc of codes) {
    if (digits.startsWith(DIAL[cc]) && digits.length === DIAL[cc].length + LEN[cc]) return cc;
  }
  return null;
}

export function normalisePhone(input, country = 'KE') {
  const raw = String(input || '');
  /* Written with its country code by the caller. The payout field sends
     every number this way, and for a country outside the seven below
     that is all we can check: there is no length rule here for Portugal
     and inventing one would reject real numbers. E.164 allows fifteen
     digits including the code, and nothing shorter than eight is a
     phone number with a country code on it. */
  const international = raw.trim().startsWith('+');

  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);

  /* A number sent in full carries its own country, and that beats the
     one on the profile: somebody who signed up in Nairobi and is being
     paid out to a Ugandan number has told us which, and reading it off
     the profile instead is how the money goes to a number that does not
     exist. */
  const declared = countryOf(digits);
  if (declared) return digits;

  if (international) {
    return digits.length >= 8 && digits.length <= 15 ? digits : null;
  }

  const dial = DIAL[country] || DIAL.KE;
  const want = LEN[country] || 9;

  if (digits.startsWith(dial)) digits = digits.slice(dial.length);
  if (digits.startsWith('0')) digits = digits.slice(1);

  if (digits.length !== want) return null;
  return dial + digits;
}

/* ============================================================
   Showing one back

   A number on a screen is read by whoever is standing behind the
   screen. Enough of it is kept for the owner to recognise their own —
   the dialling code, the first digit, the last three — and the rest
   goes, which is the same shape a bank statement uses and for the same
   reason.

   The masked form is what leaves the server. The full number is held
   here and used here; a browser that never receives it cannot leak it,
   and the deposit rail reads it from the profile rather than being
   handed it back by the page.
   ============================================================ */
const DIALS = Object.values(DIAL).sort((a, b) => b.length - a.length);

export function maskPhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (!digits) return null;
  /* Too short to hide anything in: everything but the last two goes,
     rather than pretending to mask a number that has nothing spare. */
  if (digits.length < 7) return '•'.repeat(Math.max(0, digits.length - 2)) + digits.slice(-2);

  const dial = DIALS.find(d => digits.startsWith(d)) || '';
  const rest = digits.slice(dial.length);
  const head = rest.slice(0, 1);
  const tail = rest.slice(-3);
  const hidden = Math.max(0, rest.length - head.length - tail.length);

  /* One unbroken run of dots rather than grouped ones: grouping implies
     a shape the hidden digits may not have, and somebody checking their
     own number should count nothing. */
  return (dial ? '+' + dial + ' ' : '') + head + '•'.repeat(hidden) + ' ' + tail;
}
