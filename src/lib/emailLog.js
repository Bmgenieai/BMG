/**
 * Persist Brevo outbound messages + inbound webhook events (open / click / reply).
 */
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { touchLeadContacted, onLeadReply } from './leadAutomation.js';

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
  htmlContent = null,
  textContent = null,
  parentReplyId = null,
}) {
  const id = uuid();
  const now = new Date().toISOString();
  const mid = normalizeMessageId(brevoMessageId);

  db.prepare(
    `INSERT INTO email_messages (
       id, lead_id, user_id, brevo_message_id, subject, to_email, template_id, source, status,
       html_content, text_content, parent_reply_id, sent_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?)`,
  ).run(
    id,
    leadId,
    userId,
    mid,
    subject || null,
    normalizeEmail(toEmail),
    templateId || null,
    source,
    htmlContent ? String(htmlContent).slice(0, 200_000) : null,
    textContent ? String(textContent).slice(0, 100_000) : null,
    parentReplyId || null,
    now,
  );

  db.prepare(
    `UPDATE leads
     SET last_emailed_at = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(now, leadId);

  const isFollowup = /follow.?up/i.test(summaryPrefix) || source === 'followup';
  db.prepare(
    `INSERT INTO lead_activities (id, lead_id, user_id, type, summary)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    uuid(),
    leadId,
    userId,
    isFollowup ? 'email_followup' : 'email_sent',
    `${summaryPrefix}: ${subject || '(no subject)'}`,
  );

  touchLeadContacted(leadId, { userId });

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
    onLeadReply(leadId);
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

  if (REPLY_EVENTS.has(event)) {
    upsertReplyStubFromEvent({
      leadId,
      message,
      email,
      subject: subject || message?.subject,
      occurredAt,
      brevoMessageId,
      payload,
    });
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
  const rawMessages = db
    .prepare(
      `SELECT m.*, u.name AS sent_by_name
       FROM email_messages m
       LEFT JOIN users u ON u.id = m.user_id
       WHERE m.lead_id = ?
       ORDER BY m.sent_at ASC
       LIMIT 100`,
    )
    .all(leadId);

  const messages = rawMessages.map((m, idx) => ({
    id: m.id,
    sequence: idx + 1,
    subject: m.subject,
    toEmail: m.to_email,
    sentAt: m.sent_at,
    sentByName: m.sent_by_name || null,
    status: m.status,
    source: m.source,
    openCount: Number(m.open_count) || 0,
    clickCount: Number(m.click_count) || 0,
    replyCount: Number(m.reply_count) || 0,
    htmlContent: m.html_content || null,
    textContent: m.text_content || null,
    hasBody: Boolean(m.html_content || m.text_content),
    // legacy snake_case for older UI bindings
    open_count: Number(m.open_count) || 0,
    click_count: Number(m.click_count) || 0,
    reply_count: Number(m.reply_count) || 0,
    sent_at: m.sent_at,
    sent_by_name: m.sent_by_name || null,
    html_content: m.html_content || null,
    text_content: m.text_content || null,
  }));

  const events = db
    .prepare(
      `SELECT * FROM email_events
       WHERE lead_id = ?
       ORDER BY occurred_at DESC
       LIMIT 200`,
    )
    .all(leadId);

  const replies = db
    .prepare(
      `SELECT * FROM email_replies
       WHERE lead_id = ?
       ORDER BY received_at DESC
       LIMIT 100`,
    )
    .all(leadId);

  return { messages, events, replies };
}

function mailboxAddress(mb) {
  if (!mb) return null;
  if (typeof mb === 'string') return normalizeEmail(mb);
  return normalizeEmail(mb.Address || mb.address || mb.email);
}

function mailboxName(mb) {
  if (!mb || typeof mb === 'string') return null;
  return mb.Name || mb.name || null;
}

function collectAddresses(list) {
  if (!Array.isArray(list)) return [];
  return list.map(mailboxAddress).filter(Boolean);
}

/** Extract lead id from Reply-To / To like lead-<uuid>@reply.domain */
export function extractLeadIdFromAddress(address) {
  const em = normalizeEmail(address);
  if (!em) return null;
  const local = em.split('@')[0] || '';
  const m = local.match(/^lead-(.+)$/i);
  return m?.[1] || null;
}

function findLeadIdFromInboundAddresses(addresses) {
  for (const addr of addresses) {
    const leadId = extractLeadIdFromAddress(addr);
    if (!leadId) continue;
    const lead = db.prepare(`SELECT id FROM leads WHERE id = ?`).get(leadId);
    if (lead) return lead.id;
  }
  return null;
}

function findMessageByInReplyTo(inReplyTo) {
  const mid = normalizeMessageId(inReplyTo);
  if (!mid) return null;
  return db
    .prepare(
      `SELECT * FROM email_messages
       WHERE brevo_message_id = ? OR brevo_message_id = ?
       ORDER BY sent_at DESC LIMIT 1`,
    )
    .get(mid, `<${mid}>`);
}

/** Match outbound CRM message from In-Reply-To and/or References headers. */
function findMessageByThreadHeaders(inReplyTo, referencesRaw) {
  const ids = [];
  const push = (raw) => {
    const mid = normalizeMessageId(raw);
    if (mid && !ids.includes(mid)) ids.push(mid);
  };
  push(inReplyTo);
  if (referencesRaw) {
    for (const part of String(referencesRaw).split(/\s+/)) push(part);
  }
  for (const mid of ids) {
    const msg = findMessageByInReplyTo(mid);
    if (msg) return msg;
  }
  return null;
}

/** Match by prospect email + subject (strip Re:/Fw:). */
function findMessageBySubjectAndFrom(subject, fromEmail) {
  const em = normalizeEmail(fromEmail);
  if (!em || !subject) return null;
  const stripped = String(subject)
    .replace(/^(re|fw|fwd)\s*:\s*/gi, '')
    .trim();
  if (!stripped) return null;

  const exact = db
    .prepare(
      `SELECT * FROM email_messages
       WHERE lower(to_email) = ?
         AND lower(trim(COALESCE(subject, ''))) = lower(?)
       ORDER BY sent_at DESC LIMIT 1`,
    )
    .get(em, stripped);
  if (exact) return exact;

  const like = db
    .prepare(
      `SELECT * FROM email_messages
       WHERE lower(to_email) = ?
         AND lower(COALESCE(subject, '')) LIKE lower(?)
       ORDER BY sent_at DESC LIMIT 1`,
    )
    .get(em, `%${stripped.slice(0, 100)}%`);
  return like || null;
}

function resolveInboundLeadAndMessage({
  toList = [],
  fromEmail,
  inReplyTo,
  references,
  subject,
}) {
  const message =
    findMessageByThreadHeaders(inReplyTo, references) ||
    findMessageBySubjectAndFrom(subject, fromEmail) ||
    findMessage({ brevoMessageId: null, email: fromEmail });

  const leadId =
    findLeadIdFromInboundAddresses(toList) ||
    message?.lead_id ||
    findLeadId({ message, email: fromEmail, tags: [] });

  return { message, leadId };
}

/**
 * Stub row when Brevo fires a transactional "reply" event (no body).
 * Full body arrives later via inbound parsing when Reply-To routing is enabled.
 */
function upsertReplyStubFromEvent({
  leadId,
  message,
  email,
  subject,
  occurredAt,
  brevoMessageId,
  payload,
}) {
  const providerId = normalizeMessageId(brevoMessageId)
    ? `event:${normalizeMessageId(brevoMessageId)}:${occurredAt.slice(0, 16)}`
    : `event:${leadId}:${email || ''}:${occurredAt.slice(0, 16)}`;

  const existing = db
    .prepare(`SELECT id FROM email_replies WHERE provider_message_id = ?`)
    .get(providerId);
  if (existing) return existing.id;

  // Prefer not to create a stub if we already have a full inbound reply for this lead recently
  const recentInbound = db
    .prepare(
      `SELECT id FROM email_replies
       WHERE lead_id = ? AND source = 'brevo_inbound'
         AND datetime(received_at) >= datetime(?, '-1 day')
       LIMIT 1`,
    )
    .get(leadId, occurredAt.replace('T', ' ').slice(0, 19));
  if (recentInbound) return recentInbound.id;

  const id = uuid();
  db.prepare(
    `INSERT INTO email_replies (
       id, lead_id, email_message_id, provider_message_id, from_email, subject,
       source, received_at, raw_json
     ) VALUES (?, ?, ?, ?, ?, ?, 'brevo_event', ?, ?)`,
  ).run(
    id,
    leadId,
    message?.id || null,
    providerId,
    normalizeEmail(email),
    subject || null,
    occurredAt,
    JSON.stringify(payload).slice(0, 8000),
  );
  return id;
}

/**
 * Persist a parsed inbound reply (Brevo inbound parse OR sender mailbox IMAP).
 * @returns {{ ok: boolean, skipped?: string, replyId?: string, leadId?: string|null }}
 */
export function ingestParsedReply({
  providerMessageId = null,
  fromEmail = null,
  fromName = null,
  toEmails = [],
  inReplyTo = null,
  references = null,
  subject = null,
  bodyText = null,
  bodyHtml = null,
  bodyMarkdown = null,
  spamScore = null,
  receivedAt = null,
  raw = null,
  source = 'brevo_inbound',
  requireLeadMatch = false,
}) {
  const sourceKey = ['brevo_inbound', 'brevo_event', 'sender_mailbox'].includes(source)
    ? source
    : 'brevo_inbound';

  const providerId = providerMessageId ? String(providerMessageId).slice(0, 500) : null;
  if (providerId) {
    const dup = db
      .prepare(`SELECT id, lead_id FROM email_replies WHERE provider_message_id = ?`)
      .get(providerId);
    if (dup) {
      return { ok: true, skipped: 'duplicate', replyId: dup.id, leadId: dup.lead_id };
    }
  }

  const toList = Array.isArray(toEmails) ? toEmails.filter(Boolean) : [];
  const { message, leadId } = resolveInboundLeadAndMessage({
    toList,
    fromEmail,
    inReplyTo,
    references,
    subject,
  });

  if (requireLeadMatch && !leadId) {
    return { ok: false, skipped: 'no_lead_match' };
  }

  const when = receivedAt || new Date().toISOString();
  const id = uuid();
  db.prepare(
    `INSERT INTO email_replies (
       id, lead_id, email_message_id, provider_message_id, in_reply_to,
       from_email, from_name, to_emails, subject,
       body_text, body_html, body_markdown, spam_score,
       source, received_at, raw_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    leadId,
    message?.id || null,
    providerId,
    normalizeMessageId(inReplyTo),
    normalizeEmail(fromEmail),
    fromName || null,
    JSON.stringify([...new Set(toList)]),
    subject || null,
    bodyText ? String(bodyText).slice(0, 100_000) : null,
    bodyHtml ? String(bodyHtml).slice(0, 200_000) : null,
    bodyMarkdown ? String(bodyMarkdown).slice(0, 100_000) : null,
    spamScore,
    sourceKey,
    when,
    raw ? JSON.stringify(raw).slice(0, 16_000) : null,
  );

  if (leadId) {
    const alreadyCounted =
      message?.status === 'replied' ||
      Boolean(
        db
          .prepare(
            `SELECT id FROM email_events
             WHERE lead_id = ? AND event IN ('reply','replied')
               AND datetime(occurred_at) >= datetime(?, '-2 days')
             LIMIT 1`,
          )
          .get(leadId, when.replace('T', ' ').slice(0, 19)),
      );

    if (!alreadyCounted) {
      db.prepare(
        `UPDATE leads
         SET email_reply_count = COALESCE(email_reply_count, 0) + 1,
             last_email_replied_at = ?,
             updated_at = datetime('now')
         WHERE id = ?`,
      ).run(when, leadId);

      if (message) {
        db.prepare(
          `UPDATE email_messages
           SET reply_count = COALESCE(reply_count, 0) + 1,
               last_replied_at = ?,
               status = 'replied'
           WHERE id = ?`,
        ).run(when, message.id);
      }
    } else {
      db.prepare(
        `UPDATE leads SET last_email_replied_at = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(when, leadId);
      if (message) {
        db.prepare(
          `UPDATE email_messages
           SET last_replied_at = ?, status = 'replied'
           WHERE id = ?`,
        ).run(when, message.id);
      }
    }

    const preview = (bodyMarkdown || bodyText || subject || '(empty reply)')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
    db.prepare(
      `INSERT INTO lead_activities (id, lead_id, user_id, type, summary, outcome)
       VALUES (?, ?, NULL, 'reply', ?, 'neutral')`,
    ).run(uuid(), leadId, `Email reply: ${preview}`);
    onLeadReply(leadId);
  }

  return { ok: true, replyId: id, leadId };
}

