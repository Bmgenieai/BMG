import { Router } from 'express';
import { db } from '../db.js';
import { authRequired, requireAnyPermission } from '../middleware/auth.js';
import { cohortSql, normalizeCohort, cohortRefDate } from '../lib/cohort.js';

const router = Router();
router.use(authRequired);

router.get('/', requireAnyPermission('leads:view_all', 'leads:view_own'), (req, res) => {
  const { status, q, from, to, cohort: cohortRaw, date } = req.query;
  const clauses = ['1=1'];
  const params = [];

  if (status) {
    clauses.push('d.status = ?');
    params.push(status);
  }
  if (from) {
    clauses.push('d.scheduled_at >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('d.scheduled_at <= ?');
    params.push(to);
  }
  if (q) {
    clauses.push('(d.name LIKE ? OR d.email LIKE ? OR d.phone LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  const cohortPred = cohortSql(
    `COALESCE(NULLIF(l.signed_up_at, ''), NULLIF(l.created_at, ''), d.created_at)`,
    cohortRaw,
    date,
  );
  if (cohortPred.sql !== '1=1') {
    clauses.push(cohortPred.sql);
    params.push(...cohortPred.params);
  }

  const rows = db
    .prepare(
      `SELECT d.*, l.assigned_to, u.name AS assigned_name, l.signed_up_at AS lead_signed_up_at
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

router.get('/counts', requireAnyPermission('leads:view_all', 'leads:view_own'), (req, res) => {
  const cohort = normalizeCohort(req.query.cohort);
  const refDate = cohortRefDate(req.query.date);
  const cohortPred = cohortSql(
    `COALESCE(NULLIF(l.signed_up_at, ''), NULLIF(l.created_at, ''), d.created_at)`,
    cohort,
    refDate,
  );
  const join = `FROM demo_bookings d LEFT JOIN leads l ON l.id = d.lead_id`;
  const where = cohortPred.sql === '1=1' ? '1=1' : cohortPred.sql;
  const params = cohortPred.params;

  const total = db.prepare(`SELECT COUNT(*) AS c ${join} WHERE ${where}`).get(...params).c;
  const upcoming = db
    .prepare(
      `SELECT COUNT(*) AS c ${join}
       WHERE d.status = 'scheduled' AND d.scheduled_at >= datetime('now') AND (${where})`,
    )
    .get(...params).c;
  const today = db
    .prepare(
      `SELECT COUNT(*) AS c ${join}
       WHERE date(d.scheduled_at) = date(?) AND (${where})`,
    )
    .get(refDate, ...params).c;
  res.json({ total, upcoming, today, cohort, cohortDate: refDate });
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
