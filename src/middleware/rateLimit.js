import rateLimit from 'express-rate-limit';

const base = {
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many attempts. Try again shortly.' } }
};

/* Credential endpoints are the ones worth guessing at, so they get a
   tighter budget than the rest of the API. */
export const authLimiter = rateLimit({ ...base, windowMs: 15 * 60 * 1000, max: 20 });

/* A password reset also sends mail, so it is rate limited by address as
   well as by IP — otherwise one attacker can flood one inbox. */
export const resetLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => `${req.ip}:${(req.body?.email || '').toLowerCase()}`
});

export const paymentLimiter = rateLimit({ ...base, windowMs: 60 * 1000, max: 10 });

export const generalLimiter = rateLimit({ ...base, windowMs: 60 * 1000, max: 120 });
