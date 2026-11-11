/* ============================================================
   Configuration

   Only two kinds of value live in the environment:

     * secrets — keys that must never be committed
     * per-deployment addresses — the URLs, which differ between
       local and Render

   Everything else is a constant and lives here, in code. A limit like
   the minimum deposit is a product decision, not a deployment one:
   putting it in the environment means the rule can silently differ
   between two running copies of the same service, and nobody notices
   until a customer is refused on one and not the other.
   ============================================================ */
import 'dotenv/config';
import crypto from 'node:crypto';
import { z } from 'zod';

/* ---------- Supabase project ----------
   This stack has its own project, so the URL and the publishable key
   come from the environment. There is no default on purpose: a missing
   value stops the service rather than letting it write into some other
   project's database. */
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY must be set (Render, Environment).');
  process.exit(1);
}

/* ---------- product rules ----------
   Minor units (cents). 10000 = KES 100.00 */
const RULES = {
  /* The name on the wallet texts, the M-Pesa statement lines and the
     stand-in email domain. One backend serves several sites, so this is
     the group name rather than any one site. */
  BRAND_NAME: process.env.BRAND_NAME || 'Kora',
  BRAND_DOMAIN: process.env.BRAND_DOMAIN || 'korabinary.com',

  /* The rails collect shillings, so this is shillings: USD 5 at the rate
     below. The customer types dollars and never sees this figure except
     on the line that says what the phone will actually be debited. */
  MIN_DEPOSIT_MINOR: 64500,        /* KES 645, i.e. USD 5 */
  MAX_DEPOSIT_MINOR: 15000000,     /* KES 150,000 */
  /* Withdrawals are requested in USD cents, which is what the balance is
     held in and, now, what the whole product is quoted in. */
  MIN_WITHDRAWAL_MINOR: 1000,      /* USD 10 */

  /* Local currency per 1 USD. A fixed rate is fine to launch on, but it
     leaks value in one direction as the real rate moves — replace it
     with a rates feed before volumes grow. */
  USD_RATE_KES: 129,

  /* The wallet USDT deposits are sent to, and the only network we accept.
     One address and one chain on purpose: a customer choosing a network
     from a menu is a customer who can choose the wrong one, and USDT
     sent over the wrong chain is gone. */
  USDT_ADDRESS: process.env.USDT_ADDRESS || 'TLEDGCXYvTkUdEUYdCY7oHRN9vRKfWkngq',
  USDT_NETWORK: 'TRC-20',
  MIN_USDT_MINOR: 1000,            /* USD 10, and USDT is quoted 1:1 */

  /* Render puts a proxy in front of the service, so the real client IP
     arrives in X-Forwarded-For. Without this, rate limiting sees one
     address for every request and throttles everybody at once. */
  TRUST_PROXY: 1,
  LOG_LEVEL: 'info'
};

/* ---------- pasted credentials ----------
   A key copied into a dashboard field arrives wearing a trailing
   newline, or a pair of quotes somebody added because the value has
   underscores in it, often enough to be worth designing for. The failure
   that causes is the worst kind: the credential is correct, the service
   says it is not, and nothing on either side can see the difference.

   So every secret is trimmed and unwrapped once, here, on the way in.
   Nothing downstream should ever have to wonder. */
function unwrap(value) {
  const v = String(value).trim();
  const q = v.charAt(0);
  if ((q === '"' || q === "'") && v.length > 1 && v.charAt(v.length - 1) === q) {
    return v.slice(1, -1).trim();
  }
  return v;
}

