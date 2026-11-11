/* ============================================================
   The VIP demo rail

   A thin layer over the mpesa_demo_* functions in sql/008. Everything
   here runs under the service role, so every caller above it must have
   established one of two things first:

     * the account is VIP        — requireVip(), for the trading terminal
     * the handset holds a token — requireHandset(), for the clone app

   Nothing in this file moves real money, touches a provider credential,
   or is reachable by a Standard account. It is a presentation prop, and
   the moment that stops being true the comment at the top of the SQL is
   the one to re-read.
   ============================================================ */
import { admin } from '../lib/supabase.js';
import { unauthorized, forbidden, badRequest, conflict, HttpError } from '../lib/errors.js';
import { notifyMovement } from './mpesaSms.js';

/* Named errors, so the deposit path can catch them by type and refund,
   and HttpError subclasses so anything that does not catch them still
   answers the handset with something it can render rather than a 500. */
export class NoWallet extends HttpError {
  constructor() {
    super(409, 'no_wallet',
      'This account has no M-Pesa demo wallet yet. An admin sets the PIN and opening balance in the console.');
    this.name = 'NoWallet';
  }
}
export class InsufficientFunds extends HttpError {
  constructor() {
    super(400, 'insufficient_funds',
      'There is not enough money in that M-Pesa account.');
    this.name = 'InsufficientFunds';
  }
}

/* Safaricom's own shape: two letters, then eight. Recognisable on a
   statement screen, and distinct from our MP-/CD- payment references so
   nobody confuses the two when reading a log. */
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const N = '0123456789';
export function demoReference() {
  const pick = (s, n) => Array.from({ length: n }, () =>
    s[Math.floor(Math.random() * s.length)]).join('');
  return pick(A, 3) + pick(N + A, 7);
}

function walletShape(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    deviceToken: row.device_token,
    pin: row.pin,
    balanceMinor: Number(row.balance_minor || 0),
    fulizaLimitMinor: Number(row.fuliza_limit_minor || 0),
    fulizaUsedMinor: Number(row.fuliza_used_minor || 0),
    holderName: row.holder_name,
    phone: row.phone,
    updatedAt: row.updated_at
  };
}

function txShape(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    subtitle: row.subtitle,
    amountMinor: Number(row.amount_minor),
    balanceAfterMinor: Number(row.balance_after_minor),
    fulizaAfterMinor: Number(row.fuliza_after_minor || 0),
    reference: row.reference,
    at: row.created_at
  };
}

/* A statement screen shows a page, never a lifetime. */
const MAX_HISTORY = 60;

/* ---------------- reads ---------------- */

export async function walletFor(userId) {
  const { data, error } = await admin
    .from('mpesa_demo_wallet').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw new HttpError(500, 'wallet_failed', error.message);
  return walletShape(data);
}

export async function linkByPin(pin) {
  const { data, error } = await admin.rpc('mpesa_demo_link', { p_pin: pin });
  if (error) throw new HttpError(500, 'link_failed', error.message);
  return walletShape(data);
}

export async function walletByToken(token) {
  const { data, error } = await admin.rpc('mpesa_demo_by_token', { p_token: token });
  if (error) throw new HttpError(500, 'wallet_failed', error.message);
  return walletShape(data);
}

export async function statementFor(userId, limit = MAX_HISTORY) {
  const { data, error } = await admin
    .from('mpesa_demo_tx').select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(Math.min(MAX_HISTORY, limit));
  if (error) throw new HttpError(500, 'statement_failed', error.message);
  return (data || []).map(txShape);
}

/* Everything the handset renders, in one call, because it polls. */
export async function handsetView(wallet) {
  const statement = await statementFor(wallet.userId);
  return {
    balanceMinor: wallet.balanceMinor,
    fuliza: {
      limitMinor: wallet.fulizaLimitMinor,
      usedMinor: wallet.fulizaUsedMinor,
      availableMinor: Math.max(0, wallet.fulizaLimitMinor - wallet.fulizaUsedMinor)
    },
    holderName: wallet.holderName || 'M-PESA user',
    phone: wallet.phone || null,
    statement
  };
}

/* ---------------- movement ---------------- */

/**
 * One movement, and the text that confirms it.
 *
 * Every rail on this side of the demo funnels through here — the
 * handset's own buttons, a VIP's deposit, a payout, a refund — which is
 * why the SMS is sent from here rather than from five call sites that
 * would each forget it differently.
 *
 * The send is deliberately not awaited. The money has already moved by
 * the time it starts, and a gateway that is slow or down must not hold
 * up the response the handset is waiting on. Failures land in the event
 * log, which is where an operator looks when a message did not arrive.
 *
 * @param {boolean} [notify=true]  false for a movement nobody should be
 *        texted about — currently nothing, kept for the day there is one.
 */