/**
 * Ingest one Brevo inbound-parse item (full reply body).
 * @returns {{ ok: boolean, skipped?: string, replyId?: string, leadId?: string|null }}
 */
export function ingestBrevoInboundEmail(item) {
  if (!item || typeof item !== 'object') {
    return { ok: false, skipped: 'empty_item' };
  }

  const providerMessageId =
    normalizeMessageId(item.MessageId || item.messageId || item.message_id) ||
    (Array.isArray(item.Uuid) && item.Uuid[0] ? `uuid:${item.Uuid[0]}` : null) ||
    null;

  const fromEmail = mailboxAddress(item.From);
  const fromName = mailboxName(item.From);
  const toList = [
    ...collectAddresses(item.To),
    ...collectAddresses(
      Array.isArray(item.Recipients)
        ? item.Recipients.map((r) => (typeof r === 'string' ? { Address: r } : r))
        : [],
    ),
    ...collectAddresses(item.Cc),
  ];

  const headers = Array.isArray(item.Headers) ? item.Headers : [];
  const headerVal = (name) => {
    const hit = headers.find(
      (h) => String(h?.Name || h?.name || '').toLowerCase() === name.toLowerCase(),
    );
    return hit?.Value || hit?.value || null;
  };

  const inReplyTo = item.InReplyTo || item.inReplyTo || headerVal('In-Reply-To') || null;
  const references = item.References || item.references || headerVal('References') || null;

  const subject = item.Subject || item.subject || null;
  const bodyMarkdown = item.ExtractedMarkdownMessage || null;
  const bodyText = item.RawTextBody || bodyMarkdown || null;
  const bodyHtml = item.RawHtmlBody || null;
  const spamScore =
    typeof item.SpamScore === 'number'
      ? item.SpamScore
      : typeof item.Spam?.Score === 'number'
        ? item.Spam.Score
        : null;

  let receivedAt = new Date().toISOString();
  if (item.SentAtDate) {
    const d = new Date(item.SentAtDate);
    if (!Number.isNaN(d.getTime())) receivedAt = d.toISOString();
  }

  return ingestParsedReply({
    providerMessageId,
    fromEmail,
    fromName,
    toEmails: toList,
    inReplyTo,
    references,
    subject,
    bodyText,
    bodyHtml,
    bodyMarkdown,
    spamScore,
    receivedAt,
    raw: item,
    source: 'brevo_inbound',
  });
}

