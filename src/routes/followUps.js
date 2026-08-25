import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { authRequired, requireAnyPermission } from '../middleware/auth.js';
import { canAccessLead, roleHasPermission } from '../lib/permissions.js';

const router = Router();
router.use(authRequired);

function markOverdue() {
  db.prepare(
    `UPDATE follow_ups SET status = 'overdue', updated_at = datetime('now')
     WHERE status = 'pending' AND due_at < datetime('now')`,
  ).run();
}

router.get('/', requireAnyPermission('followups:view_all', 'followups:view_own'), (req, res) => {
  markOverdue();
  const { status, mine } = req.query;
  const clauses = [];
  const params = [];

  if (!roleHasPermission(req.user.role, 'followups:view_all') || mine === '1') {
    clauses.push('f.assigned_to = ?');
    params.push(req.user.id);
  }
  if (status) {
    clauses.push('f.status = ?');
    params.push(status);
  }

  const where = clauses.length ? clauses.join(' AND ') : '1=1';
  const rows = db
    .prepare(
      `SELECT f.*,
        l.name AS lead_name, l.email AS lead_email, l.status AS lead_status, l.source AS lead_source,
        u.name AS assignee_name
       FROM follow_ups f
       JOIN leads l ON l.id = f.lead_id
       LEFT JOIN users u ON u.id = f.assigned_to
       WHERE ${where}
       ORDER BY
         CASE f.status WHEN 'overdue' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
         f.due_at ASC`,
    )
    .all(...params);
  res.json(rows);
});

router.post('/', requireAnyPermission('followups:manage_own', 'followups:manage_team'), (req, res) => {
  const { leadId, dueAt, note, assignedTo } = req.body || {};
  if (!leadId || !dueAt) {
    return res.status(400).json({ error: 'leadId and dueAt required' });
  }
  const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(leadId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const assignee = assignedTo || lead.assigned_to || req.user.id;
  if (
    !roleHasPermission(req.user.role, 'followups:manage_team') &&
    assignee !== req.user.id
  ) {
    return res.status(403).json({ error: 'Can only schedule your own follow-ups' });
  }
  if (!canAccessLead(req.user, lead) && !roleHasPermission(req.user.role, 'followups:manage_team')) {
    return res.status(403).json({ error: 'Permission denied' });
  }

  const id = uuid();
  db.prepare(
    `INSERT INTO follow_ups (id, lead_id, assigned_to, due_at, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, leadId, assignee, dueAt, note || null, req.user.id);

  db.prepare(
    `UPDATE leads SET
      next_follow_up_at = ?,
      status = CASE WHEN status = 'new' THEN 'follow_up_scheduled'
                   WHEN status = 'contacted' THEN 'follow_up_scheduled'
                   ELSE status END,
      updated_at = datetime('now')
     WHERE id = ?`,
  ).run(dueAt, leadId);

  db.prepare(
    `INSERT INTO lead_activities (id, lead_id, user_id, type, summary, next_follow_up_at)
     VALUES (?, ?, ?, 'follow_up_scheduled', ?, ?)`,
  ).run(uuid(), leadId, req.user.id, note || 'Follow-up scheduled', dueAt);

  res.status(201).json(db.prepare(`SELECT * FROM follow_ups WHERE id = ?`).get(id));
});

router.post(
  '/:id/complete',
  requireAnyPermission('followups:manage_own', 'followups:manage_team'),
  (req, res) => {
    const fu = db.prepare(`SELECT * FROM follow_ups WHERE id = ?`).get(req.params.id);
    if (!fu) return res.status(404).json({ error: 'Follow-up not found' });
    if (
      !roleHasPermission(req.user.role, 'followups:manage_team') &&
      fu.assigned_to !== req.user.id
    ) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    const { outcome, nextDueAt, note, leadStatus } = req.body || {};
    db.prepare(
      `UPDATE follow_ups SET status = 'completed', completed_at = datetime('now'),
        note = COALESCE(?, note), updated_at = datetime('now')
       WHERE id = ?`,
    ).run(note || null, fu.id);

    db.prepare(
      `INSERT INTO lead_activities (id, lead_id, user_id, type, summary, outcome, next_follow_up_at)
       VALUES (?, ?, ?, 'follow_up_completed', ?, ?, ?)`,
    ).run(
      uuid(),
      fu.lead_id,
      req.user.id,
      note || 'Follow-up completed',
      outcome || null,
      nextDueAt || null,
    );

    if (nextDueAt) {
      const nid = uuid();
      db.prepare(
        `INSERT INTO follow_ups (id, lead_id, assigned_to, due_at, note, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(nid, fu.lead_id, fu.assigned_to, nextDueAt, 'Auto next follow-up', req.user.id);
      db.prepare(
        `UPDATE leads SET next_follow_up_at = ?, status = 'follow_up_scheduled', updated_at = datetime('now')
         WHERE id = ?`,
      ).run(nextDueAt, fu.lead_id);
    } else if (leadStatus) {
      db.prepare(
        `UPDATE leads SET status = ?, updated_at = datetime('now'),
          converted_at = CASE WHEN ? = 'converted' THEN datetime('now') ELSE converted_at END
         WHERE id = ?`,
      ).run(leadStatus, leadStatus, fu.lead_id);
    }

    res.json(db.prepare(`SELECT * FROM follow_ups WHERE id = ?`).get(fu.id));
  },
);

router.post(
  '/:id/reschedule',
  requireAnyPermission('followups:manage_own', 'followups:manage_team'),
  (req, res) => {
    const fu = db.prepare(`SELECT * FROM follow_ups WHERE id = ?`).get(req.params.id);
    if (!fu) return res.status(404).json({ error: 'Follow-up not found' });
    if (
      !roleHasPermission(req.user.role, 'followups:manage_team') &&
      fu.assigned_to !== req.user.id
    ) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    const { dueAt, note } = req.body || {};
    if (!dueAt) return res.status(400).json({ error: 'dueAt required' });
    db.prepare(
      `UPDATE follow_ups SET due_at = ?, status = 'pending', note = COALESCE(?, note),
        updated_at = datetime('now') WHERE id = ?`,
    ).run(dueAt, note || null, fu.id);
    db.prepare(
      `UPDATE leads SET next_follow_up_at = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(dueAt, fu.lead_id);
    res.json(db.prepare(`SELECT * FROM follow_ups WHERE id = ?`).get(fu.id));
  },
);

router.post(
  '/:id/cancel',
  requireAnyPermission('followups:manage_own', 'followups:manage_team'),
  (req, res) => {
    const fu = db.prepare(`SELECT * FROM follow_ups WHERE id = ?`).get(req.params.id);
    if (!fu) return res.status(404).json({ error: 'Follow-up not found' });
    if (
      !roleHasPermission(req.user.role, 'followups:manage_team') &&
      fu.assigned_to !== req.user.id
    ) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    db.prepare(
      `UPDATE follow_ups SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`,
    ).run(fu.id);
    res.json({ ok: true });
  },
);

export default router;
