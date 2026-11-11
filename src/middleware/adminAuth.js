/* ============================================================
   Operator access
   Two gates, not one: a valid session, and a staff role read from the
   database on every request. Roles are never taken from the JWT — a
   token issued before someone was demoted would still carry the old
   claim, and that is exactly the request you do not want to honour.
   ============================================================ */
import { admin } from '../lib/supabase.js';
import { unauthorized, forbidden } from '../lib/errors.js';
import { userForToken } from './auth.js';

/* The full set of roles that may open the console. This is the door;
   requireRole() below narrows individual actions once inside. The list
   has to match the CHECK constraint on profiles.role (sql/005_roles.sql)
   — a role the database accepts but this list omits is an account that
   can be created and then cannot sign in. */
export const STAFF_ROLES = [
  'super_admin',      /* creates other staff; the only role that can */
  'admin',
  'manager',
  'finance',          /* moves money: approves payouts */
  'operator',         /* day to day: users, KYC, payments */
  'marketing',
  'session_handler'   /* runs one live session at a time */
];

export async function requireStaff(req, _res, next) {
  try {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (!token || scheme.toLowerCase() !== 'bearer') throw unauthorized();

    /* Checked locally: the role and status below are read from the
       database on every request, which is the gate that matters. */
    const authed = await userForToken(token);
    if (!authed) throw unauthorized('That session has expired. Sign in again.');
    const data = { user: authed };

    const { data: profile } = await admin
      .from('profiles')
      .select('id,email,display_name,role,status')
      .eq('id', data.user.id)
      .single();

    if (!profile || !STAFF_ROLES.includes(profile.role)) {
      /* Deliberately vague. Confirming that an endpoint exists but is
         out of reach is more than an outsider needs to know. */
      throw forbidden('This account cannot use the console.');
    }
    if (profile.status === 'suspended') {
      throw forbidden('This account is suspended.');
    }

    req.user = data.user;
    req.operator = profile;
    req.accessToken = token;
    next();
  } catch (err) {
    next(err);
  }
}

/* Some actions should be narrower than "staff". Finance can move money;
   only an admin can change what another account is allowed to do. */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.operator || !roles.includes(req.operator.role)) {
      return next(forbidden('Your role does not allow that.'));
    }
    next();
  };
}

/* Every write is recorded. Logging must never be the reason an action
   fails, so a failure here is swallowed after being logged. */
export async function audit(req, action, subject, detail) {
  try {
    await admin.from('admin_audit').insert({
      actor_id: req.operator?.id || null,
      actor_email: req.operator?.email || null,
      action,
      subject: subject || null,
      detail: detail || null
    });
  } catch (err) {
    req.log?.error({ err, action }, 'could not write audit row');
  }
}
