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