function secret() {
  return z.string().transform(unwrap);
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8080),

  /* Where the browser app lives, and where this service can be reached.
     Payment providers post callbacks to API_URL, so it has to be a real
     public address once deployed — see the fallbacks below, which mean
     neither normally has to be set by hand on Render. */
  APP_URL: z.string().url(),
  API_URL: z.string().url(),
  CORS_ORIGINS: z.string().default(''),

  /* Bypasses row level security. Server only, always. */
  SUPABASE_SERVICE_ROLE_KEY: secret().pipe(z.string().min(20)),

  /* Paystack: the secret key is all that is needed. Transactions are
     created through the API with the amount, so there is no hosted
     payment page to configure, and nothing Paystack-shaped runs in the
     browser, so there is no public key to publish. */
  PAYSTACK_SECRET_KEY: secret().pipe(z.string().min(10)),

  /* PayHero: HTTP Basic. Either paste a ready-made token or give the
     username and password and let the server build it. */
  PAYHERO_API_USERNAME: secret().optional().default(''),
  PAYHERO_API_PASSWORD: secret().optional().default(''),
  PAYHERO_BASIC_TOKEN: secret().optional().default(''),
  PAYHERO_CHANNEL_ID: secret().optional().default(''),

  /* When PayHero cannot send the M-Pesa prompt (refuses, is down, or is
     too slow to answer), send it through Paystack instead. 'off' turns
     the fallback off and a PayHero failure is reported as before. */
  MPESA_FALLBACK: z.enum(['paystack', 'off']).default('paystack'),
  /* Which rail sends the M-Pesa prompt first. 'paystack' skips PayHero
     altogether: for testing the fallback, or for running without PayHero
     while it is down. */
  MPESA_PRIMARY: z.enum(['payhero', 'paystack']).default('payhero'),
  /* How long to wait for PayHero to accept the prompt before falling
     back. Its answer normally takes a second or two. */
  PAYHERO_PUSH_TIMEOUT_MS: z.coerce.number().int().min(3000).max(60000).default(15000),

  /* The SMS gateways the demo rail texts from. Both are optional and
     both are optional together — with none of it set the rail runs
     exactly as before, silently, which is what a laptop with no .env
     should do rather than refusing to boot over a message nobody is
     waiting for.

     Celcom is preferred when both are configured; see services/sms.js,
     which holds that order in one place. */

  /* Celcom Africa. The shortcode is the sender ID they have registered
     for this account: whatever was approved (NOVI, NOVIMARKETS). It can
     never be MPESA, which belongs to Safaricom. */
  CELCOM_API_KEY: secret().optional().default(''),
  CELCOM_PARTNER_ID: secret().optional().default(''),
  CELCOM_SHORTCODE: secret().optional().default(''),

  /* Africa's Talking. The username decides which of their two worlds the
     key belongs to: "sandbox" is their test app, and a message sent
     through it reaches their simulator and never a handset. The sender
     ID is optional and messages go out as AFRICASTKNG without one, which
     is fine for a test and wrong for a demo. */
  AFRICASTALKING_USERNAME: secret().optional().default(''),
  AFRICASTALKING_API_KEY: secret().optional().default(''),
  AFRICASTALKING_SENDER_ID: secret().optional().default(''),

  /* Which SMS gateway to use when both are configured. auto prefers
     Celcom; africastalking or celcom forces that one (if it is set up),
     so one can be switched off without deleting its credentials. */
  SMS_PROVIDER: z.enum(['auto', 'celcom', 'africastalking']).default('auto')
});

/* ---------- URL fallbacks ----------
   Render exports RENDER_EXTERNAL_URL for every web service: the real
   public address of this instance. That is exactly what API_URL is, so
   take it from there rather than making somebody paste it in and risk a
   payment callback pointed at the wrong host.

   APP_URL is the front end, which this service cannot know, so it falls
   back to the first allowed CORS origin (which is the front end, by
   definition) and only then to the API's own address. Set it explicitly
   once the site has a domain. */
const firstOrigin = (process.env.CORS_ORIGINS || '')
  .split(',').map(v => v.trim()).filter(Boolean)[0];

const API_URL = process.env.API_URL || process.env.RENDER_EXTERNAL_URL || undefined;
const APP_URL = process.env.APP_URL || firstOrigin || API_URL || undefined;

const parsed = schema.safeParse({ ...process.env, API_URL, APP_URL });

