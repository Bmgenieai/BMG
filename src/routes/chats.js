import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { authRequired, requirePermission } from '../middleware/auth.js';
import { cohortSql, normalizeCohort, cohortRefDate } from '../lib/cohort.js';
import { postBmgenieJson } from '../lib/bmgenieApi.js';
import { roleHasPermission } from '../lib/permissions.js';

const router = Router();
router.use(authRequired);

const CHAT_SELECT = `SELECT c.*,
        u.name AS assigned_to_name,
        u.email AS assigned_to_email,
        l.signed_up_at AS lead_signed_up_at,
        l.source AS lead_source,
        l.name AS lead_name
       FROM chat_threads c
       LEFT JOIN users u ON u.id = c.assigned_to_user_id
       LEFT JOIN leads l ON l.id = c.lead_id`;

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

function safeJson(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function canReplyToThread(user, row) {
  if (!roleHasPermission(user.role, 'chats:reply')) return false;
  if (user.role === 'ceo') return true;
  if (!row.assigned_to_user_id) return false;
  return row.assigned_to_user_id === user.id;
}

function mapChatRow(r, user) {
  const transcript = safeJson(r.transcript_json, []);
  const crmReplies = safeJson(r.crm_replies_json, []);
  const isBmgenie = (r.provider || '') === 'bmgenie';
  const mappedTranscript = Array.isArray(transcript)
    ? transcript.map((m) => ({
        id: m.id,
        n: m.n || m.role || m.t || 'msg',
        t: m.t || m.role,
        role: m.role || m.t,
        msg: m.msg || m.message || m.body || m.text,
        at: m.at || m.createdAt,
        fromCrm: m.role === 'agent' || m.t === 'agent',
        agentId: m.agentId || null,
        agentName: m.agentName || (m.role === 'agent' || m.t === 'agent' ? m.n : null),
      }))
    : [];
  const mappedCrm = isBmgenie
    ? []
    : (Array.isArray(crmReplies) ? crmReplies : []).map((m) => ({
        n: m.agentName || 'CRM agent',
        t: 'agent',
        role: 'agent',
        msg: m.message,
        at: m.createdAt,
        fromCrm: true,
        agentId: m.agentId || null,
        agentName: m.agentName || null,
      }));

  const assignedToUserId = r.assigned_to_user_id || null;
  const isMine = user && assignedToUserId === user.id;
  const isClaimedByOther =
    Boolean(assignedToUserId) && user && assignedToUserId !== user.id;
  const canReply = user ? canReplyToThread(user, r) : false;

  return {
    ...r,
    transcript,
    crmReplies,
    combinedMessages: [...mappedTranscript, ...mappedCrm],
    liveDelivery: isBmgenie,
    canReplyInCrm: canReply,
    isMine: Boolean(isMine),
    isClaimedByOther: Boolean(isClaimedByOther),
    assignedTo: assignedToUserId
      ? {
          id: assignedToUserId,
          name: r.assigned_to_name || 'Agent',
          email: r.assigned_to_email || null,
          at: r.assigned_at || null,
        }
      : null,
    replyHint: !roleHasPermission(user?.role, 'chats:reply')
      ? 'View only — ask Chat Support or CEO to reply.'
      : isClaimedByOther && user?.role !== 'ceo'
        ? `Claimed by ${r.assigned_to_name || 'another agent'} — you cannot reply.`
        : !assignedToUserId && user?.role === 'chat_support'
          ? 'Take this chat before replying so other agents know it is yours.'
          : isBmgenie
            ? 'Replies are delivered live to the visitor’s website chat.'
            : 'Legacy Tawk thread — replies are saved in CRM only.',
    transcript_json: undefined,
    crm_replies_json: undefined,
    raw_json: undefined,
    assigned_to_name: undefined,
    assigned_to_email: undefined,
  };
}

function fetchChat(id) {
  return db.prepare(`${CHAT_SELECT} WHERE c.id = ?`).get(id);
}

/** Atomically claim if unassigned (or already mine). Returns updated row or null on race loss. */
function tryClaim(chatId, user) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE chat_threads
       SET assigned_to_user_id = ?,
           assigned_at = COALESCE(assigned_at, ?),
           mode = 'human',
           status = CASE
             WHEN status = 'waiting_human' THEN 'human_active'
             WHEN status = 'closed' THEN status
             ELSE 'human_active'
           END,
           updated_at = datetime('now')
       WHERE id = ?
         AND (assigned_to_user_id IS NULL OR assigned_to_user_id = ?)`,
    )
    .run(user.id, now, chatId, user.id);
  if (result.changes === 0) return null;
  return fetchChat(chatId);
}

router.get('/', requirePermission('chats:view'), (req, res) => {
  const { status, q, cohort: cohortRaw, date, mode, assignee } = req.query;
  const clauses = ['1=1'];
  const params = [];

  if (status) {
    clauses.push('c.status = ?');
    params.push(status);
  }
  if (mode) {
    clauses.push('c.mode = ?');
    params.push(mode);
  }
  if (assignee === 'me') {
    clauses.push('c.assigned_to_user_id = ?');
    params.push(req.user.id);
  } else if (assignee === 'unassigned') {
    clauses.push('c.assigned_to_user_id IS NULL');
  } else if (assignee === 'others') {
    clauses.push('c.assigned_to_user_id IS NOT NULL AND c.assigned_to_user_id != ?');
    params.push(req.user.id);
  }
  if (q) {
    clauses.push(
      '(c.visitor_name LIKE ? OR c.visitor_email LIKE ? OR c.preview LIKE ? OR c.visitor_city LIKE ? OR c.visitor_country LIKE ?)',
    );
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }

  const cohortPred = chatCohortClause(cohortRaw, date);
  if (cohortPred.sql !== '1=1') {
    clauses.push(cohortPred.sql);
    params.push(...cohortPred.params);
  }

  const rows = db
    .prepare(
      `${CHAT_SELECT}
       WHERE ${clauses.join(' AND ')}
       ORDER BY COALESCE(c.started_at, c.created_at) DESC
       LIMIT 500`,
    )
    .all(...params);

  res.json(rows.map((r) => mapChatRow(r, req.user)));
});

router.get('/counts', requirePermission('chats:view'), (req, res) => {
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
  const waitingHuman = db
    .prepare(
      `SELECT COUNT(*) AS c ${join} WHERE c.status = 'waiting_human' AND (${where})`,
    )
    .get(...params).c;
  const waitingUnassigned = db
    .prepare(
      `SELECT COUNT(*) AS c ${join}
       WHERE c.status = 'waiting_human'
         AND c.assigned_to_user_id IS NULL
         AND (${where})`,
    )
    .get(...params).c;
  const mine = db
    .prepare(
      `SELECT COUNT(*) AS c ${join}
       WHERE c.assigned_to_user_id = ?
         AND c.status IN ('waiting_human','human_active','open')
         AND (${where})`,
    )
    .get(req.user.id, ...params).c;
  const humanActive = db
    .prepare(
      `SELECT COUNT(*) AS c ${join} WHERE c.status = 'human_active' AND (${where})`,
    )
    .get(...params).c;
  const today = db
    .prepare(
      `SELECT COUNT(*) AS c ${join}
       WHERE date(COALESCE(c.started_at, c.created_at)) = date(?)
         AND (${where})`,
    )
    .get(refDate, ...params).c;
  res.json({
    total,
    open,
    waitingHuman,
    waitingUnassigned,
    mine,
    humanActive,
    today,
    cohort,
    cohortDate: refDate,
  });
});

router.get('/:id', requirePermission('chats:view'), (req, res) => {
  const row = fetchChat(req.params.id);
  if (!row) return res.status(404).json({ error: 'Chat not found' });
  res.json({
    ...mapChatRow(row, req.user),
    raw: safeJson(row.raw_json, null),
  });
});

/** Take ownership of a waiting / unassigned chat (race-safe). */
router.post('/:id/claim', requirePermission('chats:reply'), (req, res) => {
  const row = db.prepare(`SELECT * FROM chat_threads WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Chat not found' });

  if (row.assigned_to_user_id && row.assigned_to_user_id !== req.user.id) {
    const holder = db
      .prepare(`SELECT name FROM users WHERE id = ?`)
      .get(row.assigned_to_user_id);
    return res.status(409).json({
      error: `Already claimed by ${holder?.name || 'another agent'}`,
      assignedToName: holder?.name || null,
    });
  }

  const updated = tryClaim(req.params.id, req.user);
  if (!updated) {
    return res.status(409).json({ error: 'Chat was just claimed by another agent' });
  }

  res.json(mapChatRow(updated, req.user));
});

