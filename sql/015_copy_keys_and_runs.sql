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
