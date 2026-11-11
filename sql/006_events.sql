-- ============================================================
-- System events — the log the console can actually read
-- Run after 001-005. Safe to run more than once.
--
-- Render keeps stdout, but nothing in the admin console can read it, and
-- it is gone on the next deploy. The events worth acting on — a webhook
-- that failed its signature check, a provider that timed out, a deposit
-- that could not be recorded — are written here instead, where they can
-- be listed, filtered and kept.
--
-- This is not a copy of the request log. Only what an operator would act
-- on goes in, because a log nobody reads is the same as no log.
-- ============================================================

create table if not exists public.system_events (
  id          bigserial primary key,
  level       text not null default 'info'
              check (level in ('info','warn','error')),
  source      text not null,              -- 'paystack', 'payhero', 'cors', 'deposits'
  message     text not null,
  context     jsonb,                      -- never secrets: see log() in the API
  user_id     uuid references auth.users(id) on delete set null,
  reference   text,                       -- payment reference, when there is one
  created_at  timestamptz not null default now()
);

create index if not exists system_events_created_idx
  on public.system_events (created_at desc);
create index if not exists system_events_level_idx
  on public.system_events (level, created_at desc)
  where level <> 'info';
create index if not exists system_events_source_idx
  on public.system_events (source, created_at desc);
create index if not exists system_events_reference_idx
  on public.system_events (reference)
  where reference is not null;

alter table public.system_events enable row level security;
-- No policy, deliberately: the service role bypasses RLS and nothing
-- else may read this. Events name payment references and user ids.

-- ---------- keeping it from growing forever ----------
-- Call from a scheduled job, or by hand. Errors are kept longer than
-- chatter because they are the ones still worth reading next month.
create or replace function public.prune_system_events()
returns integer
language sql
security definer set search_path = public
as $$
  with gone as (
    delete from public.system_events
     where (level = 'info'  and created_at < now() - interval '14 days')
        or (level = 'warn'  and created_at < now() - interval '60 days')
        or (level = 'error' and created_at < now() - interval '180 days')
    returning 1
  )
  select count(*)::integer from gone;
$$;

revoke all on function public.prune_system_events() from public, anon, authenticated;
grant execute on function public.prune_system_events() to service_role;
