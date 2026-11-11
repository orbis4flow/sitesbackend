/* ============================================================
   Verification

   The customer's half. The document itself never passes through here:
   the browser uploads it straight into a private Supabase Storage bucket
   with its own token, into a folder named after its user id, and then
   tells us the path. So a passport photo never sits in a request log, an
   error report, or this service's memory.

   Everything is handed in together: proof of address and both sides
   of a government ID, in one submission, reviewed and approved once.
   See sql/016.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import { admin } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { badRequest, conflict, HttpError } from '../lib/errors.js';
import { events } from '../lib/events.js';

const router = Router();

/* The three documents a verification needs, all at once. */
const REQUIRED = ['proof_of_address', 'government_id_front', 'government_id_back'];

function publicSubmission(s) {
  return {
    id: s.id,
    kind: s.kind,
    documents: (s.files || []).map(f => f.kind),
    status: s.status,
    note: s.note,
    at: s.created_at,
    reviewedAt: s.reviewed_at
  };
}

/* ---------------- what this account has already sent ---------------- */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await req.db
      .from('kyc_submissions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) throw new HttpError(500, 'kyc_failed', error.message);

    const rows = (data || []).map(publicSubmission);
    res.json({
      ok: true,
      submissions: rows,
      pending: rows.some(r => r.status === 'pending'),
      required: REQUIRED
    });
  } catch (err) { next(err); }
});

/* ---------------- hand them in ----------------
   Every path is checked against the caller rather than trusted. It
   arrives from the browser, and a browser can send any string: without
   this, somebody could point their submission at another customer's
   folder and have staff review a document that is not theirs. */
const documentSchema = z.object({
  kind: z.enum(REQUIRED),
  path: z.string().min(3).max(300),
  mimeType: z.string().max(80).optional(),
  byteSize: z.coerce.number().int().min(1).max(8 * 1024 * 1024).optional()
});

router.post('/',
  requireAuth,
  validate(z.object({
    documents: z.array(documentSchema).min(1).max(REQUIRED.length)
  })),
  async (req, res, next) => {
    try {
      const docs = req.body.documents.map(d => ({ ...d, path: d.path.replace(/^\/+/, '') }));

      const missing = REQUIRED.filter(k => !docs.some(d => d.kind === k));
      if (missing.length) {
        throw badRequest('Send your proof of address and both sides of your ID together.', {
          documents: 'Missing ' + missing.join(', ')
        });
      }
      if (docs.some(d => d.path.split('/')[0] !== req.user.id)) {
        throw badRequest('That document does not belong to this account.');
      }

      const { data: profile } = await admin
        .from('profiles').select('kyc_status').eq('id', req.user.id).maybeSingle();
      if (profile?.kyc_status === 'verified') {
        throw conflict('This account is already verified.');
      }

      /* A full submission replaces anything still waiting, so somebody
         whose earlier upload was half done is never stuck behind it. */
      await admin
        .from('kyc_submissions')
        .update({ status: 'superseded' })
        .eq('user_id', req.user.id)
        .eq('status', 'pending');

      const address = docs.find(d => d.kind === 'proof_of_address');
      const { data, error } = await admin
        .from('kyc_submissions')
        .insert({
          user_id: req.user.id,
          kind: 'full',
          storage_path: address.path,
          mime_type: address.mimeType || null,
          byte_size: address.byteSize || null,
          files: REQUIRED.map(k => {
            const d = docs.find(x => x.kind === k);
            return { kind: k, path: d.path, mimeType: d.mimeType || null, byteSize: d.byteSize || null };
          })
        })
        .select()
        .single();

      if (error) {
        /* Two submissions racing: the other one got in first. */
        if (/duplicate key|kyc_submissions_one_pending/i.test(error.message)) {
          throw conflict('Your documents are already under review.');
        }
        throw new HttpError(500, 'kyc_failed', error.message);
      }

      /* Pending is set here rather than by the browser, which is the
         point of the whole route: the old flow let the customer's own
         page decide it was verified. */
      await admin.from('profiles')
        .update({ kyc_status: 'pending' })
        .eq('id', req.user.id);

      events.info('kyc', 'Verification documents submitted', { userId: req.user.id });

      res.status(201).json({ ok: true, submission: publicSubmission(data) });
    } catch (err) { next(err); }
  });

export default router;