export async function move({ userId, kind, amountMinor, direction, title, subtitle, reference, notify = true }) {
  const { data, error } = await admin.rpc('mpesa_demo_move', {
    p_user: userId,
    p_kind: kind,
    p_amount: amountMinor,
    p_direction: direction,
    p_title: title,
    p_subtitle: subtitle || '',
    p_reference: reference || demoReference()
  });

  if (error) {
    const m = error.message || '';
    if (m.includes('NO_WALLET')) throw new NoWallet();
    if (m.includes('INSUFFICIENT_FUNDS')) throw new InsufficientFunds();
    throw new HttpError(500, 'move_failed', m);
  }
  const moved = {
    balanceMinor: Number(data.balanceMinor),
    fulizaUsedMinor: Number(data.fulizaUsedMinor),
    fulizaLimitMinor: Number(data.fulizaLimitMinor),
    tx: txShape(data.tx)
  };

  if (notify) {
    /* The wallet is re-read rather than cached on the way in: the phone
       number is set in the console and may have changed since this
       request started, and texting the previous holder of a number is
       not a mistake worth saving a query for. */
    walletFor(userId)
      .then(wallet => (wallet ? notifyMovement(wallet, moved) : undefined))
      .catch(() => undefined);
  }

  return moved;
}

export async function resetWallet(userId, balanceMinor) {
  const { data, error } = await admin.rpc('mpesa_demo_reset', {
    p_user: userId,
    p_balance: balanceMinor == null ? null : balanceMinor
  });
  if (error) {
    if ((error.message || '').includes('NO_WALLET')) throw new NoWallet();
    throw new HttpError(500, 'reset_failed', error.message);
  }
  return walletShape(data);
}

/* ---------------- admin ---------------- */

export async function setWallet(userId, { pin, balanceMinor, fulizaLimitMinor, name, phone }) {
  const { data, error } = await admin.rpc('mpesa_demo_set_wallet', {
    p_user: userId,
    p_pin: pin ?? null,
    p_balance: balanceMinor ?? null,
    p_fuliza_limit: fulizaLimitMinor ?? null,
    p_name: name ?? null,
    p_phone: phone ?? null
  });

  if (error) {
    const m = error.message || '';
    if (m.includes('PIN_TAKEN')) {
      throw conflict('That PIN is already assigned to another account.');
    }
    if (m.includes('BAD_PIN')) throw badRequest('The PIN must be four digits.');
    if (m.includes('PIN_REQUIRED')) {
      throw badRequest('Set a four digit PIN to create the wallet.');
    }
    if (m.includes('BAD_BALANCE')) throw badRequest('The balance cannot be negative.');
    if (m.includes('BAD_FULIZA')) throw badRequest('The Fuliza limit cannot be negative.');
    throw new HttpError(500, 'wallet_save_failed', m);
  }
  return walletShape(data);
}

export async function clearWallet(userId) {
  const { error } = await admin.rpc('mpesa_demo_clear_wallet', { p_user: userId });
  if (error) throw new HttpError(500, 'wallet_clear_failed', error.message);
  return true;
}

/* ---------------- gates ---------------- */

/**
 * The handset. It has no Supabase session and no account of its own: the
 * device token it was given when the PIN was accepted is the whole of
 * its identity, and it presents that on every call.
 */
export async function requireHandset(req) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  const value = (scheme || '').toLowerCase() === 'bearer'
    ? token
    : (req.get('x-device-token') || '');

  if (!value) throw unauthorized('This phone is not linked yet.');

  const wallet = await walletByToken(value.trim());
  if (!wallet) throw unauthorized('This phone is no longer linked. Enter the PIN again.');
  return wallet;
}

/**
 * The trading terminal, for a VIP.
 *
 * The tier is read from the database on every call rather than taken
 * from a token: a customer demoted back to Standard mid-session must not
 * keep spending a prop balance because their JWT still says otherwise.
 */
export async function requireVip(userId) {
  const { data, error } = await admin
    .from('profiles').select('tier,display_name,phone').eq('id', userId).single();

  if (error) throw new HttpError(500, 'tier_failed', error.message);
  if (!data || data.tier !== 'vip') {
    throw forbidden('This account is not on the demo rail.');
  }
  return data;
}

export async function tierOf(userId) {
  const { data } = await admin
    .from('profiles').select('tier').eq('id', userId).maybeSingle();
  return data?.tier === 'vip' ? 'vip' : 'standard';
}
