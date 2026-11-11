-- The three sites on this backend: KivoBinary (primary), ZenyTrade and
-- VeraBinary. 004 and 020 already add Kivo and Zeny; this makes sure all
-- three are listed and live. Safe to run more than once.
insert into public.domains (host, label, status) values
  ('kivobinary.com', 'Primary',    'live'),
  ('zenytrade.com', 'ZenyTrade', 'live'),
  ('verabinary.com', 'VeraBinary', 'live')
on conflict (host) do update set status = 'live';
