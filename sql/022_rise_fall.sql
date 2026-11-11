-- ============================================================================
-- Buy / Sell (rise / fall) on VeraBinary
-- Run after 001-021. Idempotent, safe to re-run.
--
-- The bars site trades whether the price ends higher (rise, shown as Buy) or
-- lower (fall, shown as Sell) than it started. Without these two lines the
-- server's payout check refuses every such trade as CONTRACT_UNKNOWN.
-- ============================================================================
create or replace function public.payout_multiple(p_type text)
returns numeric language sql immutable as $$
  select case p_type
    when 'even_odd' then 1.953
    when 'matches'  then 10.35
    when 'differs'  then 1.084
    when 'over'     then 1.72
    when 'under'    then 1.72
    when 'rise'     then 1.95
    when 'fall'     then 1.95
    else 0
  end;
$$;
