/**
 * One-shot: remove known test "Demos booked" leads from production SQLite.
 */
const Database = require('better-sqlite3');
const db = new Database('./data/crm.db');
db.pragma('foreign_keys = ON');

const emails = [
  'doe88377@gmail.com',
  'doe86377@gmail.com',
  'onetwothreefourfive097@gmail.com',
  'onetwothreefourfive087@gmail.com',
  'onetwithreefourfive087@gmail.com',
  'onetwithreefourfive097@gmail.com',
].map((e) => e.toLowerCase());

const leads = db
  .prepare(
    `SELECT id, name, email, status, source
     FROM leads
     WHERE LOWER(TRIM(COALESCE(email, ''))) IN (${emails.map(() => '?').join(',')})
        OR (
          LOWER(COALESCE(name, '')) LIKE '%john doe%'
          AND LOWER(COALESCE(name, '')) LIKE '%test%'
        )
        OR (
          LOWER(TRIM(COALESCE(name, ''))) = 'testing crm'
        )`,
  )
  .all(...emails);

console.log('MATCHED_LEADS', JSON.stringify(leads, null, 2));

// Also list remaining demos-booked activities this month for visibility
const remainingDemoRows = db
  .prepare(
    `SELECT a.id, a.created_at, a.summary, a.outcome, l.name, l.email, u.name AS rep
     FROM lead_activities a
     LEFT JOIN leads l ON l.id = a.lead_id
     LEFT JOIN users u ON u.id = a.user_id
     WHERE (
       a.outcome IN ('demo_scheduled', 'demo_booked')
       OR a.summary LIKE '%→ demo_scheduled%'
       OR a.summary LIKE '%→ demo_booked%'
     )
     AND datetime(REPLACE(REPLACE(a.created_at, 'T', ' '), 'Z', '')) >= datetime('2026-10-01')
     ORDER BY a.created_at DESC
     LIMIT 20`,
  )
  .all();
console.log('REMAINING_OCT_DEMOS_BEFORE', JSON.stringify(remainingDemoRows, null, 2));

const result = db.transaction(() => {
  let bookingsRemoved = db
    .prepare(
      `DELETE FROM demo_bookings
       WHERE LOWER(TRIM(COALESCE(email, ''))) IN (${emails.map(() => '?').join(',')})`,
    )
    .run(...emails).changes;

  if (leads.length) {
    bookingsRemoved += db
      .prepare(
        `DELETE FROM demo_bookings
         WHERE lead_id IN (${leads.map(() => '?').join(',')})`,
      )
      .run(...leads.map((l) => l.id)).changes;
  }

  const delLead = db.prepare('DELETE FROM leads WHERE id = ?');
  let leadsRemoved = 0;
  for (const l of leads) {
    leadsRemoved += delLead.run(l.id).changes;
  }
  return { bookingsRemoved, leadsRemoved };
})();

const remainingAfter = db
  .prepare(
    `SELECT a.id, a.created_at, a.summary, l.name, l.email
     FROM lead_activities a
     LEFT JOIN leads l ON l.id = a.lead_id
     WHERE (
       a.outcome IN ('demo_scheduled', 'demo_booked')
       OR a.summary LIKE '%→ demo_scheduled%'
       OR a.summary LIKE '%→ demo_booked%'
     )
     AND datetime(REPLACE(REPLACE(a.created_at, 'T', ' '), 'Z', '')) >= datetime('2026-10-01')
     ORDER BY a.created_at DESC
     LIMIT 20`,
  )
  .all();

console.log(
  JSON.stringify(
    {
      ...result,
      remainingMatchingLeads: db
        .prepare(
          `SELECT COUNT(*) AS c FROM leads
           WHERE LOWER(TRIM(COALESCE(email, ''))) IN (${emails.map(() => '?').join(',')})
              OR LOWER(TRIM(COALESCE(name, ''))) = 'testing crm'`,
        )
        .get(...emails).c,
      remainingOctDemosAfter: remainingAfter,
    },
    null,
    2,
  ),
);

db.close();
