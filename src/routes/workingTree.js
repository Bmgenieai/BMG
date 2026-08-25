import { Router } from 'express';
import { db } from '../db.js';
import { authRequired, requireAnyPermission } from '../middleware/auth.js';
import { OPEN_STATUSES, END_STATUSES, roleHasPermission } from '../lib/permissions.js';

const router = Router();
router.use(authRequired);

function toneFor(status, overdueCount) {
  if (status === 'converted') return 'green';
  if (status === 'lost') return 'grey';
  if (overdueCount > 0) return 'red';
  if (status === 'follow_up_scheduled' || status === 'contacted') return 'amber';
  return 'blue';
}

/**
 * Working tree — hierarchical pending work for CEO / Manager / Telesales.
 * Inspired by Ilaan CRM accountability trees, adapted to BMGenie lead pipeline.
 */
router.get('/', requireAnyPermission(
  'working_tree:view_all',
  'working_tree:view_team',
  'working_tree:view_own',
), (req, res) => {
  const scope = req.query.scope || 'auto'; // auto | all | team | own
  const userId = req.query.userId;

  let mode = scope;
  if (scope === 'auto') {
    if (roleHasPermission(req.user.role, 'working_tree:view_all')) mode = 'all';
    else if (roleHasPermission(req.user.role, 'working_tree:view_team')) mode = 'team';
    else mode = 'own';
  }

  if (mode === 'all' && !roleHasPermission(req.user.role, 'working_tree:view_all')) {
    return res.status(403).json({ error: 'Permission denied' });
  }
  if (mode === 'team' && !roleHasPermission(req.user.role, 'working_tree:view_team')) {
    return res.status(403).json({ error: 'Permission denied' });
  }

  const reps = db
    .prepare(
      `SELECT id, name, email, role FROM users
       WHERE is_active = 1 AND role IN ('telesales','manager')
       ORDER BY role DESC, name`,
    )
    .all()
    .filter((u) => {
      if (mode === 'own') return u.id === req.user.id;
      if (mode === 'team' && userId) return u.id === userId;
      if (mode === 'own' || (mode === 'team' && req.user.role === 'telesales')) {
        return u.id === req.user.id;
      }
      return true;
    });

  const statusCounts = db.prepare(
    `SELECT status, COUNT(*) AS c FROM leads
     WHERE assigned_to = ? GROUP BY status`,
  );
  const overdueFu = db.prepare(
    `SELECT COUNT(*) AS c FROM follow_ups
     WHERE assigned_to = ? AND status IN ('pending','overdue') AND due_at < datetime('now')`,
  );
  const pendingFu = db.prepare(
    `SELECT COUNT(*) AS c FROM follow_ups
     WHERE assigned_to = ? AND status = 'pending'`,
  );
  const dueToday = db.prepare(
    `SELECT COUNT(*) AS c FROM follow_ups
     WHERE assigned_to = ? AND status IN ('pending','overdue')
       AND date(due_at) = date('now')`,
  );

  const people = reps.map((rep) => {
    const byStatus = Object.fromEntries(
      statusCounts.all(rep.id).map((r) => [r.status, r.c]),
    );
    const open = OPEN_STATUSES.reduce((s, st) => s + (byStatus[st] || 0), 0);
    const ended = END_STATUSES.reduce((s, st) => s + (byStatus[st] || 0), 0);
    const overdue = overdueFu.get(rep.id).c;
    const pending = pendingFu.get(rep.id).c;
    const today = dueToday.get(rep.id).c;

    const buckets = [
      ...OPEN_STATUSES.map((st) => ({
        key: st,
        label: st.replace(/_/g, ' '),
        count: byStatus[st] || 0,
        kind: 'open',
        tone: toneFor(st, overdue),
      })),
      ...END_STATUSES.map((st) => ({
        key: st,
        label: st.replace(/_/g, ' '),
        count: byStatus[st] || 0,
        kind: 'ended',
        tone: toneFor(st, 0),
      })),
      {
        key: 'followups_overdue',
        label: 'Overdue follow-ups',
        count: overdue,
        kind: 'attention',
        tone: overdue ? 'red' : 'green',
      },
      {
        key: 'followups_pending',
        label: 'Pending follow-ups',
        count: pending,
        kind: 'open',
        tone: 'amber',
      },
      {
        key: 'followups_today',
        label: 'Due today',
        count: today,
        kind: 'attention',
        tone: today ? 'amber' : 'green',
      },
    ];

    return {
      user: rep,
      totals: { open, ended, overdue, pending, today },
      buckets,
    };
  });

  const unassigned = db
    .prepare(
      `SELECT COUNT(*) AS c FROM leads
       WHERE assigned_to IS NULL AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`,
    )
    .get(...OPEN_STATUSES).c;

  const summary = {
    people: people.length,
    openLeads: people.reduce((s, p) => s + p.totals.open, 0),
    overdueFollowUps: people.reduce((s, p) => s + p.totals.overdue, 0),
    dueToday: people.reduce((s, p) => s + p.totals.today, 0),
    unassigned,
  };

  res.json({ mode, summary, people, unassignedPool: unassigned });
});

