/* ============================================================
   Auth — thin wrapper over Supabase Auth
   Supabase owns the passwords, the hashing, the tokens and the reset
   mail. This layer exists to normalise errors into the shape the front
   end already expects, and to avoid leaking which addresses exist.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import { anon, admin } from '../lib/supabase.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireAuthStrict } from '../middleware/auth.js';
import { authLimiter, resetLimiter } from '../middleware/rateLimit.js';
import { badRequest, unauthorized, forbidden, conflict, HttpError } from '../lib/errors.js';
import { env } from '../config/env.js';
import { normalisePhone, maskPhone } from '../lib/phone.js';
import { events } from '../lib/events.js';
import { siteHost } from '../lib/site.js';

const router = Router();

/* The same rules the browser enforces. Checked again here because a
   client-side check is a convenience, not a control. */
const password = z.string()
  .min(8, 'Use at least 8 characters')
  .refine(v => /[a-z]/.test(v) && /[A-Z]/.test(v), 'Include an upper and a lower case letter')
  .refine(v => /\d/.test(v), 'Include a number')
  .refine(v => /[^A-Za-z0-9]/.test(v), 'Include a symbol');

const email = z.string().trim().toLowerCase().email('That does not look like an email address');

/* ---------------- create account ---------------- */
router.post('/signup',
  authLimiter,
  validate(z.object({
    email,
    password,
    name: z.string().trim().min(1, 'Enter your name').max(80),
    phone: z.string().optional(),
    country: z.string().length(2).optional().default('KE'),
    referralCode: z.string().trim().max(16).optional()
  })),
  async (req, res, next) => {
    try {
      const { email: mail, password: pass, name, phone, country, referralCode } = req.body;

      const { data, error } = await anon.auth.signUp({
        email: mail,
        password: pass,
        options: {
          data: { full_name: name, country },
          emailRedirectTo: `${env.APP_URL}/login?confirmed=1`
        }
      });

      if (error) {
        /* Supabase says "User already registered". Saying that back is an
           account-enumeration oracle, so the message stays neutral. */
        if (/already/i.test(error.message)) {
          return res.status(200).json({
            ok: true,
            needsConfirmation: true,
            message: 'Check your email to finish setting up your account.'
          });
        }
        throw new HttpError(400, 'signup_failed', error.message);
      }

      /* The trigger in 001_schema.sql has already created the profile and
         both balances. Fill in the extras it could not know. */
      if (data.user) {
        const patch = {};
        if (phone) patch.phone = normalisePhone(phone, country) || null;
        if (country) patch.country = country;
        /* The site the account was opened on, for the console's Domains
           and Payments pages. */
        const site = siteHost(req);
        if (site) patch.domain_host = site;

        if (referralCode) {
          const { data: referrer } = await admin
            .from('profiles').select('id')
            .eq('referral_code', referralCode.toUpperCase())
            .maybeSingle();
          /* Ignore a code that does not resolve — a typo should not stop
             someone opening an account. */
          if (referrer && referrer.id !== data.user.id) patch.referred_by = referrer.id;
        }

        if (Object.keys(patch).length) {
          await admin.from('profiles').update(patch).eq('id', data.user.id);
        }
      }

      /* Supabase withholds a session when the project has email
         confirmation switched on. It also withholds one on some
         configurations where no confirmation email is ever sent, and
         then the customer is told to check an inbox nothing is coming
         to — an account they cannot get into, created successfully.

         So rather than trusting the absence of a session, ask: sign in
         with what was just typed. If the project wants a confirmation
         that attempt fails and the message stands; if it does not, the
         account is already usable and they go straight to the terminal.
         Either way it is the server that finds out, not the customer. */
      let session = data.session;
      if (!session) {
        const { data: signedIn } = await anon.auth.signInWithPassword({
          email: mail, password: pass
        });
        if (signedIn?.session) session = signedIn.session;
      }

      res.status(201).json({
        ok: true,
        needsConfirmation: !session,
        session: session ? publicSession(session) : null,
        user: data.user ? { id: data.user.id, email: data.user.email } : null
      });
    } catch (err) { next(err); }
  });

