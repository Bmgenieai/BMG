/**
 * In-CRM email campaigns (Brevo transactional delivery).
 */
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { canUpdateLead } from './permissions.js';
import { resolveSendAccount } from './emailAccounts.js';
import { resolveAnalyticsBounds } from './periodBounds.js';

/** Email format tags — used to compare open/reply rates by style. */
export const CONTENT_CATEGORIES = ['plain_text', 'image', 'gif', 'video'];

export const CONTENT_CATEGORY_LABELS = {
  plain_text: 'Plain text',
  image: 'Image',
  gif: 'GIF',
  video: 'Video',
};

export function normalizeContentCategory(raw) {
  const v = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!v) return null;
  if (CONTENT_CATEGORIES.includes(v)) return v;
  if (v === 'text' || v === 'plaintext') return 'plain_text';
  if (v === 'static_image' || v === 'static') return 'image';
  if (v === 'youtube' || v === 'video_thumbnail') return 'video';
  return null;
}

function sqlDate(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

const DT = (col) => `datetime(REPLACE(REPLACE(${col}, 'T', ' '), 'Z', ''))`;

/** Prefer a real name over a stored email (common after CSV imports without Name). */
export function displayLeadName(name, email, company) {
  const n = String(name || '').trim();
  const e = String(email || '').trim();
  const c = String(company || '').trim();
  const looksLikeEmail =
    !n || (e && n.toLowerCase() === e.toLowerCase()) || n.includes('@');
  if (!looksLikeEmail) return n;
  if (c) return c;
  const local = e.split('@')[0] || '';
  if (!local) return n || null;
  const human = local
    .replace(/[._+-]+/g, ' ')
    .replace(/\d+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
  return human || n || null;
}

/** Engagement stats for one campaign (any From account). */
export function getCampaignStats(campaignId) {
  const sent = db
    .prepare(`SELECT COUNT(*) AS c FROM email_messages WHERE campaign_id = ?`)
    .get(campaignId).c;
  const delivered = db
    .prepare(
      `SELECT COUNT(*) AS c FROM email_messages m
       WHERE m.campaign_id = ?
         AND (
           m.status IN ('delivered', 'opened', 'replied')
           OR EXISTS (
             SELECT 1 FROM email_events e
             WHERE e.email_message_id = m.id AND e.event IN ('delivered', 'request')
           )
         )`,
    )
    .get(campaignId).c;
  const opened = db
    .prepare(
      `SELECT COUNT(*) AS c FROM email_messages
       WHERE campaign_id = ? AND COALESCE(open_count, 0) > 0`,
    )
    .get(campaignId).c;
  const bounced = db
    .prepare(
      `SELECT COUNT(*) AS c FROM email_messages
       WHERE campaign_id = ? AND status = 'bounced'`,
    )
    .get(campaignId).c;
  const replies = db
    .prepare(
      `SELECT COUNT(*) AS c FROM email_replies r
       WHERE EXISTS (
         SELECT 1 FROM email_messages m
         WHERE m.campaign_id = ?
           AND (m.id = r.email_message_id OR m.lead_id = r.lead_id)
       )`,
    )
    .get(campaignId).c;

  const byStep = db
    .prepare(
      `SELECT
         cs.id AS step_id,
         cs.step_order,
         cs.delay_days,
         cs.subject,
         cs.content_category,
         (SELECT COUNT(*) FROM email_messages m WHERE m.campaign_step_id = cs.id) AS sent,
         (SELECT COUNT(*) FROM email_messages m
            WHERE m.campaign_step_id = cs.id AND COALESCE(m.open_count, 0) > 0) AS opened,
         (SELECT COUNT(*) FROM email_messages m
            WHERE m.campaign_step_id = cs.id AND m.status = 'bounced') AS bounced,
         (SELECT COUNT(*) FROM email_replies r
            WHERE EXISTS (
              SELECT 1 FROM email_messages m
              WHERE m.campaign_step_id = cs.id
                AND (m.id = r.email_message_id OR m.lead_id = r.lead_id)
            )) AS replies
       FROM email_campaign_steps cs
       WHERE cs.campaign_id = ?
       ORDER BY cs.step_order ASC`,
    )
    .all(campaignId)
    .map((row) => ({
      ...row,
      content_category_label:
        CONTENT_CATEGORY_LABELS[row.content_category] ||
        (row.content_category ? row.content_category : 'Uncategorized'),
      openRate: row.sent ? Math.round((row.opened / row.sent) * 1000) / 10 : 0,
      replyRate: row.sent ? Math.round((row.replies / row.sent) * 1000) / 10 : 0,
    }));

  return {
    sent,
    delivered,
    opened,
    replies,
    bounced,
    openRate: sent ? Math.round((opened / sent) * 1000) / 10 : 0,
    replyRate: sent ? Math.round((replies / sent) * 1000) / 10 : 0,
    bounceRate: sent ? Math.round((bounced / sent) * 1000) / 10 : 0,
    deliveryRate: sent ? Math.round((delivered / sent) * 1000) / 10 : 0,
    byStep,
  };
}

export function listCampaigns() {
  const rows = db
    .prepare(
      `SELECT c.*,
              a.label AS account_label,
              a.email AS account_email,
              u.name AS created_by_name,
              (SELECT COUNT(*) FROM email_campaign_leads cl WHERE cl.campaign_id = c.id) AS lead_count,
              (SELECT COUNT(*) FROM email_campaign_steps cs WHERE cs.campaign_id = c.id) AS step_count,
              (SELECT COUNT(*) FROM email_messages m WHERE m.campaign_id = c.id) AS sent_count,
              (SELECT COUNT(*) FROM email_messages m
                 WHERE m.campaign_id = c.id AND COALESCE(m.open_count, 0) > 0) AS opened_count,
              (SELECT COUNT(*) FROM email_messages m
                 WHERE m.campaign_id = c.id AND m.status = 'bounced') AS bounced_count,
              (SELECT COUNT(*) FROM email_replies r
                 WHERE EXISTS (
                   SELECT 1 FROM email_messages m
                   WHERE m.campaign_id = c.id
                     AND (m.id = r.email_message_id OR m.lead_id = r.lead_id)
                 )) AS reply_count,
              (SELECT COUNT(*) FROM email_messages m
                 JOIN email_campaign_steps cs ON cs.id = m.campaign_step_id
                 WHERE m.campaign_id = c.id AND cs.step_order = 1) AS sent_step_1,
              (SELECT COUNT(*) FROM email_messages m
                 JOIN email_campaign_steps cs ON cs.id = m.campaign_step_id
                 WHERE m.campaign_id = c.id AND cs.step_order = 2) AS sent_step_2,
              (SELECT COUNT(*) FROM email_messages m
                 JOIN email_campaign_steps cs ON cs.id = m.campaign_step_id
                 WHERE m.campaign_id = c.id AND cs.step_order = 3) AS sent_step_3,
              (SELECT MIN(s.scheduled_at) FROM scheduled_emails s
                 WHERE s.campaign_id = c.id
                   AND s.status IN ('pending', 'sending')
                   AND s.scheduled_at IS NOT NULL) AS next_follow_up_at
       FROM email_campaigns c
       LEFT JOIN email_accounts a ON a.id = c.email_account_id
       LEFT JOIN users u ON u.id = c.created_by
       ORDER BY c.created_at DESC`,
    )
    .all();
  return rows.map((r) => ({
    ...r,
    open_rate: r.sent_count ? Math.round((r.opened_count / r.sent_count) * 1000) / 10 : 0,
    reply_rate: r.sent_count ? Math.round((r.reply_count / r.sent_count) * 1000) / 10 : 0,
  }));
}

export function getCampaign(id) {
  const campaign = db
    .prepare(
      `SELECT c.*,
              a.label AS account_label,
              a.email AS account_email,
              u.name AS created_by_name
       FROM email_campaigns c
       LEFT JOIN email_accounts a ON a.id = c.email_account_id
       LEFT JOIN users u ON u.id = c.created_by
       WHERE c.id = ?`,
    )
    .get(id);
  if (!campaign) return null;

  const steps = db
    .prepare(
      `SELECT * FROM email_campaign_steps
       WHERE campaign_id = ?
       ORDER BY step_order ASC`,
    )
    .all(id);

  const leads = db
    .prepare(
      `SELECT cl.*, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company
       FROM email_campaign_leads cl
       JOIN leads l ON l.id = cl.lead_id
       WHERE cl.campaign_id = ?
       ORDER BY cl.enrolled_at DESC`,
    )
    .all(id)
    .map((row) => ({
      ...row,
      lead_name: displayLeadName(row.lead_name, row.lead_email, row.lead_company),
    }));

  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status = 'stopped' THEN 1 ELSE 0 END) AS stopped,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         COUNT(*) AS total
       FROM email_campaign_leads
       WHERE campaign_id = ?`,
    )
    .get(id);

  const stats = getCampaignStats(id);

  return { ...campaign, steps, leads, counts, stats };
}

export function createCampaign(body, { userId }) {
  const name = String(body.name || '').trim();
  if (!name) {
    const err = new Error('Campaign name required');
    err.status = 400;
    throw err;
  }

  let accountId = body.emailAccountId || body.email_account_id || null;
  if (accountId) {
    resolveSendAccount(accountId);
  } else {
    accountId = resolveSendAccount(null).accountId;
  }

  const id = uuid();
  db.prepare(
    `INSERT INTO email_campaigns (id, name, status, email_account_id, created_by)
     VALUES (?, ?, 'draft', ?, ?)`,
  ).run(id, name, accountId, userId);

  const steps = Array.isArray(body.steps) ? body.steps : [];
  if (steps.length) {
    replaceSteps(id, steps);
  }

  return getCampaign(id);
}

export function updateCampaign(id, body) {
  const row = db.prepare(`SELECT * FROM email_campaigns WHERE id = ?`).get(id);
  if (!row) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }
  if (row.status !== 'draft' && row.status !== 'paused') {
    const err = new Error('Only draft or paused campaigns can be edited');
    err.status = 400;
    throw err;
  }

  const name = body.name != null ? String(body.name).trim() : row.name;
  if (!name) {
    const err = new Error('Campaign name required');
    err.status = 400;
    throw err;
  }

  let accountId = row.email_account_id;
  if (body.emailAccountId !== undefined || body.email_account_id !== undefined) {
    accountId = body.emailAccountId ?? body.email_account_id ?? null;
    if (accountId) resolveSendAccount(accountId);
  }

  db.prepare(
    `UPDATE email_campaigns
     SET name = ?, email_account_id = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(name, accountId, id);

  if (Array.isArray(body.steps)) {
    replaceSteps(id, body.steps);
  }

  return getCampaign(id);
}

function replaceSteps(campaignId, steps) {
  db.prepare(`DELETE FROM email_campaign_steps WHERE campaign_id = ?`).run(campaignId);
  const insert = db.prepare(
    `INSERT INTO email_campaign_steps (
       id, campaign_id, step_order, delay_days, subject, html_content, text_content, template_id, content_category
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  steps.forEach((s, i) => {
    const order = Number(s.step_order || s.stepOrder || i + 1) || i + 1;
    const delay = Math.max(0, Number(s.delay_days ?? s.delayDays ?? 0) || 0);
    const subject = s.subject != null ? String(s.subject) : null;
    const html = s.html_content ?? s.htmlContent ?? null;
    const text = s.text_content ?? s.textContent ?? null;
    const templateId = s.template_id || s.templateId || null;
    const category = normalizeContentCategory(s.content_category ?? s.contentCategory);
    if (!category) {
      const err = new Error(
        `Email ${order}: pick a format (Plain text, Image, GIF, or Video)`,
      );
      err.status = 400;
      throw err;
    }
    if (!templateId && !subject) {
      const err = new Error(`Email ${order}: subject or template required`);
      err.status = 400;
      throw err;
    }
    if (!templateId && !html && !text) {
      const err = new Error(`Email ${order}: body required`);
      err.status = 400;
      throw err;
    }
    insert.run(
      uuid(),
      campaignId,
      order,
      delay,
      subject,
      html,
      text,
      templateId,
      category,
    );
  });
}

/**
 * Open / reply rates by email format across campaigns (easy comparison table).
 */
export function getCategoryStats(query = {}) {
  const bounds = resolveAnalyticsBounds({
    period: query.period || 'overall',
    from: query.from,
    to: query.to,
    fromYmd: query.fromYmd,
    toYmd: query.toYmd,
  });
  const isOverall = bounds.period === 'overall';
  const dateClause = isOverall
    ? ''
    : ` AND ${DT('m.sent_at')} >= datetime(?) AND ${DT('m.sent_at')} < datetime(?)`;
  const params = isOverall ? [] : [bounds.from, bounds.to];

  const sentRows = db
    .prepare(
      `SELECT
         COALESCE(cs.content_category, '') AS content_category,
         COUNT(*) AS sent,
         SUM(CASE WHEN COALESCE(m.open_count, 0) > 0 THEN 1 ELSE 0 END) AS opened,
         SUM(CASE WHEN m.status = 'bounced' THEN 1 ELSE 0 END) AS bounced
       FROM email_messages m
       LEFT JOIN email_campaign_steps cs ON cs.id = m.campaign_step_id
       WHERE m.campaign_id IS NOT NULL${dateClause}
       GROUP BY COALESCE(cs.content_category, '')`,
    )
    .all(...params);

  const replyRows = db
    .prepare(
      `SELECT
         COALESCE(cs.content_category, '') AS content_category,
         COUNT(*) AS replies
       FROM email_replies r
       JOIN email_messages m ON m.id = r.email_message_id
       LEFT JOIN email_campaign_steps cs ON cs.id = m.campaign_step_id
       WHERE m.campaign_id IS NOT NULL${dateClause}
       GROUP BY COALESCE(cs.content_category, '')`,
    )
    .all(...params);

  const replyMap = new Map(replyRows.map((r) => [r.content_category || '', r.replies || 0]));
  const byKey = new Map();
  for (const row of sentRows) {
    const key = row.content_category || '';
    const sent = row.sent || 0;
    const opened = row.opened || 0;
    const replies = replyMap.get(key) || 0;
    byKey.set(key, {
      content_category: key || null,
      label: CONTENT_CATEGORY_LABELS[key] || (key ? key : 'Uncategorized'),
      sent,
      opened,
      replies,
      bounced: row.bounced || 0,
      openRate: sent ? Math.round((opened / sent) * 1000) / 10 : 0,
      replyRate: sent ? Math.round((replies / sent) * 1000) / 10 : 0,
    });
  }

  const empty = (key) => ({
    content_category: key || null,
    label: CONTENT_CATEGORY_LABELS[key] || 'Uncategorized',
    sent: 0,
    opened: 0,
    replies: replyMap.get(key || '') || 0,
    bounced: 0,
    openRate: 0,
    replyRate: 0,
  });

  const ordered = [
    ...CONTENT_CATEGORIES.map((key) => byKey.get(key) || empty(key)),
    ...(byKey.has('') ? [byKey.get('')] : []),
  ];

  return {
    period: bounds.period,
    label: bounds.label,
    fromYmd: bounds.fromYmd,
    toYmd: bounds.toYmd,
    categories: ordered,
  };
}

export function addLeads(campaignId, leadIds, { user, skipPerm = false } = {}) {
  const campaign = db.prepare(`SELECT * FROM email_campaigns WHERE id = ?`).get(campaignId);
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }
  if (!['draft', 'paused', 'active'].includes(campaign.status)) {
    const err = new Error('Cannot add leads to this campaign');
    err.status = 400;
    throw err;
  }

  const ids = [...new Set((leadIds || []).filter(Boolean))];
  if (!ids.length) {
    const err = new Error('leadIds[] required');
    err.status = 400;
    throw err;
  }

  const placeholders = ids.map(() => '?').join(',');
  let leads = db
    .prepare(
      `SELECT * FROM leads WHERE id IN (${placeholders}) AND email IS NOT NULL AND email != ''`,
    )
    .all(...ids);

  if (!skipPerm && user) {
    leads = leads.filter((l) => canUpdateLead(user, l));
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO email_campaign_leads (id, campaign_id, lead_id, status)
     VALUES (?, ?, ?, ?)`,
  );
  const status = campaign.status === 'active' ? 'active' : 'pending';
  let added = 0;
  const tx = db.transaction(() => {
    for (const lead of leads) {
      const r = insert.run(uuid(), campaignId, lead.id, status);
      if (r.changes) added += 1;
    }
  });
  tx();

  return { added, total: leads.length };
}

export function removeLead(campaignId, leadId) {
  const campaign = db.prepare(`SELECT * FROM email_campaigns WHERE id = ?`).get(campaignId);
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }
  if (campaign.status === 'active') {
    db.prepare(
      `UPDATE scheduled_emails
       SET status = 'cancelled', error = ?
       WHERE campaign_id = ? AND lead_id = ? AND status IN ('pending', 'sending')`,
    ).run('Removed from campaign', campaignId, leadId);
  }
  return db
    .prepare(`DELETE FROM email_campaign_leads WHERE campaign_id = ? AND lead_id = ?`)
    .run(campaignId, leadId).changes;
}

