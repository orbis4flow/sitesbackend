-- ============================================================
-- Everything, in order, for a brand-new Supabase project.
-- Paste this whole file into the SQL editor once. Generated from
-- 001 to 021; the numbered files stay the source of truth.
-- ============================================================

-- >>>>>>>>>> 001_schema.sql
-- ============================================================
-- Nexas — schema
-- Run in Supabase → SQL editor, in order (001 then 002).
--
-- Money is stored as BIGINT in minor units (cents). Never floats:
-- 0.1 + 0.2 is not 0.3 in binary floating point, and a balance that
-- drifts by a cent per thousand trades is a support queue.
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- profile, one per auth user ----------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null,
  display_name  text,
  phone         text,                       -- E.164, no leading +
  country       text default 'KE',
  kyc_status    text not null default 'unverified'
                check (kyc_status in ('unverified','pending','verified','rejected')),
  referral_code text unique,
  referred_by   uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- ---------- balances ----------
-- One row per user per account kind. The balance is a cached total; every
-- change to it must also write a ledger entry, and only the functions
-- below are allowed to touch it.
create table if not exists public.accounts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  kind          text not null check (kind in ('real','demo')),
  currency      text not null default 'USD',
  balance_minor bigint not null default 0 check (balance_minor >= 0),
  created_at    timestamptz not null default now(),
  unique (user_id, kind)
);

-- ---------- payments ----------
-- One row per attempt, created before the provider is called so a
-- callback always has something to match against.
create table if not exists public.payments (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  direction     text not null check (direction in ('deposit','withdrawal')),
  provider      text not null check (provider in ('paystack','payhero','manual')),
  reference     text not null unique,        -- ours, sent to the provider
  provider_ref  text unique,                 -- theirs, returned to us
  amount_minor  bigint not null check (amount_minor > 0),
  currency      text not null default 'KES',
  credited_minor bigint,                     -- what landed in the USD balance
  status        text not null default 'pending'
                check (status in ('pending','success','failed','cancelled')),
  phone         text,
  failure_reason text,
  raw           jsonb,                       -- last provider payload, for support
  created_at    timestamptz not null default now(),
  settled_at    timestamptz
);

create index if not exists payments_user_idx on public.payments(user_id, created_at desc);
create index if not exists payments_status_idx on public.payments(status) where status = 'pending';

-- ---------- ledger ----------
-- Append-only. The balance can always be rebuilt from this, which is how
-- you prove a balance is right when someone disputes it.
create table if not exists public.ledger_entries (
  id                 uuid primary key default gen_random_uuid(),
  account_id         uuid not null references public.accounts(id) on delete cascade,
  payment_id         uuid references public.payments(id) on delete set null,
  kind               text not null,          -- deposit | withdrawal | trade | payout | adjustment
  amount_minor       bigint not null,        -- signed: credit positive, debit negative
  balance_after_minor bigint not null,
  memo               text,
  created_at         timestamptz not null default now()
);

create index if not exists ledger_account_idx on public.ledger_entries(account_id, created_at desc);

-- ---------- withdrawal requests ----------
-- Funds are held the moment a request is made, so the same balance
-- cannot be requested twice while a payout is in review.
create table if not exists public.withdrawal_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  payment_id    uuid references public.payments(id) on delete set null,
  amount_minor  bigint not null check (amount_minor > 0),
  currency      text not null default 'USD',
  method        text not null check (method in ('mpesa','bank')),
  destination   jsonb not null,              -- { phone } or bank details
  status        text not null default 'pending'
                check (status in ('pending','approved','paid','rejected','cancelled')),
  reviewed_by   uuid references auth.users(id) on delete set null,
  review_note   text,
  created_at    timestamptz not null default now(),
  settled_at    timestamptz
);

create index if not exists withdrawals_user_idx on public.withdrawal_requests(user_id, created_at desc);

-- ============================================================
-- A new sign-up gets a profile and both balances automatically, so no
-- code path can leave a user without somewhere to put money.
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, referral_code)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 7))
  )
  on conflict (id) do nothing;

  insert into public.accounts (user_id, kind, currency, balance_minor)
  values (new.id, 'real', 'USD', 0),
         (new.id, 'demo', 'USD', 1000000)      -- 10,000.00 practice funds
  on conflict (user_id, kind) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- Money movement. These are the ONLY things allowed to change a
-- balance, and they are the reason a replayed webhook cannot pay
-- somebody twice.
-- ============================================================

-- Settle a deposit: idempotent by design. Called only from a verified
-- webhook. Re-delivery of the same event is a no-op.
create or replace function public.settle_deposit(
  p_payment_id uuid,
  p_provider_ref text,
  p_credited_minor bigint,
  p_raw jsonb default null
)
returns public.payments
language plpgsql
security definer set search_path = public
as $$
declare
  v_payment public.payments;
  v_account public.accounts;
  v_new_balance bigint;
begin
  -- Lock the row first. Two callbacks arriving together will queue here
  -- rather than both reading 'pending' and both crediting.
  select * into v_payment from public.payments
    where id = p_payment_id for update;

  if v_payment is null then
    raise exception 'payment % not found', p_payment_id;
  end if;

  if v_payment.status = 'success' then
    return v_payment;                         -- already settled; do nothing
  end if;

  select * into v_account from public.accounts
    where user_id = v_payment.user_id and kind = 'real' for update;

  v_new_balance := v_account.balance_minor + p_credited_minor;

  update public.accounts
     set balance_minor = v_new_balance
   where id = v_account.id;

  insert into public.ledger_entries
    (account_id, payment_id, kind, amount_minor, balance_after_minor, memo)
  values
    (v_account.id, v_payment.id, 'deposit', p_credited_minor, v_new_balance,
     v_payment.provider || ' ' || v_payment.reference);

  update public.payments
     set status = 'success',
         provider_ref = coalesce(p_provider_ref, provider_ref),
         credited_minor = p_credited_minor,
         raw = coalesce(p_raw, raw),
         settled_at = now()
   where id = v_payment.id
  returning * into v_payment;

  return v_payment;
end;
$$;

