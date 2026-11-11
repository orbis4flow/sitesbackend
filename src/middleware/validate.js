import { badRequest } from '../lib/errors.js';

/* Parse and replace. Whatever reaches the handler has already been
   checked and coerced, so handlers never re-validate. */
export function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const fields = {};
      for (const issue of result.error.issues) {
        fields[issue.path.join('.') || 'value'] = issue.message;
      }
      return next(badRequest('Check the details you entered', fields));
    }
    req[source] = result.data;
    next();
  };
}