/**
 * List email replies for CRM inbox tab.
 * @param {{ user: { id: string, role: string }, q?: string, unreadOnly?: boolean, limit?: number, canViewAll: boolean }} opts
 */
export function listEmailReplies({ user, q = '', unreadOnly = false, limit = 100, canViewAll }) {
  const clauses = [];
  const params = [];

  if (!canViewAll && user?.id) {
    clauses.push('(l.assigned_to = ? OR l.created_by = ? OR r.lead_id IS NULL)');
    params.push(user.id, user.id);
  }
  if (unreadOnly) {
    clauses.push('r.read_at IS NULL');
  }
  if (q) {
    clauses.push(
      `(r.subject LIKE ? OR r.from_email LIKE ? OR r.body_markdown LIKE ? OR r.body_text LIKE ? OR l.name LIKE ? OR l.email LIKE ? OR m.subject LIKE ? OR su.name LIKE ?)`,
    );
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like, like, like);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `WITH ranked AS (
         SELECT r.*,
                l.name AS lead_name,
                l.email AS lead_email,
                l.company AS lead_company,
                l.status AS lead_status,
                l.state AS lead_state,
                l.business_type AS lead_business_type,
                l.assigned_to AS lead_assigned_to,
                u.name AS assigned_to_name,
                m.subject AS original_subject,
                m.sent_at AS original_sent_at,
                m.to_email AS original_to_email,
                su.name AS sent_by_name,
                COALESCE(r.lead_id, LOWER(TRIM(r.from_email))) AS conv_key,
                ROW_NUMBER() OVER (
                  PARTITION BY COALESCE(r.lead_id, LOWER(TRIM(r.from_email)))
                  ORDER BY r.received_at DESC
                ) AS rn,
                COUNT(*) OVER (
                  PARTITION BY COALESCE(r.lead_id, LOWER(TRIM(r.from_email)))
                ) AS thread_count,
                SUM(CASE WHEN r.read_at IS NULL THEN 1 ELSE 0 END) OVER (
                  PARTITION BY COALESCE(r.lead_id, LOWER(TRIM(r.from_email)))
                ) AS thread_unread_count
         FROM email_replies r
         LEFT JOIN leads l ON l.id = r.lead_id
         LEFT JOIN users u ON u.id = l.assigned_to
         LEFT JOIN email_messages m ON m.id = r.email_message_id
         LEFT JOIN users su ON su.id = m.user_id
         ${where}
       )
       SELECT * FROM ranked
       WHERE rn = 1
       ORDER BY received_at DESC
       LIMIT ?`,
    )
    .all(...params, Math.min(Math.max(Number(limit) || 100, 1), 300));

  return rows.map((r) => ({
    ...r,
    preview: (r.body_markdown || r.body_text || r.subject || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160),
    hasBody: Boolean(r.body_markdown || r.body_text || r.body_html),
    read_at: r.thread_unread_count > 0 ? null : r.read_at,
  }));
}

