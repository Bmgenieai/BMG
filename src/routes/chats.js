import { Router } from 'express';
import { db } from '../db.js';
import { authRequired, requireAnyPermission } from '../middleware/auth.js';

const router = Router();
router.use(authRequired);

const TAWK_DASHBOARD = (process.env.TAWK_DASHBOARD_URL || 'https://dashboard.tawk.to/').replace(
  /\/$/,
  '',
);

router.get('/', requireAnyPermission('leads:view_all', 'leads:view_own'), (req, res) => {
  const { status, q } = req.query;
  const clauses = ['1=1'];
  const params = [];

  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (q) {
    clauses.push('(visitor_name LIKE ? OR visitor_email LIKE ? OR preview LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  const rows = db
    .prepare(
      `SELECT * FROM chat_threads
       WHERE ${clauses.join(' AND ')}
       ORDER BY COALESCE(started_at, created_at) DESC
       LIMIT 500`,
    )
    .all(...params);

  res.json(
    rows.map((r) => ({
      ...r,
      transcript: safeJson(r.transcript_json, []),
      tawkDashboardUrl: TAWK_DASHBOARD,
      transcript_json: undefined,
      raw_json: undefined,
    })),
  );
});

router.get('/counts', requireAnyPermission('leads:view_all', 'leads:view_own'), (_req, res) => {
  const total = db.prepare(`SELECT COUNT(*) AS c FROM chat_threads`).get().c;
  const open = db.prepare(`SELECT COUNT(*) AS c FROM chat_threads WHERE status = 'open'`).get().c;
  const today = db
    .prepare(
      `SELECT COUNT(*) AS c FROM chat_threads
       WHERE date(COALESCE(started_at, created_at)) = date('now')`,
    )
    .get().c;
  res.json({ total, open, today });
});

router.get('/:id', requireAnyPermission('leads:view_all', 'leads:view_own'), (req, res) => {
  const row = db.prepare(`SELECT * FROM chat_threads WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Chat not found' });
  res.json({
    ...row,
    transcript: safeJson(row.transcript_json, []),
    raw: safeJson(row.raw_json, null),
    tawkDashboardUrl: TAWK_DASHBOARD,
    replyHint:
      'Tawk.to does not allow CRM to send agent replies via API. Open the Tawk dashboard to reply.',
    transcript_json: undefined,
    raw_json: undefined,
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
