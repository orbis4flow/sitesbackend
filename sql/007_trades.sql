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