export function countUnreadEmailReplies({ user, canViewAll }) {
  if (canViewAll || !user?.id) {
    return db
      .prepare(
        `SELECT COUNT(DISTINCT COALESCE(lead_id, LOWER(TRIM(from_email)))) AS c
         FROM email_replies WHERE read_at IS NULL`,
      )
      .get().c;
  }
  return db
    .prepare(
      `SELECT COUNT(DISTINCT COALESCE(r.lead_id, LOWER(TRIM(r.from_email)))) AS c
       FROM email_replies r
       LEFT JOIN leads l ON l.id = r.lead_id
       WHERE r.read_at IS NULL
         AND (l.assigned_to = ? OR l.created_by = ? OR r.lead_id IS NULL)`,
    )
    .get(user.id, user.id).c;
}

export function countEmailReplies({ user, canViewAll }) {
  if (canViewAll || !user?.id) {
    return db
      .prepare(
        `SELECT COUNT(DISTINCT COALESCE(lead_id, LOWER(TRIM(from_email)))) AS c
         FROM email_replies`,
      )
      .get().c;
  }
  return db
    .prepare(
      `SELECT COUNT(DISTINCT COALESCE(r.lead_id, LOWER(TRIM(r.from_email)))) AS c
       FROM email_replies r
       LEFT JOIN leads l ON l.id = r.lead_id
       WHERE (l.assigned_to = ? OR l.created_by = ? OR r.lead_id IS NULL)`,
    )
    .get(user.id, user.id).c;
}

