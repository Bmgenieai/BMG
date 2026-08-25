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

export default router;
