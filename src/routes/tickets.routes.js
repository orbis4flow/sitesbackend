/* ============================================================
   Support tickets

   The customer's half. A category, a description, and whatever reply
   came back. There is no thread: a ticket is one question and one
   answer, and when that is not enough the customer opens another one.

   That is a smaller promise than live chat, and it is one the team can
   actually keep at this size. See the note at the top of sql/012 for
   what was here before.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import { admin } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { conflict, HttpError } from '../lib/errors.js';
import { events } from '../lib/events.js';

const router = Router();

const CATEGORIES = ['deposit', 'withdrawal', 'account', 'trading', 'other'];

/* Three at once is somebody who is not being answered, not somebody with
   three problems, and the second copy of a question makes the first one
   slower to answer. */
const MAX_OPEN = 3;

function publicTicket(t) {
  return {
    id: t.id,
    category: t.category,
    body: t.body,
    status: t.status,
    reply: t.reply,
    at: t.created_at,
    repliedAt: t.replied_at
  };
}

/* ---------------- this account's tickets ---------------- */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await req.db
      .from('support_tickets')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) throw new HttpError(500, 'tickets_failed', error.message);
    res.json({ ok: true, tickets: (data || []).map(publicTicket) });
  } catch (err) { next(err); }
});

/* ---------------- open one ---------------- */
router.post('/',
  requireAuth,
  validate(z.object({
    category: z.enum(CATEGORIES),
    body: z.string().trim().min(10).max(2000)
  })),
  async (req, res, next) => {
    try {
      const { count } = await admin
        .from('support_tickets')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', req.user.id)
        .eq('status', 'open');

      if ((count || 0) >= MAX_OPEN) {
        throw conflict('You already have three open tickets. We will answer those first.');
      }

      const { data, error } = await admin
        .from('support_tickets')
        .insert({
          user_id: req.user.id,
          category: req.body.category,
          body: req.body.body
        })
        .select()
        .single();

      if (error) throw new HttpError(500, 'tickets_failed', error.message);

      events.info('support', 'Ticket opened', {
        userId: req.user.id, context: { category: req.body.category }
      });

      res.status(201).json({ ok: true, ticket: publicTicket(data) });
    } catch (err) { next(err); }
  });

export default router;
