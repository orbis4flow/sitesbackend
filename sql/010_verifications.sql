-- ============================================================================
-- Verifications: proof of address
-- Run after 001-009. Idempotent, safe to re-run.
-- ============================================================================
--
-- Until now the whole identity flow lived in the browser: the picker took a
-- photo, a local flag said "verified", and nothing ever reached a server. So
-- the console's approve button had nothing to approve, and a withdrawal was
-- gated on a value the customer's own browser had set. This is the missing
-- half.
--
-- WHAT WE COLLECT, AND WHAT WE DELIBERATELY DO NOT
-- ----------------------------------------------------------------------------
-- Proof of address only. Government ID is not collected: holding passport and
-- national ID images is the highest-consequence data a business of this size
-- can hold, and until there is a reason to need it, and somewhere properly
-- locked to keep it, not having it is the safer position. The interface says
-- "coming soon" rather than pretending the option is gone, because it will be
-- back when payouts get large enough to require it.
--
-- WHERE THE FILE LIVES
-- ----------------------------------------------------------------------------
-- A private Supabase Storage bucket. The browser uploads straight to it with
-- the customer's own token, into a folder named after their user id, so a
-- document never passes through our API and never sits in a log. Nobody can
-- read it back: there is no select policy for customers at all. Staff see it
-- through a short-lived signed URL the API mints with the service role.
-- ============================================================================

-- --- 1. The bucket -----------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'kyc', 'kyc', false, 8388608,
  array['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

/*
 * Upload into your own folder, and nothing else. No select, no update, no
 * delete: a customer can hand a document in and cannot take it back out, which
 * is the same property a counter has.
 */
drop policy if exists "kyc upload own folder" on storage.objects;
create policy "kyc upload own folder" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'kyc'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- --- 2. The submissions ------------------------------------------------------

create table if not exists public.kyc_submissions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,

  kind          text not null default 'proof_of_address'
                check (kind in ('proof_of_address', 'government_id')),
  storage_path  text not null,
  mime_type     text,
  byte_size     integer,

  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'rejected')),
  note          text,                       -- why, when rejected
  reviewed_by   uuid references auth.users (id) on delete set null,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists kyc_submissions_status_idx
  on public.kyc_submissions (status, created_at);
create index if not exists kyc_submissions_user_idx
  on public.kyc_submissions (user_id, created_at desc);

-- One open submission per person. Somebody who uploads four times while
-- waiting should not produce four things to review.
create unique index if not exists kyc_submissions_one_pending
  on public.kyc_submissions (user_id) where status = 'pending';

alter table public.kyc_submissions enable row level security;

/* Read your own, so the app can show "under review" honestly. Writing is the
   API's job: a customer who could insert their own row could set its status. */
drop policy if exists "read own submissions" on public.kyc_submissions;
create policy "read own submissions" on public.kyc_submissions
  for select using (auth.uid() = user_id);

grant select on public.kyc_submissions to authenticated;
revoke insert, update, delete on public.kyc_submissions from authenticated, anon;

-- --- 3. Deciding one ---------------------------------------------------------

/*
 * Approve or reject, and move the profile with it, in one transaction. Two
 * statements from a route is how an account ends up approved with its
 * submission still pending, or the reverse, and the reverse is the one that
 * opens a payout nobody agreed to.
 */
create or replace function public.decide_kyc(
  p_submission uuid,
  p_actor      uuid,
  p_approve    boolean,
  p_note       text default null
) returns public.kyc_submissions
language plpgsql
security definer set search_path = public
as $$
declare
  v_row public.kyc_submissions;
begin
  select * into v_row from public.kyc_submissions
    where id = p_submission for update;

  if v_row is null then
    raise exception 'SUBMISSION_NOT_FOUND';
  end if;
  if v_row.status <> 'pending' then
    return v_row;                      -- already decided; do nothing
  end if;

  update public.kyc_submissions
     set status      = case when p_approve then 'approved' else 'rejected' end,
         note        = p_note,
         reviewed_by = p_actor,
         reviewed_at = now()
   where id = v_row.id
  returning * into v_row;

  update public.profiles
     set kyc_status = case when p_approve then 'verified' else 'rejected' end
   where id = v_row.user_id;

  return v_row;
end;
$$;

revoke all on function public.decide_kyc(uuid, uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.decide_kyc(uuid, uuid, boolean, text) to service_role;
