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
