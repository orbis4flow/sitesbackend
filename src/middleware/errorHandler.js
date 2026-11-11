import { HttpError } from '../lib/errors.js';
import { isProd } from '../config/env.js';

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint' } });
}

/* One place decides what the client sees. Nothing internal leaks: an
   unexpected error is logged in full and reported as a generic 500,
   because stack traces and driver messages are a gift to an attacker. */
export function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { fields: err.details } : {}) }
    });
  }

  req.log?.error({ err }, 'unhandled error');
  res.status(500).json({
    error: {
      code: 'server_error',
      message: 'Something went wrong on our side. Nothing was charged.',
      ...(isProd ? {} : { detail: err.message })
    }
  });
}
