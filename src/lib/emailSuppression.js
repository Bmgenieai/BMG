/**
 * Global cold-email suppression list (hard bounces, spam complaints, unsubscribes, manual).
 * Suppressing an address stops active sequences for matching leads and blocks future cold emails.
 */
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { cancelScheduledOutreach } from './leadAutomation.js';

export const SUPPRESSION_REASONS = ['hard_bounce', 'spam', 'unsubscribed', 'manual'];

export function normalizeSuppressionEmail(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase();
}

export function reasonStopMessage(reason) {
  switch (reason) {
    case 'hard_bounce':
      return 'Hard bounce — address suppressed';
    case 'spam':
      return 'Spam complaint — address suppressed';
    case 'unsubscribed':
      return 'Unsubscribed — outreach stopped';
    case 'manual':
      return 'Manually suppressed — outreach stopped';
    default:
      return 'Suppressed — outreach stopped';
  }
}

/** Return suppression row if email is globally suppressed, else null. */
export function getEmailSuppression(email) {
  const em = normalizeSuppressionEmail(email);
  if (!em) return null;
  try {
    return (
      db
        .prepare(`SELECT * FROM email_suppressions WHERE lower(email) = ? LIMIT 1`)
        .get(em) || null
    );
  } catch {
    return null;
  }
}

export function isEmailSuppressed(email) {
  return Boolean(getEmailSuppression(email));
}

/** Return a Set of lowercase suppressed emails from a given list (or all if empty/null). */
export function getSuppressedEmailSet(emails = null) {
  const set = new Set();
  try {
    if (Array.isArray(emails) && emails.length > 0) {
      const normalized = [...new Set(emails.map(normalizeSuppressionEmail).filter(Boolean))];
      if (!normalized.length) return set;
      const chunkSize = 400;
      for (let i = 0; i < normalized.length; i += chunkSize) {
        const chunk = normalized.slice(i, i + chunkSize);
        const ph = chunk.map(() => '?').join(',');
        const rows = db
          .prepare(`SELECT lower(email) AS email FROM email_suppressions WHERE lower(email) IN (${ph})`)
          .all(...chunk);
        for (const r of rows) set.add(r.email);
      }
      return set;
    }
    const rows = db.prepare(`SELECT lower(email) AS email FROM email_suppressions`).all();
    for (const r of rows) set.add(r.email);
  } catch {
    /* ignore */
  }
  return set;
}

/**
 * Add or update an email in the global suppression list, stop all active sequences
 * and cancel pending scheduled emails for matching leads.
 */
export function suppressEmail({
  email,
  reason = 'manual',
  source = 'crm',
  leadId = null,
  notes = null,
  userId = null,
}) {
  const em = normalizeSuppressionEmail(email);
  if (!em || !em.includes('@')) {
    const err = new Error('Valid email is required');
    err.status = 400;
    throw err;
  }
  const safeReason = SUPPRESSION_REASONS.includes(reason) ? reason : 'manual';

  // Find all CRM leads with this email
  const matchingLeads = db
    .prepare(`SELECT id FROM leads WHERE lower(email) = ?`)
    .all(em);
  const resolvedLeadId = leadId || matchingLeads[0]?.id || null;

  const existing = getEmailSuppression(em);
  if (existing) {
    db.prepare(
      `UPDATE email_suppressions
       SET reason = ?,
           source = COALESCE(?, source),
           lead_id = COALESCE(?, lead_id),
           notes = COALESCE(?, notes),
           updated_at = datetime('now')
       WHERE id = ?`,
    ).run(safeReason, source || null, resolvedLeadId, notes || null, existing.id);
  } else {
    db.prepare(
      `INSERT INTO email_suppressions (id, email, reason, source, lead_id, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(uuid(), em, safeReason, source || null, resolvedLeadId, notes || null, userId || null);
  }

  // Stop all active sequences & pending scheduled emails for every lead with this address
  const stopMsg = reasonStopMessage(safeReason);
  const leadIds = new Set(matchingLeads.map((l) => l.id));
  if (resolvedLeadId) leadIds.add(resolvedLeadId);

  let cancelled = 0;
  for (const lid of leadIds) {
    cancelled += cancelScheduledOutreach(lid, stopMsg);
    try {
      db.prepare(
        `INSERT INTO lead_activities (id, lead_id, user_id, type, summary, outcome)
         VALUES (?, ?, ?, 'email_suppressed', ?, ?)`,
      ).run(
        uuid(),
        lid,
        userId || null,
        `Email suppressed (${safeReason}): ${em}${notes ? ` — ${notes}` : ''}`,
        safeReason,
      );
    } catch {
      /* ignore */
    }
  }

  return {
    suppression: getEmailSuppression(em),
    cancelled,
    leadIds: [...leadIds],
  };
}

export function unsuppressEmail(idOrEmail) {
  const raw = String(idOrEmail || '').trim();
  if (!raw) return { deleted: 0 };
  const byId = db.prepare(`DELETE FROM email_suppressions WHERE id = ?`).run(raw).changes;
  if (byId) return { deleted: byId };
  const em = normalizeSuppressionEmail(raw);
  const byEmail = db.prepare(`DELETE FROM email_suppressions WHERE lower(email) = ?`).run(em).changes;
  return { deleted: byEmail };
}

export function listSuppressions({ reason = '', q = '', limit = 200, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (reason && SUPPRESSION_REASONS.includes(reason)) {
    where.push(`s.reason = ?`);
    params.push(reason);
  }
  if (q && String(q).trim()) {
    const like = `%${String(q).trim().toLowerCase()}%`;
    where.push(`(lower(s.email) LIKE ? OR lower(COALESCE(s.notes,'')) LIKE ? OR lower(COALESCE(l.name,'')) LIKE ?)`);
    params.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM email_suppressions s
       LEFT JOIN leads l ON l.id = s.lead_id
       ${whereSql}`,
    )
    .get(...params).c;

  const rows = db
    .prepare(
      `SELECT s.*, l.name AS lead_name, l.company AS lead_company, u.name AS created_by_name
       FROM email_suppressions s
       LEFT JOIN leads l ON l.id = s.lead_id
       LEFT JOIN users u ON u.id = s.created_by
       ${whereSql}
       ORDER BY s.updated_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, Math.min(500, Math.max(1, Number(limit) || 200)), Math.max(0, Number(offset) || 0));

  const counts = db
    .prepare(
      `SELECT reason, COUNT(*) AS count FROM email_suppressions GROUP BY reason`,
    )
    .all();

  return { rows, total, counts };
}
