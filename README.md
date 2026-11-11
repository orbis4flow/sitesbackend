# Kora API

The backend for KoraBinary, LyraBinary and VexaBinary, and the Kora admin
console. A copy of the Novi API with its own Supabase project and its own
Render service: nothing here touches Novi.

## New-stack setup (do once)

1. Supabase: create a new project. SQL editor → paste all of
   `sql/000_setup_all.sql` → Run. Then make yourself an admin:
   `update public.profiles set role = 'admin' where email = 'you@example.com';`
   (after signing up on one of the sites).
2. Render: New → Blueprint (or Web Service) on this repo. Set
   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, the payment
   and SMS keys (same as Novi's if you want the same accounts), and
   CORS_ORIGINS = the three sites + the admin host.
3. Put the Render URL and the Supabase URL + publishable key into
   `assets/js/config.js` on each site and in the admin.
4. The M-Pesa clone app has a `kora` rail for this backend
   (`services/rails/kora.ts`); set its baseUrl to the Render URL.


Express service in front of Supabase, with PayHero (M-Pesa) and USDT. No card payments on this stack.

## Getting it running

```bash
cd backend
npm install
cp .env.example .env     # fill it in
npm run dev
```

Then in Supabase → SQL editor, run `sql/001_schema.sql` and `sql/002_policies.sql`, in that order.

## Endpoints

### Auth
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/signup` | email, password, name, optional phone + referralCode |
| POST | `/auth/login` | returns access and refresh tokens |
| GET  | `/auth/google` | returns the consent URL to redirect to |
| POST | `/auth/callback` | exchanges a PKCE code for a session |
| POST | `/auth/forgot-password` | always answers the same, whether or not the address exists |
| POST | `/auth/reset-password` | accessToken from the emailed link, plus the new password |
| POST | `/auth/change-password` | signed in; re-checks the current password |
| GET  | `/auth/session` | profile and balances |
| POST | `/auth/refresh` | new access token |
| POST | `/auth/logout` | |
| POST | `/auth/account/delete` | `{ confirm: "DELETE", password }`. Deletes the user and everything tied to them, and their verification files. Refused with a real balance above zero, a pending deposit, an open withdrawal, or for staff |

### Deposits
| Method | Path | Notes |
|---|---|---|
| POST | `/deposits/mpesa` | `{ amountMinor, phone }` → STK push |
| POST | `/deposits/mpesa/:reference/resend` | the prompt never arrived: a new PayHero prompt, same amount and phone |

| GET  | `/deposits/:reference` | poll while the waiting screen is up |
| GET  | `/deposits` | recent deposits |

### Withdrawals
| Method | Path | Notes |
|---|---|---|
| POST | `/withdrawals` | holds the funds, queues for review |
| GET  | `/withdrawals` | list |
| POST | `/withdrawals/:id/cancel` | releases the hold |

### Automated runs
Needs `sql/015_copy_keys_and_runs.sql`, and `sql/018_sold_trades.sql` for
contracts closed early (`status: "sold"`, credited at the price they were
sold for).

| Method | Path | Notes |
|---|---|---|
| POST | `/runs` | `{ accountKind, takeProfitMinor, stopLossMinor, multiplier, baseStakeMinor }` → opens a run, closing any still open |
| GET  | `/runs/:id` | the run's status, trades, wins, losses and P/L |
| POST | `/runs/:id/stop` | stopped by hand |

A run has no fixed number of contracts. Each contract is posted to
`/trades` with its `runId`; the server adds its profit to the run and ends
the run as `take_profit` or `stop_loss` the moment either rule is met. The
`/trades` response carries `runs: [...]`, which is how the terminal knows
whether to place the next one.

### Copy trading
| Method | Path | Notes |
|---|---|---|
| POST | `/copy/activate` | `{ key }`. One key, one account; sets `profiles.copy_active` |
| GET  | `/copy` | `{ copyActive }` |
| GET  | `/copy/keys` | VIP only: their keys and how many were used. Makes one if none is unused. Needs `sql/017_vip_copy_keys.sql` |
| POST | `/copy/keys` | VIP only: a new key, up to 5 unused at once |
| POST | `/copy/keys/:id/regenerate` | VIP only: a new code for an unused key; the old code stops working |
| POST | `/copy/keys/:id/deactivate` | VIP only: an unused key stops working |
| GET  | `/admin/copy-keys` | staff: every key and who used it |
| POST | `/admin/copy-keys` | staff: `{ count, note }`, makes up to 50 keys |
| POST | `/admin/copy-keys/:id/revoke` | staff: unused keys only |

### Webhooks
| Method | Path | Notes |
|---|---|---|
| POST | `/webhooks/payhero/:secret` | secret in the path; PayHero does not sign |

### Manual credits (console)
| Method | Path | Notes |
|---|---|---|
| POST | `/admin/users/:id/credit` | `{ amountMinor, note, requestId }`, USD cents. super_admin, admin or finance |

For customers in a country no gateway covers: they send the money some
other way and staff load it. The credit is written as a `manual` deposit
and settled through `settle_deposit`, so it is in the ledger and the
customer's deposit history like any other. The note is required and
audited. `requestId` is stored as the unique `provider_ref`, so a double
click is refused rather than paid twice.

## How money moves

Nothing in a route handler changes a balance. A deposit goes:

1. `POST /deposits/*` writes a **pending** payment row with our own reference, **then** calls the provider. That order is deliberate: if the provider succeeds but our response is lost, the callback still finds a row to settle.
2. The provider calls a webhook. The path secret (PayHero) is checked.
3. We ask the provider's API what actually happened rather than believing the payload.
4. `settle_deposit()` credits the balance and writes a ledger entry **in one transaction**, and returns early if the payment is already settled — so a replayed webhook is a no-op.

Two things follow from this that are worth not undoing later:

- **Amounts are integers in minor units everywhere.** KES 100 is `10000`. Floats drift, and a balance that drifts is a support queue.
- **Balances are only writable through the SQL functions.** `002_policies.sql` grants no `UPDATE` on `accounts` and no `INSERT` on `ledger_entries` to anyone, so even a leaked anon key cannot write itself money.

## Deploying to Render

`render.yaml` is a blueprint — point Render at the repo and set the secrets in the dashboard.

**Use a paid instance.** Free services sleep, and a sleeping service misses payment webhooks. A missed webhook is a customer who paid and did not get credited.

After the first deploy:

1. Nothing to do for `API_URL` — it defaults to Render's own `RENDER_EXTERNAL_URL`, so callbacks point at the live service from the first boot. Set it explicitly only behind a custom domain. `APP_URL` defaults to the first `CORS_ORIGINS` entry.
2. PayHero callback → the URL printed in the boot log as `payhero callback`. It is derived from the service-role key rather than configured, so it is stable across restarts and instances — but rotating that key changes it, and the dashboard has to be updated at the same time.
3. Supabase, Authentication, URL Configuration:

   **Site URL** `https://novibinary.com`

   **Redirect URLs** (one per line). These are the three addresses this
   service asks Supabase to send people back to, so they are the three
   that have to be allowed. A wildcard covers them, but listing them is
   worth the extra minute: a wildcard also allows every future page,
   including ones nobody meant to make a landing spot for an auth token.

   ```
   https://novibinary.com/login
   https://novibinary.com/reset-password
   https://novibinary.com
   ```

   For previews and local work, add what you actually use:
   `http://localhost:5500/**`, `https://*.vercel.app/**`.
5. Supabase → Authentication → Providers → Google: add the client ID and secret, and set the callback to `https://<project>.supabase.co/auth/v1/callback`.

## When something is not working

The console's **Logs** page is the first place to look. It shows, at the
top, whether this service can currently reach Supabase and
PayHero — each probe is an authenticated call, so a green light means the
credentials work, not merely that the hostname resolves. A dependency can
report `key` rather than `down`, which is the difference between "they
are having an outage" and "our key was rotated".

Underneath is `system_events`: the things worth acting on. A refused
origin, a webhook whose signature did not verify, an STK push that never
left. It is not a copy of the request log — that stays on the host, where
nothing in the console can read it and a deploy erases it.

The most common failure is a browser call that never arrives, reported by
the site as "could not reach Nexas". Nine times in ten that is CORS: the
origin is not in `CORS_ORIGINS`, the browser refuses to send the request,
and the reason never reaches JavaScript. The Logs page records every
refused origin with the address that was turned away, so the fix is to
read the line and add that origin. Preview deploys change hostname every
build, so `CORS_ORIGINS` accepts one wildcard label —
`https://*.vercel.app` — alongside exact origins.

## The first super admin

There is no endpoint that grants admin, and there should not be: an
endpoint that can make the first super admin can make the second one for
somebody else, and it stays reachable from the internet forever after.
The first one is made by hand, once, in the Supabase SQL editor — where
the only way in is your own Supabase password.

1. Run `sql/005_roles.sql`, `sql/006_events.sql` (the Logs page),
   `sql/007_trades.sql` (trade history) and `sql/008_vip_mpesa.sql`
   (the VIP demo rail). It widens `profiles.role` to the seven roles
   the console actually assigns; before it, creating a `manager` fails on
   a CHECK constraint left over from `003`.
2. Create the account the normal way — sign up on the site, or Supabase →
   Authentication → Users → Add user with **Auto Confirm** on. The profile
   row is written by the `handle_new_user` trigger, and it must exist
   before step 3 can update anything.
3. Promote it:

   ```sql
   update public.profiles
      set role = 'super_admin', status = 'active'
    where lower(email) = lower('you@example.com');
   ```

4. Confirm, then sign in to the console. This should return one row:

   ```sql
   select email, role, status from public.profiles where role <> 'customer';
   ```

Everyone else is created from the console: Admins → New, which only a
`super_admin` can reach. `005` also installs a trigger that refuses to
demote or suspend the last active super admin — not a grant, just a
refusal to let the console lock everybody out.

## Connecting the front end

`assets/js/api.js` already has the seam:

```html
<script>window.NEXAS_API = "https://nexas-api.onrender.com";</script>
```

## The VIP demo rail

Every account is **Standard** by default and moves real money. An admin can
promote one to **VIP**, and a VIP's deposits settle against a companion M-Pesa
clone app instead of PayHero: the money comes off a handset in the room and
lands on the trading balance in real time, so a deposit can be shown working
without anybody spending a shilling.

Run `sql/008_vip_mpesa.sql`. It adds `profiles.tier`, the two wallet tables and
the functions that move them.

**Setting one up**, in the console, on the user's drawer:

1. **Make VIP.** The tier alone changes nothing a customer can see.
2. **Set the handset**: a four digit PIN, the balance the phone will show, and
   the Fuliza limit. Tier and wallet are separate on purpose, because they fail
   separately, and "VIP with no wallet" is a state an operator needs to see
   rather than infer from a deposit that will not work.
3. The customer types that PIN into the M-Pesa app **once**. It is exchanged
   for a device token the phone keeps, so the binding survives the app closing.

| Route | Who calls it | Auth |
| --- | --- | --- |
| `POST /mpesa/link` | An unlinked handset | The PIN itself, rate limited |
| `GET /mpesa/account` | The handset, polling | Device token |
| `POST /mpesa/agent-withdraw` | The handset | Device token |
| `POST /mpesa/receive` | The handset | Device token |
| `POST /mpesa/reset` | Between rehearsals | Device token |
| `POST /deposits/mpesa` | A VIP's terminal | The normal customer token; the tier is checked server side |
| `POST /admin/users/:id/wallet/test-sms` | An operator, before the demo | Staff token |

The deposit endpoint is **the same one Standard accounts use**. The fork happens
inside it, from the database, so the browser cannot ask to be on the demo rail
and a customer demoted mid-session stops being on it immediately.

### The confirmation texts

The half of M-Pesa an audience actually recognises is the message that
arrives a second after the PIN, so the rail sends one. Every movement —
a deposit onto the trading balance, a payout back, an agent withdrawal, a
reversal — is followed by a Safaricom-shaped SMS to the number on the
wallet, through **Africa's Talking**:

```
TDK7X2M4P1 Confirmed. Ksh5,000.00 paid to NOVI MARKETS. on 20/9/26 at
4:15 PM.New M-PESA balance is Ksh45,000.00. Transaction cost, Ksh0.00.
```

#### Which gateway

Africa's Talking is the only gateway on this stack:

| Provider | Settings, all required together | What it is for |
| --- | --- | --- |
| Africa's Talking | `AFRICASTALKING_USERNAME`, `AFRICASTALKING_API_KEY`, and optionally `AFRICASTALKING_SENDER_ID` | A sandbox username tests against their simulator; a live one sends for real |

With none of it set the rail runs exactly as it did before, silently. The
boot log prints which gateway will be used, or why none is — half-set
credentials are the usual answer, and they are ignored rather than half
used. The console's status strip carries an **SMS gateway** tile next to
PayHero's, naming whichever is live.

The choice lives in one list, in `services/sms.js`; each provider is a
small module beside it answering the same four questions. Nothing ever
falls back mid-send: a gateway that answered and refused has given an
answer, and quietly re-sending through the other one is how somebody gets
the same receipt twice.

Three things are worth knowing before a presentation:

* **The number is the wallet's**, not the profile's. Set it on the handset
  panel and press **Test SMS**, which sends one plainly-worded message to
  that number and reports back what the gateway said, and which one said
  it. A wrong digit otherwise means a stranger gets a receipt for money
  that does not exist.
* **Africa's Talking' sandbox delivers to nobody.** A username of
  `sandbox` reaches their simulator at `simulator.africastalking.com` and
  never a handset, however well the send goes — fine for wiring this up,
  useless in front of a room. Their live app is a different username and
  a different key.
* **Sandbox refuses a sender ID**, always: it has none registered, and it
  says so by answering 2xx with an empty recipient list rather than an
  error, so a message sent with one vanishes. `AFRICASTALKING_SENDER_ID`
  is therefore ignored on sandbox and the messages go out as
  `AFRICASTKNG`. Live, an alphanumeric sender has to be applied for and
  approved by the networks first, which takes days — until then the same
  shared shortcode is what arrives.
* **The sender can never be MPESA.** That sender ID is Safaricom's and
  both gateways will refuse it. So a message that arrives is always
  attributable to us, which is the line this rail should not cross: the
  text is there to demonstrate a flow to people who know they are watching
  a demo, not to make a prop balance look like money to somebody who does
  not.

Sending is fire-and-forget and never blocks a movement: the money has
already moved by the time the gateway is called, and a refused or slow
message is written to the event log (`source: sms`, with the provider on
the row) rather than failing a deposit that settled. Wording lives in
`services/mpesaSms.js`, the gateway in
`services/africastalking.js` behind `services/sms.js`, and the single call
site is `move()` in `services/mpesaDemo.js` — so nothing can move on this
rail without a text following it.

### Fuliza

The limit is set per wallet by an admin rather than derived from the balance,
because here it is a thing being demonstrated rather than simulated. It behaves
as the real product does: money out that the balance cannot cover draws the
shortfall from the limit and floors the balance at zero, money in repays what is
owed before it touches the balance, and a debit past balance-plus-remaining-limit
is refused outright.

### The line this must not cross

The wallet is a presentation prop. It touches no PayHero credential, it is reachable only for accounts an admin has marked VIP, and
Standard accounts remain the only path real money takes. The PIN is stored in
plain text **deliberately**: it is assigned by an admin, never chosen by a
customer, so it cannot be anyone's real M-Pesa PIN, and the console has to read
it back to tell them what to type. If it ever gates anything real it needs
hashing and rate limiting first.

A VIP deposit still writes a `payments` row and still settles through
`settle_deposit`, so it appears in the ledger and the console exactly as a real
one does. The provider is `mpesa_demo`, which is how you tell them apart.

## Trade history is the client's account, not the server's

`/trades` records settled contracts so a person's history survives the
browser it was made in. It is not evidence. Contracts are still decided
client side, so a row says what that browser reported — anyone can open
devtools and write themselves a winning history.

Two things keep that contained, and both are in the schema rather than in
a convention somebody can forget: nothing in `trades` can reach a balance
(no trigger, no function, no path to `accounts` or `ledger_entries`), and
a row is immutable once written (no UPDATE or DELETE policy for anyone).

When settlement moves server side this table becomes the record of what
the server decided, and only the insert policy changes.

## Still to do before real money

- [ ] A scheduled sweep calling `reconcile()` on payments pending more than ~10 minutes. Mobile-money callbacks do get lost, and a deposit that silently never lands is the worst failure here.
- [ ] Replace the fixed `USD_RATE_KES` with a rates feed; a stale rate leaks value in one direction.
- [ ] An operator surface for approving payouts (`release_withdrawal` is written and ready).
- [ ] Move contracts and the price feed server-side. While the browser decides trade outcomes, anyone can edit their own balance in devtools — everything above only secures the *money in and out*.
