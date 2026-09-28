/**
 * Persist Brevo outbound messages + inbound webhook events (open / click / reply).
 */
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';

const OPEN_EVENTS = new Set(['opened', 'unique_opened', 'uniqueOpened']);
const CLICK_EVENTS = new Set(['click', 'clicks']);
const REPLY_EVENTS = new Set(['reply', 'replied']);
const DELIVERED_EVENTS = new Set(['delivered', 'request']);
const BOUNCE_EVENTS = new Set([
  'hardBounce',
  'softBounce',
  'blocked',
  'invalid',
  'error',
  'deferred',
  'spam',
]);

function normalizeEvent(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, '');
}

function normalizeMessageId(raw) {
  if (!raw) return null;
  return String(raw).trim().replace(/^<|>$/g, '') || null;
}

function normalizeEmail(raw) {
  if (!raw) return null;
  return String(raw).trim().toLowerCase() || null;
}

/**
 * Record a successful Brevo send and bump lead.last_emailed_at.
 * @returns {{ messageId: string, brevoMessageId: string|null }}
 */
export function recordEmailSend({
  leadId,
  userId = null,
  subject,
  toEmail,
  templateId = null,
  brevoMessageId = null,
  source = 'transactional',
  summaryPrefix = 'Brevo cold email',
}) {
  const id = uuid();
  const now = new Date().toISOString();
  const mid = normalizeMessageId(brevoMessageId);

  db.prepare(
    `INSERT INTO email_messages (
       id, lead_id, user_id, brevo_message_id, subject, to_email, template_id, source, status, sent_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?)`,
  ).run(
    id,
    leadId,
    userId,
    mid,
    subject || null,
    normalizeEmail(toEmail),
    templateId || null,
    source,
    now,
  );

  db.prepare(
    `UPDATE leads
     SET last_emailed_at = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(now, leadId);

  db.prepare(
    `INSERT INTO lead_activities (id, lead_id, user_id, type, summary)
     VALUES (?, ?, ?, 'email_sent', ?)`,
  ).run(uuid(), leadId, userId, `${summaryPrefix}: ${subject || '(no subject)'}`);

  return { messageId: id, brevoMessageId: mid };
}

function findMessage({ brevoMessageId, email }) {
  const mid = normalizeMessageId(brevoMessageId);
  if (mid) {
    const byId = db
      .prepare(
        `SELECT * FROM email_messages
         WHERE brevo_message_id = ? OR brevo_message_id = ?
         ORDER BY sent_at DESC LIMIT 1`,
      )
      .get(mid, `<${mid}>`);
    if (byId) return byId;
  }

  const em = normalizeEmail(email);
  if (em) {
    return db
      .prepare(
        `SELECT * FROM email_messages
         WHERE lower(to_email) = ?
         ORDER BY sent_at DESC LIMIT 1`,
      )
      .get(em);
  }
  return null;
}

function findLeadId({ message, email, tags }) {
  if (message?.lead_id) return message.lead_id;

  if (Array.isArray(tags)) {
    for (const tag of tags) {
      const m = String(tag).match(/^crm-lead-(.+)$/i);
      if (m?.[1]) {
        const lead = db.prepare(`SELECT id FROM leads WHERE id = ?`).get(m[1]);
        if (lead) return lead.id;
      }
    }
  }

  const em = normalizeEmail(email);
  if (em) {
    const lead = db
      .prepare(
        `SELECT id FROM leads WHERE lower(email) = ? ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(em);
    if (lead) return lead.id;
  }
  return null;
}

function bumpLeadCounters(leadId, event) {
  const now = new Date().toISOString();
  if (OPEN_EVENTS.has(event)) {
    db.prepare(
      `UPDATE leads
       SET email_open_count = COALESCE(email_open_count, 0) + 1,
           last_email_opened_at = ?,
           updated_at = datetime('now')
       WHERE id = ?`,
    ).run(now, leadId);
    return;
  }
  if (CLICK_EVENTS.has(event)) {
    db.prepare(
      `UPDATE leads
       SET email_click_count = COALESCE(email_click_count, 0) + 1,
           updated_at = datetime('now')
       WHERE id = ?`,
    ).run(leadId);
    return;
  }
  if (REPLY_EVENTS.has(event)) {
    db.prepare(
      `UPDATE leads
       SET email_reply_count = COALESCE(email_reply_count, 0) + 1,
           last_email_replied_at = ?,
           updated_at = datetime('now')
       WHERE id = ?`,
    ).run(now, leadId);
  }
}

function activityForEvent(event, subject) {
  const subj = subject ? `: ${subject}` : '';
  if (OPEN_EVENTS.has(event)) {
    return { type: 'email_opened', summary: `Email opened${subj}` };
  }
  if (CLICK_EVENTS.has(event)) {
    return { type: 'email_clicked', summary: `Email link clicked${subj}` };
  }
  if (REPLY_EVENTS.has(event)) {
    return { type: 'reply', summary: `Email reply received${subj}`, outcome: 'neutral' };
  }
  if (BOUNCE_EVENTS.has(event)) {
    return { type: 'email_bounced', summary: `Email ${event}${subj}` };
  }
  if (DELIVERED_EVENTS.has(event)) {
    return { type: 'email_delivered', summary: `Email delivered${subj}` };
  }
  return { type: 'email_event', summary: `Email ${event}${subj}` };
}

