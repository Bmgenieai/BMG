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

router.get('/lists', authRequired, requireAnyPermission('email:bulk_send', 'leads:assign', 'leads:import'), async (_req, res) => {
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
  requirePermission('email:bulk_send'),
  async (req, res) => {
    try {
      const { leadIds, listIds } = req.body || {};
      if (!Array.isArray(leadIds) || !leadIds.length) {
        return res.status(400).json({ error: 'leadIds[] required' });
      }
      const ids = leadIds.slice(0, 100);
      const placeholders = ids.map(() => '?').join(',');
      let leads = db
        .prepare(`SELECT * FROM leads WHERE id IN (${placeholders}) AND email IS NOT NULL AND email != ''`)
        .all(...ids);

      // Telesales may only sync leads they own / created
      leads = leads.filter((lead) => canAccessLead(req.user, lead));

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

      // Outreach stays on qualified — funnel stage only advances on reply/demo/trial/paid
      res.json({ ok: true, brevo: result, subject: content.subject });
    } catch (err) {
      const status = err.status || (err.code === 'BREVO_DISABLED' ? 503 : 500);
      res.status(status).json({ error: err.message || 'Send failed' });
    }
  },
);

/** Bulk cold email — max 25 per request. Telesales limited to accessible leads. */
router.post(
  '/bulk-send',
  authRequired,
  requirePermission('email:bulk_send'),
  async (req, res) => {
    try {
      const { leadIds, subject, htmlContent, textContent, templateId, syncToBrevo } = req.body || {};
      if (!Array.isArray(leadIds) || !leadIds.length) {
        return res.status(400).json({ error: 'leadIds[] required' });
      }

      const ids = leadIds.slice(0, 25);
      const placeholders = ids.map(() => '?').join(',');
      let leads = db
        .prepare(`SELECT * FROM leads WHERE id IN (${placeholders}) AND email IS NOT NULL AND email != ''`)
        .all(...ids);

      leads = leads.filter((lead) => canAccessLead(req.user, lead));

      if (!leads.length) {
        return res.status(400).json({
          error: 'No accessible leads with email addresses found',
        });
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

/** Schedule bulk cold email for later (worker sends when due). Max 25 leads. */
router.post(
  '/schedule',
  authRequired,
  requirePermission('email:bulk_send'),
  (req, res) => {
    const {
      leadIds,
      subject,
      htmlContent,
      textContent,
      templateId,
      syncToBrevo,
      scheduledAt,
    } = req.body || {};

    if (!Array.isArray(leadIds) || !leadIds.length) {
      return res.status(400).json({ error: 'leadIds[] required' });
    }
    if (!scheduledAt) {
      return res.status(400).json({ error: 'scheduledAt required (ISO datetime)' });
    }

    const when = new Date(scheduledAt);
    if (Number.isNaN(when.getTime())) {
      return res.status(400).json({ error: 'Invalid scheduledAt' });
    }
    if (when.getTime() < Date.now() - 60_000) {
      return res.status(400).json({ error: 'scheduledAt must be in the future' });
    }

    if (!templateId && !subject) {
      return res.status(400).json({ error: 'subject or templateId required' });
    }
    if (!templateId && !htmlContent && !textContent) {
      return res.status(400).json({ error: 'htmlContent or textContent required (or use templateId)' });
    }

    const ids = leadIds.slice(0, 25);
    const placeholders = ids.map(() => '?').join(',');
    let leads = db
      .prepare(
        `SELECT * FROM leads WHERE id IN (${placeholders}) AND email IS NOT NULL AND email != ''`,
      )
      .all(...ids)
      .filter((lead) => canAccessLead(req.user, lead));

    if (!leads.length) {
      return res.status(400).json({ error: 'No accessible leads with email addresses found' });
    }

    const batchId = uuid();
    const scheduledSql = when.toISOString().slice(0, 19).replace('T', ' ');
    const insert = db.prepare(
      `INSERT INTO scheduled_emails (
         id, batch_id, lead_id, user_id, subject, html_content, text_content,
         template_id, sync_to_brevo, scheduled_at, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    );

    const tx = db.transaction(() => {
      for (const lead of leads) {
        insert.run(
          uuid(),
          batchId,
          lead.id,
          req.user.id,
          subject || null,
          htmlContent || null,
          textContent || null,
          templateId || null,
          syncToBrevo === false ? 0 : 1,
          scheduledSql,
        );
      }
    });
    tx();

    res.status(201).json({
      ok: true,
      batchId,
      scheduledAt: scheduledSql,
      count: leads.length,
    });
  },
);

/** List scheduled emails (own for telesales; team/all for manager/ceo). */
router.get(
  '/scheduled',
  authRequired,
  requirePermission('email:bulk_send'),
  (req, res) => {
    const canSeeAll = roleHasPermission(req.user.role, 'leads:view_all');
    const status = String(req.query.status || 'pending').toLowerCase();

    let rows;
    if (canSeeAll) {
      rows =
        status === 'all'
          ? db
              .prepare(
                `SELECT s.*, l.name AS lead_name, l.email AS lead_email, u.name AS scheduled_by_name
                 FROM scheduled_emails s
                 LEFT JOIN leads l ON l.id = s.lead_id
                 LEFT JOIN users u ON u.id = s.user_id
                 ORDER BY s.scheduled_at DESC
                 LIMIT 200`,
              )
              .all()
          : db
              .prepare(
                `SELECT s.*, l.name AS lead_name, l.email AS lead_email, u.name AS scheduled_by_name
                 FROM scheduled_emails s
                 LEFT JOIN leads l ON l.id = s.lead_id
                 LEFT JOIN users u ON u.id = s.user_id
                 WHERE s.status = ?
                 ORDER BY s.scheduled_at ASC
                 LIMIT 200`,
              )
              .all(status);
    } else {
      rows =
        status === 'all'
          ? db
              .prepare(
                `SELECT s.*, l.name AS lead_name, l.email AS lead_email, u.name AS scheduled_by_name
                 FROM scheduled_emails s
                 LEFT JOIN leads l ON l.id = s.lead_id
                 LEFT JOIN users u ON u.id = s.user_id
                 WHERE s.user_id = ?
                 ORDER BY s.scheduled_at DESC
                 LIMIT 200`,
              )
              .all(req.user.id)
          : db
              .prepare(
                `SELECT s.*, l.name AS lead_name, l.email AS lead_email, u.name AS scheduled_by_name
                 FROM scheduled_emails s
                 LEFT JOIN leads l ON l.id = s.lead_id
                 LEFT JOIN users u ON u.id = s.user_id
                 WHERE s.user_id = ? AND s.status = ?
                 ORDER BY s.scheduled_at ASC
                 LIMIT 200`,
              )
              .all(req.user.id, status);
    }

    const batches = new Map();
    for (const r of rows) {
      if (!batches.has(r.batch_id)) {
        batches.set(r.batch_id, {
          batchId: r.batch_id,
          scheduledAt: r.scheduled_at,
          status: r.status,
          subject: r.subject,
          templateId: r.template_id,
          scheduledByName: r.scheduled_by_name,
          count: 0,
          sent: 0,
          failed: 0,
          pending: 0,
          cancelled: 0,
          recipients: [],
        });
      }
      const b = batches.get(r.batch_id);
      b.count += 1;
      if (r.status === 'sent') b.sent += 1;
      else if (r.status === 'failed') b.failed += 1;
      else if (r.status === 'cancelled') b.cancelled += 1;
      else b.pending += 1;
      if (r.status === 'pending') b.status = 'pending';
      b.recipients.push({
        id: r.id,
        leadId: r.lead_id,
        leadName: r.lead_name,
        leadEmail: r.lead_email,
        status: r.status,
        error: r.error,
      });
    }

    res.json({ batches: [...batches.values()] });
  },
);

/** Cancel a pending scheduled batch (or single row). */
router.post(
  '/scheduled/:id/cancel',
  authRequired,
  requirePermission('email:bulk_send'),
  (req, res) => {
    const id = req.params.id;
    const canSeeAll = roleHasPermission(req.user.role, 'leads:view_all');

    // Cancel by batch id or row id
    let rows = db
      .prepare(`SELECT * FROM scheduled_emails WHERE batch_id = ? OR id = ?`)
      .all(id, id);

    if (!canSeeAll) {
      rows = rows.filter((r) => r.user_id === req.user.id);
    }

    const pending = rows.filter((r) => r.status === 'pending');
    if (!pending.length) {
      return res.status(404).json({ error: 'No pending scheduled emails found' });
    }

    const cancel = db.prepare(
      `UPDATE scheduled_emails SET status = 'cancelled'
       WHERE id = ? AND status = 'pending'`,
    );
    const tx = db.transaction(() => {
      for (const r of pending) cancel.run(r.id);
    });
    tx();

    res.json({ ok: true, cancelled: pending.length });
  },
);

export default router;