create or replace function public.fail_payment(
  p_payment_id uuid,
  p_reason text,
  p_raw jsonb default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  update public.payments
     set status = case when status = 'success' then status else 'failed' end,
         failure_reason = p_reason,
         raw = coalesce(p_raw, raw),
         settled_at = now()
   where id = p_payment_id;
end;
$$;

-- Hold funds for a withdrawal. Debits immediately so the same balance
-- cannot be withdrawn twice while the first request is in review.
create or replace function public.hold_for_withdrawal(
  p_user_id uuid,
  p_amount_minor bigint,
  p_method text,
  p_destination jsonb
)
returns public.withdrawal_requests
language plpgsql
security definer set search_path = public
as $$
declare
  v_account public.accounts;
  v_request public.withdrawal_requests;
  v_new_balance bigint;
begin
  select * into v_account from public.accounts
    where user_id = p_user_id and kind = 'real' for update;

  if v_account is null then
    raise exception 'no real account for user %', p_user_id;
  end if;

  if v_account.balance_minor < p_amount_minor then
    raise exception 'insufficient funds' using errcode = 'P0001';
  end if;

  v_new_balance := v_account.balance_minor - p_amount_minor;

  update public.accounts set balance_minor = v_new_balance where id = v_account.id;

  insert into public.withdrawal_requests (user_id, amount_minor, currency, method, destination)
  values (p_user_id, p_amount_minor, v_account.currency, p_method, p_destination)
  returning * into v_request;

  insert into public.ledger_entries
    (account_id, kind, amount_minor, balance_after_minor, memo)
  values
    (v_account.id, 'withdrawal', -p_amount_minor, v_new_balance,
     'hold for request ' || v_request.id);

  return v_request;
end;
$$;

-- Put the money back if a payout is rejected or cancelled.
create or replace function public.release_withdrawal(
  p_request_id uuid,
  p_status text,
  p_note text default null
)
returns public.withdrawal_requests
language plpgsql
security definer set search_path = public
as $$
declare
  v_request public.withdrawal_requests;
  v_account public.accounts;
  v_new_balance bigint;
begin
  select * into v_request from public.withdrawal_requests
    where id = p_request_id for update;

  if v_request is null then
    raise exception 'request % not found', p_request_id;
  end if;
  if v_request.status in ('paid','rejected','cancelled') then
    return v_request;                         -- already finished
  end if;

  if p_status in ('rejected','cancelled') then
    select * into v_account from public.accounts
      where user_id = v_request.user_id and kind = 'real' for update;

    v_new_balance := v_account.balance_minor + v_request.amount_minor;
    update public.accounts set balance_minor = v_new_balance where id = v_account.id;

    insert into public.ledger_entries
      (account_id, kind, amount_minor, balance_after_minor, memo)
    values
      (v_account.id, 'adjustment', v_request.amount_minor, v_new_balance,
       'released request ' || v_request.id);
  end if;

  update public.withdrawal_requests
     set status = p_status, review_note = p_note, settled_at = now()
   where id = v_request.id
  returning * into v_request;

  return v_request;
end;
$$;


-- >>>>>>>>>> 002_policies.sql
-- ============================================================
-- Row level security
--
-- Every table is locked by default and opened only to the row's owner.
-- The API uses the service-role key, which bypasses all of this — these
-- policies are what keeps the data safe if the anon key is ever used
-- directly from a browser, which is the whole point of Supabase.
--
-- Note what is NOT granted anywhere below: no UPDATE on accounts, and no
-- INSERT on ledger_entries. Balances move only through the security
-- definer functions in 001, so a compromised client cannot write itself
-- a balance.
-- ============================================================

alter table public.profiles            enable row level security;
alter table public.accounts            enable row level security;
alter table public.payments            enable row level security;
alter table public.ledger_entries      enable row level security;
alter table public.withdrawal_requests enable row level security;

-- ---------- profiles ----------
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update using (auth.uid() = id)
  with check (auth.uid() = id);

-- ---------- accounts ----------
drop policy if exists "read own accounts" on public.accounts;
create policy "read own accounts" on public.accounts
  for select using (auth.uid() = user_id);

-- ---------- payments ----------
drop policy if exists "read own payments" on public.payments;
create policy "read own payments" on public.payments
  for select using (auth.uid() = user_id);

-- ---------- ledger ----------
drop policy if exists "read own ledger" on public.ledger_entries;
create policy "read own ledger" on public.ledger_entries
  for select using (
    exists (
      select 1 from public.accounts a
       where a.id = ledger_entries.account_id
         and a.user_id = auth.uid()
    )
  );

-- ---------- withdrawals ----------
drop policy if exists "read own withdrawals" on public.withdrawal_requests;
create policy "read own withdrawals" on public.withdrawal_requests
  for select using (auth.uid() = user_id);

-- A user may cancel their own request while it is still pending; any
-- other transition belongs to an operator through the service role.
drop policy if exists "cancel own pending withdrawal" on public.withdrawal_requests;
create policy "cancel own pending withdrawal" on public.withdrawal_requests
  for update using (auth.uid() = user_id and status = 'pending')
  with check (auth.uid() = user_id and status = 'cancelled');

-- ---------- lock the money functions down ----------
-- They are security definer, so anyone who can execute them can move
-- money. Only the service role may call them.
revoke all on function public.settle_deposit(uuid, text, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.fail_payment(uuid, text, jsonb)           from public, anon, authenticated;
revoke all on function public.hold_for_withdrawal(uuid, bigint, text, jsonb) from public, anon, authenticated;
revoke all on function public.release_withdrawal(uuid, text, text)      from public, anon, authenticated;

grant execute on function public.settle_deposit(uuid, text, bigint, jsonb) to service_role;
grant execute on function public.fail_payment(uuid, text, jsonb)           to service_role;
grant execute on function public.hold_for_withdrawal(uuid, bigint, text, jsonb) to service_role;
grant execute on function public.release_withdrawal(uuid, text, text)      to service_role;


-- >>>>>>>>>> 003_admin.sql
-- ============================================================
-- Admin console support
-- Run after 001 and 002.
-- ============================================================

-- ---------- who is allowed into the console ----------
alter table public.profiles
  add column if not exists role text not null default 'customer'
    check (role in ('customer','operator','finance','admin')),
  add column if not exists status text not null default 'active'
    check (status in ('active','suspended')),
  add column if not exists suspended_reason text,
  add column if not exists trades_count integer not null default 0,
  add column if not exists last_seen_at timestamptz;

create index if not exists profiles_role_idx on public.profiles(role)
  where role <> 'customer';
create index if not exists profiles_kyc_idx on public.profiles(kyc_status);

-- ---------- every operator action is recorded ----------
-- Without this, "who approved that payout" has no answer, and an
-- operator console without an answer to that question is a liability.
create table if not exists public.admin_audit (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references auth.users(id) on delete set null,
  actor_email text,
  action      text not null,
  subject     text,                       -- user id, payment id, request id
  detail      jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_created_idx on public.admin_audit(created_at desc);
create index if not exists audit_subject_idx on public.admin_audit(subject);

alter table public.admin_audit enable row level security;
-- No policy: nothing but the service role reads or writes this.

-- ---------- helper: is the caller staff? ----------
create or replace function public.is_staff(p_user uuid)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
     where id = p_user and role in ('operator','finance','admin')
  );
$$;

-- ---------- console figures, in one round trip ----------
create or replace function public.admin_stats()
returns jsonb
language sql
security definer set search_path = public
stable
as $$
  select jsonb_build_object(
    'users',            (select count(*) from public.profiles where role = 'customer'),
    'activeUsers',      (select count(*) from public.profiles
                          where role = 'customer' and status = 'active'),
    'suspended',        (select count(*) from public.profiles where status = 'suspended'),
    'kycPending',       (select count(*) from public.profiles where kyc_status = 'pending'),
    'heldMinor',        (select coalesce(sum(balance_minor),0) from public.accounts where kind = 'real'),
    'depositsMinor',    (select coalesce(sum(amount_minor),0) from public.payments
                          where direction = 'deposit' and status = 'success'),
    'depositCount',     (select count(*) from public.payments
                          where direction = 'deposit' and status = 'success'),
    'failedCount',      (select count(*) from public.payments
                          where direction = 'deposit' and status = 'failed'),
    'pendingCount',     (select count(*) from public.payments
                          where direction = 'deposit' and status = 'pending'),
    'payoutsPending',   (select count(*) from public.withdrawal_requests where status = 'pending'),
    'payoutsPendingMinor',
                        (select coalesce(sum(amount_minor),0) from public.withdrawal_requests
                          where status = 'pending'),
    'paidOutMinor',     (select coalesce(sum(amount_minor),0) from public.withdrawal_requests
                          where status = 'paid'),
    'oldestPending',    (select min(created_at) from public.withdrawal_requests where status = 'pending')
  );
$$;

-- ---------- 14 days of money in and out ----------
-- generate_series gives a row for a quiet day too. Without it the chart
-- silently closes the gap and a dead day looks like a busy one.
create or replace function public.admin_daily(p_days integer default 14)
returns table (day date, deposits_minor bigint, withdrawals_minor bigint, signups integer)
language sql
security definer set search_path = public
stable
as $$
  with days as (
    select generate_series(
      (current_date - (p_days - 1)),
      current_date,
      interval '1 day'
    )::date as day
  )
  select
    d.day,
    coalesce((select sum(p.amount_minor) from public.payments p
               where p.direction = 'deposit' and p.status = 'success'
                 and p.settled_at::date = d.day), 0)::bigint,
    coalesce((select sum(w.amount_minor) from public.withdrawal_requests w
               where w.status = 'paid' and w.settled_at::date = d.day), 0)::bigint,
    coalesce((select count(*) from public.profiles pr
               where pr.created_at::date = d.day), 0)::integer
  from days d
  order by d.day;
$$;

-- ---------- mark a payout paid ----------
-- Money already left the balance when the request was made, so this
-- only closes the record. Idempotent: approving twice does nothing.
create or replace function public.settle_withdrawal(
  p_request_id uuid,
  p_actor uuid,
  p_note text default null
)
returns public.withdrawal_requests
language plpgsql
security definer set search_path = public
as $$
declare
  v_request public.withdrawal_requests;
begin
  select * into v_request from public.withdrawal_requests
    where id = p_request_id for update;

  if v_request is null then
    raise exception 'request % not found', p_request_id;
  end if;
  if v_request.status in ('paid','rejected','cancelled') then
    return v_request;
  end if;

  update public.withdrawal_requests
     set status = 'paid', reviewed_by = p_actor, review_note = p_note, settled_at = now()
   where id = v_request.id
  returning * into v_request;

  return v_request;
end;
$$;

revoke all on function public.admin_stats()                       from public, anon, authenticated;
revoke all on function public.admin_daily(integer)                from public, anon, authenticated;
revoke all on function public.settle_withdrawal(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.is_staff(uuid)                      from public, anon;

grant execute on function public.admin_stats()                       to service_role;
grant execute on function public.admin_daily(integer)                to service_role;
grant execute on function public.settle_withdrawal(uuid, uuid, text) to service_role;
grant execute on function public.is_staff(uuid)                      to service_role, authenticated;

-- ============================================================
-- Make yourself an operator. Sign up through the app first, then:
--
--   update public.profiles set role = 'admin' where email = 'you@example.com';
--
-- Do this by hand. An endpoint that grants admin is an endpoint that
-- eventually grants it to somebody else.
-- ============================================================


-- >>>>>>>>>> 004_growth.sql
-- ============================================================
-- Domains and marketing sessions
-- Run after 003.
-- ============================================================

-- ---------- the hosts the product is served on ----------
create table if not exists public.domains (
  id          uuid primary key default gen_random_uuid(),
  host        text not null unique,
  label       text not null default 'New',
  status      text not null default 'paused' check (status in ('live','paused')),
  created_at  timestamptz not null default now()
);

-- Every account remembers which host it arrived through, so money can
-- be attributed without guessing later.
alter table public.profiles
  add column if not exists domain_host text;

create index if not exists profiles_domain_idx on public.profiles(domain_host);

-- ---------- marketing sessions ----------
-- A stream is bought, run and measured. Exactly one may be live: the
-- partial unique index below enforces that in the database rather than
-- trusting every caller to check first.
create table if not exists public.sessions (
  id              uuid primary key default gen_random_uuid(),
  channel         text not null,
  handler         text not null,
  domain_host     text,
  note            text,
  ad_spend_minor  bigint not null default 0 check (ad_spend_minor >= 0),
  status          text not null default 'live' check (status in ('live','ended')),
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  started_by      uuid references auth.users(id) on delete set null,
  ended_by        uuid references auth.users(id) on delete set null
);

create unique index if not exists sessions_one_live
  on public.sessions ((status)) where status = 'live';

create index if not exists sessions_started_idx on public.sessions(started_at desc);

alter table public.domains  enable row level security;
alter table public.sessions enable row level security;
-- No policies: staff reach these through the service role only.

-- ============================================================
-- Figures for a session: everything that happened between its start
-- and its end (or now, if it is still running).
-- ============================================================
create or replace function public.session_figures(p_session_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public
stable
as $$
declare
  s public.sessions;
  v_from timestamptz;
  v_to timestamptz;
  v_deposits bigint;
  v_withdrawals bigint;
  v_stake bigint;
  v_signups integer;
  v_trades integer;
begin
  select * into s from public.sessions where id = p_session_id;
  if s is null then return null; end if;

  v_from := s.started_at;
  v_to := coalesce(s.ended_at, now());

  select coalesce(sum(amount_minor), 0) into v_deposits
    from public.payments
   where direction = 'deposit' and status = 'success'
     and settled_at between v_from and v_to;

  select coalesce(sum(amount_minor), 0) into v_withdrawals
    from public.withdrawal_requests
   where status = 'paid' and settled_at between v_from and v_to;

  select coalesce(count(*), 0) into v_signups
    from public.profiles
   where created_at between v_from and v_to;

  /* Stake volume and trade count come from the contracts table once
     trading moves server-side. Until then they are zero rather than
     estimated — a made-up number here would flow straight into the
     profit figure an operator makes decisions on. */
  v_stake := 0;
  v_trades := 0;

  return jsonb_build_object(
    'depositsMinor',    v_deposits,
    'withdrawalsMinor', v_withdrawals,
    'stakeVolumeMinor', v_stake,
    'marginMinor',      round(v_stake * 0.0235),
    'signups',          v_signups,
    'trades',           v_trades
  );
end;
$$;

-- ---------- money per domain ----------
create or replace function public.domain_figures()
returns table (
  host text, label text, status text,
  users integer, deposits_minor bigint, withdrawals_minor bigint
)
language sql
security definer set search_path = public
stable
as $$
  select
    d.host, d.label, d.status,
    coalesce((select count(*) from public.profiles p
               where p.domain_host = d.host), 0)::integer,
    coalesce((select sum(pay.amount_minor) from public.payments pay
               join public.profiles p on p.id = pay.user_id
              where p.domain_host = d.host
                and pay.direction = 'deposit' and pay.status = 'success'), 0)::bigint,
    coalesce((select sum(w.amount_minor) from public.withdrawal_requests w
               join public.profiles p on p.id = w.user_id
              where p.domain_host = d.host and w.status = 'paid'), 0)::bigint
  from public.domains d
  order by d.created_at;
$$;

revoke all on function public.session_figures(uuid) from public, anon, authenticated;
revoke all on function public.domain_figures()     from public, anon, authenticated;
grant execute on function public.session_figures(uuid) to service_role;
grant execute on function public.domain_figures()      to service_role;

-- The hosts this product is served from, so the console is not empty on
-- day one. The console itself is listed too: it is a domain that has to
-- be kept in the CORS allow-list and pointed at DNS like any other, and
-- a list of domains that omits one of them is a list you cannot trust.
insert into public.domains (host, label, status)
values
  ('kivobinary.com',           'Primary',  'live'),
  ('admin.kivobinary.com', 'Console',  'live')
on conflict (host) do nothing;


-- >>>>>>>>>> 005_roles.sql
-- ============================================================
-- Roles, and the first super admin
-- Run after 001-004. Safe to run more than once.
--
-- Two things happen here:
--   1. profiles.role learns the roles the console actually uses. Until
--      now the CHECK constraint allowed four; the console assigns seven.
--      Creating a 'manager' would have failed on the constraint.
--   2. You promote yourself, by hand, once.
--
-- There is deliberately no endpoint that grants admin. An endpoint that
-- can make the first super admin can make the second one for somebody
-- else, and it is reachable from the internet forever after. This runs
-- in the SQL editor, where the only way in is your Supabase password.
-- ============================================================

-- ---------- 1. the roles the console assigns ----------
alter table public.profiles
  drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check check (role in (
    'customer',
    'super_admin',      -- creates other staff; the only role that can
    'admin',
    'manager',
    'finance',          -- moves money: approves payouts
    'operator',         -- day to day: users, KYC, payments
    'marketing',
    'session_handler'   -- runs one live session at a time
  ));

-- is_staff() was written against the old four. A manager is staff.
create or replace function public.is_staff(p_user uuid)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
     where id = p_user
       and role in ('super_admin','admin','manager','finance',
                    'operator','marketing','session_handler')
       and status = 'active'
  );
$$;

revoke all on function public.is_staff(uuid) from public, anon;
grant execute on function public.is_staff(uuid) to service_role, authenticated;

-- ---------- 2. the first super admin ----------
-- The account has to exist in auth.users first, because profiles.id
-- references it and the row is created by the handle_new_user trigger.
-- So: sign up through the site (or Supabase -> Authentication -> Users
-- -> Add user, with "Auto Confirm" on), then run the statement below
-- with that email.
--
-- Uncomment, set the address, run once:
--
--   update public.profiles
--      set role = 'super_admin', status = 'active'
--    where lower(email) = lower('you@example.com');
--
-- Then check it took. This should return exactly one row:
--
--   select email, role, status from public.profiles
--    where role <> 'customer';
--
-- If it returns none, the signup did not create a profile row — look at
-- the handle_new_user trigger before promoting anything.

-- A guard rail, not a grant: it cannot create an admin, it only refuses
-- to let the last one disappear. Demoting or suspending the final active
-- super admin locks everybody out of the console, and the fix for that
-- is another trip to the SQL editor.
create or replace function public.protect_last_super_admin()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if old.role = 'super_admin'
     and old.status = 'active'
     and (new.role <> 'super_admin' or new.status <> 'active')
     and (select count(*) from public.profiles
           where role = 'super_admin' and status = 'active') <= 1 then
    raise exception 'refusing to remove the last active super admin';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_last_super_admin on public.profiles;
create trigger protect_last_super_admin
  before update on public.profiles
  for each row execute function public.protect_last_super_admin();


-- >>>>>>>>>> 006_events.sql
-- ============================================================
-- System events — the log the console can actually read
-- Run after 001-005. Safe to run more than once.
--
-- Render keeps stdout, but nothing in the admin console can read it, and
-- it is gone on the next deploy. The events worth acting on — a webhook
-- that failed its signature check, a provider that timed out, a deposit
-- that could not be recorded — are written here instead, where they can
-- be listed, filtered and kept.
--
-- This is not a copy of the request log. Only what an operator would act
-- on goes in, because a log nobody reads is the same as no log.
-- ============================================================

create table if not exists public.system_events (
  id          bigserial primary key,
  level       text not null default 'info'
              check (level in ('info','warn','error')),
  source      text not null,              -- 'paystack', 'payhero', 'cors', 'deposits'
  message     text not null,
  context     jsonb,                      -- never secrets: see log() in the API
  user_id     uuid references auth.users(id) on delete set null,
  reference   text,                       -- payment reference, when there is one
  created_at  timestamptz not null default now()
);

create index if not exists system_events_created_idx
  on public.system_events (created_at desc);
create index if not exists system_events_level_idx
  on public.system_events (level, created_at desc)
  where level <> 'info';
create index if not exists system_events_source_idx
  on public.system_events (source, created_at desc);
create index if not exists system_events_reference_idx
  on public.system_events (reference)
  where reference is not null;

alter table public.system_events enable row level security;
-- No policy, deliberately: the service role bypasses RLS and nothing
-- else may read this. Events name payment references and user ids.

-- ---------- keeping it from growing forever ----------
-- Call from a scheduled job, or by hand. Errors are kept longer than
-- chatter because they are the ones still worth reading next month.
create or replace function public.prune_system_events()
returns integer
language sql
security definer set search_path = public
as $$
  with gone as (
    delete from public.system_events
     where (level = 'info'  and created_at < now() - interval '14 days')
        or (level = 'warn'  and created_at < now() - interval '60 days')
        or (level = 'error' and created_at < now() - interval '180 days')
    returning 1
  )
  select count(*)::integer from gone;
$$;

revoke all on function public.prune_system_events() from public, anon, authenticated;
grant execute on function public.prune_system_events() to service_role;


-- >>>>>>>>>> 007_trades.sql
-- ============================================================
-- Trade history
-- Run after 001-006. Safe to run more than once.
--
-- READ THIS BEFORE TRUSTING WHAT IS IN HERE.
--
-- Contracts are still decided in the browser: the price feed, the tick
-- that settles a contract and the profit on it are all computed client
-- side. So a row in this table is *the client's account of what
-- happened*, not the server's. Anyone can open devtools and write
-- themselves a winning history.
--
-- That is acceptable for exactly one purpose, which is the purpose it is
-- built for: showing a person their own history on whatever device they
-- pick up next, instead of losing it with localStorage. It is not
-- acceptable as a basis for paying anybody anything.
--
-- Two things follow, and both are enforced below rather than trusted:
--   * Nothing here touches a balance. No trigger, no function, no path
--     from this table to accounts or ledger_entries.
--   * A row is immutable once written. No UPDATE policy, no DELETE
--     policy — a history that can be edited after the fact is not one.
--
-- When settlement moves server side, this table becomes the record of
-- what the server decided, and the insert policy below is what changes.
-- ============================================================

create table if not exists public.trades (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,

  client_ref    text not null,            -- the contract id from the browser
  account_kind  text not null default 'demo'
                check (account_kind in ('real', 'demo')),

  symbol        text not null,
  symbol_name   text,
  contract_type text not null,            -- even_odd | matches | differs | over | under
  side          text,
  barrier       smallint,

  stake_minor   bigint not null check (stake_minor >= 0),
  payout_minor  bigint not null default 0 check (payout_minor >= 0),
  profit_minor  bigint not null default 0,          -- signed: a loss is negative
  currency      text not null default 'USD',

  status        text not null check (status in ('won', 'lost')),
  ticks         smallint,
  entry_spot    numeric(18,5),
  exit_spot     numeric(18,5),
  opened_at     timestamptz not null,
  settled_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- One row per contract, however many times the client sends it. The
-- browser retries on a flaky connection and must not double-record.
create unique index if not exists trades_user_ref_idx
  on public.trades (user_id, client_ref);

create index if not exists trades_user_settled_idx
  on public.trades (user_id, settled_at desc);

alter table public.trades enable row level security;

-- Read your own, insert your own. Nothing else, for anyone.
drop policy if exists "read own trades" on public.trades;
create policy "read own trades" on public.trades
  for select using (auth.uid() = user_id);

drop policy if exists "record own trades" on public.trades;
create policy "record own trades" on public.trades
  for insert with check (auth.uid() = user_id);

-- Deliberately absent: update and delete. A settled trade is a fact.

grant select, insert on public.trades to authenticated;
revoke update, delete on public.trades from authenticated, anon;


-- >>>>>>>>>> 008_vip_mpesa.sql
-- ============================================================================
-- The VIP demo rail: account tiers and the M-Pesa clone wallets
-- Run after 001-007. Idempotent, safe to re-run.
-- ============================================================================
--
-- WHAT THIS IS FOR
-- ----------------------------------------------------------------------------
-- Every account is Standard by default and moves real money through PayHero or
-- Paystack. An admin can promote one to VIP, and a VIP's deposits settle
-- against a companion M-Pesa clone app instead: the money comes off a handset
-- in the room and lands on the trading balance in real time, so a deposit can
-- be shown working without anybody spending a shilling.
--
-- THE LINE THIS MUST NOT CROSS
-- ----------------------------------------------------------------------------
-- The wallet here is a presentation prop. It touches no PayHero credential and
-- no Paystack key, and it is reachable only for accounts an admin has marked
-- VIP. Standard accounts cannot see it, cannot call it, and remain the only
-- path real money takes. Promotion is therefore a deliberate, audited act, and
-- `tier` defaults to 'standard' so nobody arrives on the demo rail by accident.
--
-- ON THE PIN
-- ----------------------------------------------------------------------------
-- Stored in plain text, deliberately. It is assigned by an admin and never
-- chosen by the customer, so it is not and cannot be anybody's real M-Pesa PIN,
-- and the console has to read it back to tell the customer what to type. It
-- guards a prop balance. If this ever gates anything real it needs hashing and
-- rate limiting first, and this comment is the reason to remember that.
--
-- PRIVILEGE MODEL
-- ----------------------------------------------------------------------------
-- service_role only. Both tables have RLS on and no policies, so `anon` and
-- `authenticated` cannot touch them at all. The routes reach them under the
-- service key, having first checked either the caller's tier or the handset's
-- device token.
-- ============================================================================

-- --- 1. Tier -----------------------------------------------------------------

alter table public.profiles
  add column if not exists tier text not null default 'standard'
    check (tier in ('standard', 'vip'));

create index if not exists profiles_tier_idx
  on public.profiles (tier) where tier <> 'standard';

-- --- 1b. The demo rail is a payment provider like any other -------------------
-- A VIP deposit still writes a payments row and still settles through
-- settle_deposit, so it appears in the ledger, in the console and in the
-- customer's history exactly as a real one does. Only the provider differs,
-- and the name says plainly which rows were not real money.

alter table public.payments
  drop constraint if exists payments_provider_check;

alter table public.payments
  add constraint payments_provider_check
  check (provider in ('paystack', 'payhero', 'manual', 'mpesa_demo'));

-- --- 2. The wallets ----------------------------------------------------------

create table if not exists public.mpesa_demo_wallet (
  user_id         uuid        primary key references auth.users (id) on delete cascade,
  pin             text        not null check (pin ~ '^\d{4}$'),
  device_token    uuid        not null default gen_random_uuid(),
  balance_minor   bigint      not null default 0 check (balance_minor >= 0),

  -- Fuliza: the overdraft the handset may go into. Set by the admin rather
  -- than derived from the balance, because on this rail it is a thing being
  -- demonstrated, not a thing being simulated. used_minor is what is currently
  -- owed and is repaid automatically from the next money in, which is how the
  -- real product behaves and the part people want to see.
  fuliza_limit_minor bigint   not null default 0 check (fuliza_limit_minor >= 0),
  fuliza_used_minor  bigint   not null default 0 check (fuliza_used_minor >= 0),

  -- What the handset shows at the top of its screen.
  holder_name     text,
  phone           text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- The phone presents a PIN and nothing else, so a PIN must identify exactly
-- one wallet. Assigning one already in use is refused rather than resolved
-- arbitrarily: a handset linked to the wrong customer stays invisible until it
-- shows the wrong balance in front of the room.
create unique index if not exists mpesa_demo_wallet_pin_key
  on public.mpesa_demo_wallet (pin);
create unique index if not exists mpesa_demo_wallet_token_key
  on public.mpesa_demo_wallet (device_token);

-- --- 3. The statement --------------------------------------------------------

create table if not exists public.mpesa_demo_tx (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references auth.users (id) on delete cascade,
  kind                text        not null check (kind in
                        ('DEPOSIT', 'WITHDRAWAL', 'AGENT_WITHDRAWAL',
                         'RECEIVE', 'FULIZA_REPAY', 'REVERSAL')),
  title               text        not null,
  subtitle            text        not null default '',
  amount_minor        bigint      not null,      -- signed: negative leaves the phone
  balance_after_minor bigint      not null,
  fuliza_after_minor  bigint      not null default 0,
  reference           text        not null,
  created_at          timestamptz not null default now()
);

create index if not exists mpesa_demo_tx_user_created_idx
  on public.mpesa_demo_tx (user_id, created_at desc);

alter table public.mpesa_demo_wallet enable row level security;
alter table public.mpesa_demo_tx     enable row level security;

-- --- 4. Admin: create or adjust one wallet -----------------------------------

/*
 * Every field optional except on creation, where a PIN is required: a wallet
 * no PIN reaches is a wallet no handset can ever link to.
 *
 * Setting a balance does NOT clear the statement. An admin correcting an
 * opening figure between rehearsals should not silently destroy the history
 * that explains it; mpesa_demo_reset is the one that wipes.
 */
create or replace function public.mpesa_demo_set_wallet(
  p_user         uuid,
  p_pin          text   default null,
  p_balance      bigint default null,
  p_fuliza_limit bigint default null,
  p_name         text   default null,
  p_phone        text   default null
) returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_exists boolean;
  v_row    public.mpesa_demo_wallet;
begin
  select exists (select 1 from public.mpesa_demo_wallet where user_id = p_user)
    into v_exists;

  if p_pin is not null and p_pin !~ '^\d{4}$' then
    raise exception 'BAD_PIN';
  end if;
  if p_balance is not null and p_balance < 0 then
    raise exception 'BAD_BALANCE';
  end if;
  if p_fuliza_limit is not null and p_fuliza_limit < 0 then
    raise exception 'BAD_FULIZA';
  end if;
  if not v_exists and p_pin is null then
    raise exception 'PIN_REQUIRED';
  end if;

  if v_exists then
    update public.mpesa_demo_wallet
       set pin                = coalesce(p_pin, pin),
           balance_minor      = coalesce(p_balance, balance_minor),
           fuliza_limit_minor = coalesce(p_fuliza_limit, fuliza_limit_minor),
           holder_name        = coalesce(p_name, holder_name),
           phone              = coalesce(p_phone, phone),
           updated_at         = now()
     where user_id = p_user
    returning * into v_row;
  else
    insert into public.mpesa_demo_wallet
      (user_id, pin, balance_minor, fuliza_limit_minor, holder_name, phone)
    values
      (p_user, p_pin, coalesce(p_balance, 0), coalesce(p_fuliza_limit, 0), p_name, p_phone)
    returning * into v_row;
  end if;

  return to_jsonb(v_row);
exception
  when unique_violation then
    raise exception 'PIN_TAKEN';
end;
$$;

/** Removes a wallet and its statement, unlinking any handset holding its token. */
create or replace function public.mpesa_demo_clear_wallet(p_user uuid)
returns boolean
language plpgsql
security definer set search_path = public
as $$
begin
  delete from public.mpesa_demo_tx     where user_id = p_user;
  delete from public.mpesa_demo_wallet where user_id = p_user;
  return true;
end;
$$;

-- --- 5. The handset: link by PIN, then read by token -------------------------

/*
 * Exchanges a PIN for a device token.
 *
 * Returns null when no wallet carries that PIN. The route answers "wrong PIN"
 * either way, so the handset cannot be used to discover which PINs exist.
 */
create or replace function public.mpesa_demo_link(p_pin text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_row public.mpesa_demo_wallet;
begin
  select * into v_row from public.mpesa_demo_wallet where pin = p_pin;
  if not found then return null; end if;
  return to_jsonb(v_row);
end;
$$;

/** The wallet behind a device token, or null when the token is unknown. */
create or replace function public.mpesa_demo_by_token(p_token uuid)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_row public.mpesa_demo_wallet;
begin
  select * into v_row from public.mpesa_demo_wallet where device_token = p_token;
  if not found then return null; end if;
  return to_jsonb(v_row);
end;
$$;

-- --- 6. Movement -------------------------------------------------------------

/*
 * One movement on one wallet, applied atomically, with Fuliza.
 *
 * `for update` on the wallet row is what makes this safe: the terminal
 * depositing while the handset polls and withdraws would otherwise both read
 * the same balance and the second write would erase the first. Under the lock
 * they serialise.
 *
 * Fuliza behaves as the real product does, because that is what is being
 * demonstrated:
 *   - money out that the balance cannot cover draws the shortfall from the
 *     limit, and the balance floors at zero
 *   - money in repays what is owed first, and only the remainder lands on the
 *     balance
 * A debit that exceeds balance + remaining limit is refused outright.
 */
create or replace function public.mpesa_demo_move(
  p_user      uuid,
  p_kind      text,
  p_amount    bigint,
  p_direction text,
  p_title     text,
  p_subtitle  text,
  p_reference text
) returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_balance  bigint;
  v_limit    bigint;
  v_used     bigint;
  v_signed   bigint;
  v_short    bigint;
  v_repay    bigint;
  v_tx       public.mpesa_demo_tx;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'BAD_AMOUNT';
  end if;
  if p_direction not in ('IN', 'OUT') then
    raise exception 'BAD_DIRECTION';
  end if;

  select balance_minor, fuliza_limit_minor, fuliza_used_minor
    into v_balance, v_limit, v_used
    from public.mpesa_demo_wallet
   where user_id = p_user
     for update;

  if not found then
    raise exception 'NO_WALLET';
  end if;

  if p_direction = 'OUT' then
    v_signed := -p_amount;

    if p_amount > v_balance then
      v_short := p_amount - v_balance;
      if v_used + v_short > v_limit then
        raise exception 'INSUFFICIENT_FUNDS';
      end if;
      v_used    := v_used + v_short;
      v_balance := 0;
    else
      v_balance := v_balance - p_amount;
    end if;
  else
    v_signed := p_amount;

    -- Money in clears the overdraft before it touches the balance.
    v_repay := least(v_used, p_amount);
    v_used  := v_used - v_repay;
    v_balance := v_balance + (p_amount - v_repay);
  end if;

  update public.mpesa_demo_wallet
     set balance_minor     = v_balance,
         fuliza_used_minor = v_used,
         updated_at        = now()
   where user_id = p_user;

  insert into public.mpesa_demo_tx (
    user_id, kind, title, subtitle,
    amount_minor, balance_after_minor, fuliza_after_minor, reference
  ) values (
    p_user, p_kind, p_title, coalesce(p_subtitle, ''),
    v_signed, v_balance, v_used, p_reference
  )
  returning * into v_tx;

  return jsonb_build_object(
    'balanceMinor',     v_balance,
    'fulizaUsedMinor',  v_used,
    'fulizaLimitMinor', v_limit,
    'tx',               to_jsonb(v_tx)
  );
end;
$$;

-- --- 7. Reset ----------------------------------------------------------------

/*
 * One wallet back to a chosen balance with an empty statement and no
 * overdraft, for rehearsing: run the demo, reset, run it again in front of the
 * room. The device token is left alone so the handset stays linked.
 */
create or replace function public.mpesa_demo_reset(
  p_user    uuid,
  p_balance bigint default null
) returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_row public.mpesa_demo_wallet;
begin
  delete from public.mpesa_demo_tx where user_id = p_user;

  update public.mpesa_demo_wallet
     set balance_minor     = coalesce(p_balance, balance_minor),
         fuliza_used_minor = 0,
         updated_at        = now()
   where user_id = p_user
  returning * into v_row;

  if not found then raise exception 'NO_WALLET'; end if;
  return to_jsonb(v_row);
end;
$$;

-- --- 8. Privileges -----------------------------------------------------------
-- Nobody but the service role. These move a prop balance on the say-so of the
-- caller, and the only callers allowed to ask are route handlers that have
-- already verified the account's tier or the handset's device token.

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.mpesa_demo_set_wallet(uuid, text, bigint, bigint, text, text)',
    'public.mpesa_demo_clear_wallet(uuid)',
    'public.mpesa_demo_link(text)',
    'public.mpesa_demo_by_token(uuid)',
    'public.mpesa_demo_move(uuid, text, bigint, text, text, text, text)',
    'public.mpesa_demo_reset(uuid, bigint)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;


-- >>>>>>>>>> 009_demo_mode.sql
-- ============================================================================
-- VIP demo mode
-- Run after 001-008. Idempotent, safe to re-run.
-- ============================================================================
--
-- A presentation switch for VIP accounts. With it on, contracts on that
-- account settle in the customer's favour almost always, so a walkthrough does
-- not fall apart on a losing streak. VIP accounts fund from the M-Pesa clone
-- wallet, so the money going in is a prop.
--
-- WHAT THIS IS NOT
-- ----------------------------------------------------------------------------
-- It is not on by default, it cannot be turned on for a Standard account, and
-- it changes nothing about how real accounts trade. Standard accounts run on
-- the published odds, which is the only thing the Learn and Risk pages
-- describe and the only thing this platform sells.
--
-- THE PART THAT IS NOT A PROP
-- ----------------------------------------------------------------------------
-- A VIP's deposit is fake but the balance it creates is not: settle_deposit
-- credits accounts.kind = 'real', and withdrawal_request debits that same row.
-- So winnings made under this mode sit in the real ledger and can be requested
-- as cash. The control is that every payout is reviewed by a person and no
-- automatic payout route exists, which is why `tier` and `demo_mode` are
-- surfaced on the withdrawal screen by 009 and the admin routes: a reviewer
-- cannot act on what they cannot see.
--
-- Trades made under the mode are tagged, so the console's own figures can tell
-- a demonstration from the business. A win rate that includes staged wins is a
-- number nobody can use.
-- ============================================================================

alter table public.profiles
  add column if not exists demo_mode boolean not null default false;

/*
 * Only a VIP may have it on. Enforced here rather than in a route because a
 * route is one place and the database is the last one: a Standard account with
 * this flag set is the exact state that must never exist, however it is
 * reached.
 */
create or replace function public.enforce_demo_mode_tier()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.demo_mode and new.tier <> 'vip' then
    raise exception 'DEMO_MODE_REQUIRES_VIP';
  end if;
  /* Demoting to Standard takes the mode with it, rather than leaving it set
     and waiting to surprise somebody on the next promotion. */
  if new.tier <> 'vip' then
    new.demo_mode := false;
  end if;
  return new;
end;
$$;

drop trigger if exists demo_mode_requires_vip on public.profiles;
create trigger demo_mode_requires_vip
  before insert or update on public.profiles
  for each row execute function public.enforce_demo_mode_tier();

-- Existing rows that predate the trigger.
update public.profiles set demo_mode = false where demo_mode and tier <> 'vip';

-- --- A payout that went to the handset ---------------------------------------
-- A VIP's withdrawal is paid onto the prop wallet rather than queued for a
-- person to send. It is still a withdrawal_requests row, so the ledger reads
-- the same, and the method says plainly which ones were not real money.

alter table public.withdrawal_requests
  drop constraint if exists withdrawal_requests_method_check;

alter table public.withdrawal_requests
  add constraint withdrawal_requests_method_check
  check (method in ('mpesa', 'bank', 'mpesa_demo'));

-- --- The tag on a trade -------------------------------------------------------

alter table public.trades
  add column if not exists demo_mode boolean not null default false;

create index if not exists trades_demo_idx
  on public.trades (user_id, demo_mode) where demo_mode;


-- >>>>>>>>>> 010_verifications.sql
-- ============================================================================
-- Verifications: proof of address
-- Run after 001-009. Idempotent, safe to re-run.
-- ============================================================================
--
-- Until now the whole identity flow lived in the browser: the picker took a
-- photo, a local flag said "verified", and nothing ever reached a server. So
-- the console's approve button had nothing to approve, and a withdrawal was
-- gated on a value the customer's own browser had set. This is the missing
-- half.
--
-- WHAT WE COLLECT, AND WHAT WE DELIBERATELY DO NOT
-- ----------------------------------------------------------------------------
-- Proof of address only. Government ID is not collected: holding passport and
-- national ID images is the highest-consequence data a business of this size
-- can hold, and until there is a reason to need it, and somewhere properly
-- locked to keep it, not having it is the safer position. The interface says
-- "coming soon" rather than pretending the option is gone, because it will be
-- back when payouts get large enough to require it.
--
-- WHERE THE FILE LIVES
-- ----------------------------------------------------------------------------
-- A private Supabase Storage bucket. The browser uploads straight to it with
-- the customer's own token, into a folder named after their user id, so a
-- document never passes through our API and never sits in a log. Nobody can
-- read it back: there is no select policy for customers at all. Staff see it
-- through a short-lived signed URL the API mints with the service role.
-- ============================================================================

-- --- 1. The bucket -----------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'kyc', 'kyc', false, 8388608,
  array['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

/*
 * Upload into your own folder, and nothing else. No select, no update, no
 * delete: a customer can hand a document in and cannot take it back out, which
 * is the same property a counter has.
 */
drop policy if exists "kyc upload own folder" on storage.objects;
create policy "kyc upload own folder" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'kyc'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- --- 2. The submissions ------------------------------------------------------

create table if not exists public.kyc_submissions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,

  kind          text not null default 'proof_of_address'
                check (kind in ('proof_of_address', 'government_id')),
  storage_path  text not null,
  mime_type     text,
  byte_size     integer,

  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'rejected')),
  note          text,                       -- why, when rejected
  reviewed_by   uuid references auth.users (id) on delete set null,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists kyc_submissions_status_idx
  on public.kyc_submissions (status, created_at);
create index if not exists kyc_submissions_user_idx
  on public.kyc_submissions (user_id, created_at desc);

-- One open submission per person. Somebody who uploads four times while
-- waiting should not produce four things to review.
create unique index if not exists kyc_submissions_one_pending
  on public.kyc_submissions (user_id) where status = 'pending';

alter table public.kyc_submissions enable row level security;

/* Read your own, so the app can show "under review" honestly. Writing is the
   API's job: a customer who could insert their own row could set its status. */
drop policy if exists "read own submissions" on public.kyc_submissions;
create policy "read own submissions" on public.kyc_submissions
  for select using (auth.uid() = user_id);

grant select on public.kyc_submissions to authenticated;
revoke insert, update, delete on public.kyc_submissions from authenticated, anon;

-- --- 3. Deciding one ---------------------------------------------------------

/*
 * Approve or reject, and move the profile with it, in one transaction. Two
 * statements from a route is how an account ends up approved with its
 * submission still pending, or the reverse, and the reverse is the one that
 * opens a payout nobody agreed to.
 */
create or replace function public.decide_kyc(
  p_submission uuid,
  p_actor      uuid,
  p_approve    boolean,
  p_note       text default null
) returns public.kyc_submissions
language plpgsql
security definer set search_path = public
as $$
declare
  v_row public.kyc_submissions;
begin
  select * into v_row from public.kyc_submissions
    where id = p_submission for update;

  if v_row is null then
    raise exception 'SUBMISSION_NOT_FOUND';
  end if;
  if v_row.status <> 'pending' then
    return v_row;                      -- already decided; do nothing
  end if;

  update public.kyc_submissions
     set status      = case when p_approve then 'approved' else 'rejected' end,
         note        = p_note,
         reviewed_by = p_actor,
         reviewed_at = now()
   where id = v_row.id
  returning * into v_row;

  update public.profiles
     set kyc_status = case when p_approve then 'verified' else 'rejected' end
   where id = v_row.user_id;

  return v_row;
end;
$$;

revoke all on function public.decide_kyc(uuid, uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.decide_kyc(uuid, uuid, boolean, text) to service_role;


-- >>>>>>>>>> 011_payout_methods.sql
-- 011_payout_methods.sql
-- Card and USDT payouts.
--
-- The withdrawal methods were mpesa, bank and mpesa_demo. The sheet now
-- offers a card refund and a USDT address as well, and the check
-- constraint would reject both. Safe to run whether or not 009 has been
-- applied: it drops the constraint by name and writes the full set.

alter table public.withdrawal_requests
  drop constraint if exists withdrawal_requests_method_check;

alter table public.withdrawal_requests
  add constraint withdrawal_requests_method_check
  check (method in ('mpesa', 'bank', 'card', 'usdt', 'mpesa_demo'));


-- >>>>>>>>>> 012_tickets.sql
-- ============================================================================
-- Support tickets
-- Run after 001-011. Idempotent, safe to re-run.
-- ============================================================================
--
-- The support page was a chat window that answered itself: a message went into
-- a div, a canned reply came back nine hundred milliseconds later, and nothing
-- left the browser. Nobody on the team ever saw it. A customer who had lost a
-- deposit typed the whole story into a box that threw it away.
--
-- A ticket is the smaller, honest version of that: a category, a description,
-- one reply, and a status the customer can see. It is worth less than live
-- chat and it is worth infinitely more than a simulation of live chat.
-- ============================================================================

create table if not exists public.support_tickets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  category    text not null check (category in (
                'deposit', 'withdrawal', 'account', 'trading', 'other')),
  body        text not null check (length(btrim(body)) between 10 and 2000),
  status      text not null default 'open' check (status in ('open', 'answered', 'closed')),
  reply       text,
  replied_at  timestamptz,
  replied_by  uuid,
  created_at  timestamptz not null default now()
);

create index if not exists support_tickets_user_idx
  on public.support_tickets (user_id, created_at desc);
create index if not exists support_tickets_open_idx
  on public.support_tickets (created_at) where status = 'open';

/*
 * Three open tickets is a person who is not being answered, not a person with
 * three problems. The cap is on open ones only, so a customer whose ticket has
 * been answered can always come back.
 */
create or replace function public.open_ticket_count(p_user uuid)
returns integer language sql stable as $$
  select count(*)::int from public.support_tickets
   where user_id = p_user and status = 'open';
$$;

alter table public.support_tickets enable row level security;

drop policy if exists "tickets read own" on public.support_tickets;
create policy "tickets read own" on public.support_tickets
  for select to authenticated
  using (user_id = auth.uid());

-- Writes go through the API with the service role, which is what applies the
-- open-ticket cap. There is deliberately no insert policy for customers.

/*
 * Answering a ticket. One function so the reply, the status and the timestamp
 * can never disagree with each other, which is what happens the first time
 * somebody updates the reply column by hand.
 */
create or replace function public.reply_ticket(
  p_ticket uuid,
  p_actor  uuid,
  p_reply  text,
  p_close  boolean default false
) returns public.support_tickets
language plpgsql security definer set search_path = public as $$
declare
  v_row public.support_tickets;
begin
  if p_reply is null or length(btrim(p_reply)) < 2 then
    raise exception 'REPLY_EMPTY';
  end if;

  update public.support_tickets
     set reply      = btrim(p_reply),
         status     = case when p_close then 'closed' else 'answered' end,
         replied_at = now(),
         replied_by = p_actor
   where id = p_ticket
   returning * into v_row;

  if not found then
    raise exception 'TICKET_NOT_FOUND';
  end if;

  return v_row;
end;
$$;

revoke all on function public.reply_ticket(uuid, uuid, text, boolean) from public, anon, authenticated;


-- >>>>>>>>>> 013_usdt.sql
-- ============================================================================
-- USDT deposits, TRC-20
-- Run after 001-012. Idempotent, safe to re-run.
-- ============================================================================
--
-- A crypto deposit has no callback. Nobody tells us a transfer happened: it
-- lands in a wallet, and the only thing connecting it to an account is the
-- customer saying "that one was me". So the row is written as pending with
-- the transaction hash on it, and somebody credits it after looking at the
-- chain. That is slower than a card and it is the honest shape of the rail.
--
-- The provider is named rather than folded into 'manual', so a year from now
-- the ledger still says which rail the money came in on.
-- ============================================================================

alter table public.payments
  drop constraint if exists payments_provider_check;

-- Every provider that has ever been written, not just the new one. 008 added
-- 'mpesa_demo' for the VIP handset rail; leaving it out here is why this
-- migration failed the first time it was run against a database that had one.
alter table public.payments
  add constraint payments_provider_check
  check (provider in ('paystack', 'payhero', 'manual', 'mpesa_demo', 'usdt'));

-- One hash, one credit. Without this, the same transfer pasted twice is two
-- pending rows, and two people crediting them is the account paid twice for
-- money that arrived once.
create unique index if not exists payments_usdt_tx_idx
  on public.payments ((raw ->> 'txHash'))
  where provider = 'usdt' and raw ->> 'txHash' is not null;


-- >>>>>>>>>> 014_trade_balance.sql
-- ============================================================================
-- Settled trades move the real balance
-- Run after 001-013. Idempotent, safe to re-run.
-- ============================================================================
--
-- READ THIS. IT CHANGES WHAT A TRADE CAN DO.
--
-- Until now nothing a customer did in the terminal touched the server. They
-- deposited, the balance went up; they traded, a number in their browser moved
-- and the server never heard about it; they withdrew, and the request was held
-- against the deposit. See the note at the top of 007_trades.sql, which was
-- true when it was written and stops being true here.
--
-- That gap ran in both directions and one of them costs money:
--
--   * Somebody who deposited 50 and lost it could still withdraw 50, because
--     the loss never reached the server. The business pays out money that has
--     already been lost.
--   * Somebody who deposited 50 and won 300 could only withdraw 50, because
--     the winnings did not exist here either. The customer is told the money
--     on their screen is not real.
--
-- So settled trades now move accounts.balance_minor.
--
-- WHAT THIS DOES NOT FIX, AND MUST NOT BE MISTAKEN FOR
-- ----------------------------------------------------------------------------
-- Contracts are still decided in the browser. This function applies the result
-- the client reports; it cannot check whether the contract really won, because
-- the price feed and the tick that settles it live on the client.
--
-- What it can check, and does:
--   * the payout is arithmetically possible for the contract type claimed, at
--     the published odds, so a client cannot report a 50x return on an
--     even/odd contract
--   * the stake is inside the published limits
--   * one movement per trade, ever, by client_ref
--   * a real balance never goes below zero
--
-- What it cannot check is the word "won". A determined person with devtools can
-- report wins they did not have, and the ceiling on that is the payout multiple
-- and the stake limit, not honesty. That is a real exposure and it is the
-- reason settlement has to move server side before volumes grow. Until it does,
-- watch the win rate per account: staged wins are tagged demo_mode, and anything
-- else far above the published probability is somebody writing their own.
-- ============================================================================

-- --- The odds, on the server ------------------------------------------------
-- The same table the browser uses. Here so the payout claimed can be checked
-- against what the contract could actually pay, rather than believed.
create or replace function public.payout_multiple(p_type text)
returns numeric language sql immutable as $$
  select case p_type
    when 'even_odd' then 1.953
    when 'matches'  then 10.35
    when 'differs'  then 1.084
    when 'over'     then 1.72
    when 'under'    then 1.72
    else 0
  end;
$$;

-- --- Applying one settled contract -------------------------------------------
create or replace function public.settle_trade(
  p_user_id     uuid,
  p_client_ref  text,
  p_type        text,
  p_stake_minor bigint,
  p_payout_minor bigint,
  p_won         boolean
) returns bigint                       -- the balance after, in minor units
language plpgsql security definer set search_path = public as $$
declare
  v_account   public.accounts;
  v_multiple  numeric;
  v_max_payout bigint;
  v_delta     bigint;
  v_new       bigint;
  v_memo      text;
begin
  if p_stake_minor <= 0 then
    raise exception 'STAKE_INVALID';
  end if;

  -- The published ceiling, 5,000.00, same as LIMITS.max in the browser.
  if p_stake_minor > 500000 then
    raise exception 'STAKE_ABOVE_LIMIT';
  end if;

  v_multiple := public.payout_multiple(p_type);
  if v_multiple = 0 then
    raise exception 'CONTRACT_UNKNOWN';
  end if;

  -- A won contract pays stake x multiple. One cent of slack for the rounding
  -- the client does; anything past that is a claim the odds cannot support.
  v_max_payout := ceil(p_stake_minor * v_multiple) + 1;
  if p_won and p_payout_minor > v_max_payout then
    raise exception 'PAYOUT_ABOVE_ODDS';
  end if;
  if not p_won and p_payout_minor <> 0 then
    raise exception 'PAYOUT_ON_A_LOSS';
  end if;

  select * into v_account
    from public.accounts
   where user_id = p_user_id and kind = 'real'
   for update;

  if not found then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;

  -- One movement per contract, ever. The client re-sends its history on every
  -- load, and without this each re-send would pay the same win again.
  if exists (
    select 1 from public.ledger_entries
     where account_id = v_account.id
       and kind = 'trade'
       and memo = 'trade ' || p_client_ref
  ) then
    return v_account.balance_minor;
  end if;

  -- Net, because the stake was never taken at buy time on this side: a loss is
  -- the stake off, a win is the stake back plus the profit.
  v_delta := case when p_won then p_payout_minor - p_stake_minor else -p_stake_minor end;
  v_new := v_account.balance_minor + v_delta;

  -- A real balance never goes below zero. It should not be able to: the browser
  -- will not let a stake exceed the balance. If it happens anyway the shortfall
  -- is the interesting part, so it is written down rather than swallowed.
  if v_new < 0 then
    v_memo := 'trade ' || p_client_ref;
    insert into public.ledger_entries
      (account_id, kind, amount_minor, balance_after_minor, memo)
    values
      (v_account.id, 'trade', -v_account.balance_minor, 0,
       v_memo || ' (clamped, short by ' || abs(v_new) || ')');

    update public.accounts set balance_minor = 0
     where id = v_account.id;
    return 0;
  end if;

  update public.accounts
     set balance_minor = v_new
   where id = v_account.id;

  insert into public.ledger_entries
    (account_id, kind, amount_minor, balance_after_minor, memo)
  values
    (v_account.id, 'trade', v_delta, v_new, 'trade ' || p_client_ref);

  return v_new;
end;
$$;

-- Callable only through the API's service role, like every other money
-- function here. A customer's own token must never be able to call this.
revoke all on function public.settle_trade(uuid, text, text, bigint, bigint, boolean)
  from public, anon, authenticated;

-- Finding the ledger entry for a contract is how the idempotency check above
-- works, and it runs on every single settled trade.
create index if not exists ledger_trade_memo_idx
  on public.ledger_entries (account_id, memo)
  where kind = 'trade';


-- >>>>>>>>>> 015_copy_keys_and_runs.sql
-- ============================================================================
-- Copy-trading keys, and automated runs the server keeps count of
-- Run after 001-014. Idempotent, safe to re-run.
-- ============================================================================
--
-- 1. COPY-TRADING KEYS
--    Copy trading is switched on per account with a key staff issue from the
--    console. A key works once, for one account. Redeeming it sets
--    profiles.copy_active, which /auth/session reports to the browser.
--
-- 2. AUTOMATED RUNS
--    An automated run no longer has a fixed number of contracts. It keeps
--    going until its running profit reaches the target or its running loss
--    reaches the stop, and the server is the one keeping that count: every
--    contract recorded against a run moves the run's P/L here, and the answer
--    to "does it carry on" comes back from /trades.
--
--    The same caveat as 014 applies. Contracts are still settled in the
--    browser, so the P/L here is the sum of what the client reported. What
--    this adds is that the stop rules live on the server, next to the ledger,
--    rather than in a page somebody can edit.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Copy-trading keys
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists copy_active boolean not null default false;

create table if not exists public.copy_keys (
  id           uuid primary key default gen_random_uuid(),
  key          text not null unique,
  note         text,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  redeemed_by  uuid references auth.users(id) on delete set null,
  redeemed_at  timestamptz,
  revoked_at   timestamptz
);

create index if not exists copy_keys_created_idx on public.copy_keys (created_at desc);

-- Staff only, through the API's service role. A customer never reads this
-- table: a list of keys is a list of free activations.
alter table public.copy_keys enable row level security;
revoke all on public.copy_keys from anon, authenticated;

-- Redeem one key for one account, in one transaction. The row is locked so two
-- people typing the same key at the same moment cannot both have it.
create or replace function public.redeem_copy_key(p_user_id uuid, p_key text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_key public.copy_keys;
begin
  select * into v_key
    from public.copy_keys
   where key = upper(trim(p_key))
   for update;

  if not found or v_key.revoked_at is not null then
    raise exception 'KEY_INVALID';
  end if;

  if v_key.redeemed_by is not null then
    -- The same account entering its own key again is not an error.
    if v_key.redeemed_by = p_user_id then
      update public.profiles set copy_active = true where id = p_user_id;
      return true;
    end if;
    raise exception 'KEY_USED';
  end if;

  update public.copy_keys
     set redeemed_by = p_user_id, redeemed_at = now()
   where id = v_key.id;

  update public.profiles set copy_active = true where id = p_user_id;
  return true;
end;
$$;

revoke all on function public.redeem_copy_key(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Automated runs
-- ---------------------------------------------------------------------------
create table if not exists public.auto_runs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  account_kind      text not null default 'demo' check (account_kind in ('real', 'demo')),

  take_profit_minor bigint not null check (take_profit_minor > 0),
  stop_loss_minor   bigint not null check (stop_loss_minor > 0),
  multiplier        numeric(6,2) not null default 1 check (multiplier >= 1 and multiplier <= 5),
  base_stake_minor  bigint not null check (base_stake_minor > 0),

  -- running until one of the two rules is met, or the trader stops it
  status            text not null default 'running'
                    check (status in ('running', 'take_profit', 'stop_loss', 'stopped')),

  trades            integer not null default 0,
  wins              integer not null default 0,
  losses            integer not null default 0,
  pnl_minor         bigint  not null default 0,

  started_at        timestamptz not null default now(),
  ended_at          timestamptz
);

create index if not exists auto_runs_user_idx on public.auto_runs (user_id, started_at desc);

alter table public.auto_runs enable row level security;

drop policy if exists "read own runs" on public.auto_runs;
create policy "read own runs" on public.auto_runs
  for select using (auth.uid() = user_id);

-- Written only through the API's service role.
grant select on public.auto_runs to authenticated;
revoke insert, update, delete on public.auto_runs from authenticated, anon;

-- Which run a contract belonged to, if any.
alter table public.trades
  add column if not exists run_id uuid references public.auto_runs(id) on delete set null;

create index if not exists trades_run_idx on public.trades (run_id) where run_id is not null;

-- Apply one settled contract to its run, and decide whether the run carries on.
-- Called once per newly recorded trade, so a re-sent trade does not count
-- twice. A run that has already ended is returned as it is and not moved.
create or replace function public.apply_run_trade(
  p_run_id       uuid,
  p_user_id      uuid,
  p_profit_minor bigint
) returns public.auto_runs
language plpgsql security definer set search_path = public as $$
declare
  v_run public.auto_runs;
begin
  select * into v_run
    from public.auto_runs
   where id = p_run_id and user_id = p_user_id
   for update;

  if not found then
    raise exception 'RUN_NOT_FOUND';
  end if;

  if v_run.status <> 'running' then
    return v_run;
  end if;

  v_run.trades    := v_run.trades + 1;
  v_run.wins      := v_run.wins   + case when p_profit_minor >= 0 then 1 else 0 end;
  v_run.losses    := v_run.losses + case when p_profit_minor <  0 then 1 else 0 end;
  v_run.pnl_minor := v_run.pnl_minor + p_profit_minor;

  -- The only two ways a run ends on its own.
  if v_run.pnl_minor >= v_run.take_profit_minor then
    v_run.status := 'take_profit';
    v_run.ended_at := now();
  elsif -v_run.pnl_minor >= v_run.stop_loss_minor then
    v_run.status := 'stop_loss';
    v_run.ended_at := now();
  end if;

  update public.auto_runs
     set trades = v_run.trades, wins = v_run.wins, losses = v_run.losses,
         pnl_minor = v_run.pnl_minor, status = v_run.status, ended_at = v_run.ended_at
   where id = v_run.id;

  return v_run;
end;
$$;

revoke all on function public.apply_run_trade(uuid, uuid, bigint) from public, anon, authenticated;


-- >>>>>>>>>> 016_kyc_one_submission.sql
-- ============================================================================
-- Verification in one submission
-- Run after 001-015. Idempotent, safe to re-run.
-- ============================================================================
--
-- Proof of address and both sides of a government ID used to go in as separate
-- submissions, one at a time. With only one submission allowed under review per
-- person, the second document was refused as "already under review", and
-- approving any one document verified the whole account.
--
-- Now everything goes in together: one submission carries every file in
-- `files`, a reviewer looks at them side by side, and one approval verifies the
-- account. A new full submission replaces one still waiting (the old row is
-- marked superseded), so nobody is stuck behind a half-finished upload.
-- ============================================================================

alter table public.kyc_submissions
  add column if not exists files jsonb not null default '[]'::jsonb;

-- 'full' is a submission carrying every document in `files`.
alter table public.kyc_submissions
  drop constraint if exists kyc_submissions_kind_check;
alter table public.kyc_submissions
  add constraint kyc_submissions_kind_check
  check (kind in ('proof_of_address', 'government_id', 'full'));

-- 'superseded' is a submission replaced by a newer full one before review.
alter table public.kyc_submissions
  drop constraint if exists kyc_submissions_status_check;
alter table public.kyc_submissions
  add constraint kyc_submissions_status_check
  check (status in ('pending', 'approved', 'rejected', 'superseded'));


-- >>>>>>>>>> 017_vip_copy_keys.sql
-- ============================================================================
-- Copy-trading keys for VIP accounts
-- Run after 001-016. Idempotent, safe to re-run.
-- ============================================================================
--
-- VIP accounts hand out copy-trading keys of their own. Each key still works
-- once, on one account, exactly like a key made in the console; the only
-- difference is who made it (copy_keys.created_by is the VIP's user id).
--
-- This gives every existing VIP one unused key now, so the card on their copy
-- trading page has something in it from the first visit. VIPs promoted later
-- get theirs from the API the first time they open the page.
-- ============================================================================

-- Twelve characters from an alphabet with no 0/O or 1/I/L, grouped in fours,
-- drawn from gen_random_uuid() (a secure random source) rather than random().
create or replace function public.new_copy_key()
returns text
language plpgsql volatile set search_path = public as $$
declare
  v_alpha text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_hex   text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_out   text := '';
  v_i     int;
  v_byte  int;
begin
  for v_i in 0..11 loop
    if v_i > 0 and v_i % 4 = 0 then
      v_out := v_out || '-';
    end if;
    v_byte := ('x' || substr(v_hex, v_i * 2 + 1, 2))::bit(8)::int;
    v_out := v_out || substr(v_alpha, (v_byte % length(v_alpha)) + 1, 1);
  end loop;
  return v_out;
end;
$$;

revoke all on function public.new_copy_key() from public, anon, authenticated;

-- One unused key for every VIP who has none.
insert into public.copy_keys (key, note, created_by)
select public.new_copy_key(), 'VIP key', p.id
  from public.profiles p
 where p.tier = 'vip'
   and not exists (
     select 1 from public.copy_keys k
      where k.created_by = p.id
        and k.redeemed_by is null
        and k.revoked_at is null
   );


-- >>>>>>>>>> 018_sold_trades.sql
-- ============================================================================
-- Contracts closed early ("sold")
-- Run after 001-017. Idempotent, safe to re-run.
-- ============================================================================
--
-- A contract can be closed before its last tick, for what it is worth at
-- that moment: by hand, or by an automated run ending on its target or stop
-- loss. Until now the site reported such a contract as "lost" with no
-- payout, so on a real account the server took the whole stake even when
-- the contract had been closed at a profit.
--
-- A sold contract is now recorded as 'sold', with payout_minor holding what
-- it was sold for. settle_trade is called with p_won = true for it, which
-- applies payout - stake: positive or negative, whatever the sale came to.
-- The payout is still checked against the published odds, so a sale can
-- never be worth more than winning outright.
-- ============================================================================

alter table public.trades
  drop constraint if exists trades_status_check;
alter table public.trades
  add constraint trades_status_check check (status in ('won', 'lost', 'sold'));


-- >>>>>>>>>> 019_real_money_stats.sql
-- ============================================================================
-- Console figures count real money only
-- Run after 001-018. Idempotent, safe to re-run.
-- ============================================================================
--
-- The dashboard was summing every account and every provider, so VIP demo
-- deposits (mpesa_demo), admin credits (manual) and the balances they created
-- sat in "Customer funds held" next to money a customer actually paid.
--
-- From here the overview counts only:
--   * deposits collected by an M-Pesa STK prompt (provider = 'payhero')
--   * from Standard customers (not VIP, not staff)
--   * balances and payouts belonging to those same customers
-- VIP accounts and their handset payouts (method = 'mpesa_demo') are left out
-- entirely. The Payments and Users pages still show everything.
-- ============================================================================

-- Standard customers: the only accounts whose money is real.
create or replace function public.is_real_customer(p_user uuid)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
     where id = p_user and role = 'customer' and tier = 'standard'
  );
$$;

create or replace function public.admin_stats()
returns jsonb
language sql
security definer set search_path = public
stable
as $$
  with real_deposits as (
    select p.status, p.amount_minor
      from public.payments p
      join public.profiles pr on pr.id = p.user_id
     where p.direction = 'deposit'
       and p.provider  = 'payhero'
       and pr.role = 'customer' and pr.tier = 'standard'
  ),
  real_payouts as (
    select w.status, w.amount_minor, w.created_at
      from public.withdrawal_requests w
      join public.profiles pr on pr.id = w.user_id
     where w.method <> 'mpesa_demo'
       and pr.role = 'customer' and pr.tier = 'standard'
  )
  select jsonb_build_object(
    'users',            (select count(*) from public.profiles
                          where role = 'customer' and tier = 'standard'),
    'activeUsers',      (select count(*) from public.profiles
                          where role = 'customer' and tier = 'standard' and status = 'active'),
    'suspended',        (select count(*) from public.profiles where status = 'suspended'),
    'kycPending',       (select count(*) from public.profiles where kyc_status = 'pending'),
    'heldMinor',        (select coalesce(sum(a.balance_minor),0)
                           from public.accounts a
                           join public.profiles pr on pr.id = a.user_id
                          where a.kind = 'real'
                            and pr.role = 'customer' and pr.tier = 'standard'),
    'depositsMinor',    (select coalesce(sum(amount_minor),0) from real_deposits where status = 'success'),
    'depositCount',     (select count(*) from real_deposits where status = 'success'),
    'failedCount',      (select count(*) from real_deposits where status = 'failed'),
    'pendingCount',     (select count(*) from real_deposits where status = 'pending'),
    'payoutsPending',   (select count(*) from real_payouts where status = 'pending'),
    'payoutsPendingMinor',
                        (select coalesce(sum(amount_minor),0) from real_payouts where status = 'pending'),
    'paidOutMinor',     (select coalesce(sum(amount_minor),0) from real_payouts where status = 'paid'),
    'oldestPending',    (select min(created_at) from real_payouts where status = 'pending')
  );
$$;

create or replace function public.admin_daily(p_days integer default 14)
returns table (day date, deposits_minor bigint, withdrawals_minor bigint, signups integer)
language sql
security definer set search_path = public
stable
as $$
  with days as (
    select generate_series(
      (current_date - (p_days - 1)),
      current_date,
      interval '1 day'
    )::date as day
  )
  select
    d.day,
    coalesce((select sum(p.amount_minor) from public.payments p
               where p.direction = 'deposit' and p.status = 'success'
                 and p.provider = 'payhero'
                 and public.is_real_customer(p.user_id)
                 and p.settled_at::date = d.day), 0)::bigint,
    coalesce((select sum(w.amount_minor) from public.withdrawal_requests w
               where w.status = 'paid' and w.method <> 'mpesa_demo'
                 and public.is_real_customer(w.user_id)
                 and w.settled_at::date = d.day), 0)::bigint,
    coalesce((select count(*) from public.profiles pr
               where pr.created_at::date = d.day
                 and pr.role = 'customer' and pr.tier = 'standard'), 0)::integer
  from days d
  order by d.day;
$$;

revoke all on function public.is_real_customer(uuid)  from public, anon, authenticated;
revoke all on function public.admin_stats()           from public, anon, authenticated;
revoke all on function public.admin_daily(integer)    from public, anon, authenticated;
grant execute on function public.is_real_customer(uuid) to service_role;
grant execute on function public.admin_stats()          to service_role;
grant execute on function public.admin_daily(integer)   to service_role;


-- >>>>>>>>>> 020_site_domains.sql
-- ============================================================
-- A second site on the same API
-- Run after 019.
--
-- zenytrade.com is a second front end on this backend. Accounts and
-- money are shared; what the console needs is to tell the two sites
-- apart. Each deposit now records the site it was made through, and
-- the Domains figures count a deposit against that site.
--
-- Rows from before this (and every account that never recorded a site)
-- belong to kivobinary.com, which was the only site there was.
-- ============================================================

alter table public.payments
  add column if not exists domain_host text;

create index if not exists payments_domain_idx
  on public.payments(domain_host) where domain_host is not null;

insert into public.domains (host, label, status)
values ('zenytrade.com', 'ZenyTrade', 'live')
on conflict (host) do nothing;

-- nexas.trade was the primary in the first version of 004, before the
-- product moved to kivobinary.com. It was never a site anyone used, and
-- a database that ran the old seed still lists it.
delete from public.domains where host = 'nexas.trade';

-- Those databases never got kivobinary.com either, since the old seed
-- listed nexas.trade in its place. Make sure the primary is there, dated
-- first so the console lists it at the top.
insert into public.domains (host, label, status, created_at)
values ('kivobinary.com', 'Primary', 'live', now() - interval '1 year')
on conflict (host) do update set label = 'Primary', status = 'live';

-- ---------- money per domain ----------
-- Users by the site they signed up on; deposits by the site each one was
-- made through, falling back to the account's site and then to the
-- primary; withdrawals by the account's site, since a payout is not made
-- "through" a page.
create or replace function public.domain_figures()
returns table (
  host text, label text, status text,
  users integer, deposits_minor bigint, withdrawals_minor bigint
)
language sql
security definer set search_path = public
stable
as $$
  select
    d.host, d.label, d.status,
    coalesce((select count(*) from public.profiles p
               where coalesce(p.domain_host, 'kivobinary.com') = d.host), 0)::integer,
    coalesce((select sum(pay.amount_minor) from public.payments pay
               join public.profiles p on p.id = pay.user_id
              where coalesce(pay.domain_host, p.domain_host, 'kivobinary.com') = d.host
                and pay.direction = 'deposit' and pay.status = 'success'), 0)::bigint,
    coalesce((select sum(w.amount_minor) from public.withdrawal_requests w
               join public.profiles p on p.id = w.user_id
              where coalesce(p.domain_host, 'kivobinary.com') = d.host
                and w.status = 'paid'), 0)::bigint
  from public.domains d
  order by d.created_at;
$$;

revoke all on function public.domain_figures() from public, anon, authenticated;
grant execute on function public.domain_figures() to service_role;


-- >>>>>>>>>> 021_kivo_sites.sql
-- The three sites on this backend: KivoBinary (primary), ZenyTrade and
-- VeraBinary. 004 and 020 already add Kivo and Zeny; this makes sure all
-- three are listed and live. Safe to run more than once.
insert into public.domains (host, label, status) values
  ('kivobinary.com', 'Primary',    'live'),
  ('zenytrade.com', 'ZenyTrade', 'live'),
  ('verabinary.com', 'VeraBinary', 'live')
on conflict (host) do update set status = 'live';


-- ---------------------------------------------------------------- 022_rise_fall.sql
-- ============================================================================
-- Buy / Sell (rise / fall) on VeraBinary
-- Run after 001-021. Idempotent, safe to re-run.
--
-- The bars site trades whether the price ends higher (rise, shown as Buy) or
-- lower (fall, shown as Sell) than it started. Without these two lines the
-- server's payout check refuses every such trade as CONTRACT_UNKNOWN.
-- ============================================================================
create or replace function public.payout_multiple(p_type text)
returns numeric language sql immutable as $$
  select case p_type
    when 'even_odd' then 1.953
    when 'matches'  then 10.35
    when 'differs'  then 1.084
    when 'over'     then 1.72
    when 'under'    then 1.72
    when 'rise'     then 1.95
    when 'fall'     then 1.95
    else 0
  end;
$$;

-- ---------------------------------------------------------------- 023_site_names.sql
-- ============================================================================
-- The real site names
-- Run after 001-022. Idempotent, safe to re-run.
--
-- KivoBinary (kivobinary.com, primary), ZenyTrade (zenytrade.com) and
-- VeraBinary (verabinary.com) replace the placeholder names the stack was
-- built under. Marking them live here is also what lets the API answer them:
-- every live host in this table is an allowed browser origin.
-- ============================================================================
insert into public.domains (host, label, status) values
  ('kivobinary.com', 'Primary',    'live'),
  ('zenytrade.com',  'ZenyTrade',  'live'),
  ('verabinary.com', 'VeraBinary', 'live')
on conflict (host) do update set status = 'live', label = excluded.label;

-- The placeholder hosts were never real sites.
delete from public.domains
 where host in ('korabinary.com', 'lyrabinary.com', 'vexabinary.com');