/** Release claim so another Chat Support agent can take it. */
router.post('/:id/release', requirePermission('chats:reply'), (req, res) => {
  const row = db.prepare(`SELECT * FROM chat_threads WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Chat not found' });

  const isCeo = req.user.role === 'ceo';
  if (!isCeo && row.assigned_to_user_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the assigned agent or CEO can release this chat' });
  }
  if (!row.assigned_to_user_id) {
    return res.json(mapChatRow(fetchChat(row.id), req.user));
  }

  db.prepare(
    `UPDATE chat_threads
     SET assigned_to_user_id = NULL,
         assigned_at = NULL,
         status = CASE WHEN status = 'human_active' THEN 'waiting_human' ELSE status END,
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(row.id);

  res.json(mapChatRow(fetchChat(row.id), req.user));
});

/**
 * Reply to visitor. For bmgenie provider, deliver live to the website chatbot.
 * Chat Support must own the thread (auto-claims if still unassigned). CEO always allowed.
 */
router.post('/:id/reply', requirePermission('chats:reply'), async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message || message.length < 1) {
    return res.status(400).json({ error: 'message is required' });
  }
  if (message.length > 8000) {
    return res.status(400).json({ error: 'message too long' });
  }

  let row = db.prepare(`SELECT * FROM chat_threads WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Chat not found' });

  const isCeo = req.user.role === 'ceo';
  if (!isCeo) {
    if (row.assigned_to_user_id && row.assigned_to_user_id !== req.user.id) {
      const holder = db
        .prepare(`SELECT name FROM users WHERE id = ?`)
        .get(row.assigned_to_user_id);
      return res.status(409).json({
        error: `This chat is handled by ${holder?.name || 'another agent'}`,
      });
    }
    if (!row.assigned_to_user_id) {
      const claimed = tryClaim(row.id, req.user);
      if (!claimed) {
        return res.status(409).json({ error: 'Chat was just claimed by another agent' });
      }
      row = db.prepare(`SELECT * FROM chat_threads WHERE id = ?`).get(row.id);
    }
  } else if (!row.assigned_to_user_id) {
    // CEO reply also stamps ownership so Chat Support sees who took it
    tryClaim(row.id, req.user);
    row = db.prepare(`SELECT * FROM chat_threads WHERE id = ?`).get(row.id);
  }

  const entry = {
    id: uuid(),
    message,
    createdAt: new Date().toISOString(),
    agentId: req.user.id,
    agentName: req.user.name || req.user.email,
    agentRole: req.user.role,
  };

  if (row.provider === 'bmgenie' && row.external_chat_id) {
    const delivered = await postBmgenieJson(
      `/support-chat/internal/sessions/${row.external_chat_id}/agent-reply`,
      {
        message,
        agentName: entry.agentName,
        agentId: entry.agentId,
      },
    );
    if (!delivered.ok) {
      return res.status(502).json({
        error: delivered.error || 'Failed to deliver reply to website visitor',
      });
    }

    const replies = safeJson(row.crm_replies_json, []);
    replies.push(entry);
    const transcript = Array.isArray(delivered.data?.messages)
      ? delivered.data.messages.map((m) => ({
          id: m.id,
          role: m.role,
          n:
            m.role === 'visitor'
              ? 'Visitor'
              : m.role === 'ai'
                ? 'AI'
                : m.role === 'agent'
                  ? m.agentName || 'Agent'
                  : 'System',
          t: m.role,
          msg: m.body,
          at: m.createdAt,
          agentId: m.agentId || (m.role === 'agent' ? entry.agentId : null),
          agentName: m.agentName || (m.role === 'agent' ? entry.agentName : null),
        }))
      : safeJson(row.transcript_json, []);

    db.prepare(
      `UPDATE chat_threads
       SET crm_replies_json = ?,
           transcript_json = ?,
           preview = ?,
           mode = 'human',
           status = 'human_active',
           updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      JSON.stringify(replies),
      JSON.stringify(transcript),
      `CRM: ${message.slice(0, 180)}`,
      row.id,
    );
  } else {
    const replies = safeJson(row.crm_replies_json, []);
    replies.push(entry);
    db.prepare(
      `UPDATE chat_threads
       SET crm_replies_json = ?,
           preview = ?,
           updated_at = datetime('now'),
           mode = 'human',
           status = CASE WHEN status = 'closed' THEN 'open' ELSE 'human_active' END
       WHERE id = ?`,
    ).run(JSON.stringify(replies), `CRM: ${message.slice(0, 180)}`, row.id);
  }

  if (row.lead_id) {
    db.prepare(
      `INSERT INTO lead_activities (id, lead_id, user_id, type, summary)
       VALUES (?, ?, ?, 'note', ?)`,
    ).run(uuid(), row.lead_id, req.user.id, `Chat reply: ${message.slice(0, 500)}`);
  }

  const updated = fetchChat(row.id);

  res.status(201).json({
    ...mapChatRow(updated, req.user),
    savedReply: entry,
    deliveryNote:
      row.provider === 'bmgenie'
        ? 'Reply delivered to the visitor’s website chat.'
        : 'Reply saved in CRM (legacy thread).',
  });
});

export default router;
