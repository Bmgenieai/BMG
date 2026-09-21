import { Router } from 'express';
import { db } from '../db.js';
import { authRequired, requireAnyPermission } from '../middleware/auth.js';

const router = Router();
router.use(authRequired);

router.get('/', requireAnyPermission('leads:view_all', 'leads:view_own'), (req, res) => {
  const { status, q, from, to } = req.query;
  const clauses = ['1=1'];
  const params = [];

  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (from) {
    clauses.push('scheduled_at >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('scheduled_at <= ?');
    params.push(to);
  }
  if (q) {
    clauses.push('(name LIKE ? OR email LIKE ? OR phone LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  const rows = db
    .prepare(
      `SELECT d.*, l.assigned_to, u.name AS assigned_name
       FROM demo_bookings d
       LEFT JOIN leads l ON l.id = d.lead_id
       LEFT JOIN users u ON u.id = l.assigned_to
       WHERE ${clauses.join(' AND ')}
       ORDER BY COALESCE(d.scheduled_at, d.created_at) DESC
       LIMIT 500`,
    )
    .all(...params);

  res.json(
    rows.map((r) => ({
      ...r,
      questions: safeJson(r.questions_json, []),
      raw: undefined,
      questions_json: undefined,
      raw_json: undefined,
    })),
  );
});

router.get('/counts', requireAnyPermission('leads:view_all', 'leads:view_own'), (_req, res) => {
  const total = db.prepare(`SELECT COUNT(*) AS c FROM demo_bookings`).get().c;
  const upcoming = db
    .prepare(
      `SELECT COUNT(*) AS c FROM demo_bookings
       WHERE status = 'scheduled' AND scheduled_at >= datetime('now')`,
    )
    .get().c;
  const today = db
    .prepare(
      `SELECT COUNT(*) AS c FROM demo_bookings
       WHERE date(scheduled_at) = date('now')`,
    )
    .get().c;
  res.json({ total, upcoming, today });
});

router.get('/:id', requireAnyPermission('leads:view_all', 'leads:view_own'), (req, res) => {
  const row = db
    .prepare(
      `SELECT d.*, l.assigned_to, u.name AS assigned_name, l.status AS lead_status
       FROM demo_bookings d
       LEFT JOIN leads l ON l.id = d.lead_id
       LEFT JOIN users u ON u.id = l.assigned_to
       WHERE d.id = ?`,
    )
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Demo booking not found' });
  res.json({
    ...row,
    questions: safeJson(row.questions_json, []),
    raw: safeJson(row.raw_json, null),
    questions_json: undefined,
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