/* ---------------- sign in ---------------- */
router.post('/login',
  authLimiter,
  validate(z.object({ email, password: z.string().min(1, 'Enter your password') })),
  async (req, res, next) => {
    try {
      const { data, error } = await anon.auth.signInWithPassword({
        email: req.body.email,
        password: req.body.password
      });

      /* One message for a wrong password and for an unknown address, so
         this endpoint cannot be used to discover who has an account. */
      if (error || !data.session) {
        if (/confirm/i.test(error?.message || '')) {
          throw new HttpError(403, 'email_unconfirmed',
            'Confirm your email address first. Check your inbox.');
        }
        throw unauthorized('That email and password do not match.');
      }

      res.json({ ok: true, session: publicSession(data.session), user: publicUser(data.user) });
    } catch (err) { next(err); }
  });

/* ---------------- Google ----------------
   The browser never posts Google credentials here. We hand back the
   consent URL, Supabase handles the exchange, and the browser comes back
   with a session in the URL fragment. */
router.get('/google', async (req, res, next) => {
  try {
    /* Clean URLs: the site dropped .html from every address, and the host
       308s the old form to the new one. That redirect does carry the
       fragment Supabase puts the tokens in, but relying on it is a hop
       and an assumption for no reason, and every one of these addresses
       has to be on the Supabase redirect allow-list by hand, where two
       spellings of the same page is one more thing to get wrong. */
    const redirectTo = `${env.APP_URL}/login?oauth=1`;
    const { data, error } = await anon.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: true }
    });
    if (error) throw new HttpError(502, 'oauth_failed', error.message);
    res.json({ ok: true, url: data.url });
  } catch (err) { next(err); }
});

/* Exchange a PKCE code for a session, for flows that return a code
   rather than a fragment. */
router.post('/callback',
  validate(z.object({ code: z.string().min(10) })),
  async (req, res, next) => {
    try {
      const { data, error } = await anon.auth.exchangeCodeForSession(req.body.code);
      if (error || !data.session) throw unauthorized('That sign-in link is no longer valid.');
      res.json({ ok: true, session: publicSession(data.session), user: publicUser(data.user) });
    } catch (err) { next(err); }
  });

/* ---------------- forgot / reset password ---------------- */
router.post('/forgot-password',
  resetLimiter,
  validate(z.object({ email })),
  async (req, res, next) => {
    try {
      await anon.auth.resetPasswordForEmail(req.body.email, {
        redirectTo: `${env.APP_URL}/reset-password`
      });
      /* Always the same answer, whether or not the address is on file. */
      res.json({
        ok: true,
        message: 'If that address has an account, a reset link is on its way.'
      });
    } catch (err) { next(err); }
  });

/* The browser arrives at reset-password.html holding a recovery token.
   It sends that token here with the new password. */
router.post('/reset-password',
  authLimiter,
  validate(z.object({ accessToken: z.string().min(10), password })),
  async (req, res, next) => {
    try {
      const { data: userData, error: userErr } =
        await admin.auth.getUser(req.body.accessToken);
      if (userErr || !userData?.user) {
        throw unauthorized('That reset link has expired. Request a new one.');
      }

      const { error } = await admin.auth.admin.updateUserById(userData.user.id, {
        password: req.body.password
      });
      if (error) throw new HttpError(400, 'reset_failed', error.message);

      res.json({ ok: true, message: 'Password updated. Sign in with your new password.' });
    } catch (err) { next(err); }
  });

