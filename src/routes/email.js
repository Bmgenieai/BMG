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
import {
  backfillLegacyEmailAccountIds,
  createEmailAccount,
  emailAccountMatch,
  getEmailAccount,
  listEmailAccounts,
  resolveSendAccount,
  updateEmailAccount,
} from '../lib/emailAccounts.js';
import * as campaigns from '../lib/campaigns.js';
import { canAccessLead, canUpdateLead, roleHasPermission } from '../lib/permissions.js';
import { claimLeadIfUnassigned } from '../lib/leadAutomation.js';
import {
  countEmailReplies,
  countUnreadEmailReplies,
  getEmailReply,
  getLeadConversation,
  getLeadEmailHistory,
  ingestBrevoInboundEmail,
  ingestBrevoWebhookEvent,
  listEmailReplies,
  markEmailReplyRead,
  recordEmailSend,
  sendCrmReplyToInbound,
} from '../lib/emailLog.js';

const router = Router();

function resolveEmailContent({
  subject,
  htmlContent,
  textContent,
  templateId,
  lead,
  user,
  emailAccountId = null,
}) {
  const { sender } = resolveSendAccount(emailAccountId);
  const mergeSender = {
    name: user?.name || sender.name,
    email: sender.email,
  };
  if (templateId) {
    const tpl = getTemplateById(templateId);
    if (!tpl) throw Object.assign(new Error('Unknown template'), { status: 400 });
    return {
      subject: applyMergeTags(subject || tpl.subject, lead, mergeSender),
      htmlContent: applyMergeTags(htmlContent || tpl.htmlContent, lead, mergeSender),
      textContent: applyMergeTags(textContent || tpl.textContent, lead, mergeSender),
      sender,
    };
  }
  return {
    subject: applyMergeTags(subject, lead, mergeSender),
    htmlContent: htmlContent ? applyMergeTags(htmlContent, lead, mergeSender) : undefined,
    textContent: textContent ? applyMergeTags(textContent, lead, mergeSender) : undefined,
    sender,
  };
}

function assertWebhookSecret(req, res) {
  const expected = (process.env.BREVO_WEBHOOK_SECRET || '').trim();
  if (!expected) return true; // allow when unset (dev); set in prod
  const provided =
    req.query.secret ||
    req.headers['x-brevo-secret'] ||
    req.headers['x-webhook-secret'] ||
    '';
  if (String(provided) !== expected) {
    res.status(401).json({ error: 'Invalid webhook secret' });
    return false;
  }
  return true;
}

/** Brevo transactional webhook — open / click / delivered / reply / bounce */
router.post('/webhooks/brevo', (req, res) => {
  if (!assertWebhookSecret(req, res)) return;

  const body = req.body;
  const events = Array.isArray(body) ? body : body ? [body] : [];
  const results = [];
  for (const evt of events) {
    try {
      results.push(ingestBrevoWebhookEvent(evt));
    } catch (err) {
      results.push({ ok: false, skipped: err.message || 'error' });
    }
  }
  res.json({ ok: true, processed: results.length, results: results.slice(0, 50) });
});

/**
 * Brevo Inbound Parsing webhook — full reply bodies.
 * Configure in Brevo: type=inbound, events=[inboundEmailProcessed], domain=BREVO_REPLY_DOMAIN
 * URL: https://crm-api.bmgenie.ai/api/email/webhooks/brevo-inbound?secret=...
 */
router.post('/webhooks/brevo-inbound', (req, res) => {
  if (!assertWebhookSecret(req, res)) return;

  const body = req.body || {};
  const items = Array.isArray(body.items)
    ? body.items
    : Array.isArray(body)
      ? body
      : body.MessageId || body.From
        ? [body]
        : [];

  const results = [];
  for (const item of items) {
    try {
      results.push(ingestBrevoInboundEmail(item));
    } catch (err) {
      results.push({ ok: false, skipped: err.message || 'error' });
    }
  }
  res.json({ ok: true, processed: results.length, results: results.slice(0, 50) });
});

