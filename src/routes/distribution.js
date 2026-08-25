import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { authRequired, requirePermission } from '../middleware/auth.js';
import { OPEN_STATUSES } from '../lib/permissions.js';

const router = Router();
router.use(authRequired);

function assignOne(leadId, repId, byUserId) {
  const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(leadId);
  if (!lead) return { error: 'Lead not found', status: 404 };
  const rep = db
    .prepare(`SELECT id, name, role FROM users WHERE id = ? AND is_active = 1`)
    .get(repId);
  if (!rep || !['telesales', 'manager'].includes(rep.role)) {
    return { error: 'Invalid assignee', status: 400 };
  }
  db.prepare(
    `UPDATE leads SET
      assigned_to = ?, assigned_at = datetime('now'), assigned_by = ?,
      updated_at = datetime('now')
     WHERE id = ?`,
  ).run(repId, byUserId, leadId);
  db.prepare(
    `INSERT INTO lead_activities (id, lead_id, user_id, type, summary)
     VALUES (?, ?, ?, 'assigned', ?)`,
  ).run(uuid(), leadId, byUserId, `Assigned to ${rep.name}`);
  return { lead: db.prepare(`SELECT * FROM leads WHERE id = ?`).get(leadId) };
}

/** Manual assign one or many */
router.post('/assign', requirePermission('leads:assign'), (req, res) => {
  const { leadIds, assignedTo } = req.body || {};
  if (!assignedTo || !Array.isArray(leadIds) || !leadIds.length) {
    return res.status(400).json({ error: 'leadIds[] and assignedTo required' });
  }
  const results = [];
  const tx = db.transaction(() => {
    for (const id of leadIds) {
      results.push(assignOne(id, assignedTo, req.user.id));
    }
  });
  tx();
  const errors = results.filter((r) => r.error);
  if (errors.length && errors.length === results.length) {
    return res.status(errors[0].status || 400).json({ error: errors[0].error });
  }
  res.json({
    assigned: results.filter((r) => r.lead).length,
    results,
  });
});

/**
 * Distribute unassigned open leads.
 * mode: manual (with assignedTo), round_robin, workload
 */
router.post('/distribute', requirePermission('leads:assign'), (req, res) => {
  const { mode = 'round_robin', leadIds, assignedTo, limit = 50 } = req.body || {};
  const openList = OPEN_STATUSES.map(() => '?').join(',');

  let leads;
  if (Array.isArray(leadIds) && leadIds.length) {
    const placeholders = leadIds.map(() => '?').join(',');
    leads = db
      .prepare(`SELECT * FROM leads WHERE id IN (${placeholders})`)
      .all(...leadIds);
  } else {
    leads = db
      .prepare(
        `SELECT * FROM leads
         WHERE assigned_to IS NULL AND status IN (${openList})
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(...OPEN_STATUSES, Math.min(Number(limit) || 50, 500));
  }

  if (!leads.length) {
    return res.json({ assigned: 0, message: 'No leads to distribute' });
  }

  if (mode === 'manual') {
    if (!assignedTo) return res.status(400).json({ error: 'assignedTo required for manual' });
    const out = [];
    const tx = db.transaction(() => {
      for (const lead of leads) {
        out.push(assignOne(lead.id, assignedTo, req.user.id));
      }
    });
    tx();
    return res.json({ mode, assigned: out.filter((r) => r.lead).length });
  }

  const reps = db
    .prepare(
      `SELECT id, name FROM users WHERE role = 'telesales' AND is_active = 1 ORDER BY name`,
    )
    .all();
  if (!reps.length) {
    return res.status(400).json({ error: 'No active telesales reps' });
  }

  let assigned = 0;
  if (mode === 'round_robin') {
    let i = 0;
    const tx = db.transaction(() => {
      for (const lead of leads) {
        const rep = reps[i % reps.length];
        assignOne(lead.id, rep.id, req.user.id);
        i += 1;
        assigned += 1;
      }
    });
    tx();
  } else if (mode === 'workload') {
    const openPlaceholders = OPEN_STATUSES.map(() => '?').join(',');
    const loadStmt = db.prepare(
      `SELECT COUNT(*) AS c FROM leads
       WHERE assigned_to = ? AND status IN (${openPlaceholders})`,
    );
    const tx = db.transaction(() => {
      for (const lead of leads) {
        const loads = reps.map((r) => ({
          ...r,
          load: loadStmt.get(r.id, ...OPEN_STATUSES).c,
        }));
        loads.sort((a, b) => a.load - b.load);
        assignOne(lead.id, loads[0].id, req.user.id);
        assigned += 1;
      }
    });
    tx();
  } else {
    return res.status(400).json({ error: 'mode must be manual | round_robin | workload' });
  }

  res.json({ mode, assigned, repCount: reps.length });
});

router.get('/queue-stats', requirePermission('leads:assign'), (_req, res) => {
  const unassigned = db
    .prepare(
      `SELECT COUNT(*) AS c FROM leads WHERE assigned_to IS NULL AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`,
    )
    .get(...OPEN_STATUSES).c;

  const byRep = db
    .prepare(
      `SELECT u.id, u.name, u.email,
        SUM(CASE WHEN l.status IN ('new','contacted','follow_up_scheduled') THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN l.status = 'converted' THEN 1 ELSE 0 END) AS converted_count,
        COUNT(l.id) AS total_assigned
       FROM users u
       LEFT JOIN leads l ON l.assigned_to = u.id
       WHERE u.role = 'telesales' AND u.is_active = 1
       GROUP BY u.id
       ORDER BY open_count DESC, u.name`,
    )
    .all();

  res.json({ unassigned, byRep });
});

export default router;