/* ---------------- change password while signed in ---------------- */
router.post('/change-password',
  requireAuthStrict,
  authLimiter,
  validate(z.object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    password
  })),
  async (req, res, next) => {
    try {
      /* Re-authenticate first. Without this, a stolen access token is
         enough to take the account over permanently. */
      const { error: checkErr } = await anon.auth.signInWithPassword({
        email: req.user.email,
        password: req.body.currentPassword
      });
      if (checkErr) throw badRequest('Your current password is not right', {
        currentPassword: 'That is not your current password'
      });

      const { error } = await admin.auth.admin.updateUserById(req.user.id, {
        password: req.body.password
      });
      if (error) throw new HttpError(400, 'update_failed', error.message);

      res.json({ ok: true, message: 'Password updated' });
    } catch (err) { next(err); }
  });

/* ---------------- session ----------------
   The number goes out masked and never in full. The browser has no use
   for the digits — the deposit rail reads them from the profile — and a
   browser that never receives them cannot put them on a screen somebody
   else is looking at, or leave them in a cache. */
router.get('/session', requireAuth, async (req, res, next) => {
  try {
    const { data: row } = await req.db
      .from('profiles')
      .select('id,email,display_name,phone,country,kyc_status,referral_code,tier,demo_mode,copy_active,created_at')
      .eq('id', req.user.id)
      .single();

    const profile = row && {
      ...row,
      /* VIP accounts hand out the keys, so they never need one. */
      copy_active: !!row.copy_active || row.tier === 'vip',
      phone: undefined,
      phone_masked: maskPhone(row.phone),
      phone_set: !!row.phone,
      /* The name an ID check reads, and whether it can still be edited.
         The console screen needs both: a locked field that looks
         editable is worse than one that says why it is not. */
      legal_name: req.user.user_metadata?.full_name || null,
      name_locked: row.kyc_status === 'verified'
    };

    const { data: accounts } = await req.db
      .from('accounts')
      .select('kind,currency,balance_minor')
      .eq('user_id', req.user.id);

    /* A token checked locally carries no account date; the profile
       row has one, made in the same moment as the account. */
    const user = publicUser(req.user);
    if (!user.createdAt && row?.created_at) user.createdAt = row.created_at;

    /* A Google sign-up never passes through /signup, so its site is
       recorded here, on the first session check of a brand new account.
       Best effort: it must never stand between someone and the app. */
    if (row?.created_at && Date.now() - new Date(row.created_at).getTime() < 30 * 60 * 1000) {
      const site = siteHost(req);
      if (site) {
        admin.from('profiles').update({ domain_host: site })
          .eq('id', req.user.id).is('domain_host', null)
          .then(() => undefined, () => undefined);
      }
    }

    res.json({ ok: true, user, profile, accounts: accounts || [] });
  } catch (err) { next(err); }
});