router.get('/status', authRequired, async (_req, res) => {
  let mailbox = null;
  try {
    const { senderMailboxSyncConfig } = await import('../lib/senderMailboxSync.js');
    mailbox = senderMailboxSyncConfig();
  } catch {
    mailbox = null;
  }
  res.json({
    ...getBrevoPublicConfig(),
    webhookPath: '/api/email/webhooks/brevo',
    inboundWebhookPath: '/api/email/webhooks/brevo-inbound',
    webhookSecretConfigured: Boolean((process.env.BREVO_WEBHOOK_SECRET || '').trim()),
    senderMailbox: mailbox
      ? {
          enabled: mailbox.enabled,
          configured: mailbox.configured,
          user: mailbox.user,
          host: mailbox.host,
          lastSyncAt: mailbox.lastSyncAt,
          lastIngested: mailbox.lastIngested,
          lastError: mailbox.lastError,
        }
      : null,
  });
});

/** Manually poll magic.retouching IMAP for replies that landed on From (CEO/manager). */
router.post(
  '/mailbox-sync',
  authRequired,
  requireAnyPermission('analytics:view_all', 'leads:view_all'),
  async (_req, res) => {
    try {
      const { syncSenderMailboxOnce, senderMailboxSyncConfig } = await import(
        '../lib/senderMailboxSync.js'
      );
      const cfg = senderMailboxSyncConfig();
      if (!cfg.enabled) {
        return res.status(400).json({
          error:
            'Sender mailbox sync is off. Set SENDER_MAILBOX_SYNC=true and SENDER_MAILBOX_USER / SENDER_MAILBOX_PASS on the API server.',
        });
      }
      const result = await syncSenderMailboxOnce();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message || 'Mailbox sync failed' });
    }
  },
);

/** Email replies inbox for BD / telesales */
router.get(
  '/replies',
  authRequired,
  requireAnyPermission('leads:view_all', 'leads:view_own'),
  (req, res) => {
    const canViewAll = roleHasPermission(req.user.role, 'leads:view_all');
    const unreadOnly =
      req.query.unread === '1' ||
      req.query.unread === 'true' ||
      req.query.status === 'unread';
    const rows = listEmailReplies({
      user: req.user,
      q: String(req.query.q || '').trim(),
      unreadOnly,
      limit: Number(req.query.limit) || 100,
      canViewAll,
    });
    res.json(rows);
  },
);

router.get(
  '/replies/counts',
  authRequired,
  requireAnyPermission('leads:view_all', 'leads:view_own'),
  (req, res) => {
    const canViewAll = roleHasPermission(req.user.role, 'leads:view_all');
    res.json({
      unread: countUnreadEmailReplies({ user: req.user, canViewAll }),
      total: countEmailReplies({ user: req.user, canViewAll }),
    });
  },
);

router.get(
  '/replies/:id',
  authRequired,
  requireAnyPermission('leads:view_all', 'leads:view_own'),
  (req, res) => {
    const row = getEmailReply(req.params.id);
    if (!row) return res.status(404).json({ error: 'Reply not found' });
    if (row.lead_id) {
      const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(row.lead_id);
      if (lead && !canAccessLead(req.user, lead)) {
        return res.status(403).json({ error: 'Permission denied' });
      }
    } else if (!roleHasPermission(req.user.role, 'leads:view_all')) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    res.json(row);
  },
);

router.post(
  '/replies/:id/read',
  authRequired,
  requireAnyPermission('leads:view_all', 'leads:view_own'),
  (req, res) => {
    const row = getEmailReply(req.params.id);
    if (!row) return res.status(404).json({ error: 'Reply not found' });
    if (row.lead_id) {
      const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(row.lead_id);
      if (lead && !canAccessLead(req.user, lead)) {
        return res.status(403).json({ error: 'Permission denied' });
      }
    }
    const read = req.body?.read !== false;
    res.json(markEmailReplyRead(req.params.id, read));
  },
);

