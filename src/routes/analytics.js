import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { authRequired, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { LEAD_SOURCES, roleHasPermission } from '../lib/permissions.js';

const router = Router();
router.use(authRequired);

router.get(
  '/overview',
  requireAnyPermission('analytics:view_all', 'analytics:view_team', 'analytics:view_own'),
  (req, res) => {
    const isCeo = roleHasPermission(req.user.role, 'analytics:view_all');
    const isManager = roleHasPermission(req.user.role, 'analytics:view_team');

    let leadFilter = '';
    const params = [];
    if (!isCeo && !isManager) {
      leadFilter = 'AND assigned_to = ?';
      params.push(req.user.id);
    }

    const totals = db
      .prepare(
        `SELECT
          COUNT(*) AS total_leads,
          SUM(CASE WHEN status IN ('new','contacted','interested','neutral','follow_up_scheduled') THEN 1 ELSE 0 END) AS open_leads,
          SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS new_leads,
          SUM(CASE WHEN status = 'interested' THEN 1 ELSE 0 END) AS interested,
          SUM(CASE WHEN status = 'follow_up_scheduled' THEN 1 ELSE 0 END) AS follow_up,
          SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) AS converted,
          SUM(CASE WHEN status IN ('not_interested','lost') THEN 1 ELSE 0 END) AS lost,
          SUM(CASE WHEN assigned_to IS NULL AND status IN ('new','contacted','interested','neutral','follow_up_scheduled') THEN 1 ELSE 0 END) AS unassigned
         FROM leads WHERE 1=1 ${leadFilter}`,
      )
      .get(...params);

    const bySource = db
      .prepare(
        `SELECT source, COUNT(*) AS count,
          SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) AS converted
         FROM leads WHERE 1=1 ${leadFilter}
         GROUP BY source ORDER BY count DESC`,
      )
      .all(...params)
      .map((r) => ({
        ...r,
        label: LEAD_SOURCES[r.source]?.label || r.source,
        conversionRate: r.count ? Math.round((r.converted / r.count) * 1000) / 10 : 0,
      }));

    const revenue = db
      .prepare(
        `SELECT
          COALESCE(SUM(amount), 0) AS total,
          COALESCE(SUM(CASE WHEN occurred_at >= datetime('now','-30 days') THEN amount ELSE 0 END), 0) AS last_30_days,
          COUNT(*) AS events
         FROM revenue_events`,
      )
      .get();

    const convertedValue = db
      .prepare(
        `SELECT COALESCE(SUM(estimated_value), 0) AS pipeline_won
         FROM leads WHERE status = 'converted' ${leadFilter.replace('AND', 'AND')}`,
      )
      .get(...params);

    let performance = [];
    if (isCeo || isManager) {
      performance = db
        .prepare(
          `SELECT u.id, u.name, u.email,
            COUNT(l.id) AS leads_assigned,
            SUM(CASE WHEN l.status IN ('new','contacted','interested','neutral','follow_up_scheduled') THEN 1 ELSE 0 END) AS open_leads,
            SUM(CASE WHEN l.status = 'converted' THEN 1 ELSE 0 END) AS converted,
            SUM(CASE WHEN l.status = 'lost' THEN 1 ELSE 0 END) AS lost,
            (SELECT COUNT(*) FROM follow_ups f WHERE f.assigned_to = u.id AND f.status IN ('pending','overdue') AND f.due_at < datetime('now')) AS overdue_followups,
            (SELECT COUNT(*) FROM follow_ups f WHERE f.assigned_to = u.id AND f.status = 'completed') AS completed_followups
           FROM users u
           LEFT JOIN leads l ON l.assigned_to = u.id
           WHERE u.role = 'telesales' AND u.is_active = 1
           GROUP BY u.id
           ORDER BY converted DESC, leads_assigned DESC`,
        )
        .all()
        .map((r) => ({
          ...r,
          conversionRate: r.leads_assigned
            ? Math.round((r.converted / r.leads_assigned) * 1000) / 10
            : 0,
        }));
    } else {
      performance = db
        .prepare(
          `SELECT u.id, u.name, u.email,
            COUNT(l.id) AS leads_assigned,
            SUM(CASE WHEN l.status = 'converted' THEN 1 ELSE 0 END) AS converted,
            (SELECT COUNT(*) FROM follow_ups f WHERE f.assigned_to = u.id AND f.status = 'completed') AS completed_followups
           FROM users u
           LEFT JOIN leads l ON l.assigned_to = u.id
           WHERE u.id = ?
           GROUP BY u.id`,
        )
        .all(req.user.id)
        .map((r) => ({
          ...r,
          conversionRate: r.leads_assigned
            ? Math.round((r.converted / r.leads_assigned) * 1000) / 10
            : 0,
        }));
    }

    const recentLeads = db
      .prepare(
        `SELECT id, name, email, source, status, country, created_at, assigned_to
         FROM leads WHERE 1=1 ${leadFilter}
         ORDER BY created_at DESC LIMIT 8`,
      )
      .all(...params);

    const followUpHealth = db
      .prepare(
        isCeo || isManager
          ? `SELECT
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'overdue' OR (status = 'pending' AND due_at < datetime('now')) THEN 1 ELSE 0 END) AS overdue,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
             FROM follow_ups`
          : `SELECT
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'overdue' OR (status = 'pending' AND due_at < datetime('now')) THEN 1 ELSE 0 END) AS overdue,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
             FROM follow_ups WHERE assigned_to = ?`,
      )
      .get(...(isCeo || isManager ? [] : [req.user.id]));

    res.json({
      totals,
      bySource,
      revenue: {
        recorded: revenue.total,
        last30Days: revenue.last_30_days,
        events: revenue.events,
        pipelineWon: convertedValue.pipeline_won,
      },
      performance,
      recentLeads,
      followUpHealth,
    });
  },
);

router.post('/revenue', requirePermission('revenue:record'), (req, res) => {
  const { amount, currency = 'USD', label, leadId, occurredAt } = req.body || {};
  if (amount == null || Number.isNaN(Number(amount))) {
    return res.status(400).json({ error: 'amount required' });
  }
  const id = uuid();
  db.prepare(
    `INSERT INTO revenue_events (id, lead_id, amount, currency, label, recorded_by, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
  ).run(id, leadId || null, Number(amount), currency, label || null, req.user.id, occurredAt || null);
  res.status(201).json(db.prepare(`SELECT * FROM revenue_events WHERE id = ?`).get(id));
});

router.get('/revenue', requirePermission('revenue:view'), (_req, res) => {
  const rows = db
    .prepare(
      `SELECT r.*, l.name AS lead_name, u.name AS recorded_by_name
       FROM revenue_events r
       LEFT JOIN leads l ON l.id = r.lead_id
       LEFT JOIN users u ON u.id = r.recorded_by
       ORDER BY r.occurred_at DESC LIMIT 100`,
    )
    .all();
  res.json(rows);
});

export default router;