/* ---------------- the account ----------------
   Two names, and they are not the same thing.

   The legal name lives on the auth user as full_name and is what an ID
   check is read against. The display name lives on the profile and is
   what other people see in support chat and copy trading. Editing them
   on one screen is right; storing them in one field would not be, since
   one of them has to match a document and the other is a handle.

   Once identity is verified the legal name stops being editable here. A
   verified account whose name can be typed over is a verified account
   that proves nothing, and the way back is a fresh check rather than a
   form. The display name stays editable, because nothing was ever
   checked against it.
*/
router.post('/profile',
  requireAuthStrict,
  validate(z.object({
    firstName: z.string().trim().max(40).optional(),
    lastName: z.string().trim().max(40).optional(),
    displayName: z.string().trim().min(1, 'Pick a name to show other traders').max(40).optional()
  })),
  async (req, res, next) => {
    try {
      const { firstName, lastName, displayName } = req.body;
      const wantsLegal = firstName !== undefined || lastName !== undefined;

      const { data: profile } = await req.db
        .from('profiles').select('display_name,kyc_status').eq('id', req.user.id).single();

      let fullName = req.user.user_metadata?.full_name || null;

      if (wantsLegal) {
        if (profile?.kyc_status === 'verified') {
          throw badRequest(
            'Your name is fixed once your identity is verified. Contact support to change it.',
            { firstName: 'Locked by verification' });
        }
        const first = (firstName ?? '').trim();
        const last = (lastName ?? '').trim();
        if (!first) throw badRequest('Enter your first name', { firstName: 'Required' });
        if (!last) throw badRequest('Enter your last name', { lastName: 'Required' });
        /* A name with digits in it is not a name, and it is the one
           thing an ID check will reject out of hand. */
        if (/\d/.test(first + last)) {
          throw badRequest('Names cannot contain numbers', { firstName: 'Letters only' });
        }

        fullName = `${first} ${last}`;
        const { error } = await admin.auth.admin.updateUserById(req.user.id, {
          user_metadata: { ...(req.user.user_metadata || {}), full_name: fullName }
        });
        if (error) throw new HttpError(400, 'profile_failed', error.message);
      }

      let shown = profile?.display_name || null;
      if (displayName !== undefined) {
        shown = displayName;
        const { error } = await admin
          .from('profiles').update({ display_name: shown }).eq('id', req.user.id);
        if (error) throw new HttpError(500, 'profile_failed', error.message);
      }

      events.info('auth', 'Profile updated', {
        userId: req.user.id,
        context: { legalName: wantsLegal, displayName: displayName !== undefined }
      });

      res.json({ ok: true, name: fullName, displayName: shown });
    } catch (err) { next(err); }
  });

/* ---------------- the deposit number ----------------
   The number a deposit is taken from. It is set at sign-up and changed
   here, because the alternative is a customer typing it in full on the
   deposit sheet every time — which is the one moment they are in a
   hurry, and a mistyped digit there is a prompt sent to a stranger's
   handset.

   No password. It was asked for at first, on the grounds that this is
   where our messages go — but the number cannot be used to take
   anything (a deposit pulls from the handset that approves the prompt,
   so a wrong number sends a prompt a stranger declines), and the check
   refused everybody who signed in with Google and therefore has no
   password to give. A guard that stops honest people and no attacker is
   not a guard. The change is recorded in the event log instead, masked,
   so there is a trail of when it moved and to what. */
router.post('/phone',
  requireAuthStrict,
  authLimiter,
  validate(z.object({
    phone: z.string().min(6, 'Enter your number'),
    country: z.string().length(2).optional()
  })),
  async (req, res, next) => {
    try {
      const { data: profile } = await req.db
        .from('profiles').select('country,phone').eq('id', req.user.id).single();

      const phone = normalisePhone(req.body.phone, req.body.country || profile?.country || 'KE');
      if (!phone) {
        throw badRequest('That number does not look right', {
          phone: 'Enter it in full, for example 0712345678'
        });
      }

      const { error } = await admin
        .from('profiles').update({ phone }).eq('id', req.user.id);
      if (error) throw new HttpError(500, 'phone_failed', error.message);

      /* Both ends of the move, masked. Which number it was is the first
         thing anybody asks when a prompt goes somewhere unexpected. */
      events.info('auth', 'Deposit number changed', {
        userId: req.user.id,
        context: { from: maskPhone(profile?.phone) || 'none', to: maskPhone(phone) }
      });

      res.json({ ok: true, phoneMasked: maskPhone(phone) });
    } catch (err) { next(err); }
  });

router.post('/refresh',
  validate(z.object({ refreshToken: z.string().min(10) })),
  async (req, res, next) => {
    try {
      const { data, error } = await anon.auth.refreshSession({
        refresh_token: req.body.refreshToken
      });
      if (error || !data.session) throw unauthorized('Session expired. Sign in again.');
      res.json({ ok: true, session: publicSession(data.session) });
    } catch (err) { next(err); }
  });