/** Reply to an inbound prospect message from CRM via Brevo mailbox (threaded). */
router.post(
  '/replies/:id/reply',
  authRequired,
  requireAnyPermission('leads:update_any', 'leads:update_own'),
  async (req, res) => {
    try {
      const row = getEmailReply(req.params.id);
      if (!row) return res.status(404).json({ error: 'Reply not found' });
      if (row.lead_id) {
        const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(row.lead_id);
        if (!lead) return res.status(404).json({ error: 'Lead not found' });
        if (!canUpdateLead(req.user, lead)) {
          return res.status(403).json({ error: 'Permission denied' });
        }
      }

      const message = req.body?.message || req.body?.text || req.body?.body || '';
      const result = await sendCrmReplyToInbound({
        replyId: req.params.id,
        user: req.user,
        bodyText: message,
        subject: req.body?.subject || null,
        sendTransactionalEmail,
      });
      res.json(result);
    } catch (err) {
      const status = err.code === 'BREVO_DISABLED' ? 503 : err.status || 500;
      res.status(status).json({ error: err.message || 'Failed to send reply' });
    }
  },
);

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
      if (!canUpdateLead(req.user, lead)) {
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

      // BD: own leads + shared product pool (e.g. free credit)
      leads = leads.filter((lead) => canUpdateLead(req.user, lead));

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
      if (!canUpdateLead(req.user, lead)) {
        return res.status(403).json({ error: 'Permission denied' });
      }
      if (!lead.email) return res.status(400).json({ error: 'Lead has no email' });

      const { subject, htmlContent, textContent, templateId, syncToBrevo, emailAccountId } =
        req.body || {};
      const { accountId } = resolveSendAccount(emailAccountId || null);
      const content = resolveEmailContent({
        subject,
        htmlContent,
        textContent,
        templateId,
        lead,
        user: req.user,
        emailAccountId: accountId,
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
        leadId: lead.id,
        sender: content.sender,
      });

      recordEmailSend({
        leadId: lead.id,
        userId: req.user.id,
        subject: content.subject,
        toEmail: lead.email,
        templateId: templateId || null,
        brevoMessageId: result?.messageId || result?.message_id || null,
        source: 'transactional',
        summaryPrefix: 'Brevo cold email',
        htmlContent: content.htmlContent || null,
        textContent: content.textContent || null,
        emailAccountId: accountId,
      });

      // BD working a shared product-pool lead (e.g. free credit) becomes the owner
      claimLeadIfUnassigned(lead.id, req.user.id);

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
      const {
        leadIds,
        subject,
        htmlContent,
        textContent,
        templateId,
        syncToBrevo,
        emailAccountId,
      } = req.body || {};
      if (!Array.isArray(leadIds) || !leadIds.length) {
        return res.status(400).json({ error: 'leadIds[] required' });
      }

      const { accountId } = resolveSendAccount(emailAccountId || null);

      const ids = leadIds.slice(0, 25);
      const placeholders = ids.map(() => '?').join(',');
      let leads = db
        .prepare(`SELECT * FROM leads WHERE id IN (${placeholders}) AND email IS NOT NULL AND email != ''`)
        .all(...ids);

      leads = leads.filter((lead) => canUpdateLead(req.user, lead));

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
            emailAccountId: accountId,
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
            leadId: lead.id,
            sender: content.sender,
          }).then((result) => {
            recordEmailSend({
              leadId: lead.id,
              userId: req.user.id,
              subject: content.subject,
              toEmail: lead.email,
              templateId: templateId || null,
              brevoMessageId: result?.messageId || result?.message_id || null,
              source: 'bulk',
              summaryPrefix: 'Brevo bulk',
              htmlContent: content.htmlContent || null,
              textContent: content.textContent || null,
              emailAccountId: accountId,
            });
            claimLeadIfUnassigned(lead.id, req.user.id);
          });

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

