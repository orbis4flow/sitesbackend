-- ============================================================================
-- The real site names
-- Run after 001-022. Idempotent, safe to re-run.
--
-- KivoBinary (kivobinary.com, primary), ZenyTrade (zenytrade.com) and
-- VeraBinary (verabinary.com) replace the placeholder names the stack was
-- built under. Marking them live here is also what lets the API answer them:
-- every live host in this table is an allowed browser origin.
-- ============================================================================
insert into public.domains (host, label, status) values
  ('kivobinary.com', 'Primary',    'live'),
  ('zenytrade.com',  'ZenyTrade',  'live'),
  ('verabinary.com', 'VeraBinary', 'live')
on conflict (host) do update set status = 'live', label = excluded.label;

-- The placeholder hosts were never real sites.
delete from public.domains
 where host in ('korabinary.com', 'lyrabinary.com', 'vexabinary.com');
