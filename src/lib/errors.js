/* Typed errors so routes can throw and one handler decides the status. */
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Sign in to continue') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Not allowed') => new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found') => new HttpError(404, 'not_found', msg);
export const conflict = (msg, details) => new HttpError(409, 'conflict', msg, details);
export const tooMany = (msg = 'Too many attempts. Try again shortly.') =>
  new HttpError(429, 'rate_limited', msg);
export const upstream = (msg = 'The payment provider did not respond') =>
  new HttpError(502, 'upstream_error', msg);