function findOriginalOutboundMessage(reply) {
  if (reply?.email_message_id) {
    const byId = db
      .prepare(
        `SELECT m.*, u.name AS sent_by_name
         FROM email_messages m
         LEFT JOIN users u ON u.id = m.user_id
         WHERE m.id = ?`,
      )
      .get(reply.email_message_id);
    if (byId) return byId;
  }

  if (reply?.in_reply_to) {
    const mid = normalizeMessageId(reply.in_reply_to);
    if (mid) {
      const byMid = db
        .prepare(
          `SELECT m.*, u.name AS sent_by_name
           FROM email_messages m
           LEFT JOIN users u ON u.id = m.user_id
           WHERE m.brevo_message_id = ? OR m.brevo_message_id = ?
           ORDER BY m.sent_at DESC LIMIT 1`,
        )
        .get(mid, `<${mid}>`);
      if (byMid) return byMid;
    }
  }

  if (reply?.lead_id) {
    return db
      .prepare(
        `SELECT m.*, u.name AS sent_by_name
         FROM email_messages m
         LEFT JOIN users u ON u.id = m.user_id
         WHERE m.lead_id = ?
           AND datetime(m.sent_at) <= datetime(REPLACE(REPLACE(?, 'T', ' '), 'Z', ''))
         ORDER BY m.sent_at DESC
         LIMIT 1`,
      )
      .get(reply.lead_id, reply.received_at || new Date().toISOString());
  }
  return null;
}

