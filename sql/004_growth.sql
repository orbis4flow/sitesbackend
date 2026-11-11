-- ============================================================
-- Domains and marketing sessions
-- Run after 003.
-- ============================================================

-- ---------- the hosts the product is served on ----------
create table if not exists public.domains (
  id          uuid primary key default gen_random_uuid(),
  host        text not null unique,
  label       text not null default 'New',
  status      text not null default 'paused' check (status in ('live','paused')),
  created_at  timestamptz not null default now()
);

-- Every account remembers which host it arrived through, so money can
-- be attributed without guessing later.
alter table public.profiles
  add column if not exists domain_host text;

create index if not exists profiles_domain_idx on public.profiles(domain_host);

-- ---------- marketing sessions ----------
-- A stream is bought, run and measured. Exactly one may be live: the
-- partial unique index below enforces that in the database rather than
-- trusting every caller to check first.
create table if not exists public.sessions (
  id              uuid primary key default gen_random_uuid(),
  channel         text not null,
  handler         text not null,
  domain_host     text,
  note            text,
  ad_spend_minor  bigint not null default 0 check (ad_spend_minor >= 0),
  status          text not null default 'live' check (status in ('live','ended')),
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  started_by      uuid references auth.users(id) on delete set null,
  ended_by        uuid references auth.users(id) on delete set null
);

create unique index if not exists sessions_one_live
  on public.sessions ((status)) where status = 'live';

create index if not exists sessions_started_idx on public.sessions(started_at desc);

alter table public.domains  enable row level security;
alter table public.sessions enable row level security;
-- No policies: staff reach these through the service role only.

-- ============================================================
-- Figures for a session: everything that happened between its start
-- and its end (or now, if it is still running).
-- ============================================================
create or replace function public.session_figures(p_session_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public
stable
as $$
declare
  s public.sessions;
  v_from timestamptz;
  v_to timestamptz;
  v_deposits bigint;
  v_withdrawals bigint;
  v_stake bigint;
  v_signups integer;
  v_trades integer;
begin
  select * into s from public.sessions where id = p_session_id;
  if s is null then return null; end if;

  v_from := s.started_at;
  v_to := coalesce(s.ended_at, now());

  select coalesce(sum(amount_minor), 0) into v_deposits
    from public.payments
   where direction = 'deposit' and status = 'success'
     and settled_at between v_from and v_to;

  select coalesce(sum(amount_minor), 0) into v_withdrawals
    from public.withdrawal_requests
   where status = 'paid' and settled_at between v_from and v_to;

  select coalesce(count(*), 0) into v_signups
    from public.profiles
   where created_at between v_from and v_to;

  /* Stake volume and trade count come from the contracts table once
     trading moves server-side. Until then they are zero rather than
     estimated — a made-up number here would flow straight into the
     profit figure an operator makes decisions on. */
  v_stake := 0;
  v_trades := 0;

  return jsonb_build_object(
    'depositsMinor',    v_deposits,
    'withdrawalsMinor', v_withdrawals,
    'stakeVolumeMinor', v_stake,
    'marginMinor',      round(v_stake * 0.0235),
    'signups',          v_signups,
    'trades',           v_trades
  );
end;
$$;

-- ---------- money per domain ----------
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
               where p.domain_host = d.host), 0)::integer,
    coalesce((select sum(pay.amount_minor) from public.payments pay
               join public.profiles p on p.id = pay.user_id
              where p.domain_host = d.host
                and pay.direction = 'deposit' and pay.status = 'success'), 0)::bigint,
    coalesce((select sum(w.amount_minor) from public.withdrawal_requests w
               join public.profiles p on p.id = w.user_id
              where p.domain_host = d.host and w.status = 'paid'), 0)::bigint
  from public.domains d
  order by d.created_at;
$$;

revoke all on function public.session_figures(uuid) from public, anon, authenticated;
revoke all on function public.domain_figures()     from public, anon, authenticated;
grant execute on function public.session_figures(uuid) to service_role;
grant execute on function public.domain_figures()      to service_role;

-- The hosts this product is served from, so the console is not empty on
-- day one. The console itself is listed too: it is a domain that has to
-- be kept in the CORS allow-list and pointed at DNS like any other, and
-- a list of domains that omits one of them is a list you cannot trust.
insert into public.domains (host, label, status)
values
  ('kivobinary.com',           'Primary',  'live'),
  ('admin.kivobinary.com', 'Console',  'live')
on conflict (host) do nothing;
