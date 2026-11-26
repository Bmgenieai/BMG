import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { authRequired } from '../middleware/auth.js';

const router = Router();
router.use(authRequired);

const CONNECTED_OUTCOMES = new Set([
  'connected_not_interested',
  'connected_callback',
  'connected_interested',
  'demo_booked',
]);

const CALLBACK_OUTCOMES = new Set(['busy_callback', 'connected_callback']);

function isAdminViewer(user) {
  return user?.role === 'ceo' || user?.role === 'manager';
}

function normalizeIsoDate(raw, fallbackNow = false) {
  if (!raw || !String(raw).trim()) {
    return fallbackNow ? new Date().toISOString() : null;
  }
  const d = new Date(String(raw).trim());
  if (Number.isNaN(d.getTime())) {
    return fallbackNow ? new Date().toISOString() : null;
  }
  return d.toISOString();
}

/**
 * List personal cold-calling activity.
 * Callers & BDs strictly see their own personal cold calls.
 * CEO / Manager see all (or can pass ?mine=1 or ?userId=...).
 */
router.get('/', (req, res) => {
  const { q, outcome, dateFrom, dateTo, followUpOnly, userId, mine } = req.query;
  const clauses = [];
  const params = [];

  if (!isAdminViewer(req.user) || mine === '1' || mine === 'true') {
    clauses.push('c.user_id = ?');
    params.push(req.user.id);
  } else if (userId) {
    clauses.push('c.user_id = ?');
    params.push(String(userId));
  }

  if (outcome) {
    clauses.push('c.call_outcome = ?');
    params.push(String(outcome));
  }
  if (q && String(q).trim()) {
    const like = `%${String(q).trim()}%`;
    clauses.push(
      `(c.contact_name LIKE ? OR COALESCE(c.company,'') LIKE ? OR c.phone LIKE ? OR COALESCE(c.follow_up_notes,'') LIKE ?)`,
    );
    params.push(like, like, like, like);
  }
  if (dateFrom) {
    clauses.push(`date(REPLACE(REPLACE(c.call_date,'T',' '),'Z','')) >= date(?)`);
    params.push(String(dateFrom));
  }
  if (dateTo) {
    clauses.push(`date(REPLACE(REPLACE(c.call_date,'T',' '),'Z','')) <= date(?)`);
    params.push(String(dateTo));
  }
  if (followUpOnly === '1' || followUpOnly === 'true') {
    clauses.push(`(c.follow_up_date IS NOT NULL AND TRIM(c.follow_up_date) != '')`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const items = db
    .prepare(
      `SELECT c.*, u.name AS user_name
       FROM cold_call_logs c
       LEFT JOIN users u ON u.id = c.user_id
       ${where}
       ORDER BY datetime(REPLACE(REPLACE(c.call_date,'T',' '),'Z','')) DESC, c.created_at DESC
       LIMIT 1000`,
    )
    .all(...params);

  const todayYmd = new Date().toISOString().slice(0, 10);
  const stats = {
    total: items.length,
    today: items.filter((r) => String(r.call_date || '').slice(0, 10) === todayYmd).length,
    connected: items.filter((r) => CONNECTED_OUTCOMES.has(r.call_outcome)).length,
    callbacks: items.filter(
      (r) => CALLBACK_OUTCOMES.has(r.call_outcome) || Boolean(r.follow_up_date),
    ).length,
    interested: items.filter((r) => r.call_outcome === 'connected_interested').length,
    demosBooked: items.filter((r) => r.call_outcome === 'demo_booked').length,
  };

  res.json({ items, stats });
});

/** Log a new personal cold call. */
router.post('/', (req, res) => {
  const {
    contact_name,
    company,
    phone,
    call_date,
    call_outcome,
    follow_up_notes,
    follow_up_date,
  } = req.body || {};

  const name = String(contact_name || '').trim();
  const phoneClean = String(phone || '').trim();
  const outcome = String(call_outcome || '').trim();

  if (!name) return res.status(400).json({ error: 'Contact name is required' });
  if (!phoneClean) return res.status(400).json({ error: 'Phone number is required' });
  if (!outcome) return res.status(400).json({ error: 'Call outcome is required' });

  const id = uuid();
  const callDateIso = normalizeIsoDate(call_date, true);
  const followUpDateIso = normalizeIsoDate(follow_up_date, false);

  db.prepare(
    `INSERT INTO cold_call_logs (
       id, user_id, contact_name, company, phone, call_date,
       call_outcome, follow_up_notes, follow_up_date
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    req.user.id,
    name,
    company ? String(company).trim() : null,
    phoneClean,
    callDateIso,
    outcome,
    follow_up_notes ? String(follow_up_notes).trim() : null,
    followUpDateIso,
  );

  const created = db
    .prepare(
      `SELECT c.*, u.name AS user_name
       FROM cold_call_logs c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.id = ?`,
    )
    .get(id);
  res.status(201).json(created);
});

/** Update an existing cold call record (owner or CEO). */
router.patch('/:id', (req, res) => {
  const existing = db.prepare(`SELECT * FROM cold_call_logs WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Cold call record not found' });
  if (existing.user_id !== req.user.id && req.user.role !== 'ceo') {
    return res.status(403).json({ error: 'Permission denied' });
  }

  const body = req.body || {};
  const name =
    body.contact_name !== undefined ? String(body.contact_name || '').trim() : existing.contact_name;
  const phoneClean =
    body.phone !== undefined ? String(body.phone || '').trim() : existing.phone;
  const outcome =
    body.call_outcome !== undefined ? String(body.call_outcome || '').trim() : existing.call_outcome;
  if (!name) return res.status(400).json({ error: 'Contact name is required' });
  if (!phoneClean) return res.status(400).json({ error: 'Phone number is required' });
  if (!outcome) return res.status(400).json({ error: 'Call outcome is required' });

  const company =
    body.company !== undefined ? (body.company ? String(body.company).trim() : null) : existing.company;
  const callDate =
    body.call_date !== undefined ? normalizeIsoDate(body.call_date, true) : existing.call_date;
  const followUpNotes =
    body.follow_up_notes !== undefined
      ? body.follow_up_notes
        ? String(body.follow_up_notes).trim()
        : null
      : existing.follow_up_notes;
  const followUpDate =
    body.follow_up_date !== undefined
      ? normalizeIsoDate(body.follow_up_date, false)
      : existing.follow_up_date;

  db.prepare(
    `UPDATE cold_call_logs
     SET contact_name = ?, company = ?, phone = ?, call_date = ?,
         call_outcome = ?, follow_up_notes = ?, follow_up_date = ?,
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(name, company, phoneClean, callDate, outcome, followUpNotes, followUpDate, existing.id);

  const updated = db
    .prepare(
      `SELECT c.*, u.name AS user_name
       FROM cold_call_logs c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.id = ?`,
    )
    .get(existing.id);
  res.json(updated);
});

/** Delete a cold call record (owner or CEO). */
router.delete('/:id', (req, res) => {
  const existing = db.prepare(`SELECT * FROM cold_call_logs WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Cold call record not found' });
  if (existing.user_id !== req.user.id && req.user.role !== 'ceo') {
    return res.status(403).json({ error: 'Permission denied' });
  }
  db.prepare(`DELETE FROM cold_call_logs WHERE id = ?`).run(existing.id);
  res.json({ ok: true, id: existing.id });
});

export default router;
