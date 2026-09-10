import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { authRequired, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { LEAD_SOURCES, OPEN_STATUSES, roleHasPermission } from '../lib/permissions.js';

const router = Router();
router.use(authRequired);

const OPEN_LIST = OPEN_STATUSES.map((s) => `'${s}'`).join(',');

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
          SUM(CASE WHEN status IN (${OPEN_LIST}) THEN 1 ELSE 0 END) AS open_leads,
          SUM(CASE WHEN status = 'qualified' THEN 1 ELSE 0 END) AS new_leads,
          SUM(CASE WHEN status = 'qualified' THEN 1 ELSE 0 END) AS qualified,
          SUM(CASE WHEN status = 'conversation' THEN 1 ELSE 0 END) AS interested,
          SUM(CASE WHEN status = 'conversation' THEN 1 ELSE 0 END) AS conversation,
          SUM(CASE WHEN status = 'demo_booked' THEN 1 ELSE 0 END) AS demo_booked,
          SUM(CASE WHEN status = 'trial' THEN 1 ELSE 0 END) AS trial,
          SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS converted,
          SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid,
          SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) AS lost,
          SUM(CASE WHEN assigned_to IS NULL AND status IN (${OPEN_LIST}) THEN 1 ELSE 0 END) AS unassigned
         FROM leads WHERE 1=1 ${leadFilter}`,
      )
      .get(...params);

    const bySource = db
      .prepare(
        `SELECT source, COUNT(*) AS count,
          SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS converted
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
         FROM leads WHERE status = 'paid' ${leadFilter.replace('AND', 'AND')}`,
      )
      .get(...params);

    let performance = [];
    if (isCeo || isManager) {
      performance = db
        .prepare(
          `SELECT u.id, u.name, u.email,
            COUNT(l.id) AS leads_assigned,
            SUM(CASE WHEN l.status IN (${OPEN_LIST}) THEN 1 ELSE 0 END) AS open_leads,
            SUM(CASE WHEN l.status = 'paid' THEN 1 ELSE 0 END) AS converted,
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
            SUM(CASE WHEN l.status = 'paid' THEN 1 ELSE 0 END) AS converted,
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

/** Sales funnel: stages + outreach touches + reply/show/conversion rates + lost reasons. */
router.get(
  '/funnel',
  requireAnyPermission('analytics:view_all', 'analytics:view_team', 'analytics:view_own'),
  (req, res) => {
    const isCeo = roleHasPermission(req.user.role, 'analytics:view_all');
    const isManager = roleHasPermission(req.user.role, 'analytics:view_team');

    let leadFilter = '';
    const params = [];
    if (!isCeo && !isManager) {
      leadFilter = 'AND l.assigned_to = ?';
      params.push(req.user.id);
    }

    const stages = db
      .prepare(
        `SELECT
          COUNT(*) AS qualified_prospects,
          SUM(CASE WHEN status = 'qualified' THEN 1 ELSE 0 END) AS qualified,
          SUM(CASE WHEN status = 'conversation' THEN 1 ELSE 0 END) AS conversations,
          SUM(CASE WHEN status = 'demo_booked' THEN 1 ELSE 0 END) AS demos_booked,
          SUM(CASE WHEN status = 'trial' THEN 1 ELSE 0 END) AS trials,
          SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid,
          SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) AS lost
         FROM leads l WHERE 1=1 ${leadFilter}`,
      )
      .get(...params);

    const actFilter = leadFilter
      ? `AND a.lead_id IN (SELECT id FROM leads l WHERE 1=1 ${leadFilter})`
      : '';

    const outreach = db
      .prepare(
        `SELECT
          SUM(CASE WHEN a.type IN ('email','email_sent') THEN 1 ELSE 0 END) AS emails,
          SUM(CASE WHEN a.type = 'linkedin' THEN 1 ELSE 0 END) AS linkedin_touches,
          SUM(CASE WHEN a.type = 'call' THEN 1 ELSE 0 END) AS calls,
          SUM(CASE WHEN a.type = 'reply' THEN 1 ELSE 0 END) AS replies,
          SUM(CASE WHEN a.type = 'reply' AND a.outcome = 'positive' THEN 1 ELSE 0 END) AS positive_replies,
          SUM(CASE WHEN a.type = 'demo_shown' THEN 1 ELSE 0 END) AS demos_shown,
          COUNT(DISTINCT CASE WHEN a.type IN ('email','email_sent','linkedin','call') THEN a.lead_id END) AS leads_touched,
          COUNT(DISTINCT CASE WHEN a.type = 'reply' THEN a.lead_id END) AS leads_replied,
          COUNT(DISTINCT CASE WHEN a.type = 'reply' AND a.outcome = 'positive' THEN a.lead_id END) AS leads_positive_reply
         FROM lead_activities a
         WHERE 1=1 ${actFilter}`,
      )
      .get(...params);

    const demosBookedLeads = db
      .prepare(
        `SELECT COUNT(DISTINCT l.id) AS c
         FROM leads l
         WHERE (
           l.status IN ('demo_booked','trial','paid')
           OR EXISTS (
             SELECT 1 FROM lead_activities a
             WHERE a.lead_id = l.id AND a.type = 'status_change' AND a.outcome = 'demo_booked'
           )
         ) ${leadFilter}`,
      )
      .get(...params).c;

    const demosShownLeads = db
      .prepare(
        `SELECT COUNT(DISTINCT a.lead_id) AS c
         FROM lead_activities a
         WHERE a.type = 'demo_shown' ${actFilter}`,
      )
      .get(...params).c;

    const pct = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : 0);

    const lostReasons = db
      .prepare(
        `SELECT COALESCE(NULLIF(TRIM(lost_reason), ''), 'Unspecified') AS reason, COUNT(*) AS count
         FROM leads l
         WHERE status = 'lost' ${leadFilter}
         GROUP BY reason
         ORDER BY count DESC`,
      )
      .all(...params);

    res.json({
      stages: {
        qualifiedProspects: stages.qualified_prospects,
        qualified: stages.qualified,
        conversations: stages.conversations,
        demosBooked: stages.demos_booked,
        trials: stages.trials,
        paid: stages.paid,
        lost: stages.lost,
      },
      outreach: {
        emails: outreach.emails || 0,
        linkedinTouches: outreach.linkedin_touches || 0,
        calls: outreach.calls || 0,
        replies: outreach.replies || 0,
        positiveReplies: outreach.positive_replies || 0,
        demosShown: outreach.demos_shown || 0,
        leadsTouched: outreach.leads_touched || 0,
        leadsReplied: outreach.leads_replied || 0,
        leadsPositiveReply: outreach.leads_positive_reply || 0,
      },
      rates: {
        replyRate: pct(outreach.leads_replied || 0, outreach.leads_touched || 0),
        positiveReplyRate: pct(outreach.leads_positive_reply || 0, outreach.leads_replied || 0),
        showRate: pct(demosShownLeads || 0, demosBookedLeads || 0),
        conversionRate: pct(stages.paid || 0, stages.qualified_prospects || 0),
      },
      lostReasons,
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
