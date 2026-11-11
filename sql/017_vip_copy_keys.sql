-- ============================================================================
-- Copy-trading keys for VIP accounts
-- Run after 001-016. Idempotent, safe to re-run.
-- ============================================================================
--
-- VIP accounts hand out copy-trading keys of their own. Each key still works
-- once, on one account, exactly like a key made in the console; the only
-- difference is who made it (copy_keys.created_by is the VIP's user id).
--
-- This gives every existing VIP one unused key now, so the card on their copy
-- trading page has something in it from the first visit. VIPs promoted later
-- get theirs from the API the first time they open the page.
-- ============================================================================

-- Twelve characters from an alphabet with no 0/O or 1/I/L, grouped in fours,
-- drawn from gen_random_uuid() (a secure random source) rather than random().
create or replace function public.new_copy_key()
returns text
language plpgsql volatile set search_path = public as $$
declare
  v_alpha text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_hex   text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_out   text := '';
  v_i     int;
  v_byte  int;
begin
  for v_i in 0..11 loop
    if v_i > 0 and v_i % 4 = 0 then
      v_out := v_out || '-';
    end if;
    v_byte := ('x' || substr(v_hex, v_i * 2 + 1, 2))::bit(8)::int;
    v_out := v_out || substr(v_alpha, (v_byte % length(v_alpha)) + 1, 1);
  end loop;
  return v_out;
end;
$$;

revoke all on function public.new_copy_key() from public, anon, authenticated;

-- One unused key for every VIP who has none.
insert into public.copy_keys (key, note, created_by)
select public.new_copy_key(), 'VIP key', p.id
  from public.profiles p
 where p.tier = 'vip'
   and not exists (
     select 1 from public.copy_keys k
      where k.created_by = p.id
        and k.redeemed_by is null
        and k.revoked_at is null
   );
