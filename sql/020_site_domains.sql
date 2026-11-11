-- ============================================================
-- A second site on the same API
-- Run after 019.
--
-- zenytrade.com is a second front end on this backend. Accounts and
-- money are shared; what the console needs is to tell the two sites
-- apart. Each deposit now records the site it was made through, and
-- the Domains figures count a deposit against that site.
--
-- Rows from before this (and every account that never recorded a site)
-- belong to kivobinary.com, which was the only site there was.
-- ============================================================

alter table public.payments
  add column if not exists domain_host text;

create index if not exists payments_domain_idx
  on public.payments(domain_host) where domain_host is not null;

insert into public.domains (host, label, status)
values ('zenytrade.com', 'ZenyTrade', 'live')
on conflict (host) do nothing;

-- nexas.trade was the primary in the first version of 004, before the
-- product moved to kivobinary.com. It was never a site anyone used, and
-- a database that ran the old seed still lists it.
delete from public.domains where host = 'nexas.trade';

-- Those databases never got kivobinary.com either, since the old seed
-- listed nexas.trade in its place. Make sure the primary is there, dated
-- first so the console lists it at the top.
insert into public.domains (host, label, status, created_at)
values ('kivobinary.com', 'Primary', 'live', now() - interval '1 year')
on conflict (host) do update set label = 'Primary', status = 'live';

-- ---------- money per domain ----------
-- Users by the site they signed up on; deposits by the site each one was
-- made through, falling back to the account's site and then to the
-- primary; withdrawals by the account's site, since a payout is not made
-- "through" a page.
create or replace function public.domain_figures()
returns table (
  host text, label text, status text,
  users integer, deposits_minor bigint, withdrawals_minor bigint
)
language sql
security definer set search_path = public
stable
as $$
  select
    d.host, d.label, d.status,
    coalesce((select count(*) from public.profiles p
               where coalesce(p.domain_host, 'kivobinary.com') = d.host), 0)::integer,
    coalesce((select sum(pay.amount_minor) from public.payments pay
               join public.profiles p on p.id = pay.user_id
              where coalesce(pay.domain_host, p.domain_host, 'kivobinary.com') = d.host
                and pay.direction = 'deposit' and pay.status = 'success'), 0)::bigint,
    coalesce((select sum(w.amount_minor) from public.withdrawal_requests w
               join public.profiles p on p.id = w.user_id
              where coalesce(p.domain_host, 'kivobinary.com') = d.host
                and w.status = 'paid'), 0)::bigint
  from public.domains d
  order by d.created_at;
$$;

revoke all on function public.domain_figures() from public, anon, authenticated;
grant execute on function public.domain_figures() to service_role;