function buildConversationThread({ leadId, fromEmail, leadName }) {
  const convKeyLead = leadId || null;
  const convKeyEmail = fromEmail ? String(fromEmail).toLowerCase().trim() : null;

  let allReplies = [];
  if (convKeyLead && convKeyEmail) {
    allReplies = db
      .prepare(
        `SELECT * FROM email_replies
         WHERE lead_id = ? OR LOWER(TRIM(from_email)) = ?
         ORDER BY received_at ASC`,
      )
      .all(convKeyLead, convKeyEmail);
  } else if (convKeyLead) {
    allReplies = db
      .prepare(`SELECT * FROM email_replies WHERE lead_id = ? ORDER BY received_at ASC`)
      .all(convKeyLead);
  } else if (convKeyEmail) {
    allReplies = db
      .prepare(
        `SELECT * FROM email_replies WHERE LOWER(TRIM(from_email)) = ? ORDER BY received_at ASC`,
      )
      .all(convKeyEmail);
  }

  let outboundMessages = [];
  if (convKeyLead && convKeyEmail) {
    outboundMessages = db
      .prepare(
        `SELECT m.*, u.name AS sent_by_name
         FROM email_messages m
         LEFT JOIN users u ON u.id = m.user_id
         WHERE m.lead_id = ? OR LOWER(TRIM(m.to_email)) = ?
         ORDER BY m.sent_at ASC`,
      )
      .all(convKeyLead, convKeyEmail);
  } else if (convKeyLead) {
    outboundMessages = db
      .prepare(
        `SELECT m.*, u.name AS sent_by_name
         FROM email_messages m
         LEFT JOIN users u ON u.id = m.user_id
         WHERE m.lead_id = ?
         ORDER BY m.sent_at ASC`,
      )
      .all(convKeyLead);
  } else if (convKeyEmail) {
    outboundMessages = db
      .prepare(
        `SELECT m.*, u.name AS sent_by_name
         FROM email_messages m
         LEFT JOIN users u ON u.id = m.user_id
         WHERE LOWER(TRIM(m.to_email)) = ?
         ORDER BY m.sent_at ASC`,
      )
      .all(convKeyEmail);
  }

  const thread = [];
  for (const m of outboundMessages) {
    thread.push({
      id: m.id,
      direction: 'sent',
      senderName: m.sent_by_name || 'BD Team',
      toEmail: m.to_email,
      date: m.sent_at,
      subject: m.subject,
      htmlContent: m.html_content || null,
      textContent: m.text_content || null,
      hasBody: Boolean(m.html_content || m.text_content),
    });
  }
  for (const r of allReplies) {
    thread.push({
      id: r.id,
      direction: 'reply',
      senderName: r.from_name || r.from_email || leadName || 'Prospect',
      fromEmail: r.from_email,
      date: r.received_at,
      subject: r.subject,
      htmlContent: r.body_html || null,
      textContent: r.body_text || null,
      markdownContent: r.body_markdown || null,
      hasBody: Boolean(r.body_html || r.body_text || r.body_markdown),
    });
  }

  thread.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  return { thread, allReplies, outboundMessages };
}

