/* ============================================================
   Kora API (Kora, Lyra and Vexa share it)
   Express in front of Supabase, with Paystack and PayHero for money.

   Mounting order matters in one place: the Paystack webhook needs the
   raw request body to check its signature, so it is registered before
   express.json() gets a chance to consume the stream.
   ============================================================ */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import pino from 'pino';

import { env, corsOrigins, payheroAuthSource, smsSource } from './config/env.js';
import { originPermitted, liveDomains } from './lib/origins.js';
import { events } from './lib/events.js';
import { callbackUrl as payheroCallbackUrl } from './services/payhero.js';
import { generalLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

import authRoutes from './routes/auth.routes.js';
import depositRoutes from './routes/deposits.routes.js';
import withdrawalRoutes from './routes/withdrawals.routes.js';
import tradeRoutes from './routes/trades.routes.js';
import runRoutes from './routes/runs.routes.js';
import copyRoutes from './routes/copy.routes.js';
import kycRoutes from './routes/kyc.routes.js';
import ticketRoutes from './routes/tickets.routes.js';
import mpesaRoutes from './routes/mpesa.routes.js';
import webhookRoutes from './routes/webhooks.routes.js';
import adminRoutes from './routes/admin.routes.js';

const logger = pino({
  level: env.LOG_LEVEL,
  /* Anything that could carry a secret is stripped before it is written.
     Logs get shipped, searched and pasted into tickets. */
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-paystack-signature"]',
      'req.body.password',
      'req.body.currentPassword',
      'req.body.accessToken',
      'req.body.refreshToken'
    ],
    censor: '[redacted]'
  }
});

const app = express();

app.set('trust proxy', env.TRUST_PROXY);
app.disable('x-powered-by');

app.use(pinoHttp({ logger }));
app.use(helmet());

app.use(cors({
  async origin(origin, cb) {
    /* No Origin header means a server-to-server call or a health probe,
       which CORS does not govern. */
    if (!origin) return cb(null, true);
    /* CORS_ORIGINS, or any domain set live on the console's Domains
       page (see lib/origins.js). */
    if (await originPermitted(origin)) return cb(null, true);
    /* Logged at warn, because from the browser this is invisible: the
       page reports a network failure and nothing says which origin was
       turned away. This line is the answer, and it is what the console's
       Logs page surfaces. */
    logger.warn({ origin, allowed: corsOrigins, domains: liveDomains() }, 'cors: origin refused');
    events.warn('cors', 'Refused a request from ' + origin, {
      context: { origin, allowed: corsOrigins, domains: liveDomains() }
    });
    cb(new Error(`Origin ${origin} is not allowed`));
  },
  credentials: true,
  maxAge: 86400
}));

/* ---- webhooks come first: raw body, no rate limit ----
   Rate limiting a provider's retries would turn a transient blip into
   lost settlements. */
app.use('/webhooks/paystack', express.raw({ type: '*/*', limit: '1mb' }));
app.use('/webhooks', express.json({ limit: '1mb' }), webhookRoutes);

/* ---- everything else ---- */
app.use(express.json({ limit: '256kb' }));
app.use(generalLimiter);

/* uptime is here on purpose. A 502 from the host looks the same whether
   the instance is asleep, restarting, or crashed — and from a browser it
   also looks like a CORS failure, because an error page carries no CORS
   headers. Uptime settles it: poll this, and if the number keeps
   resetting the process is dying; if it climbs, the 502s were the host
   waking a sleeping instance. Neither fact is sensitive. */
const startedAt = Date.now();

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'kora-api',
    env: env.NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: new Date(startedAt).toISOString(),
    time: new Date().toISOString()
  });
});