/**
 * Drill-down: list leads (or follow-up rows) for a working-tree bucket.
 * Query: bucket, userId? (optional — omit for team/all aggregate)
 */
router.get('/leads', requireAnyPermission(
  'working_tree:view_all',
  'working_tree:view_team',
  'working_tree:view_own',
), (req, res) => {
  const { bucket, userId } = req.query;
  if (!bucket) {
    return res.status(400).json({ error: 'bucket required' });
  }

  const canAll = roleHasPermission(req.user.role, 'working_tree:view_all');
  const canTeam = roleHasPermission(req.user.role, 'working_tree:view_team');

  let assigneeFilter = null;
  if (userId) {
    if (!canAll && !canTeam && userId !== req.user.id) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    if (!canAll && canTeam && req.user.role === 'telesales' && userId !== req.user.id) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    assigneeFilter = userId;
  } else if (!canAll && !canTeam) {
    assigneeFilter = req.user.id;
  } else if (!canAll && canTeam && req.user.role === 'telesales') {
    assigneeFilter = req.user.id;
  }

  const leadCols = `l.id, l.name, l.email, l.phone, l.company, l.country, l.source, l.status,
    l.assigned_to, l.next_follow_up_at, l.estimated_value, l.created_at,
    u.name AS assigned_name`;

  const leadJoin = `FROM leads l LEFT JOIN users u ON u.id = l.assigned_to`;

  let rows = [];
  let title = String(bucket).replace(/_/g, ' ');

  if (bucket === 'unassigned') {
    if (!canAll && !canTeam) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    rows = db
      .prepare(
        `SELECT ${leadCols} ${leadJoin}
         WHERE l.assigned_to IS NULL AND l.status IN (${OPEN_STATUSES.map(() => '?').join(',')})
         ORDER BY l.created_at DESC`,
      )
      .all(...OPEN_STATUSES);
    title = 'Unassigned open leads';
  } else if (bucket === 'open' || bucket === 'open_leads') {
    const clauses = [`l.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`];
    const params = [...OPEN_STATUSES];
    if (assigneeFilter) {
      clauses.push('l.assigned_to = ?');
      params.push(assigneeFilter);
    } else {
      clauses.push('l.assigned_to IS NOT NULL');
    }
    rows = db
      .prepare(`SELECT ${leadCols} ${leadJoin} WHERE ${clauses.join(' AND ')} ORDER BY l.updated_at DESC`)
      .all(...params);
    title = 'Open leads';
  } else if (['new', 'contacted', 'follow_up_scheduled', 'converted', 'lost'].includes(bucket)) {
    const clauses = ['l.status = ?'];
    const params = [bucket];
    if (assigneeFilter) {
      clauses.push('l.assigned_to = ?');
      params.push(assigneeFilter);
    }
    rows = db
      .prepare(`SELECT ${leadCols} ${leadJoin} WHERE ${clauses.join(' AND ')} ORDER BY l.updated_at DESC`)
      .all(...params);
    title = bucket.replace(/_/g, ' ');
  } else if (
    bucket === 'followups_overdue' ||
    bucket === 'followups_pending' ||
    bucket === 'followups_today' ||
    bucket === 'overdue'
  ) {
    const fuClauses = [];
    const params = [];
    if (bucket === 'followups_overdue' || bucket === 'overdue') {
      fuClauses.push(`f.status IN ('pending','overdue') AND f.due_at < datetime('now')`);
      title = 'Overdue follow-ups';
    } else if (bucket === 'followups_pending') {
      fuClauses.push(`f.status = 'pending'`);
      title = 'Pending follow-ups';
    } else {
      fuClauses.push(`f.status IN ('pending','overdue') AND date(f.due_at) = date('now')`);
      title = 'Follow-ups due today';
    }
    if (assigneeFilter) {
      fuClauses.push('f.assigned_to = ?');
      params.push(assigneeFilter);
    }
    rows = db
      .prepare(
        `SELECT DISTINCT ${leadCols},
          f.id AS follow_up_id, f.due_at AS follow_up_due, f.status AS follow_up_status, f.note AS follow_up_note
         FROM follow_ups f
         JOIN leads l ON l.id = f.lead_id
         LEFT JOIN users u ON u.id = l.assigned_to
         WHERE ${fuClauses.join(' AND ')}
         ORDER BY f.due_at ASC`,
      )
      .all(...params);
  } else {
    return res.status(400).json({ error: 'Unknown bucket', bucket });
  }

  res.json({ bucket, title, userId: assigneeFilter || null, leads: rows });
});

export default router;
