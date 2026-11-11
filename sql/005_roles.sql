-- ============================================================
-- Roles, and the first super admin
-- Run after 001-004. Safe to run more than once.
--
-- Two things happen here:
--   1. profiles.role learns the roles the console actually uses. Until
--      now the CHECK constraint allowed four; the console assigns seven.
--      Creating a 'manager' would have failed on the constraint.
--   2. You promote yourself, by hand, once.
--
-- There is deliberately no endpoint that grants admin. An endpoint that
-- can make the first super admin can make the second one for somebody
-- else, and it is reachable from the internet forever after. This runs
-- in the SQL editor, where the only way in is your Supabase password.
-- ============================================================

-- ---------- 1. the roles the console assigns ----------
alter table public.profiles
  drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check check (role in (
    'customer',
    'super_admin',      -- creates other staff; the only role that can
    'admin',
    'manager',
    'finance',          -- moves money: approves payouts
    'operator',         -- day to day: users, KYC, payments
    'marketing',
    'session_handler'   -- runs one live session at a time
  ));

-- is_staff() was written against the old four. A manager is staff.
create or replace function public.is_staff(p_user uuid)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
     where id = p_user
       and role in ('super_admin','admin','manager','finance',
                    'operator','marketing','session_handler')
       and status = 'active'
  );
$$;

revoke all on function public.is_staff(uuid) from public, anon;
grant execute on function public.is_staff(uuid) to service_role, authenticated;

-- ---------- 2. the first super admin ----------
-- The account has to exist in auth.users first, because profiles.id
-- references it and the row is created by the handle_new_user trigger.
-- So: sign up through the site (or Supabase -> Authentication -> Users
-- -> Add user, with "Auto Confirm" on), then run the statement below
-- with that email.
--
-- Uncomment, set the address, run once:
--
--   update public.profiles
--      set role = 'super_admin', status = 'active'
--    where lower(email) = lower('you@example.com');
--
-- Then check it took. This should return exactly one row:
--
--   select email, role, status from public.profiles
--    where role <> 'customer';
--
-- If it returns none, the signup did not create a profile row — look at
-- the handle_new_user trigger before promoting anything.

-- A guard rail, not a grant: it cannot create an admin, it only refuses
-- to let the last one disappear. Demoting or suspending the final active
-- super admin locks everybody out of the console, and the fix for that
-- is another trip to the SQL editor.
create or replace function public.protect_last_super_admin()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if old.role = 'super_admin'
     and old.status = 'active'
     and (new.role <> 'super_admin' or new.status <> 'active')
     and (select count(*) from public.profiles
           where role = 'super_admin' and status = 'active') <= 1 then
    raise exception 'refusing to remove the last active super admin';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_last_super_admin on public.profiles;
create trigger protect_last_super_admin
  before update on public.profiles
  for each row execute function public.protect_last_super_admin();
