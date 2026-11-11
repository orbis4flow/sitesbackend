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