app.get('/config', (_req, res) => {
  /* What the browser is allowed to know: the limits it should enforce
     before bothering the server. No keys — nothing payment-shaped runs
     in the browser. */
  res.json({
    ok: true,
    minDepositMinor: env.MIN_DEPOSIT_MINOR,
    maxDepositMinor: env.MAX_DEPOSIT_MINOR,
    minWithdrawalMinor: env.MIN_WITHDRAWAL_MINOR,
    usdRateKes: env.USD_RATE_KES,
    /* The deposit address is public by nature: it is what people send
       money to. Served from here rather than hardcoded in the site so
       changing wallets is one environment variable, not a deploy of
       every page. */
    usdt: {
      address: env.USDT_ADDRESS,
      network: env.USDT_NETWORK,
      minMinor: env.MIN_USDT_MINOR
    }
  });
});

app.use('/auth', authRoutes);
app.use('/deposits', depositRoutes);
app.use('/withdrawals', withdrawalRoutes);
app.use('/trades', tradeRoutes);
app.use('/runs', runRoutes);
app.use('/copy', copyRoutes);
app.use('/kyc', kycRoutes);
app.use('/tickets', ticketRoutes);
/* The companion handset. No Supabase session: it authenticates with a
   device token issued when its PIN was accepted. */
app.use('/mpesa', mpesaRoutes);
app.use('/admin', adminRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(env.PORT, () => {
  logger.info(`kora-api listening on ${env.PORT} (${env.NODE_ENV})`);
  /* The PayHero callback is derived rather than configured, so the only
     way to know it is to be told. Printed once, into the server log. */
  logger.info(`paystack webhook   ${env.API_URL}/webhooks/paystack`);
  logger.info(`payhero callback   ${payheroCallbackUrl()}`);
  /* An empty allow-list is not an error — webhooks and health checks carry
     no Origin — but every browser call will be refused, which looks like
     the API being down rather than a missing setting. Say so out loud. */
  if (!corsOrigins.length) {
    logger.warn('CORS_ORIGINS is empty: no browser origin can call this API');
  }
  logger.info(`payhero auth       ${payheroAuthSource}`);
  logger.info(`payhero channel    ${env.PAYHERO_CHANNEL_ID || 'NOT SET — M-Pesa will refuse'}`);
  /* The demo rail's confirmation texts. Unset is a valid state, so this
     is info rather than a warning — but it is printed either way, because
     the first sign of a missing key is otherwise a presentation where no
     message arrives. */
  logger.info(`demo rail sms      ${smsSource}`);
});

/* ---- crashes leave a note ----
   A process that dies without saying why is the hardest thing to debug
   on a host you cannot attach to: the request 502s, the next request
   502s while it restarts, and the log is gone by the time anyone looks.

   An unhandled rejection does NOT take the service down here. The
   default is to exit, and for most programs that is right — but this one
   settles payments, and dying mid-settlement is worse than continuing
   with one broken promise. It is recorded loudly instead.

   An uncaught exception is different: the process is in an unknown state
   after one, so it is logged and then allowed to die so the host can
   start a clean one. */
/* Enough of a stack to name the file and the line, not enough to fill
   a log line with framework internals. */
function firstLines(stack) {
  return String(stack || '').split(String.fromCharCode(10)).slice(0, 4).join(' | ');
}

process.on('unhandledRejection', (reason) => {
  const message = reason?.message || String(reason);
  logger.error({ err: reason }, 'unhandled rejection: ' + message);
  try {
    events.error('server', 'Unhandled rejection: ' + message, {
      context: { stack: firstLines(reason?.stack) }
    });
  } catch (e) { /* logging must never be the thing that kills it */ }
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception: ' + err.message);
  try {
    events.error('server', 'Uncaught exception, restarting: ' + err.message, {
      context: { stack: firstLines(err.stack) }
    });
  } catch (e) {}
  /* Give the log line a moment to leave the box, then go. */
  setTimeout(() => process.exit(1), 500).unref();
});

/* Render sends SIGTERM on deploy. Finish in-flight requests rather than
   dropping someone mid-deposit. */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    logger.info(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}

export default app;