/** Full conversation for a lead (outbound + inbound), same shape as Email replies modal. */
export function getLeadConversation(leadId) {
  const lead = db
    .prepare(
      `SELECT l.*, u.name AS assigned_to_name
       FROM leads l
       LEFT JOIN users u ON u.id = l.assigned_to
       WHERE l.id = ?`,
    )
    .get(leadId);
  if (!lead) return null;

  const fromEmail = lead.email ? String(lead.email).toLowerCase().trim() : null;
  const { thread, allReplies, outboundMessages } = buildConversationThread({
    leadId: lead.id,
    fromEmail,
    leadName: lead.name,
  });

  const latestReply = allReplies.length ? allReplies[allReplies.length - 1] : null;
  const latestOutbound = outboundMessages.length
    ? outboundMessages[outboundMessages.length - 1]
    : null;

  return {
    id: latestReply?.id || null,
    lead_id: lead.id,
    lead_name: lead.name,
    lead_email: lead.email,
    lead_company: lead.company,
    lead_status: lead.status,
    lead_state: lead.state || null,
    lead_business_type: lead.business_type || null,
    assigned_to_name: lead.assigned_to_name || null,
    from_email: latestReply?.from_email || lead.email || null,
    from_name: latestReply?.from_name || lead.name || null,
    subject: latestReply?.subject || latestOutbound?.subject || null,
    received_at: latestReply?.received_at || null,
    read_at: latestReply?.read_at || null,
    hasBody: Boolean(
      latestReply?.body_markdown || latestReply?.body_text || latestReply?.body_html,
    ),
    thread,
    allReplyIds: allReplies.map((r) => r.id),
    messageCount: thread.length,
    replyCount: allReplies.length,
    originalMessage: latestOutbound
      ? {
          id: latestOutbound.id,
          subject: latestOutbound.subject,
          toEmail: latestOutbound.to_email,
          sentAt: latestOutbound.sent_at,
          sentByName: latestOutbound.sent_by_name || null,
          templateId: latestOutbound.template_id,
          source: latestOutbound.source,
          htmlContent: latestOutbound.html_content || null,
          textContent: latestOutbound.text_content || null,
          hasBody: Boolean(latestOutbound.html_content || latestOutbound.text_content),
          brevoMessageId: latestOutbound.brevo_message_id || null,
        }
      : null,
    crmReplies: [],
  };
}

export function getEmailReply(id) {
  const row = db
    .prepare(
      `SELECT r.*,
              l.name AS lead_name,
              l.email AS lead_email,
              l.company AS lead_company,
              l.status AS lead_status,
              l.state AS lead_state,
              l.business_type AS lead_business_type,
              l.assigned_to AS lead_assigned_to,
              u.name AS assigned_to_name
       FROM email_replies r
       LEFT JOIN leads l ON l.id = r.lead_id
       LEFT JOIN users u ON u.id = l.assigned_to
       WHERE r.id = ?`,
    )
    .get(id);

  if (!row) return null;

  const convKeyLead = row.lead_id;
  const convKeyEmail = row.from_email ? row.from_email.toLowerCase().trim() : null;
  const { thread, allReplies } = buildConversationThread({
    leadId: convKeyLead,
    fromEmail: convKeyEmail,
    leadName: row.lead_name,
  });

  // If this reply isn't already in the thread set (edge), still include at least itself
  if (!allReplies.length) {
    thread.push({
      id: row.id,
      direction: 'reply',
      senderName: row.from_name || row.from_email || row.lead_name || 'Prospect',
      fromEmail: row.from_email,
      date: row.received_at,
      subject: row.subject,
      htmlContent: row.body_html || null,
      textContent: row.body_text || null,
      markdownContent: row.body_markdown || null,
      hasBody: Boolean(row.body_html || row.body_text || row.body_markdown),
    });
    thread.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }

  const original = findOriginalOutboundMessage(row);

  return {
    ...row,
    hasBody: Boolean(row.body_markdown || row.body_text || row.body_html),
    thread,
    allReplyIds: allReplies.map((r) => r.id),
    originalMessage: original
      ? {
          id: original.id,
          subject: original.subject,
          toEmail: original.to_email,
          sentAt: original.sent_at,
          sentByName: original.sent_by_name || null,
          templateId: original.template_id,
          source: original.source,
          htmlContent: original.html_content || null,
          textContent: original.text_content || null,
          hasBody: Boolean(original.html_content || original.text_content),
          brevoMessageId: original.brevo_message_id || null,
        }
      : null,
    crmReplies: [],
  };
}

