import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { authRequired, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { LEAD_SOURCES, OPEN_STATUSES, BUSINESS_TYPES, roleHasPermission } from '../lib/permissions.js';
import { fetchBmgenieCrmAnalytics, normalizeUserRows } from '../lib/bmgenieApi.js';
import { cohortSql, normalizeCohort, cohortRefDate, COHORT_DEFINITIONS } from '../lib/cohort.js';
import { resolveWorkingPeriod } from '../lib/periodBounds.js';

const router = Router();
router.use(authRequired);

const OPEN_LIST = OPEN_STATUSES.map((s) => `'${s}'`).join(',');

/** Normalize mixed ISO / SQLite datetime strings for range compares. */
const DT = (col) => `datetime(REPLACE(REPLACE(${col}, 'T', ' '), 'Z', ''))`;

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
          SUM(CASE WHEN status = 'uncontacted' THEN 1 ELSE 0 END) AS new_leads,
          SUM(CASE WHEN status = 'uncontacted' THEN 1 ELSE 0 END) AS uncontacted,
          SUM(CASE WHEN status = 'contacted' THEN 1 ELSE 0 END) AS contacted,
          SUM(CASE WHEN status = 'engaged' THEN 1 ELSE 0 END) AS engaged,
          SUM(CASE WHEN status = 'qualified' THEN 1 ELSE 0 END) AS qualified,
          SUM(CASE WHEN status = 'demo_scheduled' THEN 1 ELSE 0 END) AS demo_scheduled,
          SUM(CASE WHEN status = 'challenge_offered' THEN 1 ELSE 0 END) AS challenge_offered,
          SUM(CASE WHEN status = 'challenge_accepted' THEN 1 ELSE 0 END) AS challenge_accepted,
          SUM(CASE WHEN status = 'trial' THEN 1 ELSE 0 END) AS trial,
          SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS converted,
          SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid,
          SUM(CASE WHEN status = 'repeat' THEN 1 ELSE 0 END) AS repeat_customers,
          SUM(CASE WHEN status = 'nurture' THEN 1 ELSE 0 END) AS lost,
          SUM(CASE WHEN status = 'nurture' THEN 1 ELSE 0 END) AS nurture,
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

    const byBusinessType = BUSINESS_TYPES.map((bt) => {
      const row = db
        .prepare(
          `SELECT
             COUNT(DISTINCT l.id) AS leads_count,
             SUM(CASE WHEN l.status IN ('paid', 'repeat') THEN 1 ELSE 0 END) AS converted,
             (SELECT COUNT(*) FROM email_messages em JOIN leads l2 ON l2.id = em.lead_id WHERE l2.business_type = ? ${leadFilter ? leadFilter.replace(/\bl\b/g, 'l2') : ''}) AS emails_sent,
             (SELECT COUNT(*) FROM email_replies er JOIN leads l3 ON l3.id = er.lead_id WHERE l3.business_type = ? ${leadFilter ? leadFilter.replace(/\bl\b/g, 'l3') : ''}) AS replies_count
           FROM leads l
           WHERE l.business_type = ? ${leadFilter}`,
        )
        .get(bt.key, ...params, bt.key, ...params, bt.key, ...params);
      return {
        key: bt.key,
        label: bt.label,
        leadsCount: row?.leads_count || 0,
        emailsSent: row?.emails_sent || 0,
        repliesCount: row?.replies_count || 0,
        converted: row?.converted || 0,
      };
    });
    const unspec = db
      .prepare(
        `SELECT
           COUNT(DISTINCT l.id) AS leads_count,
           SUM(CASE WHEN l.status IN ('paid', 'repeat') THEN 1 ELSE 0 END) AS converted,
           (SELECT COUNT(*) FROM email_messages em JOIN leads l2 ON l2.id = em.lead_id WHERE (l2.business_type IS NULL OR TRIM(l2.business_type) = '') ${leadFilter ? leadFilter.replace(/\bl\b/g, 'l2') : ''}) AS emails_sent,
           (SELECT COUNT(*) FROM email_replies er JOIN leads l3 ON l3.id = er.lead_id WHERE (l3.business_type IS NULL OR TRIM(l3.business_type) = '') ${leadFilter ? leadFilter.replace(/\bl\b/g, 'l3') : ''}) AS replies_count
         FROM leads l
         WHERE (l.business_type IS NULL OR TRIM(l.business_type) = '') ${leadFilter}`,
      )
      .get(...params, ...params, ...params);
    if (unspec && (unspec.leads_count > 0 || unspec.emails_sent > 0)) {
      byBusinessType.push({
        key: 'unspecified',
        label: 'Unspecified',
        leadsCount: unspec.leads_count || 0,
        emailsSent: unspec.emails_sent || 0,
        repliesCount: unspec.replies_count || 0,
        converted: unspec.converted || 0,
      });
    }

    const stateExpr = `CASE WHEN l.state IS NULL OR TRIM(l.state) = '' THEN 'Unspecified' ELSE TRIM(l.state) END`;
    const leadStateRows = db
      .prepare(
        `SELECT ${stateExpr} AS state,
                COUNT(*) AS leads_count,
                SUM(CASE WHEN l.status IN ('paid', 'repeat') THEN 1 ELSE 0 END) AS converted
         FROM leads l
         WHERE 1=1 ${leadFilter.replace(/\bassigned_to\b/g, 'l.assigned_to')}
         GROUP BY 1
         ORDER BY leads_count DESC
         LIMIT 40`,
      )
      .all(...params);
    const emailStateRows = db
      .prepare(
        `SELECT ${stateExpr} AS state, COUNT(*) AS emails_sent
         FROM email_messages em
         JOIN leads l ON l.id = em.lead_id
         WHERE 1=1 ${leadFilter.replace(/\bassigned_to\b/g, 'l.assigned_to')}
         GROUP BY 1`,
      )
      .all(...params);
    const replyStateRows = db
      .prepare(
        `SELECT ${stateExpr} AS state, COUNT(*) AS replies_count
         FROM email_replies er
         JOIN leads l ON l.id = er.lead_id
         WHERE 1=1 ${leadFilter.replace(/\bassigned_to\b/g, 'l.assigned_to')}
         GROUP BY 1`,
      )
      .all(...params);
    const emailByState = Object.fromEntries(emailStateRows.map((r) => [r.state, r.emails_sent]));
    const replyByState = Object.fromEntries(replyStateRows.map((r) => [r.state, r.replies_count]));
    const byState = leadStateRows.map((r) => ({
      key: r.state === 'Unspecified' ? 'unspecified' : r.state,
      label: r.state,
      leadsCount: r.leads_count || 0,
      emailsSent: emailByState[r.state] || 0,
      repliesCount: replyByState[r.state] || 0,
      converted: r.converted || 0,
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
        `SELECT id, name, email, source, status, country, state, created_at, assigned_to
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
      byBusinessType,
      byState,
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
          COUNT(*) AS total_leads,
          SUM(CASE WHEN status = 'uncontacted' THEN 1 ELSE 0 END) AS uncontacted,
          SUM(CASE WHEN status = 'contacted' THEN 1 ELSE 0 END) AS contacted,
          SUM(CASE WHEN status = 'engaged' THEN 1 ELSE 0 END) AS engaged,
          SUM(CASE WHEN status = 'qualified' THEN 1 ELSE 0 END) AS qualified,
          SUM(CASE WHEN status = 'demo_scheduled' THEN 1 ELSE 0 END) AS demo_scheduled,
          SUM(CASE WHEN status = 'challenge_offered' THEN 1 ELSE 0 END) AS challenge_offered,
          SUM(CASE WHEN status = 'challenge_accepted' THEN 1 ELSE 0 END) AS challenge_accepted,
          SUM(CASE WHEN status = 'trial' THEN 1 ELSE 0 END) AS trials,
          SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid,
          SUM(CASE WHEN status = 'repeat' THEN 1 ELSE 0 END) AS repeat_customers,
          SUM(CASE WHEN status = 'nurture' THEN 1 ELSE 0 END) AS nurture
         FROM leads l WHERE 1=1 ${leadFilter}`,
      )
      .get(...params);

    const actFilter = leadFilter
      ? `AND a.lead_id IN (SELECT id FROM leads l WHERE 1=1 ${leadFilter})`
      : '';

    // Period window for activity counts (stages stay a live snapshot).
    const pb = resolveWorkingPeriod(req.query.period || 'overall');
    const win = (col) =>
      pb.period === 'overall'
        ? ''
        : ` AND ${DT(col)} >= datetime('${pb.from}') AND ${DT(col)} < datetime('${pb.to}')`;

    const outreach = db
      .prepare(
        `SELECT
          SUM(CASE WHEN a.type IN ('email','email_sent') THEN 1 ELSE 0 END) AS emails,
          SUM(CASE WHEN a.type = 'email_followup' THEN 1 ELSE 0 END) AS email_followups,
          SUM(CASE WHEN a.type IN ('email_opened') THEN 1 ELSE 0 END) AS email_opens,
          SUM(CASE WHEN a.type IN ('linkedin','linkedin_connection_sent','linkedin_message','linkedin_followup','linkedin_connection_accepted','linkedin_reply') THEN 1 ELSE 0 END) AS linkedin_touches,
          SUM(CASE WHEN a.type = 'linkedin_connection_sent' THEN 1 ELSE 0 END) AS linkedin_connection_sent,
          SUM(CASE WHEN a.type = 'linkedin_connection_accepted' THEN 1 ELSE 0 END) AS linkedin_connection_accepted,
          SUM(CASE WHEN a.type IN ('linkedin_message','linkedin') THEN 1 ELSE 0 END) AS linkedin_messages,
          SUM(CASE WHEN a.type = 'linkedin_reply' THEN 1 ELSE 0 END) AS linkedin_replies,
          SUM(CASE WHEN a.type IN ('call','call_attempted','call_connected') THEN 1 ELSE 0 END) AS calls,
          SUM(CASE WHEN a.type = 'call_attempted' THEN 1 ELSE 0 END) AS calls_attempted,
          SUM(CASE WHEN a.type IN ('call','call_connected') THEN 1 ELSE 0 END) AS calls_connected,
          SUM(CASE WHEN a.type IN ('reply','linkedin_reply') THEN 1 ELSE 0 END) AS replies,
          SUM(CASE WHEN a.type = 'reply' AND a.outcome = 'positive' THEN 1 ELSE 0 END) AS positive_replies,
          SUM(CASE WHEN a.type = 'meeting_scheduled' THEN 1 ELSE 0 END) AS meetings_requested,
          SUM(CASE WHEN a.type = 'demo_shown' THEN 1 ELSE 0 END) AS demos_shown,
          COUNT(DISTINCT CASE WHEN a.type IN ('email','email_sent','email_followup','linkedin','linkedin_connection_sent','linkedin_message','call','call_attempted','call_connected') THEN a.lead_id END) AS leads_touched,
          COUNT(DISTINCT CASE WHEN a.type IN ('reply','linkedin_reply') THEN a.lead_id END) AS leads_replied,
          COUNT(DISTINCT CASE WHEN a.type = 'reply' AND a.outcome = 'positive' THEN a.lead_id END) AS leads_positive_reply
         FROM lead_activities a
         WHERE 1=1 ${actFilter} ${win('a.created_at')}`,
      )
      .get(...params);

    const leadsAdded = db
      .prepare(`SELECT COUNT(*) AS c FROM leads l WHERE 1=1 ${leadFilter} ${win('l.created_at')}`)
      .get(...params).c;

    const leadsVerified = db
      .prepare(
        `SELECT COUNT(*) AS c FROM leads l
         WHERE (l.email IS NOT NULL AND TRIM(l.email) != '') ${leadFilter} ${win('l.created_at')}`,
      )
      .get(...params).c;

    const demosBookedLeads = db
      .prepare(
        `SELECT COUNT(DISTINCT l.id) AS c
         FROM leads l
         WHERE (
           l.status IN ('demo_scheduled','challenge_offered','challenge_accepted','trial','paid','repeat')
           OR EXISTS (
             SELECT 1 FROM lead_activities a
             WHERE a.lead_id = l.id AND a.type = 'status_change'
               AND a.outcome IN ('demo_scheduled','demo_booked')
           )
           OR EXISTS (SELECT 1 FROM demo_bookings d WHERE d.lead_id = l.id)
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

    const followupsCompletedCount = db
      .prepare(
        `SELECT COUNT(*) AS c FROM follow_ups f
         WHERE f.status = 'completed' ${win('COALESCE(f.completed_at, f.updated_at)')} ${leadFilter ? `AND f.lead_id IN (SELECT id FROM leads l WHERE 1=1 ${leadFilter})` : ''}`,
      )
      .get(...params).c;

    const lostReasons = db
      .prepare(
        `SELECT COALESCE(NULLIF(TRIM(lost_reason), ''), 'Unspecified') AS reason, COUNT(*) AS count
         FROM leads l
         WHERE status IN ('nurture','lost') ${leadFilter}
         GROUP BY reason
         ORDER BY count DESC`,
      )
      .all(...params);

    res.json({
      // Unique leads in each lifecycle stage (one lead = one stage)
      stages: {
        totalLeads: stages.total_leads,
        uncontacted: stages.uncontacted,
        contacted: stages.contacted,
        engaged: stages.engaged,
        qualified: stages.qualified,
        demoScheduled: stages.demo_scheduled,
        challengeOffered: stages.challenge_offered,
        challengeAccepted: stages.challenge_accepted,
        trials: stages.trials,
        paid: stages.paid,
        repeat: stages.repeat_customers,
        nurture: stages.nurture,
        // Back-compat aliases for older UI
        qualifiedProspects: stages.total_leads,
        conversations: stages.engaged,
        demosBooked: stages.demo_scheduled,
        lost: stages.nurture,
      },
      // Activity dashboard — work volume (not unique opportunities)
      activities: {
        leadsAdded: leadsAdded || 0,
        leadsVerified: leadsVerified || 0,
        emailsSent: outreach.emails || 0,
        emailOpens: outreach.email_opens || 0,
        emailReplies: outreach.replies || 0,
        followupsSent: outreach.email_followups || 0,
        emailFollowupsSent: outreach.email_followups || 0,
        followupsCompleted: followupsCompletedCount || 0,
        linkedinConnectionSent: outreach.linkedin_connection_sent || 0,
        linkedinConnectionAccepted: outreach.linkedin_connection_accepted || 0,
        linkedinMessages: outreach.linkedin_messages || 0,
        linkedinReplies: outreach.linkedin_replies || 0,
        callsAttempted: outreach.calls_attempted || outreach.calls || 0,
        callsConnected: outreach.calls_connected || 0,
        positiveReplies: outreach.positive_replies || 0,
        meetingsRequested: outreach.meetings_requested || 0,
        demosBooked: demosBookedLeads || 0,
      },
      outreach: {
        emails: outreach.emails || 0,
        emailFollowups: outreach.email_followups || 0,
        emailOpens: outreach.email_opens || 0,
        linkedinTouches: outreach.linkedin_touches || 0,
        linkedinConnectionSent: outreach.linkedin_connection_sent || 0,
        linkedinConnectionAccepted: outreach.linkedin_connection_accepted || 0,
        linkedinMessages: outreach.linkedin_messages || 0,
        linkedinReplies: outreach.linkedin_replies || 0,
        calls: outreach.calls || 0,
        callsAttempted: outreach.calls_attempted || 0,
        callsConnected: outreach.calls_connected || 0,
        replies: outreach.replies || 0,
        positiveReplies: outreach.positive_replies || 0,
        meetingsRequested: outreach.meetings_requested || 0,
        demosShown: outreach.demos_shown || 0,
        leadsTouched: outreach.leads_touched || 0,
        leadsReplied: outreach.leads_replied || 0,
        leadsPositiveReply: outreach.leads_positive_reply || 0,
      },
      rates: {
        replyRate: pct(outreach.leads_replied || 0, outreach.leads_touched || 0),
        positiveReplyRate: pct(outreach.leads_positive_reply || 0, outreach.leads_replied || 0),
        showRate: pct(demosShownLeads || 0, demosBookedLeads || 0),
        conversionRate: pct(stages.paid || 0, stages.total_leads || 0),
      },
      lostReasons,
    });
  },
);

/**
 * CEO product-user analytics for bmgenie.ai.
 * Prefers live main-API /crm-analytics/*; falls back to CRM ingest / local tables.
 */
router.get(
  '/product-tracking',
  requireAnyPermission('analytics:view_all', 'analytics:view_team'),
  async (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const cohort = normalizeCohort(req.query.cohort);
    const query = { date, cohort };

    const cards = [
      {
        key: 'daily_new_users',
        title: 'Daily new users',
        description: 'New BMGenie signups for the day',
        mainPath: '/crm-analytics/daily-new-users',
        localSource: 'signup_no_listing',
        localMode: 'created_today',
        // This card is already "new that day"; old cohort is always empty.
      },
      {
        key: 'daily_no_listings',
        title: 'Came today · no listings',
        description: 'Signed up today and have not created any listings',
        mainPath: '/crm-analytics/daily-no-listings',
        localSource: 'signup_no_listing',
        localMode: 'created_today',
      },
      {
        key: 'free_not_paid',
        title: 'Free listing · not paid',
        description: 'Used free credit but never purchased a package',
        mainPath: '/crm-analytics/free-not-paid',
        localSource: 'free_credit_no_purchase',
        localMode: 'open_source',
      },
      {
        key: 'checkout_abandoned',
        title: 'Opened Stripe · abandoned',
        description: 'Opened payment box then did not complete',
        mainPath: '/crm-analytics/checkout-abandoned',
        localSource: 'checkout_abandoned',
        localMode: 'open_source',
      },
      {
        key: 'revisions_requested',
        title: 'Asked for revisions',
        description: 'Requested listing revisions on BMGenie',
        mainPath: '/crm-analytics/revisions-requested',
        localSource: 'revision_requested',
        localMode: 'created_today',
      },
    ];

    const results = [];
    let mainAvailable = false;
    let mainError = null;

    for (const card of cards) {
      const remote = await fetchBmgenieCrmAnalytics(card.mainPath, query);
      if (remote.ok && remote.data) {
        mainAvailable = true;
        let users = normalizeUserRows(remote.data.users || remote.data.items || []);
        users = filterUsersByCohort(users, cohort, date);
        results.push({
          key: card.key,
          title: card.title,
          description: card.description,
          source: 'bmgenie_api',
          date: remote.data.date || date,
          timezone: remote.data.timezone || null,
          definition: remote.data.definition || null,
          count: users.length,
          users,
          cohort,
        });
        continue;
      }

      if (remote.error) mainError = remote.error;

      const local = localProductCard(card, date, cohort);
      results.push({
        key: card.key,
        title: card.title,
        description: card.description,
        source: 'crm_fallback',
        date,
        timezone: null,
        definition: local.definition,
        count: local.count,
        users: local.users,
        cohort,
        fallbackReason: remote.error || 'Main API unavailable',
      });
    }

    const demoCohort = cohortSql(
      `COALESCE(NULLIF(l.signed_up_at, ''), NULLIF(l.created_at, ''), d.created_at)`,
      cohort,
      date,
    );
    const chatCohort = cohortSql(
      `COALESCE(NULLIF(l.signed_up_at, ''), NULLIF(l.created_at, ''), NULLIF(c.started_at, ''), c.created_at)`,
      cohort,
      date,
    );

    const demosToday = db
      .prepare(
        `SELECT COUNT(*) AS c FROM demo_bookings d
         LEFT JOIN leads l ON l.id = d.lead_id
         WHERE date(COALESCE(d.scheduled_at, d.created_at)) = date(?)
           AND (${demoCohort.sql})`,
      )
      .get(date, ...demoCohort.params).c;
    const chatsToday = db
      .prepare(
        `SELECT COUNT(*) AS c FROM chat_threads c
         LEFT JOIN leads l ON l.id = c.lead_id
         WHERE date(COALESCE(c.started_at, c.created_at)) = date(?)
           AND (${chatCohort.sql})`,
      )
      .get(date, ...chatCohort.params).c;

    res.json({
      date,
      cohort,
      cohortDefinition: COHORT_DEFINITIONS[cohort],
      mainAvailable,
      mainError: mainAvailable ? null : mainError,
      bmgenieApiConfigured: Boolean(
        (process.env.BMGENIE_API_URL || '').trim() && (process.env.CRM_INGEST_API_KEY || '').trim(),
      ),
      cards: results,
      extras: {
        demosToday,
        chatsToday,
        demosHref: `/demos?cohort=${cohort}`,
        chatsHref: `/chats?cohort=${cohort}`,
      },
    });
  },
);

function filterUsersByCohort(users, cohort, refDate) {
  const c = normalizeCohort(cohort);
  if (c === 'all') return users;
  const day = cohortRefDate(refDate);
  return users.filter((u) => {
    const raw = u.createdAt || u.created_at || u.signedUpAt || u.signed_up_at;
    if (!raw) return c === 'all';
    const ymd = String(raw).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
    if (c === 'new') return ymd === day;
    if (c === 'old') return ymd < day;
    return true;
  });
}

function localProductCard(card, date, cohort = 'all') {
  const openList = OPEN_STATUSES.map((s) => `'${s}'`).join(',');
  const cohortPred = cohortSql('COALESCE(signed_up_at, created_at)', cohort, date);

  if (card.localMode === 'created_today') {
    // Daily cards: event day = selected date; still apply cohort on signup day.
    const users = db
      .prepare(
        `SELECT id, name, email, phone, company, created_at AS createdAt,
                signed_up_at AS signedUpAt, bmgenie_user_id AS bmgenieUserId
         FROM leads
         WHERE source = ?
           AND date(created_at) = date(?)
           AND (${cohortPred.sql})
         ORDER BY created_at DESC
         LIMIT 200`,
      )
      .all(card.localSource, date, ...cohortPred.params);
    return {
      count: users.length,
      users: normalizeUserRows(users),
      definition: `CRM fallback: leads with source=${card.localSource} created on ${date} (${cohort} users)`,
    };
  }

  const users = db
    .prepare(
      `SELECT id, name, email, phone, company, created_at AS createdAt,
              signed_up_at AS signedUpAt, bmgenie_user_id AS bmgenieUserId
       FROM leads
       WHERE source = ?
         AND status IN (${openList})
         AND (${cohortPred.sql})
       ORDER BY updated_at DESC
       LIMIT 200`,
    )
    .all(card.localSource, ...cohortPred.params);
  return {
    count: users.length,
    users: normalizeUserRows(users),
    definition: `CRM fallback: open leads with source=${card.localSource} (${cohort} users)`,
  };
}

/**
 * Period-based telesales working + performance.
 * CEO/manager: all active telesales (optional ?userId= for detail).
 * Telesales: own row + feed only.
 *
 * Query: ?period=today|yesterday|week|month&userId=
 */
router.get(
  '/telesales-working',
  requireAnyPermission('analytics:view_all', 'analytics:view_team', 'analytics:view_own'),
  (req, res) => {
    const isCeo = roleHasPermission(req.user.role, 'analytics:view_all');
    const isManager = roleHasPermission(req.user.role, 'analytics:view_team');
    const canViewTeam = isCeo || isManager;
    const bounds = resolveWorkingPeriod(req.query.period);
    const { from, to } = bounds;

    let focusUserId = req.query.userId ? String(req.query.userId) : null;
    if (!canViewTeam) {
      focusUserId = req.user.id;
    }

    const rawState = req.query.state ? String(req.query.state).trim() : '';
    const stateFilter =
      !rawState
        ? ''
        : rawState.toLowerCase() === 'unspecified'
          ? ` AND (l.state IS NULL OR TRIM(l.state) = '')`
          : ` AND TRIM(l.state) = '${rawState.replace(/'/g, "''").slice(0, 64)}'`;
    const stateLabel = rawState || null;

    const reps = canViewTeam
      ? db
          .prepare(
            `SELECT id, name, email FROM users
             WHERE role = 'telesales' AND is_active = 1
             ORDER BY name COLLATE NOCASE`,
          )
          .all()
      : db
          .prepare(`SELECT id, name, email FROM users WHERE id = ?`)
          .all(req.user.id);

    const leadAdds = db
      .prepare(
        `SELECT l.created_by AS user_id,
           SUM(CASE WHEN l.import_batch_id IS NULL OR l.import_batch_id = '' THEN 1 ELSE 0 END) AS leads_manual,
           SUM(CASE WHEN l.import_batch_id IS NOT NULL AND l.import_batch_id != '' THEN 1 ELSE 0 END) AS leads_csv,
           COUNT(*) AS leads_added
         FROM leads l
         WHERE l.created_by IS NOT NULL
           AND ${DT('l.created_at')} >= datetime(?)
           AND ${DT('l.created_at')} < datetime(?)
           ${stateFilter}
         GROUP BY l.created_by`,
      )
      .all(from, to);

    const activityAgg = db
      .prepare(
        `SELECT a.user_id,
           SUM(CASE WHEN a.type IN ('call','call_attempted','call_connected') THEN 1 ELSE 0 END) AS calls,
           SUM(CASE WHEN a.type = 'call_attempted' THEN 1 ELSE 0 END) AS calls_attempted,
           SUM(CASE WHEN a.type IN ('call','call_connected') THEN 1 ELSE 0 END) AS calls_connected,
           SUM(CASE WHEN a.type = 'whatsapp' THEN 1 ELSE 0 END) AS messages,
           SUM(CASE WHEN a.type IN ('email', 'email_sent') THEN 1 ELSE 0 END) AS emails,
           SUM(CASE WHEN a.type = 'email_followup' THEN 1 ELSE 0 END) AS email_followups,
           SUM(CASE WHEN a.type = 'note' THEN 1 ELSE 0 END) AS notes,
           SUM(CASE WHEN a.type IN ('linkedin','linkedin_connection_sent','linkedin_message','linkedin_followup','linkedin_connection_accepted','linkedin_reply') THEN 1 ELSE 0 END) AS linkedin,
           SUM(CASE WHEN a.type = 'linkedin_connection_sent' THEN 1 ELSE 0 END) AS linkedin_connection_sent,
           SUM(CASE WHEN a.type = 'linkedin_message' THEN 1 ELSE 0 END) AS linkedin_messages,
           SUM(CASE WHEN a.type = 'linkedin_reply' THEN 1 ELSE 0 END) AS linkedin_replies,
           SUM(CASE WHEN a.type = 'meeting_scheduled' THEN 1 ELSE 0 END) AS meetings,
           SUM(CASE WHEN a.type IN ('reply','linkedin_reply') THEN 1 ELSE 0 END) AS replies,
           SUM(CASE WHEN a.type IN ('call','call_attempted','call_connected','whatsapp','email','email_sent','email_followup','linkedin','linkedin_connection_sent','linkedin_message','linkedin_followup','note') THEN 1 ELSE 0 END) AS total_outreach,
           COUNT(DISTINCT CASE WHEN a.type IN ('call','call_attempted','call_connected','whatsapp','email','email_sent','email_followup','linkedin','linkedin_connection_sent','linkedin_message','note','reply','linkedin_reply') THEN a.lead_id END) AS leads_touched
         FROM lead_activities a
         LEFT JOIN leads l ON l.id = a.lead_id
         WHERE a.user_id IS NOT NULL
           AND ${DT('a.created_at')} >= datetime(?)
           AND ${DT('a.created_at')} < datetime(?)
           ${stateFilter}
         GROUP BY a.user_id`,
      )
      .all(from, to);

    const statusMoves = db
      .prepare(
        `SELECT a.user_id,
           SUM(CASE WHEN a.outcome IN ('engaged','conversation') OR a.summary LIKE '%→ engaged%' OR a.summary LIKE '%→ conversation%' THEN 1 ELSE 0 END) AS to_engaged,
           SUM(CASE WHEN a.outcome = 'contacted' OR a.summary LIKE '%→ contacted%' THEN 1 ELSE 0 END) AS to_contacted,
           SUM(CASE WHEN a.outcome IN ('demo_scheduled','demo_booked') OR a.summary LIKE '%→ demo_scheduled%' OR a.summary LIKE '%→ demo_booked%' THEN 1 ELSE 0 END) AS to_demo,
           SUM(CASE WHEN a.outcome = 'trial' OR a.summary LIKE '%→ trial%' THEN 1 ELSE 0 END) AS to_trial,
           SUM(CASE WHEN a.outcome IN ('paid','repeat') OR a.summary LIKE '%→ paid%' THEN 1 ELSE 0 END) AS to_paid,
           SUM(CASE WHEN a.type = 'status_change' THEN 1 ELSE 0 END) AS status_changes
         FROM lead_activities a
         LEFT JOIN leads l ON l.id = a.lead_id
         WHERE a.user_id IS NOT NULL
           AND a.type = 'status_change'
           AND ${DT('a.created_at')} >= datetime(?)
           AND ${DT('a.created_at')} < datetime(?)
           ${stateFilter}
         GROUP BY a.user_id`,
      )
      .all(from, to);

    const paidInPeriod = db
      .prepare(
        `SELECT l.assigned_to AS user_id, COUNT(*) AS paid
         FROM leads l
         WHERE l.assigned_to IS NOT NULL
           AND l.status = 'paid'
           ${stateFilter}
           AND (
             (${DT('l.converted_at')} >= datetime(?) AND ${DT('l.converted_at')} < datetime(?))
             OR (
               (l.converted_at IS NULL OR l.converted_at = '')
               AND ${DT('l.updated_at')} >= datetime(?)
               AND ${DT('l.updated_at')} < datetime(?)
             )
           )
         GROUP BY l.assigned_to`,
      )
      .all(from, to, from, to);

    const followUpsDone = db
      .prepare(
        `SELECT assigned_to AS user_id, COUNT(*) AS followups_completed
         FROM follow_ups
         WHERE status = 'completed'
           AND ${DT("COALESCE(completed_at, updated_at)")} >= datetime(?)
           AND ${DT("COALESCE(completed_at, updated_at)")} < datetime(?)
         GROUP BY assigned_to`,
      )
      .all(from, to);

    const overdueFollowups = db
      .prepare(
        `SELECT assigned_to AS user_id, COUNT(*) AS overdue_followups
         FROM follow_ups
         WHERE assigned_to IS NOT NULL
           AND status IN ('pending', 'overdue')
           AND ${DT('due_at')} < datetime('now')
         GROUP BY assigned_to`,
      )
      .all();

    const byId = (rows) => {
      const m = new Map();
      for (const r of rows) m.set(r.user_id, r);
      return m;
    };
    const addsMap = byId(leadAdds);
    const actMap = byId(activityAgg);
    const moveMap = byId(statusMoves);
    const paidMap = byId(paidInPeriod);
    const fuMap = byId(followUpsDone);
    const overdueMap = byId(overdueFollowups);

    const num = (v) => Number(v) || 0;

    const repRows = reps.map((u) => {
      const a = addsMap.get(u.id) || {};
      const act = actMap.get(u.id) || {};
      const mv = moveMap.get(u.id) || {};
      const paid = num(paidMap.get(u.id)?.paid);
      const leadsAdded = num(a.leads_added);
      const leadsTouched = num(act.leads_touched);
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        leadsManual: num(a.leads_manual),
        leadsCsv: num(a.leads_csv),
        leadsAdded,
        calls: num(act.calls),
        callsAttempted: num(act.calls_attempted),
        callsConnected: num(act.calls_connected),
        messages: num(act.messages),
        emails: num(act.emails),
        emailFollowups: num(act.email_followups),
        notes: num(act.notes),
        linkedin: num(act.linkedin),
        linkedinConnectionSent: num(act.linkedin_connection_sent),
        linkedinMessages: num(act.linkedin_messages),
        linkedinReplies: num(act.linkedin_replies),
        meetings: num(act.meetings),
        replies: num(act.replies),
        totalOutreach: num(act.total_outreach),
        leadsTouched,
        toContacted: num(mv.to_contacted),
        toEngaged: num(mv.to_engaged),
        toConversation: num(mv.to_engaged),
        toDemo: num(mv.to_demo),
        toTrial: num(mv.to_trial),
        toPaid: num(mv.to_paid),
        statusChanges: num(mv.status_changes),
        paid,
        followupsCompleted: num(fuMap.get(u.id)?.followups_completed),
        overdueFollowups: num(overdueMap.get(u.id)?.overdue_followups),
        conversionRate:
          leadsTouched > 0 ? Math.round((paid / leadsTouched) * 1000) / 10 : paid > 0 ? 100 : 0,
      };
    });

    // Sort: most outreach, then leads added
    repRows.sort(
      (x, y) =>
        y.totalOutreach - x.totalOutreach ||
        y.leadsAdded - x.leadsAdded ||
        y.paid - x.paid ||
        x.name.localeCompare(y.name),
    );

    const sumField = (field) => repRows.reduce((s, r) => s + (r[field] || 0), 0);
    const totals = {
      leadsManual: sumField('leadsManual'),
      leadsCsv: sumField('leadsCsv'),
      leadsAdded: sumField('leadsAdded'),
      calls: sumField('calls'),
      callsAttempted: sumField('callsAttempted'),
      callsConnected: sumField('callsConnected'),
      messages: sumField('messages'),
      emails: sumField('emails'),
      emailFollowups: sumField('emailFollowups'),
      notes: sumField('notes'),
      linkedin: sumField('linkedin'),
      linkedinConnectionSent: sumField('linkedinConnectionSent'),
      linkedinMessages: sumField('linkedinMessages'),
      linkedinReplies: sumField('linkedinReplies'),
      meetings: sumField('meetings'),
      replies: sumField('replies'),
      totalOutreach: sumField('totalOutreach'),
      leadsTouched: sumField('leadsTouched'),
      toContacted: sumField('toContacted'),
      toEngaged: sumField('toEngaged'),
      toConversation: sumField('toEngaged'),
      toDemo: sumField('toDemo'),
      toTrial: sumField('toTrial'),
      paid: sumField('paid'),
      followupsCompleted: sumField('followupsCompleted'),
    };

    let feed = [];
    let leadsCreated = [];
    const detailId = focusUserId || (repRows.length === 1 ? repRows[0].id : null);

    if (detailId) {
      feed = db
        .prepare(
          `SELECT a.id, a.type, a.summary, a.outcome, a.created_at,
                  a.lead_id, l.name AS lead_name, l.email AS lead_email, l.status AS lead_status,
                  l.state AS lead_state
           FROM lead_activities a
           LEFT JOIN leads l ON l.id = a.lead_id
           WHERE a.user_id = ?
             AND ${DT('a.created_at')} >= datetime(?)
             AND ${DT('a.created_at')} < datetime(?)
             AND a.type IN ('call','whatsapp','email','email_sent','note','linkedin','reply','status_change')
             ${stateFilter}
           ORDER BY a.created_at DESC
           LIMIT 100`,
        )
        .all(detailId, from, to);

      leadsCreated = db
        .prepare(
          `SELECT l.id, l.name, l.email, l.company, l.source, l.status, l.state, l.import_batch_id, l.created_at
           FROM leads l
           WHERE l.created_by = ?
             AND ${DT('l.created_at')} >= datetime(?)
             AND ${DT('l.created_at')} < datetime(?)
             ${stateFilter}
           ORDER BY l.created_at DESC
           LIMIT 100`,
        )
        .all(detailId, from, to)
        .map((l) => ({
          ...l,
          addMethod: l.import_batch_id ? 'csv' : 'manual',
        }));
    }

    // byState is always unfiltered so CEO can pick any state from the dropdown
    const stateKeyExpr = `CASE WHEN l.state IS NULL OR TRIM(l.state) = '' THEN 'Unspecified' ELSE TRIM(l.state) END`;
    const byState = canViewTeam
      ? db
          .prepare(
            `SELECT ${stateKeyExpr} AS state,
                    COUNT(DISTINCT a.lead_id) AS leads_touched,
                    SUM(CASE WHEN a.type IN ('email','email_sent','email_followup') THEN 1 ELSE 0 END) AS emails,
                    SUM(CASE WHEN a.type IN ('call','call_attempted','call_connected') THEN 1 ELSE 0 END) AS calls,
                    SUM(CASE WHEN a.type IN ('linkedin','linkedin_connection_sent','linkedin_message','linkedin_followup','linkedin_connection_accepted','linkedin_reply') THEN 1 ELSE 0 END) AS linkedin,
                    SUM(CASE WHEN a.type IN ('reply','linkedin_reply') THEN 1 ELSE 0 END) AS replies,
                    COUNT(*) AS activities
             FROM lead_activities a
             JOIN leads l ON l.id = a.lead_id
             WHERE a.user_id IS NOT NULL
               AND ${DT('a.created_at')} >= datetime(?)
               AND ${DT('a.created_at')} < datetime(?)
             GROUP BY 1
             ORDER BY emails DESC, leads_touched DESC, activities DESC
             LIMIT 50`,
          )
          .all(from, to)
          .map((r) => ({
            key: r.state === 'Unspecified' ? 'unspecified' : r.state,
            label: r.state,
            leadsTouched: Number(r.leads_touched) || 0,
            emails: Number(r.emails) || 0,
            calls: Number(r.calls) || 0,
            linkedin: Number(r.linkedin) || 0,
            replies: Number(r.replies) || 0,
            activities: Number(r.activities) || 0,
          }))
      : [];

    res.json({
      ...bounds,
      canViewTeam,
      focusUserId: detailId,
      state: stateLabel,
      reps: repRows,
      totals,
      byState,
      feed,
      leadsCreated,
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

/**
 * Detailed drill-down records for any metric clicked on Dashboard or BD Working page.
 */
router.get(
  '/drilldown',
  requireAnyPermission('analytics:view_all', 'analytics:view_team', 'analytics:view_own'),
  (req, res) => {
    const isCeo = roleHasPermission(req.user.role, 'analytics:view_all');
    const isManager = roleHasPermission(req.user.role, 'analytics:view_team');
    const canViewAll = isCeo || isManager;

    const metric = String(req.query.metric || '').trim();
    const bounds = resolveWorkingPeriod(req.query.period || 'overall');
    const { from, to } = bounds;
    const isOverall = bounds.period === 'overall';

    const userId = req.query.userId
      ? String(req.query.userId)
      : canViewAll
        ? null
        : req.user.id;
    const stage = req.query.stage ? String(req.query.stage).trim() : null;
    const businessType = req.query.businessType ? String(req.query.businessType).trim() : null;
    const reason = req.query.reason ? String(req.query.reason).trim() : null;
    const stateQ = req.query.state ? String(req.query.state).trim() : null;
    const stateClause = !stateQ
      ? ''
      : stateQ.toLowerCase() === 'unspecified'
        ? " AND (l.state IS NULL OR TRIM(l.state) = '')"
        : ` AND TRIM(l.state) = '${stateQ.replace(/'/g, "''").slice(0, 64)}'`;
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);

    const win = (col) =>
      isOverall
        ? ''
        : ` AND ${DT(col)} >= datetime('${from}') AND ${DT(col)} < datetime('${to}')`;

    let items = [];
    let title = 'Records';

    if (metric === 'by_state' || metric === 'state') {
      const st = stateQ || req.query.type;
      title = `Leads in ${st || 'state'}`;
      const typeFilter =
        !st || st.toLowerCase() === 'unspecified'
          ? " AND (l.state IS NULL OR TRIM(l.state) = '')"
          : ` AND TRIM(l.state) = '${String(st).replace(/'/g, "''").slice(0, 64)}'`;
      const uClause = userId ? ` AND l.assigned_to = '${userId}'` : '';
      items = db
        .prepare(
          `SELECT l.id, l.name, l.email, l.phone, l.company, l.status, l.source, l.business_type, l.state,
                  l.created_at AS date, l.notes,
                  u.name AS assigned_to_name,
                  u.name AS user_name
           FROM leads l
           LEFT JOIN users u ON u.id = l.assigned_to
           WHERE 1=1 ${typeFilter} ${uClause}
           ORDER BY l.created_at DESC
           LIMIT ?`,
        )
        .all(limit);
    } else if (metric === 'emails_by_state') {
      const st = stateQ || req.query.type;
      title = `Emails to ${st || 'state'}`;
      const typeFilter =
        !st || st.toLowerCase() === 'unspecified'
          ? " AND (l.state IS NULL OR TRIM(l.state) = '')"
          : ` AND TRIM(l.state) = '${String(st).replace(/'/g, "''").slice(0, 64)}'`;
      items = db
        .prepare(
          `SELECT m.id, m.subject, m.to_email, m.sent_at AS date, m.status,
                  m.open_count, m.reply_count,
                  l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                  l.status AS lead_status, l.business_type, l.state,
                  u.name AS user_name
           FROM email_messages m
           JOIN leads l ON l.id = m.lead_id
           LEFT JOIN users u ON u.id = m.user_id
           WHERE 1=1 ${typeFilter} ${win('m.sent_at')}
           ORDER BY m.sent_at DESC
           LIMIT ?`,
        )
        .all(limit);
    } else if (
      metric === 'leads_added' ||
      metric === 'leads' ||
      metric === 'leads_manual' ||
      metric === 'leads_csv' ||
      metric === 'leads_verified'
    ) {
      let filter = '';
      if (metric === 'leads_manual') {
        filter = " AND (l.import_batch_id IS NULL OR l.import_batch_id = '')";
        title = 'Manual leads added';
      } else if (metric === 'leads_csv') {
        filter = " AND (l.import_batch_id IS NOT NULL AND l.import_batch_id != '')";
        title = 'CSV imported leads';
      } else if (metric === 'leads_verified') {
        filter = " AND (l.email IS NOT NULL AND TRIM(l.email) != '')";
        title = 'Verified leads (with email)';
      } else {
        title = 'Leads added';
      }

      const uClause = userId ? ` AND (l.created_by = '${userId}' OR l.assigned_to = '${userId}')` : '';

      items = db
        .prepare(
          `SELECT l.id, l.name, l.email, l.phone, l.company, l.status, l.source, l.business_type, l.state,
                  COALESCE(l.date_added, l.created_at) AS date,
                  l.created_at, l.notes,
                  u.name AS assigned_to_name,
                  c.name AS user_name,
                  b.filename AS import_batch_filename
           FROM leads l
           LEFT JOIN users u ON u.id = l.assigned_to
           LEFT JOIN users c ON c.id = l.created_by
           LEFT JOIN import_batches b ON b.id = l.import_batch_id
           WHERE 1=1 ${win('l.created_at')} ${uClause} ${filter} ${stateClause}
           ORDER BY l.created_at DESC
           LIMIT ?`,
        )
        .all(limit);
    } else if (metric === 'funnel_stage' || metric === 'stage' || stage) {
      const targetStage = stage || req.query.metric;
      title = `${String(targetStage || 'Stage').replace(/_/g, ' ')} leads`;
      const uClause = userId ? ` AND l.assigned_to = '${userId}'` : '';
      items = db
        .prepare(
          `SELECT l.id, l.name, l.email, l.phone, l.company, l.status, l.source, l.business_type, l.state,
                  l.created_at AS date, l.notes,
                  u.name AS assigned_to_name,
                  u.name AS user_name
           FROM leads l
           LEFT JOIN users u ON u.id = l.assigned_to
           WHERE l.status = ? ${uClause}
           ORDER BY l.created_at DESC
           LIMIT ?`,
        )
        .all(targetStage, limit);
    } else if (metric === 'open_pipeline') {
      title = 'Open pipeline leads';
      const uClause = userId ? ` AND l.assigned_to = '${userId}'` : '';
      items = db
        .prepare(
          `SELECT l.id, l.name, l.email, l.phone, l.company, l.status, l.source, l.business_type, l.state,
                  l.created_at AS date, l.notes,
                  u.name AS assigned_to_name,
                  u.name AS user_name
           FROM leads l
           LEFT JOIN users u ON u.id = l.assigned_to
           WHERE l.status IN (${OPEN_LIST}) ${uClause}
           ORDER BY l.created_at DESC
           LIMIT ?`,
        )
        .all(limit);
    } else if (metric === 'paid') {
      title = 'Paid leads';
      const uClause = userId ? ` AND l.assigned_to = '${userId}'` : '';
      items = db
        .prepare(
          `SELECT l.id, l.name, l.email, l.phone, l.company, l.status, l.source, l.business_type, l.state,
                  COALESCE(l.converted_at, l.updated_at, l.created_at) AS date, l.notes,
                  u.name AS assigned_to_name,
                  u.name AS user_name
           FROM leads l
           LEFT JOIN users u ON u.id = l.assigned_to
           WHERE l.status IN ('paid', 'repeat')
             ${win('COALESCE(l.converted_at, l.updated_at)')} ${uClause}
           ORDER BY COALESCE(l.converted_at, l.updated_at) DESC
           LIMIT ?`,
        )
        .all(limit);
    } else if (metric === 'business_type') {
      const bType = businessType || req.query.type;
      title = `Leads: ${bType || 'Business type'}`;
      const typeFilter =
        bType === 'unspecified'
          ? " AND (l.business_type IS NULL OR TRIM(l.business_type) = '')"
          : ` AND l.business_type = '${bType}'`;
      const uClause = userId ? ` AND l.assigned_to = '${userId}'` : '';
      items = db
        .prepare(
          `SELECT l.id, l.name, l.email, l.phone, l.company, l.status, l.source, l.business_type, l.state,
                  l.created_at AS date, l.notes,
                  u.name AS assigned_to_name,
                  u.name AS user_name
           FROM leads l
           LEFT JOIN users u ON u.id = l.assigned_to
           WHERE 1=1 ${typeFilter} ${uClause}
           ORDER BY l.created_at DESC
           LIMIT ?`,
        )
        .all(limit);
    } else if (metric === 'emails_by_business_type') {
      const bType = businessType || req.query.type;
      title = `Emails sent: ${bType || 'Business type'}`;
      const typeFilter =
        bType === 'unspecified'
          ? " AND (l.business_type IS NULL OR TRIM(l.business_type) = '')"
          : ` AND l.business_type = '${bType}'`;
      items = db
        .prepare(
          `SELECT m.id, m.subject, m.to_email, m.sent_at AS date, m.status,
                  m.open_count, m.reply_count,
                  l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                  l.status AS lead_status, l.business_type, l.state,
                  u.name AS user_name
           FROM email_messages m
           JOIN leads l ON l.id = m.lead_id
           LEFT JOIN users u ON u.id = m.user_id
           WHERE 1=1 ${typeFilter} ${win('m.sent_at')}
           ORDER BY m.sent_at DESC
           LIMIT ?`,
        )
        .all(limit);
    } else if (metric === 'emails_sent' || metric === 'emails') {
      title = 'Emails sent';
      const uClause = userId ? ` AND m.user_id = '${userId}'` : '';
      items = db
        .prepare(
          `SELECT m.id, m.subject, m.to_email, m.sent_at AS date, m.status,
                  m.open_count, m.reply_count,
                  l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                  l.status AS lead_status, l.business_type, l.state,
                  u.name AS user_name
           FROM email_messages m
           LEFT JOIN leads l ON l.id = m.lead_id
           LEFT JOIN users u ON u.id = m.user_id
           WHERE 1=1 ${win('m.sent_at')} ${uClause} ${stateClause}
           ORDER BY m.sent_at DESC
           LIMIT ?`,
        )
        .all(limit);
      if (items.length === 0) {
        // Fallback to lead_activities for email
        const actUClause = userId ? ` AND a.user_id = '${userId}'` : '';
        items = db
          .prepare(
            `SELECT a.id, a.type, a.summary AS subject, a.created_at AS date,
                    l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                    l.status AS lead_status, l.business_type, l.state,
                    u.name AS user_name
             FROM lead_activities a
             LEFT JOIN leads l ON l.id = a.lead_id
             LEFT JOIN users u ON u.id = a.user_id
             WHERE a.type IN ('email', 'email_sent') ${win('a.created_at')} ${actUClause} ${stateClause}
             ORDER BY a.created_at DESC
             LIMIT ?`,
          )
          .all(limit);
      }
    } else if (metric === 'email_followups') {
      title = 'Email follow-ups sent';
      const uClause = userId ? ` AND a.user_id = '${userId}'` : '';
      items = db
        .prepare(
          `SELECT a.id, a.type, a.summary AS subject, a.created_at AS date,
                  l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                  l.status AS lead_status, l.business_type, l.state,
                  u.name AS user_name
           FROM lead_activities a
           LEFT JOIN leads l ON l.id = a.lead_id
           LEFT JOIN users u ON u.id = a.user_id
           WHERE a.type = 'email_followup' ${win('a.created_at')} ${uClause}
           ORDER BY a.created_at DESC
           LIMIT ?`,
        )
        .all(limit);
    } else if (metric === 'email_opens') {
      title = 'Email opens';
      items = db
        .prepare(
          `SELECT e.id, e.subject, e.email AS to_email, e.occurred_at AS date,
                  l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                  l.status AS lead_status, l.business_type, l.state,
                  u.name AS user_name
           FROM email_events e
           LEFT JOIN leads l ON l.id = e.lead_id
           LEFT JOIN email_messages m ON m.id = e.email_message_id
           LEFT JOIN users u ON u.id = m.user_id
           WHERE e.event = 'opened' ${win('e.occurred_at')}
           ORDER BY e.occurred_at DESC
           LIMIT ?`,
        )
        .all(limit);
    } else if (metric === 'email_replies' || metric === 'replies') {
      title = 'Replies received';
      items = db
        .prepare(
          `SELECT r.id, r.from_name, r.from_email, r.subject, r.received_at AS date,
                  COALESCE(r.body_text, r.body_markdown, r.subject) AS preview,
                  l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                  l.status AS lead_status, l.business_type, l.state,
                  u.name AS user_name
           FROM email_replies r
           LEFT JOIN leads l ON l.id = r.lead_id
           LEFT JOIN users u ON u.id = l.assigned_to
           WHERE 1=1 ${win('r.received_at')} ${stateClause}
           ORDER BY r.received_at DESC
           LIMIT ?`,
        )
        .all(limit);
      if (items.length === 0) {
        items = db
          .prepare(
            `SELECT a.id, a.type, a.summary AS subject, a.created_at AS date,
                    l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                    l.status AS lead_status, l.business_type, l.state,
                    u.name AS user_name
             FROM lead_activities a
             LEFT JOIN leads l ON l.id = a.lead_id
             LEFT JOIN users u ON u.id = a.user_id
             WHERE a.type IN ('reply', 'linkedin_reply') ${win('a.created_at')}
             ORDER BY a.created_at DESC
             LIMIT ?`,
          )
          .all(limit);
      }
    } else if (metric === 'positive_replies') {
      title = 'Positive replies';
      items = db
        .prepare(
          `SELECT a.id, a.type, a.summary, a.outcome, a.created_at AS date,
                  l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                  l.status AS lead_status, l.business_type, l.state,
                  u.name AS user_name
           FROM lead_activities a
           LEFT JOIN leads l ON l.id = a.lead_id
           LEFT JOIN users u ON u.id = a.user_id
           WHERE (a.outcome = 'positive' OR a.type = 'reply') ${win('a.created_at')}
           ORDER BY a.created_at DESC
           LIMIT ?`,
        )
        .all(limit);
    } else if (metric.startsWith('linkedin')) {
      const typeMap = {
        linkedin: "a.type IN ('linkedin','linkedin_connection_sent','linkedin_message','linkedin_followup','linkedin_connection_accepted','linkedin_reply')",
        linkedin_connection_sent: "a.type = 'linkedin_connection_sent'",
        linkedin_connection_accepted: "a.type = 'linkedin_connection_accepted'",
        linkedin_messages: "a.type = 'linkedin_message'",
        linkedin_replies: "a.type = 'linkedin_reply'",
        linkedin_followup: "a.type = 'linkedin_followup'",
      };
      const typeClause = typeMap[metric] || "a.type LIKE 'linkedin%'";
      title = String(metric).replace(/_/g, ' ');
      const uClause = userId ? ` AND a.user_id = '${userId}'` : '';
      items = db
        .prepare(
          `SELECT a.id, a.type, a.summary, a.outcome, a.created_at AS date,
                  l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                  l.status AS lead_status, l.business_type, l.state,
                  u.name AS user_name
           FROM lead_activities a
           LEFT JOIN leads l ON l.id = a.lead_id
           LEFT JOIN users u ON u.id = a.user_id
           WHERE ${typeClause} ${win('a.created_at')} ${uClause}
           ORDER BY a.created_at DESC
           LIMIT ?`,
        )
        .all(limit);
    } else if (metric.startsWith('call') || metric === 'whatsapp') {
      const typeMap = {
        calls: "a.type IN ('call','call_attempted','call_connected')",
        calls_attempted: "a.type = 'call_attempted'",
        calls_connected: "a.type IN ('call','call_connected')",
        whatsapp: "a.type = 'whatsapp'",
      };
      const typeClause = typeMap[metric] || "a.type IN ('call','call_attempted','call_connected')";
      title = String(metric).replace(/_/g, ' ');
      const uClause = userId ? ` AND a.user_id = '${userId}'` : '';
      items = db
        .prepare(
          `SELECT a.id, a.type, a.summary, a.outcome, a.created_at AS date,
                  l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                  l.status AS lead_status, l.business_type, l.state,
                  u.name AS user_name
           FROM lead_activities a
           LEFT JOIN leads l ON l.id = a.lead_id
           LEFT JOIN users u ON u.id = a.user_id
           WHERE ${typeClause} ${win('a.created_at')} ${uClause}
           ORDER BY a.created_at DESC
           LIMIT ?`,
        )
        .all(limit);
    } else if (metric === 'followups_completed' || metric === 'followups_done') {
      title = 'Follow-ups completed';
      const uClause = userId ? ` AND f.assigned_to = '${userId}'` : '';
      items = db
        .prepare(
          `SELECT f.id, f.note AS summary, f.due_at,
                  COALESCE(f.completed_at, f.updated_at) AS date,
                  l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                  l.status AS lead_status, l.business_type, l.state,
                  u.name AS user_name
           FROM follow_ups f
           LEFT JOIN leads l ON l.id = f.lead_id
           LEFT JOIN users u ON u.id = f.assigned_to
           WHERE f.status = 'completed' ${win('COALESCE(f.completed_at, f.updated_at)')} ${uClause}
           ORDER BY COALESCE(f.completed_at, f.updated_at) DESC
           LIMIT ?`,
        )
        .all(limit);
    } else if (metric === 'followups_overdue' || metric === 'followups_pending') {
      title = metric === 'followups_overdue' ? 'Overdue follow-ups' : 'Pending follow-ups';
      const statusClause =
        metric === 'followups_overdue'
          ? `f.status IN ('pending', 'overdue') AND ${DT('f.due_at')} < datetime('now')`
          : "f.status = 'pending'";
      const uClause = userId ? ` AND f.assigned_to = '${userId}'` : '';
      items = db
        .prepare(
          `SELECT f.id, f.note AS summary, f.due_at AS date,
                  l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                  l.status AS lead_status, l.business_type, l.state,
                  u.name AS user_name
           FROM follow_ups f
           LEFT JOIN leads l ON l.id = f.lead_id
           LEFT JOIN users u ON u.id = f.assigned_to
           WHERE ${statusClause} ${uClause}
           ORDER BY f.due_at ASC
           LIMIT ?`,
        )
        .all(limit);
    } else if (
      metric === 'to_engaged' ||
      metric === 'to_contacted' ||
      metric === 'to_demo' ||
      metric === 'demos_booked' ||
      metric === 'to_trial' ||
      metric === 'meetings' ||
      metric === 'meetings_requested'
    ) {
      const map = {
        to_engaged: "(a.outcome IN ('engaged','conversation') OR a.summary LIKE '%→ engaged%' OR a.summary LIKE '%→ conversation%')",
        to_contacted: "(a.outcome = 'contacted' OR a.summary LIKE '%→ contacted%')",
        to_demo: "(a.outcome IN ('demo_scheduled','demo_booked') OR a.summary LIKE '%→ demo_scheduled%' OR a.summary LIKE '%→ demo_booked%')",
        demos_booked: "(a.outcome IN ('demo_scheduled','demo_booked') OR a.summary LIKE '%→ demo_scheduled%' OR a.summary LIKE '%→ demo_booked%')",
        to_trial: "(a.outcome = 'trial' OR a.summary LIKE '%→ trial%')",
        meetings: "a.type = 'meeting_scheduled'",
        meetings_requested: "(a.type = 'meeting_scheduled' OR a.summary LIKE '%meeting%')",
      };
      const clause = map[metric] || "a.type = 'status_change'";
      title = String(metric).replace(/_/g, ' ');
      const uClause = userId ? ` AND a.user_id = '${userId}'` : '';
      items = db
        .prepare(
          `SELECT a.id, a.type, a.summary, a.outcome, a.created_at AS date,
                  l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                  l.status AS lead_status, l.business_type, l.state,
                  u.name AS user_name
           FROM lead_activities a
           LEFT JOIN leads l ON l.id = a.lead_id
           LEFT JOIN users u ON u.id = a.user_id
           WHERE ${clause} ${win('a.created_at')} ${uClause}
           ORDER BY a.created_at DESC
           LIMIT ?`,
        )
        .all(limit);
    } else if (metric === 'leads_touched' || metric === 'touched') {
      title = 'Unique leads touched';
      const uClause = userId ? ` AND a.user_id = '${userId}'` : '';
      items = db
        .prepare(
          `SELECT DISTINCT l.id, l.name, l.email, l.company, l.phone, l.status, l.source, l.business_type, l.state,
                  a.created_at AS date, a.summary,
                  u.name AS user_name
           FROM lead_activities a
           JOIN leads l ON l.id = a.lead_id
           LEFT JOIN users u ON u.id = a.user_id
           WHERE a.type IN ('call','call_attempted','call_connected','whatsapp','email','email_sent','email_followup','linkedin','linkedin_connection_sent','linkedin_message','note','reply','linkedin_reply')
             ${win('a.created_at')} ${uClause} ${stateClause}
           ORDER BY a.created_at DESC
           LIMIT ?`,
        )
        .all(limit);
    } else if (metric === 'lost_reason' || reason) {
      const r = reason || req.query.reason;
      title = `Nurture / DQ: ${r || 'Reason'}`;
      items = db
        .prepare(
          `SELECT l.id, l.name, l.email, l.company, l.status, l.source, l.business_type, l.state,
                  l.lost_reason, l.updated_at AS date,
                  u.name AS user_name
           FROM leads l
           LEFT JOIN users u ON u.id = l.assigned_to
           WHERE l.status IN ('nurture', 'lost') AND COALESCE(NULLIF(TRIM(l.lost_reason), ''), 'Unspecified') = ?
           ORDER BY l.updated_at DESC
           LIMIT ?`,
        )
        .all(r, limit);
    } else {
      // General fallback query on lead_activities or leads
      title = String(metric || 'Drilldown').replace(/_/g, ' ');
      items = db
        .prepare(
          `SELECT l.id, l.name, l.email, l.phone, l.company, l.status, l.source, l.business_type, l.state,
                  l.created_at AS date, l.notes,
                  u.name AS user_name
           FROM leads l
           LEFT JOIN users u ON u.id = l.assigned_to
           WHERE 1=1 ${win('l.created_at')}
           ORDER BY l.created_at DESC
           LIMIT ?`,
        )
        .all(limit);
    }

    res.json({
      metric,
      title,
      period: bounds.period,
      periodLabel: bounds.label,
      dateRange: `${bounds.fromYmd} to ${bounds.toYmd}`,
      total: items.length,
      items,
    });
  },
);

export default router;
