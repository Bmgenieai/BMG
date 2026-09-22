import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { authRequired, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { LEAD_SOURCES, OPEN_STATUSES, roleHasPermission } from '../lib/permissions.js';
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
        `SELECT created_by AS user_id,
           SUM(CASE WHEN import_batch_id IS NULL OR import_batch_id = '' THEN 1 ELSE 0 END) AS leads_manual,
           SUM(CASE WHEN import_batch_id IS NOT NULL AND import_batch_id != '' THEN 1 ELSE 0 END) AS leads_csv,
           COUNT(*) AS leads_added
         FROM leads
         WHERE created_by IS NOT NULL
           AND ${DT('created_at')} >= datetime(?)
           AND ${DT('created_at')} < datetime(?)
         GROUP BY created_by`,
      )
      .all(from, to);

    const activityAgg = db
      .prepare(
        `SELECT user_id,
           SUM(CASE WHEN type = 'call' THEN 1 ELSE 0 END) AS calls,
           SUM(CASE WHEN type = 'whatsapp' THEN 1 ELSE 0 END) AS messages,
           SUM(CASE WHEN type IN ('email', 'email_sent') THEN 1 ELSE 0 END) AS emails,
           SUM(CASE WHEN type = 'note' THEN 1 ELSE 0 END) AS notes,
           SUM(CASE WHEN type = 'linkedin' THEN 1 ELSE 0 END) AS linkedin,
           SUM(CASE WHEN type IN ('call','whatsapp','email','email_sent','linkedin','note') THEN 1 ELSE 0 END) AS total_outreach,
           COUNT(DISTINCT CASE WHEN type IN ('call','whatsapp','email','email_sent','linkedin','note','reply') THEN lead_id END) AS leads_touched
         FROM lead_activities
         WHERE user_id IS NOT NULL
           AND ${DT('created_at')} >= datetime(?)
           AND ${DT('created_at')} < datetime(?)
         GROUP BY user_id`,
      )
      .all(from, to);

    const statusMoves = db
      .prepare(
        `SELECT user_id,
           SUM(CASE WHEN outcome = 'conversation' OR summary LIKE '%→ conversation%' OR summary LIKE '%to conversation%' THEN 1 ELSE 0 END) AS to_conversation,
           SUM(CASE WHEN outcome = 'demo_booked' OR summary LIKE '%→ demo_booked%' OR summary LIKE '%to demo_booked%' THEN 1 ELSE 0 END) AS to_demo,
           SUM(CASE WHEN outcome = 'trial' OR summary LIKE '%→ trial%' OR summary LIKE '%to trial%' THEN 1 ELSE 0 END) AS to_trial,
           SUM(CASE WHEN outcome = 'paid' OR summary LIKE '%→ paid%' OR summary LIKE '%to paid%' THEN 1 ELSE 0 END) AS to_paid,
           SUM(CASE WHEN type = 'status_change' THEN 1 ELSE 0 END) AS status_changes
         FROM lead_activities
         WHERE user_id IS NOT NULL
           AND type = 'status_change'
           AND ${DT('created_at')} >= datetime(?)
           AND ${DT('created_at')} < datetime(?)
         GROUP BY user_id`,
      )
      .all(from, to);

    const paidInPeriod = db
      .prepare(
        `SELECT assigned_to AS user_id, COUNT(*) AS paid
         FROM leads
         WHERE assigned_to IS NOT NULL
           AND status = 'paid'
           AND (
             (${DT('converted_at')} >= datetime(?) AND ${DT('converted_at')} < datetime(?))
             OR (
               (converted_at IS NULL OR converted_at = '')
               AND ${DT('updated_at')} >= datetime(?)
               AND ${DT('updated_at')} < datetime(?)
             )
           )
         GROUP BY assigned_to`,
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
        messages: num(act.messages),
        emails: num(act.emails),
        notes: num(act.notes),
        linkedin: num(act.linkedin),
        totalOutreach: num(act.total_outreach),
        leadsTouched,
        toConversation: num(mv.to_conversation),
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
      messages: sumField('messages'),
      emails: sumField('emails'),
      notes: sumField('notes'),
      linkedin: sumField('linkedin'),
      totalOutreach: sumField('totalOutreach'),
      leadsTouched: sumField('leadsTouched'),
      toConversation: sumField('toConversation'),
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
                  a.lead_id, l.name AS lead_name, l.email AS lead_email, l.status AS lead_status
           FROM lead_activities a
           LEFT JOIN leads l ON l.id = a.lead_id
           WHERE a.user_id = ?
             AND ${DT('a.created_at')} >= datetime(?)
             AND ${DT('a.created_at')} < datetime(?)
             AND a.type IN ('call','whatsapp','email','email_sent','note','linkedin','reply','status_change')
           ORDER BY a.created_at DESC
           LIMIT 100`,
        )
        .all(detailId, from, to);

      leadsCreated = db
        .prepare(
          `SELECT id, name, email, company, source, status, import_batch_id, created_at
           FROM leads
           WHERE created_by = ?
             AND ${DT('created_at')} >= datetime(?)
             AND ${DT('created_at')} < datetime(?)
           ORDER BY created_at DESC
           LIMIT 100`,
        )
        .all(detailId, from, to)
        .map((l) => ({
          ...l,
          addMethod: l.import_batch_id ? 'csv' : 'manual',
        }));
    }

    res.json({
      ...bounds,
      canViewTeam,
      focusUserId: detailId,
      reps: repRows,
      totals,
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

export default router;
