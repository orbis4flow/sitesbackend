-- ============================================================================
-- RESET ALL MONEY AND TRADING DATA — for starting testing afresh
-- ============================================================================
--
-- DESTRUCTIVE AND IRREVERSIBLE. Not a migration: run it by hand in
-- Supabase → SQL editor only when you mean to wipe the books.
--
-- Deletes:  every payment (deposits of every provider), every withdrawal
--           request, the whole ledger, every trade and auto-run, and every
--           VIP handset statement line.
-- Zeroes:   every real balance, and any Fuliza owed on VIP handsets.
-- Keeps:    users, profiles, tiers, roles, KYC, tickets, copy keys, demo
--           balances, VIP wallet PINs/balances, and the admin audit trail.
--
-- Everything runs in one transaction: if any step fails, nothing changes.
-- Take a backup first (Database → Backups) if there is any chance you need
-- the old figures.
-- ============================================================================

begin;

delete from public.ledger_entries;
delete from public.withdrawal_requests;
delete from public.trades;
delete from public.auto_runs;
delete from public.payments;
delete from public.mpesa_demo_tx;

update public.accounts          set balance_minor = 0 where kind = 'real';
update public.mpesa_demo_wallet set fuliza_used_minor = 0, updated_at = now();
update public.profiles          set trades_count = 0;

-- Leave a record of who wiped the books and when.
insert into public.admin_audit (action, subject, detail)
values ('reset_test_money', 'all', jsonb_build_object('at', now()));

commit;

-- Check: every figure below should be 0.
select
  (select count(*) from public.payments)             as payments,
  (select count(*) from public.withdrawal_requests)  as withdrawals,
  (select count(*) from public.ledger_entries)       as ledger,
  (select count(*) from public.trades)               as trades,
  (select coalesce(sum(balance_minor),0) from public.accounts where kind = 'real') as real_balance;
