import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { authRequired, requirePermission } from '../middleware/auth.js';
import { db } from '../db.js';
import { brevoEnabled, sendTransactionalEmail } from '../lib/brevo.js';

const router = Router();

router.get('/status', authRequired, (_req, res) => {
  res.json({
    enabled: brevoEnabled(),
    sender: process.env.BREVO_SENDER_EMAIL || null,
  });
});

/** Send a one-off email to a lead (Phase 1 Brevo). */
router.post(
  '/leads/:id/send',
  authRequired,
  requirePermission('leads:update_own'),
  async (req, res) => {
    try {
      const lead = db
        .prepare(`SELECT id, name, email FROM leads WHERE id = ?`)
        .get(req.params.id);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      if (!lead.email) return res.status(400).json({ error: 'Lead has no email' });

      const subject = (req.body?.subject || '').trim();
      const htmlContent = (req.body?.htmlContent || '').trim();
      const textContent = (req.body?.textContent || '').trim();
      if (!subject || (!htmlContent && !textContent)) {
        return res.status(400).json({
          error: 'subject and htmlContent or textContent are required',
        });
      }

      const result = await sendTransactionalEmail({
        toEmail: lead.email,
        toName: lead.name || undefined,
        subject,
        htmlContent: htmlContent || undefined,
        textContent: textContent || undefined,
      });

      db.prepare(
        `INSERT INTO lead_activities (id, lead_id, user_id, type, summary)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(uuid(), lead.id, req.user.id, 'email_sent', `Brevo: ${subject}`);

      res.json({ ok: true, brevo: result });
    } catch (err) {
      const status = err.code === 'BREVO_DISABLED' ? 503 : err.status || 500;
      res.status(status).json({ error: err.message || 'Send failed' });
    }
  },
);

export default router;