if (!parsed.success) {
  const lines = parsed.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`);
  console.error('Configuration is incomplete:\n' + lines.join('\n') +
    '\n\nCopy .env.example to .env and fill it in.' +
    '\nOn Render these are set under Environment, not in a file.');
  process.exit(1);
}

export const env = {
  ...parsed.data,
  ...RULES,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  PAYHERO_BASE_URL: 'https://backend.payhero.co.ke/api/v2',
  CELCOM_BASE_URL: 'https://isms.celcomafrica.com/api/services'
};

/* Which gateway the demo rail will text through, and why none when
   there is none. Printed at boot next to the PayHero line, because "the
   messages did not arrive" is asked far more often than it is diagnosed,
   and half-set credentials are the usual reason.

   The order here has to match the list in services/sms.js. It is two
   providers and one line, so it is repeated rather than imported: this
   file is read before anything else is loaded. */
const celcomSet = !!(env.CELCOM_API_KEY && env.CELCOM_PARTNER_ID && env.CELCOM_SHORTCODE);
const celcomPart = !!(env.CELCOM_API_KEY || env.CELCOM_PARTNER_ID || env.CELCOM_SHORTCODE);
const atSet = !!(env.AFRICASTALKING_USERNAME && env.AFRICASTALKING_API_KEY);
const atPart = !!(env.AFRICASTALKING_USERNAME || env.AFRICASTALKING_API_KEY);

const atLine = () => (env.AFRICASTALKING_USERNAME === 'sandbox'
  ? "Africa's Talking (sandbox — messages reach their simulator, not a handset), sender AFRICASTKNG"
  : `Africa's Talking, sender ${env.AFRICASTALKING_SENDER_ID || 'AFRICASTKNG'}`);

export const smsSource = (env.SMS_PROVIDER === 'africastalking' && atSet)
  ? atLine() + ' (chosen by SMS_PROVIDER' + (celcomSet ? '; Celcom is set and unused' : '') + ')'
  : (env.SMS_PROVIDER === 'celcom' && celcomSet)
  ? `Celcom, sender ${env.CELCOM_SHORTCODE} (chosen by SMS_PROVIDER)`
  : celcomSet
  ? `Celcom, sender ${env.CELCOM_SHORTCODE}` +
    (atSet ? " (Africa's Talking is also set and is the standby)" : '')
  : atSet
    ? (env.AFRICASTALKING_USERNAME === 'sandbox'
        ? "Africa's Talking (sandbox — messages reach their simulator, not a handset), sender AFRICASTKNG" +
          (env.AFRICASTALKING_SENDER_ID
            ? ` (sandbox refuses a registered sender ID, so ${env.AFRICASTALKING_SENDER_ID} is not being sent)` : '')
        : `Africa's Talking, sender ${env.AFRICASTALKING_SENDER_ID || 'AFRICASTKNG'}`) +
      (celcomPart ? ' — Celcom is half-set and is being ignored' : '')
    : celcomPart
      ? 'nothing — CELCOM_API_KEY, CELCOM_PARTNER_ID and CELCOM_SHORTCODE are all required together'
      : atPart
        ? 'nothing — AFRICASTALKING_USERNAME and AFRICASTALKING_API_KEY are required together'
        : 'nothing — the demo rail will move money silently';

export const isProd = env.NODE_ENV === 'production';

export const corsOrigins = env.CORS_ORIGINS
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

/* An entry may be an exact origin, or one wildcard subdomain such as
   https://*.vercel.app. Preview deploys get a fresh hostname every time,
   and a browser refuses a request from an origin the API does not list —
   which reaches the user as "could not reach the server", not as a CORS
   message, so it is a hard failure to diagnose from the outside.

   The wildcard matches one label only: https://*.vercel.app allows
   nexas-abc123.vercel.app but not a.b.vercel.app, and never a bare
   vercel.app. Scheme and port must still match exactly. */
export function originAllowed(origin) {
  if (!origin) return false;
  for (const entry of corsOrigins) {
    if (entry === origin) return true;
    const star = entry.indexOf('://*.');
    if (star === -1) continue;
    const scheme = entry.slice(0, star + 3);
    const suffix = entry.slice(star + 4);          /* ".vercel.app" */
    if (!origin.startsWith(scheme)) continue;
    const host = origin.slice(scheme.length);
    if (!host.endsWith(suffix)) continue;
    const label = host.slice(0, host.length - suffix.length);
    if (label && !label.includes('.')) return true;
  }
  return false;
}

/* ---------- PayHero HTTP Basic ----------
   Two ways to configure the same thing, which is one more than is safe:
   when both are set, a wrong token used to win silently over a correct
   username and password, and the failure it produced was a request
   PayHero answered with 200 and success:false — no prompt, no error,
   nobody any the wiser.

   So the token is checked rather than trusted. It must decode to
   "something:something"; a value that does not is treated as not set,
   and the username and password are used instead. A pasted "Basic xxx"
   is also tidied up, because that is what the dashboard shows you. */
function readBasicToken(raw) {
  const value = String(raw || '').trim().replace(/^Basic\s+/i, '');
  if (!value) return { token: '', why: 'unset' };
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    if (!decoded.includes(':')) return { token: '', why: 'malformed' };
    return { token: value, why: 'token' };
  } catch {
    return { token: '', why: 'malformed' };
  }
}

const basic = readBasicToken(env.PAYHERO_BASIC_TOKEN);

const derived = (env.PAYHERO_API_USERNAME && env.PAYHERO_API_PASSWORD)
  ? Buffer.from(`${env.PAYHERO_API_USERNAME}:${env.PAYHERO_API_PASSWORD}`).toString('base64')
  : '';

export const payheroToken = basic.token || derived;

/* Which of the two is in use, and why — printed at boot. Never the
   value, only where it came from. */
export const payheroAuthSource =
  basic.token ? 'PAYHERO_BASIC_TOKEN'
  : derived ? (basic.why === 'malformed'
      ? 'username and password (PAYHERO_BASIC_TOKEN is set but not valid base64 of "user:pass" — ignored)'
      : 'username and password')
  : 'nothing — M-Pesa is not configured';

/* ---------- PayHero callback secret ----------
   PayHero does not sign its callbacks, so the callback URL carries a
   secret path segment instead. Rather than being one more thing to set,
   it is derived from a secret the service already holds — stable across
   restarts and across instances, and never written down anywhere.

   One consequence worth knowing: rotating the service-role key changes
   this URL, so the callback registered with PayHero has to be updated
   at the same time. The boot log prints the current one. */
export const payheroCallbackSecret = crypto
  .createHmac('sha256', env.SUPABASE_SERVICE_ROLE_KEY)
  .update('payhero:callback:v1')
  .digest('hex')
  .slice(0, 40);
