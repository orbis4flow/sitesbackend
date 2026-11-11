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
