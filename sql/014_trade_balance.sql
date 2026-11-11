-- ============================================================================
-- Settled trades move the real balance
-- Run after 001-013. Idempotent, safe to re-run.
-- ============================================================================
--
-- READ THIS. IT CHANGES WHAT A TRADE CAN DO.
--
-- Until now nothing a customer did in the terminal touched the server. They
-- deposited, the balance went up; they traded, a number in their browser moved
-- and the server never heard about it; they withdrew, and the request was held
-- against the deposit. See the note at the top of 007_trades.sql, which was
-- true when it was written and stops being true here.
--
-- That gap ran in both directions and one of them costs money:
--
--   * Somebody who deposited 50 and lost it could still withdraw 50, because
--     the loss never reached the server. The business pays out money that has
--     already been lost.
--   * Somebody who deposited 50 and won 300 could only withdraw 50, because
--     the winnings did not exist here either. The customer is told the money
--     on their screen is not real.
--
-- So settled trades now move accounts.balance_minor.
--
-- WHAT THIS DOES NOT FIX, AND MUST NOT BE MISTAKEN FOR
-- ----------------------------------------------------------------------------
-- Contracts are still decided in the browser. This function applies the result
-- the client reports; it cannot check whether the contract really won, because
-- the price feed and the tick that settles it live on the client.
--
-- What it can check, and does:
--   * the payout is arithmetically possible for the contract type claimed, at
--     the published odds, so a client cannot report a 50x return on an
--     even/odd contract
--   * the stake is inside the published limits
--   * one movement per trade, ever, by client_ref
--   * a real balance never goes below zero
--
-- What it cannot check is the word "won". A determined person with devtools can
-- report wins they did not have, and the ceiling on that is the payout multiple
-- and the stake limit, not honesty. That is a real exposure and it is the
-- reason settlement has to move server side before volumes grow. Until it does,
-- watch the win rate per account: staged wins are tagged demo_mode, and anything
-- else far above the published probability is somebody writing their own.
-- ============================================================================

-- --- The odds, on the server ------------------------------------------------
-- The same table the browser uses. Here so the payout claimed can be checked
-- against what the contract could actually pay, rather than believed.
create or replace function public.payout_multiple(p_type text)
returns numeric language sql immutable as $$
  select case p_type
    when 'even_odd' then 1.953
    when 'matches'  then 10.35
    when 'differs'  then 1.084
    when 'over'     then 1.72
    when 'under'    then 1.72
    else 0
  end;
$$;

-- --- Applying one settled contract -------------------------------------------
create or replace function public.settle_trade(
  p_user_id     uuid,
  p_client_ref  text,
  p_type        text,
  p_stake_minor bigint,
  p_payout_minor bigint,
  p_won         boolean
) returns bigint                       -- the balance after, in minor units
language plpgsql security definer set search_path = public as $$
declare
  v_account   public.accounts;
  v_multiple  numeric;
  v_max_payout bigint;
  v_delta     bigint;
  v_new       bigint;
  v_memo      text;
begin
  if p_stake_minor <= 0 then
    raise exception 'STAKE_INVALID';
  end if;

  -- The published ceiling, 5,000.00, same as LIMITS.max in the browser.
  if p_stake_minor > 500000 then
    raise exception 'STAKE_ABOVE_LIMIT';
  end if;

  v_multiple := public.payout_multiple(p_type);
  if v_multiple = 0 then
    raise exception 'CONTRACT_UNKNOWN';
  end if;

  -- A won contract pays stake x multiple. One cent of slack for the rounding
  -- the client does; anything past that is a claim the odds cannot support.
  v_max_payout := ceil(p_stake_minor * v_multiple) + 1;
  if p_won and p_payout_minor > v_max_payout then
    raise exception 'PAYOUT_ABOVE_ODDS';
  end if;
  if not p_won and p_payout_minor <> 0 then
    raise exception 'PAYOUT_ON_A_LOSS';
  end if;

  select * into v_account
    from public.accounts
   where user_id = p_user_id and kind = 'real'
   for update;

  if not found then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;

  -- One movement per contract, ever. The client re-sends its history on every
  -- load, and without this each re-send would pay the same win again.
  if exists (
    select 1 from public.ledger_entries
     where account_id = v_account.id
       and kind = 'trade'
       and memo = 'trade ' || p_client_ref
  ) then
    return v_account.balance_minor;
  end if;

  -- Net, because the stake was never taken at buy time on this side: a loss is
  -- the stake off, a win is the stake back plus the profit.
  v_delta := case when p_won then p_payout_minor - p_stake_minor else -p_stake_minor end;
  v_new := v_account.balance_minor + v_delta;

  -- A real balance never goes below zero. It should not be able to: the browser
  -- will not let a stake exceed the balance. If it happens anyway the shortfall
  -- is the interesting part, so it is written down rather than swallowed.
  if v_new < 0 then
    v_memo := 'trade ' || p_client_ref;
    insert into public.ledger_entries
      (account_id, kind, amount_minor, balance_after_minor, memo)
    values
      (v_account.id, 'trade', -v_account.balance_minor, 0,
       v_memo || ' (clamped, short by ' || abs(v_new) || ')');

    update public.accounts set balance_minor = 0
     where id = v_account.id;
    return 0;
  end if;

  update public.accounts
     set balance_minor = v_new
   where id = v_account.id;

  insert into public.ledger_entries
    (account_id, kind, amount_minor, balance_after_minor, memo)
  values
    (v_account.id, 'trade', v_delta, v_new, 'trade ' || p_client_ref);

  return v_new;
end;
$$;

-- Callable only through the API's service role, like every other money
-- function here. A customer's own token must never be able to call this.
revoke all on function public.settle_trade(uuid, text, text, bigint, bigint, boolean)
  from public, anon, authenticated;

-- Finding the ledger entry for a contract is how the idempotency check above
-- works, and it runs on every single settled trade.
create index if not exists ledger_trade_memo_idx
  on public.ledger_entries (account_id, memo)
  where kind = 'trade';
