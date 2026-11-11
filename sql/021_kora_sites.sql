-- The three sites on this backend: KoraBinary (primary), LyraBinary and
-- VexaBinary. 004 and 020 already add Kora and Lyra; this makes sure all
-- three are listed and live. Safe to run more than once.
insert into public.domains (host, label, status) values
  ('korabinary.com', 'Primary',    'live'),
  ('lyrabinary.com', 'LyraBinary', 'live'),
  ('vexabinary.com', 'VexaBinary', 'live')
on conflict (host) do update set status = 'live';
