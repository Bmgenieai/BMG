/**
 * In-CRM email campaigns (Brevo transactional delivery).
 */
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { canUpdateLead } from './permissions.js';
import { resolveSendAccount, DEFAULT_MIN_DELAY_SECONDS, getEmailAccount } from './emailAccounts.js';
import { getSuppressedEmailSet, reasonStopMessage } from './emailSuppression.js';
import {
  CAMPAIGN_SEND_END_HOUR,
  CAMPAIGN_SEND_START_HOUR,
  DEFAULT_CAMPAIGN_SEND_HOUR,
  DEFAULT_CAMPAIGN_SEND_MINUTE,
  DEFAULT_CAMPAIGN_TIMEZONE,
  normalizeCampaignSendHour,
  normalizeCampaignSendMinute,
  normalizeCampaignTimezone,
  normalizeSendWindow,
  resolveProspectTimezone,
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

/** Return ordered sender accounts configured on a campaign (falls back to single email_account_id). */
export function getCampaignAccounts(campaignId) {
  const rows = db
    .prepare(
      `SELECT a.id, a.label, a.email, a.name, a.is_active, a.daily_limit, a.min_delay_seconds
       FROM email_campaign_accounts ca
       JOIN email_accounts a ON a.id = ca.email_account_id
       WHERE ca.campaign_id = ?
       ORDER BY ca.sort_order ASC, a.label COLLATE NOCASE ASC`,
    )
    .all(campaignId);
  if (rows.length) return rows;

  const camp = db
    .prepare(`SELECT email_account_id FROM email_campaigns WHERE id = ?`)
    .get(campaignId);
  if (camp?.email_account_id) {
    const acc = getEmailAccount(camp.email_account_id);
    if (acc) return [acc];
  }
  return [];
}

function setCampaignAccounts(campaignId, accountIds = []) {
  const cleanIds = [...new Set((Array.isArray(accountIds) ? accountIds : []).filter(Boolean))];
  for (const aid of cleanIds) {
    resolveSendAccount(aid);
  }
  db.prepare(`DELETE FROM email_campaign_accounts WHERE campaign_id = ?`).run(campaignId);
  const ins = db.prepare(
    `INSERT OR IGNORE INTO email_campaign_accounts (campaign_id, email_account_id, sort_order)
     VALUES (?, ?, ?)`,
  );
  cleanIds.forEach((aid, idx) => ins.run(campaignId, aid, idx));
  return cleanIds;
}

/**
 * Rotate campaign sender inboxes evenly across newly enrolled leads without reassigning
 * leads that already have a sticky inbox (keeps all follow-ups on each lead's original inbox).
 */
export function assignInboxAccounts(campaignId) {
  const accounts = getCampaignAccounts(campaignId).filter((a) => a.is_active !== 0);
  if (!accounts.length) return;
  const accountIds = accounts.map((a) => a.id);

  const counts = Object.fromEntries(accountIds.map((id) => [id, 0]));
  const existing = db
    .prepare(
      `SELECT email_account_id, COUNT(*) AS c
       FROM email_campaign_leads
       WHERE campaign_id = ? AND email_account_id IS NOT NULL AND TRIM(email_account_id) != ''
       GROUP BY email_account_id`,
    )
    .all(campaignId);
  for (const row of existing) {
    if (counts[row.email_account_id] != null) counts[row.email_account_id] = row.c;
  }

  const unassigned = db
    .prepare(
      `SELECT id FROM email_campaign_leads
       WHERE campaign_id = ? AND (email_account_id IS NULL OR TRIM(email_account_id) = '')
       ORDER BY enrolled_at ASC, id ASC`,
    )
    .all(campaignId);
  if (!unassigned.length) return;

  const upd = db.prepare(
    `UPDATE email_campaign_leads SET email_account_id = ? WHERE id = ?`,
  );
  const tx = db.transaction(() => {
    for (const row of unassigned) {
      let pick = accountIds[0];
      let min = counts[pick];
      for (const aid of accountIds) {
        if (counts[aid] < min) {
          min = counts[aid];
          pick = aid;
        }
      }
      upd.run(pick, row.id);
      counts[pick] += 1;
    }
  });
  tx();
}

/** Engagement stats for one campaign (any From account). */
export function getCampaignStats(campaignId) {
  const sent = db
    .prepare(`SELECT COUNT(*) AS c FROM email_messages WHERE campaign_id = ?`)
    .get(campaignId).c;

  // Exclude bounced emails from Delivered
  const delivered = db
    .prepare(
      `SELECT COUNT(*) AS c FROM email_messages m
       WHERE m.campaign_id = ?
         AND m.status != 'bounced'
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

  const clicked = db
    .prepare(
      `SELECT COUNT(*) AS c FROM email_messages
       WHERE campaign_id = ? AND COALESCE(click_count, 0) > 0`,
    )
    .get(campaignId).c;

  const bounced = db
    .prepare(
      `SELECT COUNT(*) AS c FROM email_messages
       WHERE campaign_id = ? AND status = 'bounced'`,
    )
    .get(campaignId).c;

  const deferred = db
    .prepare(
      `SELECT COUNT(*) AS c FROM email_messages
       WHERE campaign_id = ? AND status != 'bounced'
         AND (status = 'deferred' OR COALESCE(deferred_count, 0) > 0)`,
    )
    .get(campaignId).c;

  // Count each prospect's reply ONCE per campaign (excluding OOO auto-replies)
  const replies = db
    .prepare(
      `SELECT COUNT(DISTINCT COALESCE(r.lead_id, r.id)) AS c
       FROM email_replies r
       WHERE COALESCE(r.is_auto_reply, 0) = 0
         AND (
           EXISTS (
             SELECT 1 FROM email_messages m
             WHERE m.campaign_id = ? AND m.id = r.email_message_id
           )
           OR (
             r.email_message_id IS NULL
             AND r.lead_id IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM email_messages m
               WHERE m.campaign_id = ? AND m.lead_id = r.lead_id
                 AND datetime(REPLACE(REPLACE(r.received_at, 'T', ' '), 'Z', '')) >= datetime(REPLACE(REPLACE(m.sent_at, 'T', ' '), 'Z', ''))
             )
           )
         )`,
    )
    .get(campaignId, campaignId).c;

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
            WHERE m.campaign_step_id = cs.id
              AND m.status != 'bounced'
              AND (
                m.status IN ('delivered', 'opened', 'replied')
                OR EXISTS (SELECT 1 FROM email_events e WHERE e.email_message_id = m.id AND e.event IN ('delivered', 'request'))
              )) AS delivered,
         (SELECT COUNT(*) FROM email_messages m
            WHERE m.campaign_step_id = cs.id AND COALESCE(m.open_count, 0) > 0) AS opened,
         (SELECT COUNT(*) FROM email_messages m
            WHERE m.campaign_step_id = cs.id AND COALESCE(m.click_count, 0) > 0) AS clicked,
         (SELECT COUNT(*) FROM email_messages m
            WHERE m.campaign_step_id = cs.id AND m.status = 'bounced') AS bounced,
         (SELECT COUNT(*) FROM email_messages m
            WHERE m.campaign_step_id = cs.id AND m.status != 'bounced'
              AND (m.status = 'deferred' OR COALESCE(m.deferred_count, 0) > 0)) AS deferred,
         (SELECT COUNT(DISTINCT COALESCE(r.lead_id, r.id)) FROM email_replies r
            WHERE COALESCE(r.is_auto_reply, 0) = 0
              AND (
                EXISTS (
                  SELECT 1 FROM email_messages m
                  WHERE m.campaign_step_id = cs.id AND m.id = r.email_message_id
                )
                OR (
                  r.email_message_id IS NULL
                  AND r.lead_id IS NOT NULL
                  AND cs.id = (
                    SELECT m2.campaign_step_id FROM email_messages m2
                    WHERE m2.campaign_id = cs.campaign_id AND m2.lead_id = r.lead_id
                      AND datetime(REPLACE(REPLACE(m2.sent_at, 'T', ' '), 'Z', '')) <= datetime(REPLACE(REPLACE(r.received_at, 'T', ' '), 'Z', ''))
                    ORDER BY m2.sent_at DESC LIMIT 1
                  )
                )
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
      clickRate: row.sent ? Math.round((row.clicked / row.sent) * 1000) / 10 : 0,
      replyRate: row.sent ? Math.round((row.replies / row.sent) * 1000) / 10 : 0,
    }));

  const byVariant = db
    .prepare(
      `SELECT
         COALESCE(m.variant_key, cl.variant_key, 'A') AS variant_key,
         COUNT(*) AS sent,
         SUM(CASE WHEN m.status != 'bounced' AND (m.status IN ('delivered','opened','replied') OR EXISTS (SELECT 1 FROM email_events e WHERE e.email_message_id = m.id AND e.event IN ('delivered','request'))) THEN 1 ELSE 0 END) AS delivered,
         SUM(CASE WHEN COALESCE(m.open_count, 0) > 0 THEN 1 ELSE 0 END) AS opened,
         SUM(CASE WHEN COALESCE(m.click_count, 0) > 0 THEN 1 ELSE 0 END) AS clicked,
         SUM(CASE WHEN m.status = 'bounced' THEN 1 ELSE 0 END) AS bounced,
         (SELECT COUNT(DISTINCT COALESCE(r.lead_id, r.id)) FROM email_replies r
            WHERE COALESCE(r.is_auto_reply, 0) = 0
              AND EXISTS (
                SELECT 1 FROM email_messages m2
                LEFT JOIN email_campaign_leads cl2
                  ON cl2.campaign_id = m2.campaign_id AND cl2.lead_id = m2.lead_id
                WHERE m2.campaign_id = ?
                  AND (m2.id = r.email_message_id OR (r.email_message_id IS NULL AND m2.lead_id = r.lead_id))
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
      clickRate: row.sent ? Math.round((row.clicked / row.sent) * 1000) / 10 : 0,
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
    clicked,
    replies,
    bounced,
    deferred,
    openRate: sent ? Math.round((opened / sent) * 1000) / 10 : 0,
    clickRate: sent ? Math.round((clicked / sent) * 1000) / 10 : 0,
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
                 WHERE m.campaign_id = c.id
                   AND m.status != 'bounced'
                   AND (
                     m.status IN ('delivered','opened','replied')
                     OR EXISTS (SELECT 1 FROM email_events e WHERE e.email_message_id = m.id AND e.event IN ('delivered','request'))
                   )) AS delivered_count,
              (SELECT COUNT(*) FROM email_messages m
                 WHERE m.campaign_id = c.id AND COALESCE(m.open_count, 0) > 0) AS opened_count,
              (SELECT COUNT(*) FROM email_messages m
                 WHERE m.campaign_id = c.id AND COALESCE(m.click_count, 0) > 0) AS clicked_count,
              (SELECT COUNT(*) FROM email_messages m
                 WHERE m.campaign_id = c.id AND m.status = 'bounced') AS bounced_count,
              (SELECT COUNT(*) FROM email_messages m
                 WHERE m.campaign_id = c.id AND m.status != 'bounced'
                   AND (m.status = 'deferred' OR COALESCE(m.deferred_count, 0) > 0)) AS deferred_count,
              (SELECT COUNT(DISTINCT COALESCE(r.lead_id, r.id)) FROM email_replies r
                 WHERE COALESCE(r.is_auto_reply, 0) = 0
                   AND (
                     EXISTS (SELECT 1 FROM email_messages m WHERE m.campaign_id = c.id AND m.id = r.email_message_id)
                     OR (
                       r.email_message_id IS NULL AND r.lead_id IS NOT NULL
                       AND EXISTS (
                         SELECT 1 FROM email_messages m
                         WHERE m.campaign_id = c.id AND m.lead_id = r.lead_id
                           AND datetime(REPLACE(REPLACE(r.received_at, 'T', ' '), 'Z', '')) >= datetime(REPLACE(REPLACE(m.sent_at, 'T', ' '), 'Z', ''))
                       )
                     )
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
              (SELECT COUNT(*) FROM email_messages m
                 JOIN email_campaign_steps cs ON cs.id = m.campaign_step_id
                 WHERE m.campaign_id = c.id AND cs.step_order = 5) AS sent_step_5,
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

  const stepCountsRows = db
    .prepare(
      `SELECT cs.campaign_id, cs.step_order,
              (SELECT COUNT(*) FROM email_messages m WHERE m.campaign_step_id = cs.id) AS sent
       FROM email_campaign_steps cs
       ORDER BY cs.step_order ASC`,
    )
    .all();
  const stepMap = new Map();
  for (const sr of stepCountsRows) {
    if (!stepMap.has(sr.campaign_id)) stepMap.set(sr.campaign_id, []);
    stepMap.get(sr.campaign_id).push({ step_order: sr.step_order, sent: sr.sent });
  }

  return rows.map((r) => ({
    ...r,
    accounts: getCampaignAccounts(r.id),
    step_counts: stepMap.get(r.id) || [],
    delivery_rate: r.sent_count ? Math.round((r.delivered_count / r.sent_count) * 1000) / 10 : 0,
    open_rate: r.sent_count ? Math.round((r.opened_count / r.sent_count) * 1000) / 10 : 0,
    click_rate: r.sent_count ? Math.round((r.clicked_count / r.sent_count) * 1000) / 10 : 0,
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
  } else if (/^step_?\d+$/.test(metric) || /^email_?\d+$/.test(metric)) {
    const stepOrder = Number(String(metric).replace(/\D/g, '')) || 1;
    title = `${campaign.name} · Email ${stepOrder}`;
    items = db
      .prepare(
        `SELECT m.id, m.subject, m.to_email, m.sent_at AS date, m.status,
                m.open_count, m.click_count, m.reply_count, m.variant_key,
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
  } else if (metric === 'delivered') {
    title = `${campaign.name} · Delivered`;
    items = db
      .prepare(
        `SELECT m.id, m.subject, m.to_email, m.sent_at AS date, m.status,
                m.open_count, m.click_count, m.reply_count, m.variant_key,
                l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                l.status AS lead_status, cs.step_order
         FROM email_messages m
         LEFT JOIN email_campaign_steps cs ON cs.id = m.campaign_step_id
         LEFT JOIN leads l ON l.id = m.lead_id
         WHERE m.campaign_id = ?
           AND m.status != 'bounced'
           AND (
             m.status IN ('delivered', 'opened', 'replied')
             OR EXISTS (SELECT 1 FROM email_events e WHERE e.email_message_id = m.id AND e.event IN ('delivered', 'request'))
           )
         ORDER BY m.sent_at DESC
         LIMIT ?`,
      )
      .all(campaignId, limit)
      .map((row) => ({
        ...row,
        lead_name: displayLeadName(row.lead_name, row.lead_email, row.lead_company),
      }));
  } else if (metric === 'clicked' || metric === 'clicks') {
    title = `${campaign.name} · Link Clicks`;
    items = db
      .prepare(
        `SELECT m.id, m.subject, m.to_email, COALESCE(m.last_clicked_at, m.sent_at) AS date, m.status,
                m.open_count, m.click_count, m.reply_count, m.variant_key,
                l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                l.status AS lead_status, cs.step_order
         FROM email_messages m
         LEFT JOIN email_campaign_steps cs ON cs.id = m.campaign_step_id
         LEFT JOIN leads l ON l.id = m.lead_id
         WHERE m.campaign_id = ? AND COALESCE(m.click_count, 0) > 0
         ORDER BY COALESCE(m.last_clicked_at, m.sent_at) DESC
         LIMIT ?`,
      )
      .all(campaignId, limit)
      .map((row) => ({
        ...row,
        lead_name: displayLeadName(row.lead_name, row.lead_email, row.lead_company),
      }));
  } else if (metric === 'deferred' || metric === 'delayed') {
    title = `${campaign.name} · Temporary Delivery Delays`;
    items = db
      .prepare(
        `SELECT m.id, m.subject, m.to_email, COALESCE(m.last_deferred_at, m.sent_at) AS date, m.status,
                m.deferred_count, m.open_count, m.click_count, m.reply_count, m.variant_key,
                l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                l.status AS lead_status, cs.step_order
         FROM email_messages m
         LEFT JOIN email_campaign_steps cs ON cs.id = m.campaign_step_id
         LEFT JOIN leads l ON l.id = m.lead_id
         WHERE m.campaign_id = ? AND m.status != 'bounced'
           AND (m.status = 'deferred' OR COALESCE(m.deferred_count, 0) > 0)
         ORDER BY COALESCE(m.last_deferred_at, m.sent_at) DESC
         LIMIT ?`,
      )
      .all(campaignId, limit)
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
    const rawReplies = db
      .prepare(
        `SELECT r.id, r.subject, r.from_email AS to_email, r.received_at AS date, 'replied' AS status,
                r.from_name, m.variant_key, cs.step_order,
                l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                l.status AS lead_status
         FROM email_replies r
         LEFT JOIN email_messages m ON m.id = r.email_message_id
         LEFT JOIN email_campaign_steps cs ON cs.id = m.campaign_step_id
         LEFT JOIN leads l ON l.id = r.lead_id
         WHERE COALESCE(r.is_auto_reply, 0) = 0
           AND (
             EXISTS (
               SELECT 1 FROM email_messages m2
               WHERE m2.campaign_id = ? AND m2.id = r.email_message_id
             )
             OR (
               r.email_message_id IS NULL
               AND r.lead_id IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM email_messages m2
                 WHERE m2.campaign_id = ? AND m2.lead_id = r.lead_id
                   AND datetime(REPLACE(REPLACE(r.received_at, 'T', ' '), 'Z', '')) >= datetime(REPLACE(REPLACE(m2.sent_at, 'T', ' '), 'Z', ''))
               )
             )
           )
         ORDER BY r.received_at DESC
         LIMIT ?`,
      )
      .all(campaignId, campaignId, limit);

    // Count each prospect's reply once (keep latest reply per lead)
    const seen = new Set();
    items = [];
    for (const row of rawReplies) {
      const key = row.lead_id || row.id;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        ...row,
        lead_name: displayLeadName(row.lead_name, row.lead_email, row.lead_company),
      });
    }
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

  const scheduledSends = db
    .prepare(
      `SELECT s.id, s.lead_id, s.campaign_step_id, s.status, s.scheduled_at, s.sent_at, s.error,
              cs.step_order
       FROM scheduled_emails s
       LEFT JOIN email_campaign_steps cs ON cs.id = s.campaign_step_id
       WHERE s.campaign_id = ?
       ORDER BY s.scheduled_at ASC`,
    )
    .all(id);

  const repliedLeadIds = new Set(
    db
      .prepare(
        `SELECT DISTINCT r.lead_id AS lead_id
         FROM email_replies r
         WHERE r.lead_id IS NOT NULL
           AND COALESCE(r.is_auto_reply, 0) = 0
           AND (
             EXISTS (
               SELECT 1 FROM email_messages m
               WHERE m.campaign_id = ? AND m.id = r.email_message_id
             )
             OR (
               r.email_message_id IS NULL
               AND EXISTS (
                 SELECT 1 FROM email_messages m
                 WHERE m.campaign_id = ? AND m.lead_id = r.lead_id
                   AND datetime(REPLACE(REPLACE(r.received_at, 'T', ' '), 'Z', '')) >= datetime(REPLACE(REPLACE(m.sent_at, 'T', ' '), 'Z', ''))
               )
             )
           )`,
      )
      .all(id, id)
      .map((r) => r.lead_id)
      .filter(Boolean),
  );

  const accounts = getCampaignAccounts(id);

  const leads = db
    .prepare(
      `SELECT cl.*, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
              l.state AS lead_state, l.country AS lead_country,
              ea.email AS assigned_account_email, ea.label AS assigned_account_label
       FROM email_campaign_leads cl
       JOIN leads l ON l.id = cl.lead_id
       LEFT JOIN email_accounts ea ON ea.id = cl.email_account_id
       WHERE cl.campaign_id = ?
       ORDER BY cl.enrolled_at DESC`,
    )
    .all(id)
    .map((row) => {
      const s =
        scheduledSends.find(
          (item) =>
            item.lead_id === row.lead_id &&
            (item.status === 'pending' || item.status === 'sending' || item.status === 'failed'),
        ) || scheduledSends.filter((item) => item.lead_id === row.lead_id).slice(-1)[0];
      return {
        ...row,
        lead_name: displayLeadName(row.lead_name, row.lead_email, row.lead_company),
        prospect_timezone:
          campaign.use_prospect_timezone !== 0
            ? resolveProspectTimezone(
                { state: row.lead_state, country: row.lead_country },
                campaign.timezone,
              )
            : campaign.timezone,
        scheduled_at: s?.scheduled_at || null,
        scheduled_status: s?.status || null,
        scheduled_error: s?.error || null,
        scheduled_step: s?.step_order || 1,
        replied: repliedLeadIds.has(row.lead_id),
      };
    });

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

  // Per-step queue: pending / sent / failed / next scheduled date (campaign follow-ups live here)
  const sequenceSummary = steps.map((step, idx) => {
    const stepSends = scheduledSends.filter((s) => s.campaign_step_id === step.id);
    const pending = stepSends.filter((s) => s.status === 'pending' || s.status === 'sending');
    const sent = stepSends.filter((s) => s.status === 'sent').length;
    const failedRows = stepSends.filter((s) => s.status === 'failed');
    const failed = failedRows.length;
    const latestFailed = failedRows[failedRows.length - 1] || null;
    const next = pending
      .slice()
      .sort((a, b) => String(a.scheduled_at || '').localeCompare(String(b.scheduled_at || '')))[0];
    const stepStat = (stats.byStep || []).find((x) => x.step_id === step.id);
    return {
      stepId: step.id,
      stepOrder: step.step_order || idx + 1,
      label: idx === 0 ? 'Initial email' : `Follow-up ${idx}`,
      delayDays: Number(step.delay_days) || 0,
      subject: step.subject || step.variants?.[0]?.subject || null,
      pending: pending.length,
      sent: stepStat?.sent ?? sent,
      delivered: stepStat?.delivered ?? 0,
      opened: stepStat?.opened ?? 0,
      clicked: stepStat?.clicked ?? 0,
      bounced: stepStat?.bounced ?? 0,
      deferred: stepStat?.deferred ?? 0,
      failed,
      failedError: latestFailed?.error || null,
      replies: stepStat?.replies ?? 0,
      openRate: stepStat?.openRate ?? 0,
      clickRate: stepStat?.clickRate ?? 0,
      replyRate: stepStat?.replyRate ?? 0,
      nextScheduledAt: next?.scheduled_at || null,
    };
  });

  return {
    ...campaign,
    accounts,
    accountIds: accounts.map((a) => a.id),
    steps,
    leads,
    counts: { ...counts, replied: repliedLeadIds.size },
    stats,
    variantKeys,
    scheduledSends,
    sequenceSummary,
  };
}

export function createCampaign(body, { userId }) {
  const name = String(body.name || '').trim();
  if (!name) {
    const err = new Error('Campaign name required');
    err.status = 400;
    throw err;
  }

  const rawAccountIds = Array.isArray(body.emailAccountIds || body.accountIds)
    ? (body.emailAccountIds || body.accountIds).filter(Boolean)
    : [];
  let accountId = rawAccountIds[0] || body.emailAccountId || body.email_account_id || null;
  if (accountId) {
    resolveSendAccount(accountId);
  } else {
    accountId = resolveSendAccount(null).accountId;
  }
  const finalAccountIds = rawAccountIds.length ? rawAccountIds : accountId ? [accountId] : [];

  const timezone = normalizeCampaignTimezone(
    body.timezone || body.timeZone || DEFAULT_CAMPAIGN_TIMEZONE,
  );
  const { startHour, endHour } = normalizeSendWindow(
    body.sendWindowStart ?? body.send_window_start ?? CAMPAIGN_SEND_START_HOUR,
    body.sendWindowEnd ?? body.send_window_end ?? CAMPAIGN_SEND_END_HOUR,
  );
  const sendHour = normalizeCampaignSendHour(
    body.sendHour ?? body.send_hour ?? DEFAULT_CAMPAIGN_SEND_HOUR,
    startHour,
    endHour - 1,
  );
  const sendMinute = normalizeCampaignSendMinute(
    body.sendMinute ?? body.send_minute ?? DEFAULT_CAMPAIGN_SEND_MINUTE,
  );
  const useProspectTz =
    body.useProspectTimezone === false || body.use_prospect_timezone === 0 ? 0 : 1;
  const threadFollowups =
    body.threadFollowups === false || body.thread_followups === 0 ? 0 : 1;

  const id = uuid();
  db.prepare(
    `INSERT INTO email_campaigns (
       id, name, status, email_account_id, timezone, send_hour, send_minute,
       send_window_start, send_window_end, use_prospect_timezone, thread_followups, created_by
     ) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    accountId,
    timezone,
    sendHour,
    sendMinute,
    startHour,
    endHour,
    useProspectTz,
    threadFollowups,
    userId,
  );

  if (finalAccountIds.length) {
    setCampaignAccounts(id, finalAccountIds);
  }

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
  const hasMultiAccounts =
    Array.isArray(body.emailAccountIds) || Array.isArray(body.accountIds);
  if (hasMultiAccounts) {
    const list = (body.emailAccountIds || body.accountIds).filter(Boolean);
    if (list.length) {
      setCampaignAccounts(id, list);
      accountId = list[0];
    }
  } else if (body.emailAccountId !== undefined || body.email_account_id !== undefined) {
    accountId = body.emailAccountId ?? body.email_account_id ?? null;
    if (accountId) {
      resolveSendAccount(accountId);
      setCampaignAccounts(id, [accountId]);
    }
  }

  let timezone = normalizeCampaignTimezone(row.timezone || DEFAULT_CAMPAIGN_TIMEZONE);
  if (body.timezone !== undefined || body.timeZone !== undefined) {
    timezone = normalizeCampaignTimezone(body.timezone ?? body.timeZone);
  }

  const { startHour, endHour } = normalizeSendWindow(
    body.sendWindowStart ?? body.send_window_start ?? row.send_window_start ?? CAMPAIGN_SEND_START_HOUR,
    body.sendWindowEnd ?? body.send_window_end ?? row.send_window_end ?? CAMPAIGN_SEND_END_HOUR,
  );

  let sendHour = normalizeCampaignSendHour(
    body.sendHour ?? body.send_hour ?? row.send_hour ?? DEFAULT_CAMPAIGN_SEND_HOUR,
    startHour,
    endHour - 1,
  );

  let sendMinute = normalizeCampaignSendMinute(row.send_minute ?? DEFAULT_CAMPAIGN_SEND_MINUTE);
  if (body.sendMinute !== undefined || body.send_minute !== undefined) {
    sendMinute = normalizeCampaignSendMinute(body.sendMinute ?? body.send_minute);
  }

  const useProspectTz =
    body.useProspectTimezone !== undefined || body.use_prospect_timezone !== undefined
      ? body.useProspectTimezone === false || body.use_prospect_timezone === 0
        ? 0
        : 1
      : row.use_prospect_timezone ?? 1;

  const threadFollowups =
    body.threadFollowups !== undefined || body.thread_followups !== undefined
      ? body.threadFollowups === false || body.thread_followups === 0
        ? 0
        : 1
      : row.thread_followups ?? 1;

  db.prepare(
    `UPDATE email_campaigns
     SET name = ?, email_account_id = ?, timezone = ?, send_hour = ?, send_minute = ?,
         send_window_start = ?, send_window_end = ?, use_prospect_timezone = ?, thread_followups = ?,
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    name,
    accountId,
    timezone,
    sendHour,
    sendMinute,
    startHour,
    endHour,
    useProspectTz,
    threadFollowups,
    id,
  );

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

/**
 * Non-destructive step & variant upsert:
 * Preserves existing step IDs (matched by id or step_order) and variant IDs so editing
 * a paused campaign NEVER orphans historical stats or causes Email 1 to be re-sent.
 */
function replaceSteps(campaignId, steps) {
  const existingSteps = db
    .prepare(`SELECT * FROM email_campaign_steps WHERE campaign_id = ? ORDER BY step_order ASC`)
    .all(campaignId);
  const existingById = new Map(existingSteps.map((s) => [s.id, s]));
  const existingByOrder = new Map(existingSteps.map((s) => [Number(s.step_order), s]));

  const parsed = steps.map((s, i) => {
    const order = Number(s.step_order || s.stepOrder || i + 1) || i + 1;
    const delay = Math.max(0, Number(s.delay_days ?? s.delayDays ?? 0) || 0);
    const variants = normalizeStepVariants(s, order);
    const matched =
      (s.id && existingById.get(s.id)) || existingByOrder.get(order) || null;
    return {
      existingId: matched?.id || null,
      order: i + 1,
      delay,
      variants,
    };
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

  const weight = Math.round(1000 / parsed[0].variants.length) / 10;

  const insertStep = db.prepare(
    `INSERT INTO email_campaign_steps (
       id, campaign_id, step_order, delay_days, subject, html_content, text_content, template_id, content_category
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateStep = db.prepare(
    `UPDATE email_campaign_steps
     SET step_order = ?, delay_days = ?, subject = ?, html_content = ?, text_content = ?,
         template_id = ?, content_category = ?
     WHERE id = ?`,
  );
  const insertVariant = db.prepare(
    `INSERT INTO email_campaign_step_variants (
       id, campaign_step_id, variant_key, label, content_category,
       subject, html_content, text_content, template_id, weight_pct, sort_order
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateVariant = db.prepare(
    `UPDATE email_campaign_step_variants
     SET label = ?, content_category = ?, subject = ?, html_content = ?, text_content = ?,
         template_id = ?, weight_pct = ?, sort_order = ?
     WHERE id = ?`,
  );

  const keptStepIds = new Set();

  const tx = db.transaction(() => {
    for (const step of parsed) {
      const first = step.variants[0];
      let stepId = step.existingId;
      if (stepId) {
        updateStep.run(
          step.order,
          step.delay,
          first.subject,
          first.html,
          first.text,
          first.templateId,
          first.category,
          stepId,
        );
      } else {
        stepId = uuid();
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
      }
      keptStepIds.add(stepId);

      // Upsert variants in place by variant_key
      const existingVars = db
        .prepare(`SELECT * FROM email_campaign_step_variants WHERE campaign_step_id = ?`)
        .all(stepId);
      const varByKey = new Map(existingVars.map((v) => [v.variant_key, v]));
      const keptVarKeys = new Set();

      for (const v of step.variants) {
        keptVarKeys.add(v.key);
        const oldVar = varByKey.get(v.key);
        if (oldVar) {
          updateVariant.run(
            v.label,
            v.category,
            v.subject,
            v.html,
            v.text,
            v.templateId,
            weight,
            v.sortOrder,
            oldVar.id,
          );
        } else {
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

      for (const oldVar of existingVars) {
        if (!keptVarKeys.has(oldVar.variant_key)) {
          const hasSent = db
            .prepare(`SELECT 1 FROM email_messages WHERE campaign_variant_id = ? LIMIT 1`)
            .get(oldVar.id);
          if (!hasSent) {
            db.prepare(`DELETE FROM email_campaign_step_variants WHERE id = ?`).run(oldVar.id);
          }
        }
      }
    }

    // Only delete removed steps that have zero historical sent messages
    for (const oldStep of existingSteps) {
      if (!keptStepIds.has(oldStep.id)) {
        const hasSent = db
          .prepare(`SELECT 1 FROM email_messages WHERE campaign_step_id = ? LIMIT 1`)
          .get(oldStep.id);
        if (!hasSent) {
          db.prepare(`DELETE FROM email_campaign_steps WHERE id = ?`).run(oldStep.id);
        }
      }
    }
  });
  tx();
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

/** Parse pasted/typed recipient emails (comma, semicolon, whitespace, or newline separated). */
export function parseEmailList(raw) {
  const chunks = [];
  if (Array.isArray(raw)) {
    for (const item of raw) chunks.push(...parseEmailList(item));
    return [...new Set(chunks)];
  }
  const text = String(raw || '').trim();
  if (!text) return [];
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => EMAIL_RE.test(s)),
    ),
  ];
}

function displayNameFromEmail(email) {
  const local = String(email || '').split('@')[0] || '';
  const human = local
    .replace(/[._+-]+/g, ' ')
    .replace(/\d+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
  return human || email;
}

/**
 * Resolve pasted emails to lead ids — reuse existing leads by email, otherwise create
 * lightweight manual leads (for quick campaign testing without CSV).
 */
export function ensureLeadsFromEmails(emails, { userId } = {}) {
  const list = parseEmailList(emails);
  if (!list.length) return { leadIds: [], created: 0, reused: 0 };

  const findByEmail = db.prepare(
    `SELECT id FROM leads
     WHERE LOWER(TRIM(COALESCE(email, ''))) = ?
       AND (archived_at IS NULL OR archived_at = '')
     ORDER BY created_at DESC
     LIMIT 1`,
  );
  const insertLead = db.prepare(
    `INSERT INTO leads (
       id, name, email, company, industry, contact_format, source, status,
       notes, created_by, assigned_to, assigned_at, assigned_by, date_added, times_added
     ) VALUES (?, ?, ?, NULL, 'Campaign test', 'company', 'manual', 'uncontacted',
       ?, ?, ?, datetime('now'), ?, datetime('now'), 1)`,
  );

  const leadIds = [];
  let created = 0;
  let reused = 0;
  const tx = db.transaction(() => {
    for (const email of list) {
      const existing = findByEmail.get(email);
      if (existing?.id) {
        leadIds.push(existing.id);
        reused += 1;
        continue;
      }
      const id = uuid();
      insertLead.run(
        id,
        displayNameFromEmail(email),
        email,
        'Added via campaign manual email entry (test/send)',
        userId || null,
        userId || null,
        userId || null,
      );
      leadIds.push(id);
      created += 1;
    }
  });
  tx();

  return { leadIds, created, reused, emails: list };
}

export function addLeads(campaignId, leadIds, { user, skipPerm = false, emails } = {}) {
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

  let fromEmails = { leadIds: [], created: 0, reused: 0 };
  if (emails != null && String(emails).trim() !== '' && !(Array.isArray(emails) && !emails.length)) {
    fromEmails = ensureLeadsFromEmails(emails, { userId: user?.id });
  }

  const ids = [...new Set([...(leadIds || []).filter(Boolean), ...fromEmails.leadIds])];
  if (!ids.length) {
    const err = new Error('leadIds[] or emails required');
    err.status = 400;
    throw err;
  }

  let leads = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const placeholders = chunk.map(() => '?').join(',');
    leads.push(
      ...db
        .prepare(
          `SELECT * FROM leads WHERE id IN (${placeholders}) AND email IS NOT NULL AND email != ''`,
        )
        .all(...chunk),
    );
  }

  if (!skipPerm && user) {
    leads = leads.filter((l) => canUpdateLead(user, l));
  }

  // Exclude globally suppressed emails (hard bounces, spam complaints, unsubscribes, manual)
  const suppressedSet = getSuppressedEmailSet(leads.map((l) => l.email));
  const beforeSupp = leads.length;
  leads = leads.filter((l) => !suppressedSet.has(String(l.email || '').trim().toLowerCase()));
  const skippedSuppressed = beforeSupp - leads.length;

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
  assignInboxAccounts(campaignId);

  // Active campaign: schedule remaining steps for newly added leads using their variant & inbox.
  let scheduled = 0;
  if (campaign.status === 'active' && addedLeadIds.length) {
    scheduled = scheduleStepsForLeads(campaignId, addedLeadIds, {
      userId: user?.id || campaign.created_by,
    }).scheduled;
  }

  return {
    added,
    total: leads.length,
    skippedSuppressed,
    scheduled,
    createdLeads: fromEmails.created || 0,
    reusedLeads: fromEmails.reused || 0,
  };
}

/**
 * Mark the next pending campaign wave as due now (does not force later follow-ups).
 * Returns number of rows bumped.
 */
export function bumpNextCampaignWaveDue(campaignId) {
  const nextStep = db
    .prepare(
      `SELECT cs.id AS step_id
       FROM scheduled_emails s
       JOIN email_campaign_steps cs ON cs.id = s.campaign_step_id
       WHERE s.campaign_id = ?
         AND s.status IN ('pending', 'failed')
         AND s.campaign_step_id IS NOT NULL
       ORDER BY cs.step_order ASC, s.scheduled_at ASC
       LIMIT 1`,
    )
    .get(campaignId);

  if (nextStep?.step_id) {
    return db
      .prepare(
        `UPDATE scheduled_emails
         SET scheduled_at = datetime('now', '-1 minute'), status = 'pending', error = NULL
         WHERE campaign_id = ?
           AND campaign_step_id = ?
           AND status IN ('pending', 'failed')`,
      )
      .run(campaignId, nextStep.step_id).changes;
  }

  // Fallback: no step linkage — bump all pending for this campaign
  return db
    .prepare(
      `UPDATE scheduled_emails
       SET scheduled_at = datetime('now', '-1 minute'), status = 'pending', error = NULL
       WHERE campaign_id = ? AND status IN ('pending', 'failed')`,
    )
    .run(campaignId).changes;
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
 * Schedule remaining unsent steps for given leads using each lead's assigned variant,
 * sticky sender inbox, prospect-local business hours, and per-inbox staggering.
 * Safely skips already-sent steps (by step_id OR step_order) so Email 1 is never re-sent.
 */
function scheduleStepsForLeads(
  campaignId,
  leadIds,
  { userId, batchId = null, now = new Date(), isResume = false } = {},
) {
  const campaign = db.prepare(`SELECT * FROM email_campaigns WHERE id = ?`).get(campaignId);
  if (!campaign) return { scheduled: 0, batchId: null, skippedExcluded: 0 };

  const steps = hydrateStepsWithVariants(
    db
      .prepare(
        `SELECT * FROM email_campaign_steps WHERE campaign_id = ? ORDER BY step_order ASC`,
      )
      .all(campaignId),
  );
  if (!steps.length || !leadIds?.length) return { scheduled: 0, batchId: null, skippedExcluded: 0 };

  assignInboxAccounts(campaignId);

  const placeholders = leadIds.map(() => '?').join(',');
  const members = db
    .prepare(
      `SELECT cl.*, l.email AS lead_email, l.state AS state, l.country AS country
       FROM email_campaign_leads cl
       JOIN leads l ON l.id = cl.lead_id
       WHERE cl.campaign_id = ?
         AND cl.lead_id IN (${placeholders})
         AND cl.status IN ('pending', 'active')
         AND l.email IS NOT NULL AND l.email != ''`,
    )
    .all(campaignId, ...leadIds);

  const suppressedSet = getSuppressedEmailSet(members.map((m) => m.lead_email));

  // Leads who already genuinely replied in this campaign
  const repliedSet = new Set(
    db
      .prepare(
        `SELECT DISTINCT r.lead_id FROM email_replies r
         WHERE r.lead_id IS NOT NULL
           AND COALESCE(r.is_auto_reply, 0) = 0
           AND (
             EXISTS (SELECT 1 FROM email_messages m WHERE m.campaign_id = ? AND m.id = r.email_message_id)
             OR (
               r.email_message_id IS NULL
               AND EXISTS (
                 SELECT 1 FROM email_messages m
                 WHERE m.campaign_id = ? AND m.lead_id = r.lead_id
                   AND datetime(REPLACE(REPLACE(r.received_at, 'T', ' '), 'Z', '')) >= datetime(REPLACE(REPLACE(m.sent_at, 'T', ' '), 'Z', ''))
               )
             )
           )`,
      )
      .all(campaignId, campaignId)
      .map((r) => r.lead_id),
  );

  // Leads who already hard-bounced in this campaign
  const bouncedSet = new Set(
    db
      .prepare(
        `SELECT DISTINCT lead_id FROM email_messages
         WHERE campaign_id = ? AND status = 'bounced' AND lead_id IS NOT NULL`,
      )
      .all(campaignId)
      .map((r) => r.lead_id),
  );

  const insert = db.prepare(
    `INSERT INTO scheduled_emails (
       id, batch_id, lead_id, user_id, subject, html_content, text_content,
       template_id, sync_to_brevo, scheduled_at, status,
       email_account_id, campaign_id, campaign_step_id, campaign_variant_id, variant_key
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'pending', ?, ?, ?, ?, ?)`,
  );

  const stopLeadStmt = db.prepare(
    `UPDATE email_campaign_leads
     SET status = 'stopped', stopped_reason = ?, completed_at = datetime('now')
     WHERE campaign_id = ? AND lead_id = ? AND status IN ('pending', 'active')`,
  );

  const accountCache = new Map();
  const getAccountMinDelay = (accId) => {
    const key = accId || 'default';
    if (!accountCache.has(key)) {
      const acc = accId ? getEmailAccount(accId) : null;
      accountCache.set(key, Math.max(0, Number(acc?.min_delay_seconds ?? DEFAULT_MIN_DELAY_SECONDS)));
    }
    return accountCache.get(key);
  };

  // Track per-inbox+step stagger index so sends space out cleanly
  const staggerCounters = new Map();

  const bid = batchId || uuid();
  let scheduled = 0;
  let skippedExcluded = 0;
  const base = campaign.launched_at ? new Date(campaign.launched_at) : now;
  const scheduleBase = Number.isNaN(base.getTime()) ? now : base;
  const { startHour, endHour } = normalizeSendWindow(
    campaign.send_window_start ?? CAMPAIGN_SEND_START_HOUR,
    campaign.send_window_end ?? CAMPAIGN_SEND_END_HOUR,
  );

  const tx = db.transaction(() => {
    for (const member of members) {
      const emailLower = String(member.lead_email || '').trim().toLowerCase();
      if (suppressedSet.has(emailLower)) {
        stopLeadStmt.run('Suppressed (bounce/spam/unsubscribe)', campaignId, member.lead_id);
        skippedExcluded += 1;
        continue;
      }
      if (repliedSet.has(member.lead_id)) {
        stopLeadStmt.run('Reply received — outreach stopped', campaignId, member.lead_id);
        skippedExcluded += 1;
        continue;
      }
      if (bouncedSet.has(member.lead_id)) {
        stopLeadStmt.run('Hard bounce — outreach stopped', campaignId, member.lead_id);
        skippedExcluded += 1;
        continue;
      }

      const vKey = normalizeVariantKey(member.variant_key || 'A', 0);
      const leadAccountId = member.email_account_id || campaign.email_account_id || null;
      const effectiveTz =
        campaign.use_prospect_timezone !== 0
          ? resolveProspectTimezone(member, campaign.timezone || DEFAULT_CAMPAIGN_TIMEZONE)
          : campaign.timezone || DEFAULT_CAMPAIGN_TIMEZONE;

      // Determine all already-sent steps for this lead in this campaign (by step_id AND step_order)
      const sentMsgs = db
        .prepare(
          `SELECT m.campaign_step_id, m.sent_at, cs.step_order, cs.delay_days
           FROM email_messages m
           LEFT JOIN email_campaign_steps cs ON cs.id = m.campaign_step_id
           WHERE m.campaign_id = ? AND m.lead_id = ?
           ORDER BY m.sent_at ASC`,
        )
        .all(campaignId, member.lead_id);

      const sentStepIds = new Set(sentMsgs.map((m) => m.campaign_step_id).filter(Boolean));
      const sentStepOrders = new Set(
        sentMsgs.map((m) => Number(m.step_order)).filter((n) => Number.isFinite(n) && n > 0),
      );
      const maxSentOrder = sentStepOrders.size ? Math.max(...sentStepOrders) : 0;
      const lastSentMsg = sentMsgs.length ? sentMsgs[sentMsgs.length - 1] : null;
      const lastSentDelayDays = Number(lastSentMsg?.delay_days || 0);

      let perLeadBase = scheduleBase;
      if (isResume) {
        if (lastSentMsg?.sent_at) {
          const lastAt = new Date(
            String(lastSentMsg.sent_at).includes('T')
              ? lastSentMsg.sent_at
              : `${String(lastSentMsg.sent_at).replace(' ', 'T')}Z`,
          );
          perLeadBase = !Number.isNaN(lastAt.getTime()) ? lastAt : now;
        } else {
          // Never received Step 1 yet → start from resume time (not an old launch date)
          perLeadBase = now;
        }
      } else if (member.enrolled_at) {
        const enrolled = new Date(
          String(member.enrolled_at).includes('T')
            ? member.enrolled_at
            : `${String(member.enrolled_at).replace(' ', 'T')}Z`,
        );
        if (!Number.isNaN(enrolled.getTime()) && enrolled > scheduleBase) {
          perLeadBase = enrolled;
        }
      }

      let scheduledAnyForLead = false;

      for (const step of steps) {
        const stepOrder = Number(step.step_order) || 1;
        // Never re-send an already sent step (nor any step <= highest already-sent step)
        if (
          sentStepIds.has(step.id) ||
          sentStepOrders.has(stepOrder) ||
          stepOrder <= maxSentOrder
        ) {
          continue;
        }

        // Also skip if already pending/sending/sent in scheduled_emails
        const exists = db
          .prepare(
            `SELECT 1 AS ok FROM scheduled_emails
             WHERE campaign_id = ? AND lead_id = ? AND campaign_step_id = ?
               AND status IN ('pending', 'sending', 'sent')
             LIMIT 1`,
          )
          .get(campaignId, member.lead_id, step.id);
        if (exists) continue;

        const variant =
          (step.variants || []).find((v) => v.variant_key === vKey) || step.variants?.[0];
        if (!variant) continue;

        const effectiveDelay =
          isResume && lastSentMsg
            ? Math.max(0, (Number(step.delay_days) || 0) - lastSentDelayDays)
            : Number(step.delay_days) || 0;

        const counterKey = `${leadAccountId || 'default'}:${stepOrder}`;
        const slotIdx = staggerCounters.get(counterKey) || 0;
        staggerCounters.set(counterKey, slotIdx + 1);
        const minDelaySec = getAccountMinDelay(leadAccountId);
        const staggerSeconds = slotIdx * Math.max(minDelaySec, 15);

        let when = resolveCampaignSendAt(
          perLeadBase,
          effectiveDelay,
          effectiveTz,
          campaign.send_hour ?? DEFAULT_CAMPAIGN_SEND_HOUR,
          campaign.send_minute ?? DEFAULT_CAMPAIGN_SEND_MINUTE,
          { startHour, endHour, staggerSeconds },
        );

        // On resume, never schedule overdue steps in the past — snap forward into business hours from `now`
        if (when < now) {
          when = resolveCampaignSendAt(
            now,
            0,
            effectiveTz,
            campaign.send_hour ?? DEFAULT_CAMPAIGN_SEND_HOUR,
            campaign.send_minute ?? DEFAULT_CAMPAIGN_SEND_MINUTE,
            { startHour, endHour, staggerSeconds },
          );
        }

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
          leadAccountId,
          campaignId,
          step.id,
          variant.id || null,
          vKey,
        );
        scheduled += 1;
        scheduledAnyForLead = true;
      }

      // If lead already finished all steps, mark completed
      if (!scheduledAnyForLead && maxSentOrder >= steps.length) {
        db.prepare(
          `UPDATE email_campaign_leads
           SET status = 'completed', completed_at = datetime('now')
           WHERE campaign_id = ? AND lead_id = ? AND status IN ('pending', 'active')`,
        ).run(campaignId, member.lead_id);
      }
    }
  });
  tx();

  return { scheduled, batchId: bid, skippedExcluded };
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
              c.send_hour AS campaign_send_hour,
              c.send_minute AS campaign_send_minute,
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
        row.campaign_send_hour ?? DEFAULT_CAMPAIGN_SEND_HOUR,
        row.campaign_send_minute ?? DEFAULT_CAMPAIGN_SEND_MINUTE,
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
 * Launch (draft) or safely Resume (paused):
 * - Preserves stopped leads (never re-enrolls replied/bounced/unsubscribed/stopped leads)
 * - Continues each eligible lead from their next unsent step without re-sending Email 1
 * - Rotates multi-inbox accounts for unassigned leads while keeping follow-ups sticky
 */
export function launchCampaign(campaignId, { userId }) {
  const campaign = db.prepare(`SELECT * FROM email_campaigns WHERE id = ?`).get(campaignId);
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }
  if (campaign.status !== 'draft' && campaign.status !== 'paused') {
    const err = new Error('Only draft or paused campaigns can be launched or resumed');
    err.status = 400;
    throw err;
  }

  const isResume = campaign.status === 'paused';

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

  // IMPORTANT: Never re-activate 'stopped' leads (replied, bounced, unsubscribed, stage-stopped)
  const members = db
    .prepare(
      `SELECT cl.*, l.email AS lead_email
       FROM email_campaign_leads cl
       JOIN leads l ON l.id = cl.lead_id
       WHERE cl.campaign_id = ? AND cl.status IN ('pending', 'active')
         AND l.email IS NOT NULL AND l.email != ''`,
    )
    .all(campaignId);
  if (!members.length) {
    const err = new Error(
      isResume
        ? 'No eligible remaining leads to resume (all leads completed or stopped)'
        : 'Add at least one lead with an email before launch',
    );
    err.status = 400;
    throw err;
  }

  const accounts = getCampaignAccounts(campaignId);
  if (accounts.length) {
    for (const acc of accounts) resolveSendAccount(acc.id);
  } else {
    resolveSendAccount(campaign.email_account_id);
  }

  const now = new Date();
  assignVariantKeys(campaignId);
  assignInboxAccounts(campaignId);

  db.prepare(
    `UPDATE email_campaigns
     SET status = 'active', launched_at = COALESCE(launched_at, ?), updated_at = datetime('now')
     WHERE id = ?`,
  ).run(sqlDate(now), campaignId);

  db.prepare(
    `UPDATE email_campaign_leads
     SET status = 'active'
     WHERE campaign_id = ? AND status = 'pending'`,
  ).run(campaignId);

  db.prepare(
    `UPDATE scheduled_emails
     SET status = 'cancelled', error = ?
     WHERE campaign_id = ? AND status IN ('pending', 'sending')`,
  ).run(isResume ? 'Resumed — rescheduled' : 'Re-launched', campaignId);

  const leadIds = members.map((m) => m.lead_id);
  const { scheduled, batchId, skippedExcluded } = scheduleStepsForLeads(campaignId, leadIds, {
    userId,
    now,
    isResume,
  });

  return {
    ok: true,
    resumed: isResume,
    batchId,
    scheduled,
    skippedExcluded,
    leads: members.length - skippedExcluded,
    steps: steps.length,
    variants: (steps[0].variants || []).map((v) => v.variant_key),
  };
}

export function resumeCampaign(campaignId, { userId }) {
  return launchCampaign(campaignId, { userId });
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

/**
 * Aggregate failed scheduled campaign emails grouped by campaign + step.
 */
export function listFailedCampaignSteps() {
  const rows = db
    .prepare(
      `SELECT
         s.campaign_id AS campaignId,
         c.name AS campaignName,
         c.status AS campaignStatus,
         c.timezone AS timezone,
         c.send_hour AS sendHour,
         c.send_minute AS sendMinute,
         s.campaign_step_id AS stepId,
         COALESCE(cs.step_order, 1) AS stepOrder,
         COALESCE(
           cs.subject,
           (SELECT v.subject FROM email_campaign_step_variants v
            WHERE v.campaign_step_id = cs.id
            ORDER BY v.sort_order ASC, v.variant_key ASC LIMIT 1)
         ) AS subject,
         COUNT(*) AS failedCount,
         MAX(COALESCE(s.sent_at, s.scheduled_at, s.created_at)) AS lastFailedAt,
         MAX(s.error) AS error
       FROM scheduled_emails s
       JOIN email_campaigns c ON c.id = s.campaign_id
       LEFT JOIN email_campaign_steps cs ON cs.id = s.campaign_step_id
       WHERE s.status = 'failed'
         AND s.campaign_id IS NOT NULL
       GROUP BY s.campaign_id, s.campaign_step_id
       ORDER BY lastFailedAt DESC, failedCount DESC`,
    )
    .all()
    .map((r) => ({
      ...r,
      stepLabel: Number(r.stepOrder) <= 1 ? 'Initial email' : `Follow-up ${Number(r.stepOrder) - 1}`,
    }));

  const nonCampaignFailed = db
    .prepare(
      `SELECT COUNT(*) AS c FROM scheduled_emails
       WHERE status = 'failed' AND campaign_id IS NULL`,
    )
    .get().c;

  const totalCampaignFailed = rows.reduce((sum, r) => sum + (Number(r.failedCount) || 0), 0);
  return {
    totalFailed: totalCampaignFailed + (Number(nonCampaignFailed) || 0),
    totalCampaignFailed,
    nonCampaignFailed: Number(nonCampaignFailed) || 0,
    groups: rows,
  };
}

/**
 * Re-queue failed emails for a specific campaign step, either immediately ('now')
 * or at a chosen future time ('schedule').
 */
export function retryFailedCampaignStep(
  campaignId,
  stepId,
  { mode = 'now', scheduledAt = null } = {},
) {
  const campaign = db.prepare(`SELECT * FROM email_campaigns WHERE id = ?`).get(campaignId);
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }
  if (campaign.status === 'cancelled') {
    const err = new Error('Cannot resend a cancelled campaign');
    err.status = 400;
    throw err;
  }

  const step = db
    .prepare(`SELECT * FROM email_campaign_steps WHERE id = ? AND campaign_id = ?`)
    .get(stepId, campaignId);
  if (!step) {
    const err = new Error('Campaign step not found');
    err.status = 404;
    throw err;
  }

  const failedCount = db
    .prepare(
      `SELECT COUNT(*) AS c FROM scheduled_emails
       WHERE campaign_id = ? AND campaign_step_id = ? AND status = 'failed'`,
    )
    .get(campaignId, stepId).c;
  if (!failedCount) {
    const err = new Error('No failed emails found for this step');
    err.status = 400;
    throw err;
  }

  let targetDate;
  if (mode === 'schedule') {
    if (scheduledAt) {
      const parsed = new Date(scheduledAt);
      if (Number.isNaN(parsed.getTime())) {
        const err = new Error('Invalid schedule date/time');
        err.status = 400;
        throw err;
      }
      targetDate = parsed;
    } else {
      targetDate = resolveCampaignSendAt(
        new Date(),
        1,
        campaign.timezone,
        campaign.send_hour,
        campaign.send_minute,
      );
    }
  } else {
    targetDate = new Date(Date.now() - 60_000);
  }

  const targetSql = toScheduleSql(targetDate);
  const stepOrder = Number(step.step_order) || 1;
  const laterSteps = db
    .prepare(
      `SELECT * FROM email_campaign_steps
       WHERE campaign_id = ? AND step_order > ?
       ORDER BY step_order ASC`,
    )
    .all(campaignId, stepOrder);

  const { queued, followUpsScheduled } = db.transaction(() => {
    const affectedLeadIds = db
      .prepare(
        `SELECT DISTINCT lead_id FROM scheduled_emails
         WHERE campaign_id = ? AND campaign_step_id = ? AND status = 'failed'`,
      )
      .all(campaignId, stepId)
      .map((r) => r.lead_id)
      .filter(Boolean);

    const res = db
      .prepare(
        `UPDATE scheduled_emails
         SET status = 'pending', error = NULL, scheduled_at = ?
         WHERE campaign_id = ? AND campaign_step_id = ? AND status = 'failed'`,
      )
      .run(targetSql, campaignId, stepId);

    let nextScheduledCount = 0;
    if (laterSteps.length > 0 && affectedLeadIds.length > 0) {
      const placeholders = affectedLeadIds.map(() => '?').join(',');
      let prevDelay = Number(step.delay_days) || 0;
      let prevDate = targetDate;

      for (const nextStep of laterSteps) {
        const nextDelay = Number(nextStep.delay_days) || 0;
        const gapDays = Math.max(1, nextDelay - prevDelay);
        const nextWhen = resolveCampaignSendAt(
          prevDate,
          gapDays,
          campaign.timezone,
          campaign.send_hour,
          campaign.send_minute,
        );
        const nextSql = toScheduleSql(nextWhen);

        const updNext = db
          .prepare(
            `UPDATE scheduled_emails
             SET status = 'pending', error = NULL, scheduled_at = ?
             WHERE campaign_id = ?
               AND campaign_step_id = ?
               AND status IN ('pending', 'failed')
               AND lead_id IN (${placeholders})`,
          )
          .run(nextSql, campaignId, nextStep.id, ...affectedLeadIds);

        nextScheduledCount += updNext.changes;
        prevDelay = nextDelay;
        prevDate = nextWhen;
      }
    }

    if (campaign.status === 'completed' || campaign.status === 'paused') {
      db.prepare(
        `UPDATE email_campaigns
         SET status = 'active', updated_at = datetime('now')
         WHERE id = ?`,
      ).run(campaignId);
    }

    db.prepare(
      `UPDATE email_campaign_leads
       SET status = 'active', completed_at = NULL
       WHERE campaign_id = ?
         AND status = 'completed'
         AND lead_id IN (
           SELECT DISTINCT lead_id FROM scheduled_emails
           WHERE campaign_id = ? AND campaign_step_id = ? AND status = 'pending'
         )`,
    ).run(campaignId, campaignId, stepId);

    return { queued: res.changes, followUpsScheduled: nextScheduledCount };
  })();

  const stepLabel = stepOrder <= 1 ? 'Initial email' : `Follow-up ${stepOrder - 1}`;

  return {
    ok: true,
    mode: mode === 'schedule' ? 'schedule' : 'now',
    campaignId,
    stepId,
    stepOrder,
    stepLabel,
    queued,
    followUpsScheduled,
    scheduledAt: targetDate.toISOString(),
  };
}
