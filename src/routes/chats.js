import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { authRequired, requireAnyPermission } from '../middleware/auth.js';
import { cohortSql, normalizeCohort, cohortRefDate } from '../lib/cohort.js';

const router = Router();
router.use(authRequired);

const TAWK_DASHBOARD = (process.env.TAWK_DASHBOARD_URL || 'https://dashboard.tawk.to/').replace(
  /\/$/,
  '',
);

/** Signup-day cohort for chats: prefer linked lead signup; else first chat day. */
function chatCohortClause(cohortRaw, date) {
  const cohort = normalizeCohort(cohortRaw);
  if (cohort === 'all') return { sql: '1=1', params: [] };
  const expr = `COALESCE(
    NULLIF(l.signed_up_at, ''),
    NULLIF(l.created_at, ''),
    NULLIF(c.started_at, ''),
    c.created_at
  )`;
  return cohortSql(expr, cohort, date);
}

function mapChatRow(r) {
  const transcript = safeJson(r.transcript_json, []);
  const crmReplies = safeJson(r.crm_replies_json, []);
  return {
    ...r,
    transcript,
    crmReplies,
    combinedMessages: [
      ...(Array.isArray(transcript) ? transcript : []),
      ...crmReplies.map((m) => ({
        n: m.agentName || 'CRM agent',
        t: 'agent',
        msg: m.message,
        at: m.createdAt,
        fromCrm: true,
      })),
    ],
    tawkDashboardUrl: TAWK_DASHBOARD,
    canReplyInCrm: true,
    replyHint:
      'Replies are saved in CRM for the team. The visitor still sees live messages in Tawk — open Tawk to deliver the same reply there (Tawk API cannot inject agent messages).',
    transcript_json: undefined,
    crm_replies_json: undefined,
    raw_json: undefined,
  };
}

router.get('/', requireAnyPermission('leads:view_all', 'leads:view_own'), (req, res) => {
  const { status, q, cohort: cohortRaw, date } = req.query;
  const clauses = ['1=1'];
  const params = [];

  if (status) {
    clauses.push('c.status = ?');
    params.push(status);
  }
  if (q) {
    clauses.push('(c.visitor_name LIKE ? OR c.visitor_email LIKE ? OR c.preview LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  const cohortPred = chatCohortClause(cohortRaw, date);
  if (cohortPred.sql !== '1=1') {
    clauses.push(cohortPred.sql);
    params.push(...cohortPred.params);
  }

  const rows = db
    .prepare(
      `SELECT c.*,
        l.signed_up_at AS lead_signed_up_at,
        l.source AS lead_source,
        l.name AS lead_name
       FROM chat_threads c
       LEFT JOIN leads l ON l.id = c.lead_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY COALESCE(c.started_at, c.created_at) DESC
       LIMIT 500`,
    )
    .all(...params);

  res.json(rows.map(mapChatRow));
});

router.get('/counts', requireAnyPermission('leads:view_all', 'leads:view_own'), (req, res) => {
  const cohort = normalizeCohort(req.query.cohort);
  const refDate = cohortRefDate(req.query.date);
  const cohortPred = chatCohortClause(cohort, refDate);
  const join = `FROM chat_threads c LEFT JOIN leads l ON l.id = c.lead_id`;
  const where = cohortPred.sql === '1=1' ? '1=1' : cohortPred.sql;
  const params = cohortPred.params;

  const total = db.prepare(`SELECT COUNT(*) AS c ${join} WHERE ${where}`).get(...params).c;
  const open = db
    .prepare(`SELECT COUNT(*) AS c ${join} WHERE c.status = 'open' AND (${where})`)
    .get(...params).c;
  const today = db
    .prepare(
      `SELECT COUNT(*) AS c ${join}
       WHERE date(COALESCE(c.started_at, c.created_at)) = date(?)
         AND (${where})`,
    )
    .get(refDate, ...params).c;
  res.json({ total, open, today, cohort, cohortDate: refDate });
});

router.get('/:id', requireAnyPermission('leads:view_all', 'leads:view_own'), (req, res) => {
  const row = db
    .prepare(
      `SELECT c.*, l.signed_up_at AS lead_signed_up_at, l.source AS lead_source, l.name AS lead_name
       FROM chat_threads c
       LEFT JOIN leads l ON l.id = c.lead_id
       WHERE c.id = ?`,
    )
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Chat not found' });
  res.json({
    ...mapChatRow(row),
    raw: safeJson(row.raw_json, null),
  });
});

/**
 * Save a telesales/CEO reply on the chat thread in CRM.
 * Also logs activity on the linked lead when present.
 * Live delivery to the website visitor still requires pasting/sending in Tawk.
 */
router.post('/:id/reply', requireAnyPermission('leads:view_all', 'leads:view_own'), (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message || message.length < 1) {
    return res.status(400).json({ error: 'message is required' });
  }
  if (message.length > 8000) {
    return res.status(400).json({ error: 'message too long' });
  }

  const row = db.prepare(`SELECT * FROM chat_threads WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Chat not found' });

  const replies = safeJson(row.crm_replies_json, []);
  const entry = {
    id: uuid(),
    message,
    createdAt: new Date().toISOString(),
    agentId: req.user.id,
    agentName: req.user.name || req.user.email,
    agentRole: req.user.role,
  };
  replies.push(entry);

  db.prepare(
    `UPDATE chat_threads
     SET crm_replies_json = ?,
         preview = ?,
         updated_at = datetime('now'),
         status = CASE WHEN status = 'closed' THEN 'open' ELSE status END
     WHERE id = ?`,
  ).run(JSON.stringify(replies), `CRM: ${message.slice(0, 180)}`, row.id);

  if (row.lead_id) {
    db.prepare(
      `INSERT INTO lead_activities (id, lead_id, user_id, type, summary)
       VALUES (?, ?, ?, 'note', ?)`,
    ).run(uuid(), row.lead_id, req.user.id, `Chat reply: ${message.slice(0, 500)}`);
  }

  const updated = db
    .prepare(
      `SELECT c.*, l.signed_up_at AS lead_signed_up_at, l.source AS lead_source, l.name AS lead_name
       FROM chat_threads c
       LEFT JOIN leads l ON l.id = c.lead_id
       WHERE c.id = ?`,
    )
    .get(row.id);

  res.status(201).json({
    ...mapChatRow(updated),
    savedReply: entry,
    deliveryNote:
      'Reply saved in CRM. Open Tawk to send this message to the visitor (Tawk cannot receive CRM replies automatically).',
  });
});

function safeJson(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export default router;