router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await admin.auth.admin.signOut(req.accessToken);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ---------------- delete the account ----------------
   Removes the person completely. Every table that holds their data is
   tied to the auth user with ON DELETE CASCADE (profile, balances,
   ledger, payments, withdrawals, trades, verification records, tickets,
   runs), so deleting the auth user takes all of it in one step. The ID
   documents live in Storage, which no foreign key reaches, so those are
   removed first, by hand.

   Refused while it would cost the customer money or strand a payment:
     * a real balance above zero (withdraw it first)
     * a deposit still pending (it could land on an account that is gone)
     * a withdrawal still open
   and for staff, so nobody can lock the console by deleting themselves.

   Confirmed twice: the word DELETE, and the password for an account that
   signs in with one. The session is checked with Supabase, not locally,
   so a token from a signed-out session cannot do this. */
router.post('/account/delete',
  authLimiter,
  requireAuthStrict,
  validate(z.object({
    confirm: z.literal('DELETE', { errorMap: () => ({ message: 'Type DELETE to confirm' }) }),
    password: z.string().max(200).optional()
  })),
  async (req, res, next) => {
    try {
      const userId = req.user.id;

      const { data: profile } = await admin
        .from('profiles').select('id,email,role').eq('id', userId).maybeSingle();
      if (profile && profile.role && profile.role !== 'customer') {
        throw forbidden('Staff accounts cannot be deleted from here.');
      }

      /* Password, for an account that has one. */
      const provider = req.user.app_metadata?.provider || 'email';
      if (provider === 'email') {
        if (!req.body.password) {
          throw badRequest('Enter your password to confirm', { password: 'Required' });
        }
        const { error: pwError } = await anon.auth.signInWithPassword({
          email: req.user.email, password: req.body.password
        });
        if (pwError) throw badRequest('That password is not right', { password: 'Not right' });
      }

      /* Nothing left in flight, nothing left in the account. */
      const { data: accounts } = await admin
        .from('accounts').select('kind,balance_minor').eq('user_id', userId);
      const real = (accounts || []).find(a => a.kind === 'real');
      if (real && Number(real.balance_minor) > 0) {
        throw conflict('Withdraw your real balance before deleting the account.', {
          balanceMinor: Number(real.balance_minor)
        });
      }

      const { count: pendingDeposits } = await admin
        .from('payments').select('id', { count: 'exact', head: true })
        .eq('user_id', userId).eq('status', 'pending');
      if (pendingDeposits) {
        throw conflict('A deposit is still being processed. Try again once it has cleared.');
      }

      const { count: openWithdrawals } = await admin
        .from('withdrawal_requests').select('id', { count: 'exact', head: true })
        .eq('user_id', userId).in('status', ['pending', 'approved']);
      if (openWithdrawals) {
        throw conflict('A withdrawal is still in progress. Try again once it has been paid.');
      }

      /* The documents, which no cascade reaches. */
      try {
        const bucket = admin.storage.from('kyc');
        const { data: files } = await bucket.list(userId, { limit: 1000 });
        const paths = (files || []).map(f => userId + '/' + f.name);
        if (paths.length) await bucket.remove(paths);
      } catch (e) {
        /* Logged rather than fatal: the account still goes, and the note
           says which folder to clear by hand. */
        events.error('auth', 'Could not remove verification files on account deletion', {
          userId, context: { folder: 'kyc/' + userId, error: e?.message }
        });
      }

      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw new HttpError(500, 'delete_failed', error.message);

      /* The event row keeps no link to the user (it was set null by the
         delete), so the address is recorded to say who it was. */
      events.info('auth', 'Account deleted by its owner', {
        context: { userId, email: profile?.email || req.user.email || null }
      });

      res.json({ ok: true, deleted: true });
    } catch (err) { next(err); }
  });

/* Only what the client needs. No provider tokens, no raw metadata. */
function publicSession(session) {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at
  };
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.user_metadata?.full_name || null,
    createdAt: user.created_at || null,
    /* email | google: whether deleting the account asks for a password. */
    provider: user.app_metadata?.provider || 'email'
  };
}

export default router;
