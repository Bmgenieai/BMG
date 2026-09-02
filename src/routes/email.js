import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { authRequired, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { db } from '../db.js';
import {
  applyMergeTags,
  brevoEnabled,
  getBrevoPublicConfig,
  getContactLists,
  getTemplateById,
  getTemplatesForSource,
  COLD_EMAIL_TEMPLATES,
  sendTransactionalEmail,
  upsertContact,
} from '../lib/brevo.js';
import { canAccessLead, roleHasPermission } from '../lib/permissions.js';

const router = Router();

function senderFromUser(user) {
  return { name: user.name, email: process.env.BREVO_SENDER_EMAIL || undefined };
}

function resolveEmailContent({ subject, htmlContent, textContent, templateId, lead, user }) {
  const sender = senderFromUser(user);
  if (templateId) {
    const tpl = getTemplateById(templateId);
    if (!tpl) throw Object.assign(new Error('Unknown template'), { status: 400 });
    return {
      subject: applyMergeTags(subject || tpl.subject, lead, sender),
      htmlContent: applyMergeTags(htmlContent || tpl.htmlContent, lead, sender),
      textContent: applyMergeTags(textContent || tpl.textContent, lead, sender),
    };
  }
  return {
    subject: applyMergeTags(subject, lead, sender),
    htmlContent: htmlContent ? applyMergeTags(htmlContent, lead, sender) : undefined,
    textContent: textContent ? applyMergeTags(textContent, lead, sender) : undefined,
  };
}

function logEmailActivity(leadId, userId, subject, extra = 'Brevo cold email') {
  db.prepare(
    `INSERT INTO lead_activities (id, lead_id, user_id, type, summary)
     VALUES (?, ?, ?, 'email_sent', ?)`,
  ).run(uuid(), leadId, userId, `${extra}: ${subject}`);
}

router.get('/status', authRequired, (_req, res) => {
  res.json(getBrevoPublicConfig());
});

router.get('/templates', authRequired, (req, res) => {
  const { source } = req.query;
  if (source) {
    return res.json({ templates: getTemplatesForSource(String(source)) });
  }
  res.json({ templates: COLD_EMAIL_TEMPLATES });
});

router.get('/lists', authRequired, requireAnyPermission('leads:assign', 'leads:import'), async (_req, res) => {
  try {
    const data = await getContactLists();
    res.json(data);
  } catch (err) {
    const status = err.code === 'BREVO_DISABLED' ? 503 : err.status || 500;
    res.status(status).json({ error: err.message || 'Failed to load lists' });
  }
});

/** Sync one lead to Brevo contacts (+ default list). */
router.post(
  '/leads/:id/sync',
  authRequired,
  requireAnyPermission('leads:update_any', 'leads:update_own'),
  async (req, res) => {
    try {
      const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(req.params.id);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      if (!canAccessLead(req.user, lead) && !roleHasPermission(req.user.role, 'leads:update_any')) {
        return res.status(403).json({ error: 'Permission denied' });
      }
      if (!lead.email) return res.status(400).json({ error: 'Lead has no email' });

      const listIds = Array.isArray(req.body?.listIds)
        ? req.body.listIds.map(Number).filter((n) => n > 0)
        : undefined;

      const result = await upsertContact({
        email: lead.email,
        name: lead.name,
        phone: lead.phone,
        company: lead.company,
        country: lead.country,
        leadId: lead.id,
        source: lead.source,
        listIds,
      });

      db.prepare(
        `INSERT INTO lead_activities (id, lead_id, user_id, type, summary)
         VALUES (?, ?, ?, 'brevo_sync', ?)`,
      ).run(uuid(), lead.id, req.user.id, `Synced to Brevo contacts`);

      res.json({ ok: true, brevo: result });
    } catch (err) {
      const status = err.code === 'BREVO_DISABLED' ? 503 : err.status || 500;
      res.status(status).json({ error: err.message || 'Sync failed' });
    }
  },
);

/** Bulk sync leads with email → Brevo list. */
router.post(
  '/sync-bulk',
  authRequired,
  requirePermission('leads:assign'),
  async (req, res) => {
    try {
      const { leadIds, listIds } = req.body || {};
      if (!Array.isArray(leadIds) || !leadIds.length) {
        return res.status(400).json({ error: 'leadIds[] required' });
      }
      const ids = leadIds.slice(0, 100);
      const placeholders = ids.map(() => '?').join(',');
      const leads = db
        .prepare(`SELECT * FROM leads WHERE id IN (${placeholders}) AND email IS NOT NULL AND email != ''`)
        .all(...ids);

      let synced = 0;
      let failed = 0;
      const errors = [];
      const parsedListIds = Array.isArray(listIds)
        ? listIds.map(Number).filter((n) => n > 0)
        : undefined;

      for (const lead of leads) {
        try {
          await upsertContact({
            email: lead.email,
            name: lead.name,
            phone: lead.phone,
            company: lead.company,
            country: lead.country,
            leadId: lead.id,
            source: lead.source,
            listIds: parsedListIds,
          });
          db.prepare(
            `INSERT INTO lead_activities (id, lead_id, user_id, type, summary)
             VALUES (?, ?, ?, 'brevo_sync', ?)`,
          ).run(uuid(), lead.id, req.user.id, 'Synced to Brevo (bulk)');
          synced += 1;
        } catch (e) {
          failed += 1;
          errors.push({ leadId: lead.id, email: lead.email, error: e.message });
        }
      }

      res.json({ synced, failed, errors: errors.slice(0, 10) });
    } catch (err) {
      const status = err.code === 'BREVO_DISABLED' ? 503 : err.status || 500;
      res.status(status).json({ error: err.message || 'Bulk sync failed' });
    }
  },
);

/** Send cold email to one lead via Brevo transactional API. */
router.post(
  '/leads/:id/send',
  authRequired,
  requireAnyPermission('leads:update_any', 'leads:update_own'),
  async (req, res) => {
    try {
      const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(req.params.id);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      if (!canAccessLead(req.user, lead) && !roleHasPermission(req.user.role, 'leads:update_any')) {
        return res.status(403).json({ error: 'Permission denied' });
      }
      if (!lead.email) return res.status(400).json({ error: 'Lead has no email' });

      const { subject, htmlContent, textContent, templateId, syncToBrevo } = req.body || {};
      const content = resolveEmailContent({
        subject,
        htmlContent,
        textContent,
        templateId,
        lead,
        user: req.user,
      });

      if (!content.subject || (!content.htmlContent && !content.textContent)) {
        return res.status(400).json({
          error: 'subject and htmlContent or textContent required (or use templateId)',
        });
      }

      if (syncToBrevo !== false) {
        await upsertContact({
          email: lead.email,
          name: lead.name,
          phone: lead.phone,
          company: lead.company,
          country: lead.country,
          leadId: lead.id,
          source: lead.source,
        }).catch(() => {});
      }

      const result = await sendTransactionalEmail({
        toEmail: lead.email,
        toName: lead.name || undefined,
        subject: content.subject,
        htmlContent: content.htmlContent,
        textContent: content.textContent,
      });

      logEmailActivity(lead.id, req.user.id, content.subject);

      if (lead.status === 'new') {
        db.prepare(
          `UPDATE leads SET status = 'contacted', updated_at = datetime('now') WHERE id = ?`,
        ).run(lead.id);
        db.prepare(
          `INSERT INTO lead_activities (id, lead_id, user_id, type, summary, outcome)
           VALUES (?, ?, ?, 'status_change', ?, ?)`,
        ).run(uuid(), lead.id, req.user.id, 'Status: new → contacted', 'contacted');
      }

      res.json({ ok: true, brevo: result, subject: content.subject });
    } catch (err) {
      const status = err.status || (err.code === 'BREVO_DISABLED' ? 503 : 500);
      res.status(status).json({ error: err.message || 'Send failed' });
    }
  },
);

/** Bulk cold email — managers only, max 25 per request. */
router.post(
  '/bulk-send',
  authRequired,
  requirePermission('leads:assign'),
  async (req, res) => {
    try {
      const { leadIds, subject, htmlContent, textContent, templateId, syncToBrevo } = req.body || {};
      if (!Array.isArray(leadIds) || !leadIds.length) {
        return res.status(400).json({ error: 'leadIds[] required' });
      }

      const ids = leadIds.slice(0, 25);
      const placeholders = ids.map(() => '?').join(',');
      const leads = db
        .prepare(`SELECT * FROM leads WHERE id IN (${placeholders}) AND email IS NOT NULL AND email != ''`)
        .all(...ids);

      if (!leads.length) {
        return res.status(400).json({ error: 'No leads with email addresses found' });
      }

      let sent = 0;
      let failed = 0;
      const errors = [];

      for (const lead of leads) {
        try {
          const content = resolveEmailContent({
            subject,
            htmlContent,
            textContent,
            templateId,
            lead,
            user: req.user,
          });
          if (!content.subject || (!content.htmlContent && !content.textContent)) {
            throw new Error('Missing subject or body');
          }

          if (syncToBrevo !== false) {
            await upsertContact({
              email: lead.email,
              name: lead.name,
              phone: lead.phone,
              company: lead.company,
              country: lead.country,
              leadId: lead.id,
              source: lead.source,
            }).catch(() => {});
          }

          await sendTransactionalEmail({
            toEmail: lead.email,
            toName: lead.name || undefined,
            subject: content.subject,
            htmlContent: content.htmlContent,
            textContent: content.textContent,
          });

          logEmailActivity(lead.id, req.user.id, content.subject, 'Brevo bulk');
          if (lead.status === 'new') {
            db.prepare(
              `UPDATE leads SET status = 'contacted', updated_at = datetime('now') WHERE id = ?`,
            ).run(lead.id);
          }
          sent += 1;
          await new Promise((r) => setTimeout(r, 200));
        } catch (e) {
          failed += 1;
          errors.push({ leadId: lead.id, email: lead.email, error: e.message });
        }
      }

      res.json({ sent, failed, errors: errors.slice(0, 10) });
    } catch (err) {
      const status = err.code === 'BREVO_DISABLED' ? 503 : err.status || 500;
      res.status(status).json({ error: err.message || 'Bulk send failed' });
    }
  },
);

/** Preview merged template for a lead (no send). */
router.post(
  '/preview',
  authRequired,
  requireAnyPermission('leads:update_any', 'leads:update_own'),
  (req, res) => {
    const { leadId, templateId, subject, htmlContent, textContent } = req.body || {};
    const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(leadId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!canAccessLead(req.user, lead) && !roleHasPermission(req.user.role, 'leads:update_any')) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    try {
      const content = resolveEmailContent({
        subject,
        htmlContent,
        textContent,
        templateId,
        lead,
        user: req.user,
      });
      res.json(content);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  },
);

export default router;
