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
