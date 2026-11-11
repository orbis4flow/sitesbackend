-- ============================================================
-- Admin console support
-- Run after 001 and 002.
-- ============================================================

-- ---------- who is allowed into the console ----------
alter table public.profiles
  add column if not exists role text not null default 'customer'
    check (role in ('customer','operator','finance','admin')),
  add column if not exists status text not null default 'active'
    check (status in ('active','suspended')),
  add column if not exists suspended_reason text,
  add column if not exists trades_count integer not null default 0,
  add column if not exists last_seen_at timestamptz;

create index if not exists profiles_role_idx on public.profiles(role)
  where role <> 'customer';
create index if not exists profiles_kyc_idx on public.profiles(kyc_status);

-- ---------- every operator action is recorded ----------
-- Without this, "who approved that payout" has no answer, and an
-- operator console without an answer to that question is a liability.
create table if not exists public.admin_audit (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references auth.users(id) on delete set null,
  actor_email text,
  action      text not null,
  subject     text,                       -- user id, payment id, request id
  detail      jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_created_idx on public.admin_audit(created_at desc);
create index if not exists audit_subject_idx on public.admin_audit(subject);

alter table public.admin_audit enable row level security;
-- No policy: nothing but the service role reads or writes this.

-- ---------- helper: is the caller staff? ----------
create or replace function public.is_staff(p_user uuid)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
     where id = p_user and role in ('operator','finance','admin')
  );
$$;

-- ---------- console figures, in one round trip ----------
create or replace function public.admin_stats()
returns jsonb
language sql
security definer set search_path = public
stable
as $$
  select jsonb_build_object(
    'users',            (select count(*) from public.profiles where role = 'customer'),
    'activeUsers',      (select count(*) from public.profiles
                          where role = 'customer' and status = 'active'),
    'suspended',        (select count(*) from public.profiles where status = 'suspended'),
    'kycPending',       (select count(*) from public.profiles where kyc_status = 'pending'),
    'heldMinor',        (select coalesce(sum(balance_minor),0) from public.accounts where kind = 'real'),
    'depositsMinor',    (select coalesce(sum(amount_minor),0) from public.payments
                          where direction = 'deposit' and status = 'success'),
    'depositCount',     (select count(*) from public.payments
                          where direction = 'deposit' and status = 'success'),
    'failedCount',      (select count(*) from public.payments
                          where direction = 'deposit' and status = 'failed'),
    'pendingCount',     (select count(*) from public.payments
                          where direction = 'deposit' and status = 'pending'),
    'payoutsPending',   (select count(*) from public.withdrawal_requests where status = 'pending'),
    'payoutsPendingMinor',
                        (select coalesce(sum(amount_minor),0) from public.withdrawal_requests
                          where status = 'pending'),
    'paidOutMinor',     (select coalesce(sum(amount_minor),0) from public.withdrawal_requests
                          where status = 'paid'),
    'oldestPending',    (select min(created_at) from public.withdrawal_requests where status = 'pending')
  );
$$;

-- ---------- 14 days of money in and out ----------
-- generate_series gives a row for a quiet day too. Without it the chart
-- silently closes the gap and a dead day looks like a busy one.
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
                 and p.settled_at::date = d.day), 0)::bigint,
    coalesce((select sum(w.amount_minor) from public.withdrawal_requests w
               where w.status = 'paid' and w.settled_at::date = d.day), 0)::bigint,
    coalesce((select count(*) from public.profiles pr
               where pr.created_at::date = d.day), 0)::integer
  from days d
  order by d.day;
$$;

-- ---------- mark a payout paid ----------
-- Money already left the balance when the request was made, so this
-- only closes the record. Idempotent: approving twice does nothing.
create or replace function public.settle_withdrawal(
  p_request_id uuid,
  p_actor uuid,
  p_note text default null
)
returns public.withdrawal_requests
language plpgsql
security definer set search_path = public
as $$
declare
  v_request public.withdrawal_requests;
begin
  select * into v_request from public.withdrawal_requests
    where id = p_request_id for update;

  if v_request is null then
    raise exception 'request % not found', p_request_id;
  end if;
  if v_request.status in ('paid','rejected','cancelled') then
    return v_request;
  end if;

  update public.withdrawal_requests
     set status = 'paid', reviewed_by = p_actor, review_note = p_note, settled_at = now()
   where id = v_request.id
  returning * into v_request;

  return v_request;
end;
$$;

revoke all on function public.admin_stats()                       from public, anon, authenticated;
revoke all on function public.admin_daily(integer)                from public, anon, authenticated;
revoke all on function public.settle_withdrawal(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.is_staff(uuid)                      from public, anon;

grant execute on function public.admin_stats()                       to service_role;
grant execute on function public.admin_daily(integer)                to service_role;
grant execute on function public.settle_withdrawal(uuid, uuid, text) to service_role;
grant execute on function public.is_staff(uuid)                      to service_role, authenticated;

-- ============================================================
-- Make yourself an operator. Sign up through the app first, then:
--
--   update public.profiles set role = 'admin' where email = 'you@example.com';
--
-- Do this by hand. An endpoint that grants admin is an endpoint that
-- eventually grants it to somebody else.
-- ============================================================