/**
 * Launch: schedule each step for each lead via scheduled_emails worker.
 */
export function launchCampaign(campaignId, { userId }) {
  const campaign = db.prepare(`SELECT * FROM email_campaigns WHERE id = ?`).get(campaignId);
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }
  if (campaign.status !== 'draft' && campaign.status !== 'paused') {
    const err = new Error('Only draft or paused campaigns can be launched');
    err.status = 400;
    throw err;
  }

  const steps = db
    .prepare(
      `SELECT * FROM email_campaign_steps WHERE campaign_id = ? ORDER BY step_order ASC`,
    )
    .all(campaignId);
  if (!steps.length) {
    const err = new Error('Add at least one email step before launch');
    err.status = 400;
    throw err;
  }

  const members = db
    .prepare(
      `SELECT cl.*, l.email AS lead_email
       FROM email_campaign_leads cl
       JOIN leads l ON l.id = cl.lead_id
       WHERE cl.campaign_id = ? AND cl.status IN ('pending', 'active', 'stopped')
         AND l.email IS NOT NULL AND l.email != ''`,
    )
    .all(campaignId);
  if (!members.length) {
    const err = new Error('Add at least one lead with an email before launch');
    err.status = 400;
    throw err;
  }

  resolveSendAccount(campaign.email_account_id);

  const now = new Date();
  const insert = db.prepare(
    `INSERT INTO scheduled_emails (
       id, batch_id, lead_id, user_id, subject, html_content, text_content,
       template_id, sync_to_brevo, scheduled_at, status,
       email_account_id, campaign_id, campaign_step_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'pending', ?, ?, ?)`,
  );

  const batchId = uuid();
  let scheduled = 0;

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE email_campaigns
       SET status = 'active', launched_at = COALESCE(launched_at, ?), updated_at = datetime('now')
       WHERE id = ?`,
    ).run(sqlDate(now), campaignId);

    db.prepare(
      `UPDATE email_campaign_leads
       SET status = 'active', stopped_reason = NULL, completed_at = NULL
       WHERE campaign_id = ? AND status IN ('pending', 'stopped')`,
    ).run(campaignId);

    // Cancel leftover pending from a previous pause
    db.prepare(
      `UPDATE scheduled_emails
       SET status = 'cancelled', error = 'Re-launched'
       WHERE campaign_id = ? AND status IN ('pending', 'sending')`,
    ).run(campaignId);

    for (const member of members) {
      for (const step of steps) {
        const when = new Date(now.getTime() + (Number(step.delay_days) || 0) * 86_400_000);
        insert.run(
          uuid(),
          batchId,
          member.lead_id,
          userId,
          step.subject || null,
          step.html_content || null,
          step.text_content || null,
          step.template_id || null,
          sqlDate(when),
          campaign.email_account_id || null,
          campaignId,
          step.id,
        );
        scheduled += 1;
      }
    }
  });
  tx();

  return { ok: true, batchId, scheduled, leads: members.length, steps: steps.length };
}

export function pauseCampaign(campaignId) {
  const campaign = db.prepare(`SELECT * FROM email_campaigns WHERE id = ?`).get(campaignId);
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }
  if (campaign.status !== 'active') {
    const err = new Error('Only active campaigns can be paused');
    err.status = 400;
    throw err;
  }
  db.prepare(
    `UPDATE scheduled_emails
     SET status = 'cancelled', error = ?
     WHERE campaign_id = ? AND status IN ('pending', 'sending')`,
  ).run('Campaign paused', campaignId);
  db.prepare(
    `UPDATE email_campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?`,
  ).run(campaignId);
  return getCampaign(campaignId);
}

export function cancelCampaign(campaignId) {
  const campaign = db.prepare(`SELECT * FROM email_campaigns WHERE id = ?`).get(campaignId);
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }
  db.prepare(
    `UPDATE scheduled_emails
     SET status = 'cancelled', error = ?
     WHERE campaign_id = ? AND status IN ('pending', 'sending')`,
  ).run('Campaign cancelled', campaignId);
  db.prepare(
    `UPDATE email_campaign_leads
     SET status = 'stopped', stopped_reason = 'Campaign cancelled', completed_at = datetime('now')
     WHERE campaign_id = ? AND status IN ('pending', 'active')`,
  ).run(campaignId);
  db.prepare(
    `UPDATE email_campaigns SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`,
  ).run(campaignId);
  return getCampaign(campaignId);
}
