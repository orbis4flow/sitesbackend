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