/**
 * Ingest one Brevo webhook payload object.
 * @returns {{ ok: boolean, skipped?: string, leadId?: string, event?: string }}
 */
export function ingestBrevoWebhookEvent(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, skipped: 'empty_payload' };
  }

  const event = normalizeEvent(payload.event || payload['event-type'] || payload.type);
  if (!event) return { ok: false, skipped: 'no_event' };

  const email = normalizeEmail(payload.email || payload['recipient'] || payload.to);
  const brevoMessageId =
    payload['message-id'] || payload.messageId || payload['message_id'] || null;
  const subject = payload.subject || null;
  const tags = payload.tags || payload.tag || [];
  const tagList = Array.isArray(tags) ? tags : [tags].filter(Boolean);
  const occurredAt = payload.date
    ? new Date(payload.date).toISOString()
    : payload.ts
      ? new Date(Number(payload.ts) * 1000).toISOString()
      : new Date().toISOString();

  const message = findMessage({ brevoMessageId, email });
  const leadId = findLeadId({ message, email, tags: tagList });
  if (!leadId) {
    return { ok: false, skipped: 'lead_not_found', event };
  }

  // Dedupe identical event+message+email within a short window via unique-ish key
  const dedupeKey = [
    event,
    normalizeMessageId(brevoMessageId) || message?.id || '',
    email || '',
    occurredAt.slice(0, 16),
  ].join('|');

  const existing = db
    .prepare(`SELECT id FROM email_events WHERE dedupe_key = ?`)
    .get(dedupeKey);
  if (existing) {
    return { ok: true, skipped: 'duplicate', leadId, event };
  }

  const eventId = uuid();
  db.prepare(
    `INSERT INTO email_events (
       id, lead_id, email_message_id, brevo_message_id, event, email, subject,
       occurred_at, dedupe_key, raw_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    leadId,
    message?.id || null,
    normalizeMessageId(brevoMessageId),
    event,
    email,
    subject,
    occurredAt,
    dedupeKey,
    JSON.stringify(payload).slice(0, 8000),
  );

  if (message && OPEN_EVENTS.has(event)) {
    db.prepare(
      `UPDATE email_messages
       SET open_count = COALESCE(open_count, 0) + 1,
           last_opened_at = ?,
           status = CASE WHEN status = 'sent' THEN 'opened' ELSE status END
       WHERE id = ?`,
    ).run(occurredAt, message.id);
  }
  if (message && CLICK_EVENTS.has(event)) {
    db.prepare(
      `UPDATE email_messages
       SET click_count = COALESCE(click_count, 0) + 1,
           last_clicked_at = ?
       WHERE id = ?`,
    ).run(occurredAt, message.id);
  }
  if (message && REPLY_EVENTS.has(event)) {
    db.prepare(
      `UPDATE email_messages
       SET reply_count = COALESCE(reply_count, 0) + 1,
           last_replied_at = ?,
           status = 'replied'
       WHERE id = ?`,
    ).run(occurredAt, message.id);
  }
  if (message && BOUNCE_EVENTS.has(event)) {
    db.prepare(
      `UPDATE email_messages SET status = 'bounced' WHERE id = ?`,
    ).run(message.id);
  }
  if (message && event === 'delivered') {
    db.prepare(
      `UPDATE email_messages
       SET status = CASE WHEN status IN ('opened','replied') THEN status ELSE 'delivered' END
       WHERE id = ?`,
    ).run(message.id);
  }

  bumpLeadCounters(leadId, event);

  // Avoid flooding activity for every 'request' / duplicate open — log meaningful events
  if (
    OPEN_EVENTS.has(event) ||
    CLICK_EVENTS.has(event) ||
    REPLY_EVENTS.has(event) ||
    BOUNCE_EVENTS.has(event) ||
    event === 'delivered'
  ) {
    const act = activityForEvent(event, subject || message?.subject);
    // Skip spammy unique_opened duplicates — we already dedupe above
    db.prepare(
      `INSERT INTO lead_activities (id, lead_id, user_id, type, summary, outcome)
       VALUES (?, ?, NULL, ?, ?, ?)`,
    ).run(uuid(), leadId, act.type, act.summary, act.outcome || null);
  }

  return { ok: true, leadId, event };
}

export function getLeadEmailHistory(leadId) {
  const messages = db
    .prepare(
      `SELECT m.*, u.name AS sent_by_name
       FROM email_messages m
       LEFT JOIN users u ON u.id = m.user_id
       WHERE m.lead_id = ?
       ORDER BY m.sent_at DESC
       LIMIT 100`,
    )
    .all(leadId);

  const events = db
    .prepare(
      `SELECT * FROM email_events
       WHERE lead_id = ?
       ORDER BY occurred_at DESC
       LIMIT 200`,
    )
    .all(leadId);

  return { messages, events };
}
