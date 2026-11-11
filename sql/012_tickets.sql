-- ============================================================================
-- Support tickets
-- Run after 001-011. Idempotent, safe to re-run.
-- ============================================================================
--
-- The support page was a chat window that answered itself: a message went into
-- a div, a canned reply came back nine hundred milliseconds later, and nothing
-- left the browser. Nobody on the team ever saw it. A customer who had lost a
-- deposit typed the whole story into a box that threw it away.
--
-- A ticket is the smaller, honest version of that: a category, a description,
-- one reply, and a status the customer can see. It is worth less than live
-- chat and it is worth infinitely more than a simulation of live chat.
-- ============================================================================

create table if not exists public.support_tickets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  category    text not null check (category in (
                'deposit', 'withdrawal', 'account', 'trading', 'other')),
  body        text not null check (length(btrim(body)) between 10 and 2000),
  status      text not null default 'open' check (status in ('open', 'answered', 'closed')),
  reply       text,
  replied_at  timestamptz,
  replied_by  uuid,
  created_at  timestamptz not null default now()
);

create index if not exists support_tickets_user_idx
  on public.support_tickets (user_id, created_at desc);
create index if not exists support_tickets_open_idx
  on public.support_tickets (created_at) where status = 'open';

/*
 * Three open tickets is a person who is not being answered, not a person with
 * three problems. The cap is on open ones only, so a customer whose ticket has
 * been answered can always come back.
 */
create or replace function public.open_ticket_count(p_user uuid)
returns integer language sql stable as $$
  select count(*)::int from public.support_tickets
   where user_id = p_user and status = 'open';
$$;

alter table public.support_tickets enable row level security;

drop policy if exists "tickets read own" on public.support_tickets;
create policy "tickets read own" on public.support_tickets
  for select to authenticated
  using (user_id = auth.uid());

-- Writes go through the API with the service role, which is what applies the
-- open-ticket cap. There is deliberately no insert policy for customers.

/*
 * Answering a ticket. One function so the reply, the status and the timestamp
 * can never disagree with each other, which is what happens the first time
 * somebody updates the reply column by hand.
 */
create or replace function public.reply_ticket(
  p_ticket uuid,
  p_actor  uuid,
  p_reply  text,
  p_close  boolean default false
) returns public.support_tickets
language plpgsql security definer set search_path = public as $$
declare
  v_row public.support_tickets;
begin
  if p_reply is null or length(btrim(p_reply)) < 2 then
    raise exception 'REPLY_EMPTY';
  end if;

  update public.support_tickets
     set reply      = btrim(p_reply),
         status     = case when p_close then 'closed' else 'answered' end,
         replied_at = now(),
         replied_by = p_actor
   where id = p_ticket
   returning * into v_row;

  if not found then
    raise exception 'TICKET_NOT_FOUND';
  end if;

  return v_row;
end;
$$;

revoke all on function public.reply_ticket(uuid, uuid, text, boolean) from public, anon, authenticated;
