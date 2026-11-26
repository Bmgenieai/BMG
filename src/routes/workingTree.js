import { Router } from 'express';
import { db } from '../db.js';
import { authRequired, requireAnyPermission } from '../middleware/auth.js';
import {
  OPEN_STATUSES,
  END_STATUSES,
  STATUS_LABELS,
  normalizeStatus,
  roleHasPermission,
} from '../lib/permissions.js';
import { excludeTestAndPakistanSql } from '../lib/leadFilters.js';

const DT = (col) => `datetime(REPLACE(REPLACE(${col}, 'T', ' '), 'Z', ''))`;
const ACTIVE_QUEUE = `(l.archived_at IS NULL OR l.archived_at = '') AND ${excludeTestAndPakistanSql('l')}`;

const router = Router();
router.use(authRequired);

function toneFor(status, overdueCount) {
  if (status === 'paid' || status === 'repeat' || status === 'converted') return 'green';
  if (status === 'nurture' || status === 'lost' || status === 'not_interested') return 'grey';
  if (overdueCount > 0) return 'red';
  if (
    status === 'demo_scheduled' ||
    status === 'demo_booked' ||
    status === 'trial' ||
    status === 'engaged' ||
    status === 'conversation' ||
    status === 'challenge_offered' ||
    status === 'challenge_accepted'
  ) {
    return 'amber';
  }
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
    `SELECT l.status, COUNT(*) AS c FROM leads l
     WHERE l.assigned_to = ? AND ${ACTIVE_QUEUE}
     GROUP BY l.status`,
  );

  // Match Leads tab follow-up counts: check both leads.next_follow_up_at AND pending follow_ups rows
  const overdueCountStmt = db.prepare(
    `SELECT COUNT(DISTINCT l.id) AS c
     FROM leads l
     WHERE l.assigned_to = ?
       AND ${ACTIVE_QUEUE}
       AND (
         (l.next_follow_up_at IS NOT NULL AND TRIM(l.next_follow_up_at) != '' AND ${DT('l.next_follow_up_at')} < datetime('now'))
         OR EXISTS (
           SELECT 1 FROM follow_ups f
           WHERE f.lead_id = l.id AND f.status IN ('pending','overdue') AND ${DT('f.due_at')} < datetime('now')
         )
       )`,
  );

  const dueTodayCountStmt = db.prepare(
    `SELECT COUNT(DISTINCT l.id) AS c
     FROM leads l
     WHERE l.assigned_to = ?
       AND ${ACTIVE_QUEUE}
       AND (
         (l.next_follow_up_at IS NOT NULL AND TRIM(l.next_follow_up_at) != '' AND date(${DT('l.next_follow_up_at')}) = date('now'))
         OR EXISTS (
           SELECT 1 FROM follow_ups f
           WHERE f.lead_id = l.id AND f.status IN ('pending','overdue') AND date(${DT('f.due_at')}) = date('now')
         )
       )`,
  );

  const pendingFuCountStmt = db.prepare(
    `SELECT COUNT(DISTINCT l.id) AS c
     FROM leads l
     WHERE l.assigned_to = ?
       AND ${ACTIVE_QUEUE}
       AND (
         (l.next_follow_up_at IS NOT NULL AND TRIM(l.next_follow_up_at) != '')
         OR EXISTS (
           SELECT 1 FROM follow_ups f
           WHERE f.lead_id = l.id AND f.status IN ('pending','overdue')
         )
       )`,
  );

  const people = reps.map((rep) => {
    const byStatus = Object.fromEntries(
      statusCounts.all(rep.id).map((r) => [r.status, r.c]),
    );
    const open = OPEN_STATUSES.reduce((s, st) => s + (byStatus[st] || 0), 0);
    const ended = END_STATUSES.reduce((s, st) => s + (byStatus[st] || 0), 0);
    const overdue = overdueCountStmt.get(rep.id).c;
    const today = dueTodayCountStmt.get(rep.id).c;
    const pending = pendingFuCountStmt.get(rep.id).c;

    const buckets = [
      {
        key: 'followups_overdue',
        label: 'Overdue follow-ups',
        count: overdue,
        kind: 'followup',
        tone: overdue > 0 ? 'red' : 'grey',
      },
      {
        key: 'followups_today',
        label: 'Due today',
        count: today,
        kind: 'followup',
        tone: today > 0 ? 'amber' : 'grey',
      },
      ...OPEN_STATUSES.map((st) => ({
        key: st,
        label: STATUS_LABELS[st] || st.replace(/_/g, ' '),
        count: byStatus[st] || 0,
        kind: 'open',
        tone: toneFor(st, 0),
      })),
      ...END_STATUSES.map((st) => ({
        key: st,
        label: STATUS_LABELS[st] || st.replace(/_/g, ' '),
        count: byStatus[st] || 0,
        kind: 'ended',
        tone: toneFor(st, 0),
      })),
    ];

    return {
      user: rep,
      totals: { open, ended, overdue, pending, today },
      buckets,
    };
  });

  const unassigned = db
    .prepare(
      `SELECT COUNT(*) AS c FROM leads l
       WHERE l.assigned_to IS NULL AND ${ACTIVE_QUEUE}
         AND l.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`,
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
         WHERE l.assigned_to IS NULL AND ${ACTIVE_QUEUE}
           AND l.status IN (${OPEN_STATUSES.map(() => '?').join(',')})
         ORDER BY l.created_at DESC`,
      )
      .all(...OPEN_STATUSES);
    title = 'Unassigned open leads';
  } else if (bucket === 'open' || bucket === 'open_leads') {
    const clauses = [ACTIVE_QUEUE, `l.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`];
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
  } else if (
    [
      'uncontacted',
      'contacted',
      'engaged',
      'qualified',
      'demo_scheduled',
      'challenge_offered',
      'challenge_accepted',
      'trial',
      'paid',
      'repeat',
      'completed',
      'nurture',
      'conversation',
      'demo_booked',
      'lost',
      'new',
      'interested',
      'neutral',
      'follow_up_scheduled',
      'converted',
      'not_interested',
    ].includes(bucket)
  ) {
    const clauses = [ACTIVE_QUEUE, 'l.status = ?'];
    const params = [normalizeStatus(bucket) || bucket];
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
    const clauses = [ACTIVE_QUEUE];
    const params = [];
    if (bucket === 'followups_overdue' || bucket === 'overdue') {
      clauses.push(`(
        (l.next_follow_up_at IS NOT NULL AND TRIM(l.next_follow_up_at) != '' AND ${DT('l.next_follow_up_at')} < datetime('now'))
        OR EXISTS (
          SELECT 1 FROM follow_ups f
          WHERE f.lead_id = l.id AND f.status IN ('pending','overdue') AND ${DT('f.due_at')} < datetime('now')
        )
      )`);
      title = 'Overdue follow-ups';
    } else if (bucket === 'followups_pending') {
      clauses.push(`(
        (l.next_follow_up_at IS NOT NULL AND TRIM(l.next_follow_up_at) != '')
        OR EXISTS (
          SELECT 1 FROM follow_ups f
          WHERE f.lead_id = l.id AND f.status IN ('pending','overdue')
        )
      )`);
      title = 'Pending follow-ups';
    } else {
      clauses.push(`(
        (l.next_follow_up_at IS NOT NULL AND TRIM(l.next_follow_up_at) != '' AND date(${DT('l.next_follow_up_at')}) = date('now'))
        OR EXISTS (
          SELECT 1 FROM follow_ups f
          WHERE f.lead_id = l.id AND f.status IN ('pending','overdue') AND date(${DT('f.due_at')}) = date('now')
        )
      )`);
      title = 'Follow-ups due today';
    }
    if (assigneeFilter) {
      clauses.push('l.assigned_to = ?');
      params.push(assigneeFilter);
    } else {
      clauses.push('l.assigned_to IS NOT NULL');
    }
    rows = db
      .prepare(
        `SELECT ${leadCols} ${leadJoin}
         WHERE ${clauses.join(' AND ')}
         ORDER BY COALESCE(l.next_follow_up_at, l.updated_at) ASC`,
      )
      .all(...params);
  } else {
    return res.status(400).json({ error: 'Unknown bucket', bucket });
  }

  res.json({ bucket, title, userId: assigneeFilter || null, leads: rows });
});

export default router;
