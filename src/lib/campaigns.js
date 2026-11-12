/**
 * In-CRM email campaigns (Brevo transactional delivery).
 */
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { canUpdateLead } from './permissions.js';
import { resolveSendAccount } from './emailAccounts.js';
import {
  DEFAULT_CAMPAIGN_TIMEZONE,
  normalizeCampaignTimezone,
} from './campaignTimezones.js';
import { resolveAnalyticsBounds } from './periodBounds.js';
import { resolveCampaignSendAt, toScheduleSql } from './campaignSchedule.js';

/** Email format tags — used to compare open/reply rates by style. */
export const CONTENT_CATEGORIES = ['plain_text', 'image', 'gif', 'video'];

export const CONTENT_CATEGORY_LABELS = {
  plain_text: 'Plain text',
  image: 'Image',
  gif: 'GIF',
  video: 'Video',
};

export const VARIANT_KEYS = ['A', 'B', 'C', 'D'];

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

export function normalizeVariantKey(raw, index = 0) {
  const k = String(raw || '')
    .trim()
    .toUpperCase();
  if (VARIANT_KEYS.includes(k)) return k;
  return VARIANT_KEYS[Math.min(Math.max(index, 0), VARIANT_KEYS.length - 1)];
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function loadStepVariants(stepId) {
  return db
    .prepare(
      `SELECT * FROM email_campaign_step_variants
       WHERE campaign_step_id = ?
       ORDER BY sort_order ASC, variant_key ASC`,
    )
    .all(stepId);
}

/** Attach variants to steps; synthesize one variant from legacy step fields if needed. */
function hydrateStepsWithVariants(steps) {
  return steps.map((step) => {
    let variants = loadStepVariants(step.id);
    if (!variants.length) {
      variants = [
        {
          id: null,
          campaign_step_id: step.id,
          variant_key: 'A',
          label: 'Variant A',
          content_category: step.content_category || 'plain_text',
          subject: step.subject,
          html_content: step.html_content,
          text_content: step.text_content,
          template_id: step.template_id,
          weight_pct: 100,
          sort_order: 1,
        },
      ];
    }
    return {
      ...step,
      variants: variants.map((v) => ({
        ...v,
        content_category_label:
          CONTENT_CATEGORY_LABELS[v.content_category] ||
          (v.content_category ? v.content_category : '—'),
      })),
    };
  });
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

  const byVariant = db
    .prepare(
      `SELECT
         COALESCE(m.variant_key, cl.variant_key, 'A') AS variant_key,
         COUNT(*) AS sent,
         SUM(CASE WHEN COALESCE(m.open_count, 0) > 0 THEN 1 ELSE 0 END) AS opened,
         SUM(CASE WHEN m.status = 'bounced' THEN 1 ELSE 0 END) AS bounced,
         (SELECT COUNT(*) FROM email_replies r
            WHERE EXISTS (
              SELECT 1 FROM email_messages m2
              LEFT JOIN email_campaign_leads cl2
                ON cl2.campaign_id = m2.campaign_id AND cl2.lead_id = m2.lead_id
              WHERE m2.campaign_id = ?
                AND (m2.id = r.email_message_id OR m2.lead_id = r.lead_id)
                AND COALESCE(m2.variant_key, cl2.variant_key, 'A') = COALESCE(m.variant_key, cl.variant_key, 'A')
            )) AS replies
       FROM email_messages m
       LEFT JOIN email_campaign_leads cl
         ON cl.campaign_id = m.campaign_id AND cl.lead_id = m.lead_id
       WHERE m.campaign_id = ?
       GROUP BY COALESCE(m.variant_key, cl.variant_key, 'A')
       ORDER BY variant_key ASC`,
    )
    .all(campaignId, campaignId)
    .map((row) => ({
      ...row,
      openRate: row.sent ? Math.round((row.opened / row.sent) * 1000) / 10 : 0,
      replyRate: row.sent ? Math.round((row.replies / row.sent) * 1000) / 10 : 0,
    }));

  const variantAssigned = db
    .prepare(
      `SELECT variant_key, COUNT(*) AS leads
       FROM email_campaign_leads
       WHERE campaign_id = ? AND variant_key IS NOT NULL AND TRIM(variant_key) != ''
       GROUP BY variant_key
       ORDER BY variant_key ASC`,
    )
    .all(campaignId);

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
    byVariant,
    variantAssigned,
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
              (SELECT COUNT(*) FROM email_messages m
                 JOIN email_campaign_steps cs ON cs.id = m.campaign_step_id
                 WHERE m.campaign_id = c.id AND cs.step_order = 4) AS sent_step_4,
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

/**
 * Drilldown rows for a campaign metric (leads, Email 1–4, opened, replies, bounced).
 */
export function getCampaignDrilldown(campaignId, metricRaw = 'leads') {
  const campaign = db
    .prepare(`SELECT id, name, status FROM email_campaigns WHERE id = ?`)
    .get(campaignId);
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }

  const metric = String(metricRaw || 'leads')
    .trim()
    .toLowerCase();
  const limit = 2000;
  let title = campaign.name;
  let items = [];

  if (metric === 'leads') {
    title = `${campaign.name} · Leads`;
    items = db
      .prepare(
        `SELECT cl.id, cl.status, cl.variant_key, cl.enrolled_at AS date,
                l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                l.status AS lead_status
         FROM email_campaign_leads cl
         JOIN leads l ON l.id = cl.lead_id
         WHERE cl.campaign_id = ?
         ORDER BY cl.enrolled_at DESC
         LIMIT ?`,
      )
      .all(campaignId, limit)
      .map((row) => ({
        ...row,
        lead_name: displayLeadName(row.lead_name, row.lead_email, row.lead_company),
        subject: row.variant_key ? `Variant ${row.variant_key}` : null,
      }));
  } else if (/^step_?[1-4]$/.test(metric) || /^email_?[1-4]$/.test(metric)) {
    const stepOrder = Number(String(metric).replace(/\D/g, '')) || 1;
    title = `${campaign.name} · Email ${stepOrder}`;
    items = db
      .prepare(
        `SELECT m.id, m.subject, m.to_email, m.sent_at AS date, m.status,
                m.open_count, m.reply_count, m.variant_key,
                l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                l.status AS lead_status, cs.step_order
         FROM email_messages m
         JOIN email_campaign_steps cs ON cs.id = m.campaign_step_id
         LEFT JOIN leads l ON l.id = m.lead_id
         WHERE m.campaign_id = ? AND cs.step_order = ?
         ORDER BY m.sent_at DESC
         LIMIT ?`,
      )
      .all(campaignId, stepOrder, limit)
      .map((row) => ({
        ...row,
        lead_name: displayLeadName(row.lead_name, row.lead_email, row.lead_company),
      }));
  } else if (metric === 'opened' || metric === 'opens') {
    title = `${campaign.name} · Opened`;
    items = db
      .prepare(
        `SELECT m.id, m.subject, m.to_email, COALESCE(m.last_opened_at, m.sent_at) AS date, m.status,
                m.open_count, m.reply_count, m.variant_key,
                l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                l.status AS lead_status, cs.step_order
         FROM email_messages m
         LEFT JOIN email_campaign_steps cs ON cs.id = m.campaign_step_id
         LEFT JOIN leads l ON l.id = m.lead_id
         WHERE m.campaign_id = ? AND COALESCE(m.open_count, 0) > 0
         ORDER BY COALESCE(m.last_opened_at, m.sent_at) DESC
         LIMIT ?`,
      )
      .all(campaignId, limit)
      .map((row) => ({
        ...row,
        lead_name: displayLeadName(row.lead_name, row.lead_email, row.lead_company),
      }));
  } else if (metric === 'replies' || metric === 'reply') {
    title = `${campaign.name} · Replies`;
    items = db
      .prepare(
        `SELECT r.id, r.subject, r.from_email AS to_email, r.received_at AS date, 'replied' AS status,
                r.from_name, m.variant_key, cs.step_order,
                l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                l.status AS lead_status
         FROM email_replies r
         LEFT JOIN email_messages m ON m.id = r.email_message_id
         LEFT JOIN email_campaign_steps cs ON cs.id = m.campaign_step_id
         LEFT JOIN leads l ON l.id = r.lead_id
         WHERE EXISTS (
           SELECT 1 FROM email_messages m2
           WHERE m2.campaign_id = ?
             AND (m2.id = r.email_message_id OR m2.lead_id = r.lead_id)
         )
         ORDER BY r.received_at DESC
         LIMIT ?`,
      )
      .all(campaignId, limit)
      .map((row) => ({
        ...row,
        lead_name: displayLeadName(row.lead_name, row.lead_email, row.lead_company),
      }));
  } else if (metric === 'bounced' || metric === 'bounces') {
    title = `${campaign.name} · Bounces`;
    items = db
      .prepare(
        `SELECT m.id, m.subject, m.to_email, m.sent_at AS date, m.status,
                m.open_count, m.reply_count, m.variant_key,
                l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                l.status AS lead_status, cs.step_order
         FROM email_messages m
         LEFT JOIN email_campaign_steps cs ON cs.id = m.campaign_step_id
         LEFT JOIN leads l ON l.id = m.lead_id
         WHERE m.campaign_id = ? AND m.status = 'bounced'
         ORDER BY m.sent_at DESC
         LIMIT ?`,
      )
      .all(campaignId, limit)
      .map((row) => ({
        ...row,
        lead_name: displayLeadName(row.lead_name, row.lead_email, row.lead_company),
      }));
  } else if (metric === 'sent' || metric === 'emails') {
    title = `${campaign.name} · Sent`;
    items = db
      .prepare(
        `SELECT m.id, m.subject, m.to_email, m.sent_at AS date, m.status,
                m.open_count, m.reply_count, m.variant_key,
                l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                l.status AS lead_status, cs.step_order
         FROM email_messages m
         LEFT JOIN email_campaign_steps cs ON cs.id = m.campaign_step_id
         LEFT JOIN leads l ON l.id = m.lead_id
         WHERE m.campaign_id = ?
         ORDER BY m.sent_at DESC
         LIMIT ?`,
      )
      .all(campaignId, limit)
      .map((row) => ({
        ...row,
        lead_name: displayLeadName(row.lead_name, row.lead_email, row.lead_company),
      }));
  } else {
    const err = new Error('Unknown metric');
    err.status = 400;
    throw err;
  }

  return {
    campaign,
    metric,
    title,
    count: items.length,
    items,
  };
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

  const rawSteps = db
    .prepare(
      `SELECT * FROM email_campaign_steps
       WHERE campaign_id = ?
       ORDER BY step_order ASC`,
    )
    .all(id);
  const steps = hydrateStepsWithVariants(rawSteps);

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
  const variantKeys = (steps[0]?.variants || []).map((v) => v.variant_key);

  return { ...campaign, steps, leads, counts, stats, variantKeys };
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

  const timezone = normalizeCampaignTimezone(
    body.timezone || body.timeZone || DEFAULT_CAMPAIGN_TIMEZONE,
  );

  const id = uuid();
  db.prepare(
    `INSERT INTO email_campaigns (id, name, status, email_account_id, timezone, created_by)
     VALUES (?, ?, 'draft', ?, ?, ?)`,
  ).run(id, name, accountId, timezone, userId);

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

  let timezone = normalizeCampaignTimezone(row.timezone || DEFAULT_CAMPAIGN_TIMEZONE);
  if (body.timezone !== undefined || body.timeZone !== undefined) {
    timezone = normalizeCampaignTimezone(body.timezone ?? body.timeZone);
  }

  db.prepare(
    `UPDATE email_campaigns
     SET name = ?, email_account_id = ?, timezone = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(name, accountId, timezone, id);

  if (Array.isArray(body.steps)) {
    replaceSteps(id, body.steps);
  }

  return getCampaign(id);
}

function normalizeStepVariants(step, stepOrder) {
  let variants = Array.isArray(step.variants) ? step.variants : null;
  // Legacy single-email step → one variant A
  if (!variants || !variants.length) {
    variants = [
      {
        key: 'A',
        contentCategory: step.content_category ?? step.contentCategory ?? 'plain_text',
        subject: step.subject,
        htmlContent: step.html_content ?? step.htmlContent,
        textContent: step.text_content ?? step.textContent,
        templateId: step.template_id || step.templateId,
      },
    ];
  }
  if (variants.length > VARIANT_KEYS.length) {
    const err = new Error(`Email ${stepOrder}: max ${VARIANT_KEYS.length} variants (A–D)`);
    err.status = 400;
    throw err;
  }

  const normalized = variants.map((v, vi) => {
    const key = normalizeVariantKey(v.key ?? v.variant_key ?? v.variantKey, vi);
    const category = normalizeContentCategory(v.content_category ?? v.contentCategory) || 'plain_text';
    const subject = v.subject != null ? String(v.subject) : null;
    const html = v.html_content ?? v.htmlContent ?? null;
    const text = v.text_content ?? v.textContent ?? null;
    const templateId = v.template_id || v.templateId || null;
    if (!templateId && !subject) {
      const err = new Error(`Email ${stepOrder} variant ${key}: subject or template required`);
      err.status = 400;
      throw err;
    }
    if (!templateId && !html && !text) {
      const err = new Error(`Email ${stepOrder} variant ${key}: body required`);
      err.status = 400;
      throw err;
    }
    return {
      key,
      label: v.label || `Variant ${key}`,
      category,
      subject,
      html,
      text,
      templateId,
      sortOrder: vi + 1,
    };
  });

  const keys = normalized.map((v) => v.key);
  if (new Set(keys).size !== keys.length) {
    const err = new Error(`Email ${stepOrder}: duplicate variant letters`);
    err.status = 400;
    throw err;
  }
  return normalized;
}

function replaceSteps(campaignId, steps) {
  db.prepare(`DELETE FROM email_campaign_steps WHERE campaign_id = ?`).run(campaignId);
  const insertStep = db.prepare(
    `INSERT INTO email_campaign_steps (
       id, campaign_id, step_order, delay_days, subject, html_content, text_content, template_id, content_category
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertVariant = db.prepare(
    `INSERT INTO email_campaign_step_variants (
       id, campaign_step_id, variant_key, label, content_category,
       subject, html_content, text_content, template_id, weight_pct, sort_order
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const parsed = steps.map((s, i) => {
    const order = Number(s.step_order || s.stepOrder || i + 1) || i + 1;
    const delay = Math.max(0, Number(s.delay_days ?? s.delayDays ?? 0) || 0);
    const variants = normalizeStepVariants(s, order);
    return { order, delay, variants };
  });

  if (!parsed.length) return;

  const baseKeys = parsed[0].variants.map((v) => v.key).join(',');
  for (const step of parsed) {
    const keys = step.variants.map((v) => v.key).join(',');
    if (keys !== baseKeys) {
      const err = new Error(
        'Every email in the sequence must use the same variants (e.g. A/B/C). Add the same letters on each follow-up.',
      );
      err.status = 400;
      throw err;
    }
  }

  const weight = Math.round((1000 / parsed[0].variants.length)) / 10;

  for (const step of parsed) {
    const stepId = uuid();
    const first = step.variants[0];
    insertStep.run(
      stepId,
      campaignId,
      step.order,
      step.delay,
      first.subject,
      first.html,
      first.text,
      first.templateId,
      first.category,
    );
    for (const v of step.variants) {
      insertVariant.run(
        uuid(),
        stepId,
        v.key,
        v.label,
        v.category,
        v.subject,
        v.html,
        v.text,
        v.templateId,
        weight,
        v.sortOrder,
      );
    }
  }
}

/**
 * Split unassigned leads evenly across variant keys (A/B/C/D).
 * Always fills the smallest bucket so adding leads one-by-one still balances.
 * Never reassigns existing leads.
 */
export function assignVariantKeys(campaignId) {
  const steps = hydrateStepsWithVariants(
    db
      .prepare(
        `SELECT * FROM email_campaign_steps WHERE campaign_id = ? ORDER BY step_order ASC`,
      )
      .all(campaignId),
  );
  const keys = (steps[0]?.variants || []).map((v) => v.variant_key);
  if (!keys.length) return { assigned: 0, keys: [] };

  const counts = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const row of db
    .prepare(
      `SELECT variant_key, COUNT(*) AS c
       FROM email_campaign_leads
       WHERE campaign_id = ?
         AND variant_key IS NOT NULL AND TRIM(variant_key) != ''
       GROUP BY variant_key`,
    )
    .all(campaignId)) {
    if (counts[row.variant_key] != null) counts[row.variant_key] = row.c || 0;
  }

  const unassigned = db
    .prepare(
      `SELECT id FROM email_campaign_leads
       WHERE campaign_id = ?
         AND (variant_key IS NULL OR TRIM(variant_key) = '')`,
    )
    .all(campaignId)
    .map((r) => r.id);

  if (!unassigned.length) return { assigned: 0, keys };

  shuffleInPlace(unassigned);
  const upd = db.prepare(`UPDATE email_campaign_leads SET variant_key = ? WHERE id = ?`);
  const pickSmallest = () => {
    let best = keys[0];
    for (const k of keys) {
      if (counts[k] < counts[best]) best = k;
    }
    return best;
  };
  const tx = db.transaction(() => {
    for (const rowId of unassigned) {
      const key = pickSmallest();
      upd.run(key, rowId);
      counts[key] += 1;
    }
  });
  tx();
  return { assigned: unassigned.length, keys };
}

/**
 * Open / reply rates by variant letter and by email format (across campaigns).
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

  const variantRows = db
    .prepare(
      `SELECT
         COALESCE(m.variant_key, '') AS variant_key,
         COUNT(*) AS sent,
         SUM(CASE WHEN COALESCE(m.open_count, 0) > 0 THEN 1 ELSE 0 END) AS opened,
         SUM(CASE WHEN m.status = 'bounced' THEN 1 ELSE 0 END) AS bounced
       FROM email_messages m
       WHERE m.campaign_id IS NOT NULL${dateClause}
       GROUP BY COALESCE(m.variant_key, '')`,
    )
    .all(...params);

  const variantReplyRows = db
    .prepare(
      `SELECT
         COALESCE(m.variant_key, '') AS variant_key,
         COUNT(*) AS replies
       FROM email_replies r
       JOIN email_messages m ON m.id = r.email_message_id
       WHERE m.campaign_id IS NOT NULL${dateClause}
       GROUP BY COALESCE(m.variant_key, '')`,
    )
    .all(...params);
  const variantReplyMap = new Map(
    variantReplyRows.map((r) => [r.variant_key || '', r.replies || 0]),
  );

  const variants = VARIANT_KEYS.map((key) => {
    const row = variantRows.find((r) => r.variant_key === key) || {
      sent: 0,
      opened: 0,
      bounced: 0,
    };
    const sent = row.sent || 0;
    const opened = row.opened || 0;
    const replies = variantReplyMap.get(key) || 0;
    return {
      variant_key: key,
      label: `Variant ${key}`,
      sent,
      opened,
      replies,
      bounced: row.bounced || 0,
      openRate: sent ? Math.round((opened / sent) * 1000) / 10 : 0,
      replyRate: sent ? Math.round((replies / sent) * 1000) / 10 : 0,
    };
  });

  const sentRows = db
    .prepare(
      `SELECT
         COALESCE(v.content_category, cs.content_category, '') AS content_category,
         COUNT(*) AS sent,
         SUM(CASE WHEN COALESCE(m.open_count, 0) > 0 THEN 1 ELSE 0 END) AS opened,
         SUM(CASE WHEN m.status = 'bounced' THEN 1 ELSE 0 END) AS bounced
       FROM email_messages m
       LEFT JOIN email_campaign_step_variants v ON v.id = m.campaign_variant_id
       LEFT JOIN email_campaign_steps cs ON cs.id = m.campaign_step_id
       WHERE m.campaign_id IS NOT NULL${dateClause}
       GROUP BY COALESCE(v.content_category, cs.content_category, '')`,
    )
    .all(...params);

  const replyRows = db
    .prepare(
      `SELECT
         COALESCE(v.content_category, cs.content_category, '') AS content_category,
         COUNT(*) AS replies
       FROM email_replies r
       JOIN email_messages m ON m.id = r.email_message_id
       LEFT JOIN email_campaign_step_variants v ON v.id = m.campaign_variant_id
       LEFT JOIN email_campaign_steps cs ON cs.id = m.campaign_step_id
       WHERE m.campaign_id IS NOT NULL${dateClause}
       GROUP BY COALESCE(v.content_category, cs.content_category, '')`,
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

  const categories = [
    ...CONTENT_CATEGORIES.map((key) => byKey.get(key) || empty(key)),
    ...(byKey.has('') ? [byKey.get('')] : []),
  ];

  return {
    period: bounds.period,
    label: bounds.label,
    fromYmd: bounds.fromYmd,
    toYmd: bounds.toYmd,
    variants,
    categories,
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
  const addedLeadIds = [];
  const tx = db.transaction(() => {
    for (const lead of leads) {
      const rowId = uuid();
      const r = insert.run(rowId, campaignId, lead.id, status);
      if (r.changes) {
        added += 1;
        addedLeadIds.push(lead.id);
      }
    }
  });
  tx();

  assignVariantKeys(campaignId);

  // Active campaign: schedule remaining steps for newly added leads using their variant.
  let scheduled = 0;
  if (campaign.status === 'active' && addedLeadIds.length) {
    scheduled = scheduleStepsForLeads(campaignId, addedLeadIds, {
      userId: user?.id || campaign.created_by,
    }).scheduled;
  }

  return { added, total: leads.length, scheduled };
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
 * Schedule each step for given leads using each lead's assigned variant content.
 */
function scheduleStepsForLeads(campaignId, leadIds, { userId, batchId = null, now = new Date() } = {}) {
  const campaign = db.prepare(`SELECT * FROM email_campaigns WHERE id = ?`).get(campaignId);
  if (!campaign) return { scheduled: 0, batchId: null };

  const steps = hydrateStepsWithVariants(
    db
      .prepare(
        `SELECT * FROM email_campaign_steps WHERE campaign_id = ? ORDER BY step_order ASC`,
      )
      .all(campaignId),
  );
  if (!steps.length || !leadIds?.length) return { scheduled: 0, batchId: null };

  const placeholders = leadIds.map(() => '?').join(',');
  const members = db
    .prepare(
      `SELECT cl.*, l.email AS lead_email
       FROM email_campaign_leads cl
       JOIN leads l ON l.id = cl.lead_id
       WHERE cl.campaign_id = ?
         AND cl.lead_id IN (${placeholders})
         AND l.email IS NOT NULL AND l.email != ''`,
    )
    .all(campaignId, ...leadIds);

  const insert = db.prepare(
    `INSERT INTO scheduled_emails (
       id, batch_id, lead_id, user_id, subject, html_content, text_content,
       template_id, sync_to_brevo, scheduled_at, status,
       email_account_id, campaign_id, campaign_step_id, campaign_variant_id, variant_key
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'pending', ?, ?, ?, ?, ?)`,
  );

  const bid = batchId || uuid();
  let scheduled = 0;
  const base = campaign.launched_at ? new Date(campaign.launched_at) : now;
  const scheduleBase = Number.isNaN(base.getTime()) ? now : base;

  const tx = db.transaction(() => {
    for (const member of members) {
      const vKey = normalizeVariantKey(member.variant_key || 'A', 0);
      // Enrollment after launch (mid-campaign add) becomes the base; otherwise use launch time.
      let perLeadBase = scheduleBase;
      if (member.enrolled_at) {
        const enrolled = new Date(
          String(member.enrolled_at).includes('T')
            ? member.enrolled_at
            : `${String(member.enrolled_at).replace(' ', 'T')}Z`,
        );
        if (!Number.isNaN(enrolled.getTime()) && enrolled > scheduleBase) {
          perLeadBase = enrolled;
        }
      }
      for (const step of steps) {
        const variant =
          (step.variants || []).find((v) => v.variant_key === vKey) || step.variants?.[0];
        if (!variant) continue;
        const when = resolveCampaignSendAt(
          perLeadBase,
          Number(step.delay_days) || 0,
          campaign.timezone || DEFAULT_CAMPAIGN_TIMEZONE,
        );
        // Skip if already sent/pending for this step+lead
        const exists = db
          .prepare(
            `SELECT 1 AS ok FROM scheduled_emails
             WHERE campaign_id = ? AND lead_id = ? AND campaign_step_id = ?
               AND status IN ('pending', 'sending', 'sent')
             LIMIT 1`,
          )
          .get(campaignId, member.lead_id, step.id);
        if (exists) continue;

        insert.run(
          uuid(),
          bid,
          member.lead_id,
          userId || campaign.created_by,
          variant.subject || null,
          variant.html_content || null,
          variant.text_content || null,
          variant.template_id || null,
          toScheduleSql(when),
          campaign.email_account_id || null,
          campaignId,
          step.id,
          variant.id || null,
          vKey,
        );
        scheduled += 1;
      }
    }
  });
  tx();

  return { scheduled, batchId: bid };
}

/**
 * Rewrite pending campaign follow-ups (and unsent day-0) using business days + peak hours.
 * Safe to run on boot / after deploy so live campaigns pick up the new rules.
 */
export function reschedulePendingCampaignSends() {
  const rows = db
    .prepare(
      `SELECT s.id, s.campaign_id, s.campaign_step_id, s.lead_id,
              cs.delay_days,
              c.launched_at,
              c.timezone AS campaign_timezone,
              cl.enrolled_at
       FROM scheduled_emails s
       JOIN email_campaigns c ON c.id = s.campaign_id
       JOIN email_campaign_steps cs ON cs.id = s.campaign_step_id
       LEFT JOIN email_campaign_leads cl
         ON cl.campaign_id = s.campaign_id AND cl.lead_id = s.lead_id
       WHERE s.status = 'pending'
         AND s.campaign_id IS NOT NULL
         AND s.campaign_step_id IS NOT NULL`,
    )
    .all();

  if (!rows.length) return { updated: 0 };

  const upd = db.prepare(
    `UPDATE scheduled_emails SET scheduled_at = ? WHERE id = ? AND status = 'pending'`,
  );
  let updated = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const baseRaw = row.enrolled_at || row.launched_at || new Date().toISOString();
      const base = new Date(String(baseRaw).includes('T') ? baseRaw : `${baseRaw.replace(' ', 'T')}Z`);
      const when = resolveCampaignSendAt(
        Number.isNaN(base.getTime()) ? new Date() : base,
        Number(row.delay_days) || 0,
        row.campaign_timezone || DEFAULT_CAMPAIGN_TIMEZONE,
      );
      const sql = toScheduleSql(when);
      const r = upd.run(sql, row.id);
      if (r.changes) updated += 1;
    }
  });
  tx();
  return { updated };
}

/**
 * Launch: assign variants evenly, then schedule each step with that variant's email.
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

  const steps = hydrateStepsWithVariants(
    db
      .prepare(
        `SELECT * FROM email_campaign_steps WHERE campaign_id = ? ORDER BY step_order ASC`,
      )
      .all(campaignId),
  );
  if (!steps.length) {
    const err = new Error('Add at least one email step before launch');
    err.status = 400;
    throw err;
  }
  if (!(steps[0].variants || []).length) {
    const err = new Error('Add at least one variant (A/B/C/D) on Email 1');
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
  assignVariantKeys(campaignId);

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

  db.prepare(
    `UPDATE scheduled_emails
     SET status = 'cancelled', error = 'Re-launched'
     WHERE campaign_id = ? AND status IN ('pending', 'sending')`,
  ).run(campaignId);

  const leadIds = members.map((m) => m.lead_id);
  const { scheduled, batchId } = scheduleStepsForLeads(campaignId, leadIds, {
    userId,
    now,
  });

  return {
    ok: true,
    batchId,
    scheduled,
    leads: members.length,
    steps: steps.length,
    variants: (steps[0].variants || []).map((v) => v.variant_key),
  };
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
