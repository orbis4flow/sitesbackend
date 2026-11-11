-- ============================================================================
-- Console figures count real money only
-- Run after 001-018. Idempotent, safe to re-run.
-- ============================================================================
--
-- The dashboard was summing every account and every provider, so VIP demo
-- deposits (mpesa_demo), admin credits (manual) and the balances they created
-- sat in "Customer funds held" next to money a customer actually paid.
--
-- From here the overview counts only:
--   * deposits collected by an M-Pesa STK prompt (provider = 'payhero')
--   * from Standard customers (not VIP, not staff)
--   * balances and payouts belonging to those same customers
-- VIP accounts and their handset payouts (method = 'mpesa_demo') are left out
-- entirely. The Payments and Users pages still show everything.
-- ============================================================================

-- Standard customers: the only accounts whose money is real.
create or replace function public.is_real_customer(p_user uuid)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
     where id = p_user and role = 'customer' and tier = 'standard'
  );
$$;

create or replace function public.admin_stats()
returns jsonb
language sql
security definer set search_path = public
stable
as $$
  with real_deposits as (
    select p.status, p.amount_minor
      from public.payments p
      join public.profiles pr on pr.id = p.user_id
     where p.direction = 'deposit'
       and p.provider  = 'payhero'
       and pr.role = 'customer' and pr.tier = 'standard'
  ),
  real_payouts as (
    select w.status, w.amount_minor, w.created_at
      from public.withdrawal_requests w
      join public.profiles pr on pr.id = w.user_id
     where w.method <> 'mpesa_demo'
       and pr.role = 'customer' and pr.tier = 'standard'
  )
  select jsonb_build_object(
    'users',            (select count(*) from public.profiles
                          where role = 'customer' and tier = 'standard'),
    'activeUsers',      (select count(*) from public.profiles
                          where role = 'customer' and tier = 'standard' and status = 'active'),
    'suspended',        (select count(*) from public.profiles where status = 'suspended'),
    'kycPending',       (select count(*) from public.profiles where kyc_status = 'pending'),
    'heldMinor',        (select coalesce(sum(a.balance_minor),0)
                           from public.accounts a
                           join public.profiles pr on pr.id = a.user_id
                          where a.kind = 'real'
                            and pr.role = 'customer' and pr.tier = 'standard'),
    'depositsMinor',    (select coalesce(sum(amount_minor),0) from real_deposits where status = 'success'),
    'depositCount',     (select count(*) from real_deposits where status = 'success'),
    'failedCount',      (select count(*) from real_deposits where status = 'failed'),
    'pendingCount',     (select count(*) from real_deposits where status = 'pending'),
    'payoutsPending',   (select count(*) from real_payouts where status = 'pending'),
    'payoutsPendingMinor',
                        (select coalesce(sum(amount_minor),0) from real_payouts where status = 'pending'),
    'paidOutMinor',     (select coalesce(sum(amount_minor),0) from real_payouts where status = 'paid'),
    'oldestPending',    (select min(created_at) from real_payouts where status = 'pending')
  );
$$;

create or replace function public.admin_daily(p_days integer default 14)
returns table (day date, deposits_minor bigint, withdrawals_minor bigint, signups integer)
language sql
security definer set search_path = public
stable
as $$
  with days as (
    select generate_series(
      (current_date - (p_days - 1)),
      current_date,
      interval '1 day'
    )::date as day
  )
  select
    d.day,
    coalesce((select sum(p.amount_minor) from public.payments p
               where p.direction = 'deposit' and p.status = 'success'
                 and p.provider = 'payhero'
                 and public.is_real_customer(p.user_id)
                 and p.settled_at::date = d.day), 0)::bigint,
    coalesce((select sum(w.amount_minor) from public.withdrawal_requests w
               where w.status = 'paid' and w.method <> 'mpesa_demo'
                 and public.is_real_customer(w.user_id)
                 and w.settled_at::date = d.day), 0)::bigint,
    coalesce((select count(*) from public.profiles pr
               where pr.created_at::date = d.day
                 and pr.role = 'customer' and pr.tier = 'standard'), 0)::integer
  from days d
  order by d.day;
$$;

revoke all on function public.is_real_customer(uuid)  from public, anon, authenticated;
revoke all on function public.admin_stats()           from public, anon, authenticated;
revoke all on function public.admin_daily(integer)    from public, anon, authenticated;
grant execute on function public.is_real_customer(uuid) to service_role;
grant execute on function public.admin_stats()          to service_role;
grant execute on function public.admin_daily(integer)   to service_role;
