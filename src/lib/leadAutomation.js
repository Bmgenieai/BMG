/**
 * Lead stage automation + outreach stop rules.
 * Activities ≠ funnel counts: stage moves apply to unique leads only.
 */
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import {
  LEAD_STATUSES,
  STOP_OUTREACH_STATUSES,
  normalizeStatus,
} from './permissions.js';

const EARLY_STAGES = new Set(['uncontacted', 'contacted', 'new']);

/** Cancel pending/sending scheduled emails for a lead (stop automated outreach). */
export function cancelScheduledOutreach(leadId, reason = 'Reply received — outreach stopped') {
  if (!leadId) return 0;
  try {
    return db
      .prepare(
        `UPDATE scheduled_emails
         SET status = 'cancelled', error = ?
         WHERE lead_id = ? AND status IN ('pending', 'sending')`,
      )
      .run(reason, leadId).changes;
  } catch {
    return 0;
  }
}

/**
 * Move lead to a new stage if allowed. Logs status_change activity.
 * @returns {{ moved: boolean, from?: string, to?: string }}
 */
export function advanceLeadStage(leadId, nextStatus, { userId = null, force = false } = {}) {
  const to = normalizeStatus(nextStatus);
  if (!to || !LEAD_STATUSES.includes(to)) return { moved: false };

  const lead = db.prepare(`SELECT id, status FROM leads WHERE id = ?`).get(leadId);
  if (!lead) return { moved: false };

  const from = normalizeStatus(lead.status) || lead.status;
  if (from === to) return { moved: false, from, to };

  // Don't regress terminal / later stages unless forced
  if (!force) {
    const fromIdx = LEAD_STATUSES.indexOf(from);
    const toIdx = LEAD_STATUSES.indexOf(to);
    if (fromIdx >= 0 && toIdx >= 0 && toIdx < fromIdx) {
      // Allow nurture from any open stage
      if (to !== 'nurture') return { moved: false, from, to };
    }
  }

  const convertedAt =
    (to === 'paid' || to === 'repeat') && from !== 'paid' && from !== 'repeat'
      ? new Date().toISOString()
      : null;

  db.prepare(
    `UPDATE leads SET
       status = ?,
       converted_at = COALESCE(?, converted_at),
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(to, convertedAt, leadId);

  db.prepare(
    `INSERT INTO lead_activities (id, lead_id, user_id, type, summary, outcome)
     VALUES (?, ?, ?, 'status_change', ?, ?)`,
  ).run(uuid(), leadId, userId, `Status: ${from} → ${to}`, to);

  if (STOP_OUTREACH_STATUSES.includes(to)) {
    cancelScheduledOutreach(leadId, `Stage ${to} — automated outreach stopped`);
  }

  return { moved: true, from, to };
}

/** Mark last contacted + optionally advance uncontacted → contacted. */
export function touchLeadContacted(leadId, { userId = null, advance = true } = {}) {
  if (!leadId) return;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE leads
     SET last_contacted_at = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(now, leadId);

  if (!advance) return;
  const lead = db.prepare(`SELECT status FROM leads WHERE id = ?`).get(leadId);
  const status = normalizeStatus(lead?.status) || lead?.status;
  if (status === 'uncontacted' || status === 'new') {
    advanceLeadStage(leadId, 'contacted', { userId });
  }
}

/** On any reply: move early-stage leads to Engaged and stop outreach. */
export function onLeadReply(leadId, { userId = null } = {}) {
  if (!leadId) return { moved: false };
  const lead = db.prepare(`SELECT status FROM leads WHERE id = ?`).get(leadId);
  const status = normalizeStatus(lead?.status) || lead?.status;

  cancelScheduledOutreach(leadId, 'Reply received — outreach stopped');

  if (EARLY_STAGES.has(status) || status === 'contacted') {
    return advanceLeadStage(leadId, 'engaged', { userId, force: true });
  }
  return { moved: false, from: status };
}

/** Confirmed calendar demo → Demo scheduled. */
export function onDemoBooked(leadId, { userId = null } = {}) {
  return advanceLeadStage(leadId, 'demo_scheduled', { userId });
}