function wrapAngle(messageId) {
  const mid = normalizeMessageId(messageId);
  if (!mid) return null;
  return mid.startsWith('<') ? mid : `<${mid}>`;
}

function textToSimpleHtml(text) {
  const escaped = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">${escaped}</div>`;
}

function replySubject(subject) {
  const s = String(subject || '').trim() || '(no subject)';
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
}

/**
 * Send a CRM follow-up reply to an inbound prospect message via Brevo.
 * @returns {{ ok: true, reply: object, brevo: object }}
 */
export async function sendCrmReplyToInbound({
  replyId,
  user,
  bodyText,
  subject: subjectOverride = null,
  sendTransactionalEmail,
}) {
  const reply = getEmailReply(replyId);
  if (!reply) {
    const err = new Error('Reply not found');
    err.status = 404;
    throw err;
  }

  const toEmail = normalizeEmail(reply.from_email) || normalizeEmail(reply.lead_email);
  if (!toEmail) {
    const err = new Error('No recipient email on this reply');
    err.status = 400;
    throw err;
  }

  const text = String(bodyText || '').trim();
  if (!text) {
    const err = new Error('Reply message is required');
    err.status = 400;
    throw err;
  }

  const leadId = reply.lead_id;
  if (!leadId) {
    const err = new Error('Reply is not linked to a CRM lead');
    err.status = 400;
    throw err;
  }

  const subject = replySubject(subjectOverride || reply.subject || reply.originalMessage?.subject);
  const htmlContent = textToSimpleHtml(text);

  const inboundMid = wrapAngle(reply.provider_message_id);
  const originalMid = wrapAngle(reply.originalMessage?.brevoMessageId);
  const references = [originalMid, inboundMid].filter(Boolean).join(' ');
  const headers = {};
  if (inboundMid) headers['In-Reply-To'] = inboundMid;
  if (references) headers.References = references;

  const brevo = await sendTransactionalEmail({
    toEmail,
    toName: reply.from_name || reply.lead_name || undefined,
    subject,
    htmlContent,
    textContent: text,
    leadId,
    tags: ['crm-reply'],
    headers,
  });

  recordEmailSend({
    leadId,
    userId: user.id,
    subject,
    toEmail,
    brevoMessageId: brevo?.messageId || brevo?.message_id || null,
    source: 'crm_reply',
    summaryPrefix: 'CRM reply',
    htmlContent,
    textContent: text,
    parentReplyId: replyId,
  });

  // Mark inbound as read after BD responds
  markEmailReplyRead(replyId, true);

  return { ok: true, reply: getEmailReply(replyId), brevo };
}

export function markEmailReplyRead(id, read = true) {
  const readAt = read ? new Date().toISOString() : null;
  const current = db.prepare(`SELECT lead_id, from_email FROM email_replies WHERE id = ?`).get(id);
  if (current) {
    if (current.lead_id) {
      db.prepare(`UPDATE email_replies SET read_at = ? WHERE lead_id = ?`).run(readAt, current.lead_id);
    } else if (current.from_email) {
      db.prepare(`UPDATE email_replies SET read_at = ? WHERE LOWER(TRIM(from_email)) = ?`).run(
        readAt,
        current.from_email.toLowerCase().trim(),
      );
    } else {
      db.prepare(`UPDATE email_replies SET read_at = ? WHERE id = ?`).run(readAt, id);
    }
  } else {
    db.prepare(`UPDATE email_replies SET read_at = ? WHERE id = ?`).run(readAt, id);
  }
  return getEmailReply(id);
}
