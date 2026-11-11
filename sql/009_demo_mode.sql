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