/** Preview merged template for a lead (no send). Supports sample lead for campaign drafts. */
router.post(
  '/preview',
  authRequired,
  requireAnyPermission(
    'leads:update_any',
    'leads:update_own',
    'email:bulk_send',
    'email:manage_campaigns',
  ),
  (req, res) => {
    const {
      leadId,
      templateId,
      subject,
      htmlContent,
      textContent,
      sample,
      sampleLead,
      sampleName,
      sampleCompany,
    } = req.body || {};

    let lead = null;
    let previewMode = 'lead';
    if (sample || sampleLead || !leadId) {
      lead = {
        name: String(sampleName || 'Alex Rivera').trim() || 'Alex Rivera',
        company: String(sampleCompany || 'Horizon Realty').trim() || 'Horizon Realty',
        email: 'alex.rivera@example.com',
        country: 'US',
        source: 'telesales',
      };
      previewMode = 'sample';
    } else {
      lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(leadId);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      if (!canUpdateLead(req.user, lead) && !roleHasPermission(req.user.role, 'email:manage_campaigns')) {
        return res.status(403).json({ error: 'Permission denied' });
      }
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
      res.json({
        ...content,
        previewMode,
        sampleLead: previewMode === 'sample'
          ? { name: lead.name, company: lead.company, email: lead.email }
          : undefined,
      });
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
      emailAccountId,
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

    const { accountId } = resolveSendAccount(emailAccountId || null);

    const ids = leadIds.slice(0, 25);
    const placeholders = ids.map(() => '?').join(',');
    let leads = db
      .prepare(
        `SELECT * FROM leads WHERE id IN (${placeholders}) AND email IS NOT NULL AND email != ''`,
      )
      .all(...ids)
      .filter((lead) => canUpdateLead(req.user, lead));

    if (!leads.length) {
      return res.status(400).json({ error: 'No accessible leads with email addresses found' });
    }

    const batchId = uuid();
    const scheduledSql = when.toISOString().slice(0, 19).replace('T', ' ');
    const insert = db.prepare(
      `INSERT INTO scheduled_emails (
         id, batch_id, lead_id, user_id, subject, html_content, text_content,
         template_id, sync_to_brevo, scheduled_at, status, email_account_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
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
          accountId,
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

/** Per-lead Brevo email history (sends + open/click/reply events). */
router.get(
  '/leads/:id/history',
  authRequired,
  requireAnyPermission('leads:view_all', 'leads:view_own'),
  (req, res) => {
    const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!canAccessLead(req.user, lead)) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    res.json(getLeadEmailHistory(lead.id));
  },
);

/** Full chronological conversation for a lead (same as Email replies thread modal). */
router.get(
  '/leads/:id/conversation',
  authRequired,
  requireAnyPermission('leads:view_all', 'leads:view_own'),
  (req, res) => {
    const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!canAccessLead(req.user, lead)) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    const conversation = getLeadConversation(lead.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    res.json(conversation);
  },
);

/** BD / CEO email performance (sent, delivered, opened, replies). */
router.get(
  '/performance',
  authRequired,
  requireAnyPermission('email:bulk_send', 'analytics:view_own', 'analytics:view_team', 'analytics:view_all'),
  (req, res) => {
    const canTeam =
      roleHasPermission(req.user.role, 'analytics:view_team') ||
      roleHasPermission(req.user.role, 'analytics:view_all');

    backfillLegacyEmailAccountIds();
    const accounts = listEmailAccounts({ activeOnly: true });
    let accountId = req.query.emailAccountId ? String(req.query.emailAccountId) : '';
    if (!accountId) {
      accountId = accounts.find((a) => a.is_default)?.id || accounts[0]?.id || '';
    }
    const account = accountId ? getEmailAccount(accountId) : null;

    // scope=account → all sends from this From address (default)
    // scope=me → only current user's sends from that account
    const scopeRaw = String(req.query.scope || 'account').trim().toLowerCase();
    let userId = null;
    if (scopeRaw === 'me') {
      userId = req.user.id;
    }
    if (canTeam && req.query.userId) {
      userId = String(req.query.userId);
    }

    const acct = emailAccountMatch(account, { alias: 'm' });
    const userClause = userId ? ' AND m.user_id = ?' : '';
    const params = [...acct.params];
    if (userId) params.push(userId);

    const sent = db
      .prepare(
        `SELECT COUNT(*) AS c FROM email_messages m WHERE 1=1${acct.sql}${userClause}`,
      )
      .get(...params).c;
    const delivered = db
      .prepare(
        `SELECT COUNT(*) AS c FROM email_messages m
         WHERE (
             m.status IN ('delivered', 'opened', 'replied')
             OR EXISTS (
               SELECT 1 FROM email_events e
               WHERE e.email_message_id = m.id AND e.event IN ('delivered', 'request')
             )
           )${acct.sql}${userClause}`,
      )
      .get(...params).c;
    const opened = db
      .prepare(
        `SELECT COUNT(*) AS c FROM email_messages m
         WHERE COALESCE(m.open_count, 0) > 0${acct.sql}${userClause}`,
      )
      .get(...params).c;
    const replies = db
      .prepare(
        `SELECT COUNT(*) AS c FROM email_replies r
         WHERE EXISTS (
           SELECT 1 FROM email_messages m
           WHERE (m.id = r.email_message_id OR m.lead_id = r.lead_id)
             ${acct.sql}${userClause}
         )`,
      )
      .get(...params).c;

    const user = userId
      ? db.prepare(`SELECT id, name, email FROM users WHERE id = ?`).get(userId)
      : null;

    let team = [];
    if (canTeam && account) {
      const teamAcct = emailAccountMatch(account, { alias: 'm' });
      team = db
        .prepare(
          `SELECT u.id, u.name,
                  (SELECT COUNT(*) FROM email_messages m
                     WHERE m.user_id = u.id ${teamAcct.sql}) AS sent,
                  (SELECT COUNT(*) FROM email_messages m
                     WHERE m.user_id = u.id AND COALESCE(m.open_count, 0) > 0 ${teamAcct.sql}) AS opened,
                  (SELECT COUNT(*) FROM email_replies r
                     WHERE EXISTS (
                       SELECT 1 FROM email_messages m
                       WHERE m.user_id = u.id
                         AND (m.id = r.email_message_id OR m.lead_id = r.lead_id)
                         ${teamAcct.sql}
                     )) AS replies
           FROM users u
           WHERE u.role = 'telesales' AND u.is_active = 1
           ORDER BY u.name COLLATE NOCASE`,
        )
        .all(...teamAcct.params, ...teamAcct.params, ...teamAcct.params);
    }

    res.json({
      user,
      account,
      accounts,
      scope: userId ? 'me' : 'account',
      stats: {
        sent,
        delivered,
        opened,
        replies,
        openRate: sent ? Math.round((opened / sent) * 1000) / 10 : 0,
        replyRate: sent ? Math.round((replies / sent) * 1000) / 10 : 0,
        deliveryRate: sent ? Math.round((delivered / sent) * 1000) / 10 : 0,
      },
      team,
    });
  },
);

/** Active sending accounts (for From dropdown). */
router.get(
  '/accounts',
  authRequired,
  requireAnyPermission('email:bulk_send', 'leads:update_any', 'leads:update_own', 'email:manage_accounts'),
  (req, res) => {
    const manage = roleHasPermission(req.user.role, 'email:manage_accounts');
    const rows = listEmailAccounts({ activeOnly: !manage });
    res.json({ accounts: rows });
  },
);

router.post(
  '/accounts',
  authRequired,
  requirePermission('email:manage_accounts'),
  (req, res) => {
    try {
      const account = createEmailAccount(req.body || {}, { userId: req.user.id });
      res.status(201).json(account);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  },
);

router.patch(
  '/accounts/:id',
  authRequired,
  requirePermission('email:manage_accounts'),
  (req, res) => {
    try {
      const account = updateEmailAccount(req.params.id, req.body || {});
      res.json(account);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  },
);

router.get(
  '/accounts/:id',
  authRequired,
  requirePermission('email:manage_accounts'),
  (req, res) => {
    const account = getEmailAccount(req.params.id);
    if (!account) return res.status(404).json({ error: 'Not found' });
    res.json(account);
  },
);

router.get(
  '/campaigns',
  authRequired,
  requirePermission('email:manage_campaigns'),
  (_req, res) => {
    res.json({ campaigns: campaigns.listCampaigns() });
  },
);

router.post(
  '/campaigns',
  authRequired,
  requirePermission('email:manage_campaigns'),
  (req, res) => {
    try {
      const row = campaigns.createCampaign(req.body || {}, { userId: req.user.id });
      res.status(201).json(row);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  },
);

router.get(
  '/campaigns/:id',
  authRequired,
  requirePermission('email:manage_campaigns'),
  (req, res) => {
    const row = campaigns.getCampaign(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  },
);

router.patch(
  '/campaigns/:id',
  authRequired,
  requirePermission('email:manage_campaigns'),
  (req, res) => {
    try {
      res.json(campaigns.updateCampaign(req.params.id, req.body || {}));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  },
);

router.post(
  '/campaigns/:id/leads',
  authRequired,
  requirePermission('email:manage_campaigns'),
  (req, res) => {
    try {
      const { leadIds } = req.body || {};
      res.json(campaigns.addLeads(req.params.id, leadIds, { user: req.user }));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  },
);

router.delete(
  '/campaigns/:id/leads/:leadId',
  authRequired,
  requirePermission('email:manage_campaigns'),
  (req, res) => {
    try {
      const removed = campaigns.removeLead(req.params.id, req.params.leadId);
      res.json({ ok: true, removed });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  },
);

router.post(
  '/campaigns/:id/launch',
  authRequired,
  requirePermission('email:manage_campaigns'),
  (req, res) => {
    try {
      res.json(campaigns.launchCampaign(req.params.id, { userId: req.user.id }));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  },
);

router.post(
  '/campaigns/:id/pause',
  authRequired,
  requirePermission('email:manage_campaigns'),
  (req, res) => {
    try {
      res.json(campaigns.pauseCampaign(req.params.id));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  },
);

router.post(
  '/campaigns/:id/cancel',
  authRequired,
  requirePermission('email:manage_campaigns'),
  (req, res) => {
    try {
      res.json(campaigns.cancelCampaign(req.params.id));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  },
);

export default router;
