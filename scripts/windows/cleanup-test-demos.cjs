/**
 * One-shot: remove known test "Demos booked" leads from production SQLite.
 * Safe: only deletes leads matching explicit test emails / John Doe Test Ramzan.
 */
const Database = require('better-sqlite3');
const db = new Database('./data/crm.db');
db.pragma('foreign_keys = ON');

const emails = [
  'doe88377@gmail.com',
  'onetwothreefourfive097@gmail.com',
  'onetwothreefourfive087@gmail.com',
  'onetwithreefourfive087@gmail.com',
].map((e) => e.toLowerCase());

const leads = db
  .prepare(
    `SELECT id, name, email, status, source
     FROM leads
     WHERE LOWER(TRIM(COALESCE(email, ''))) IN (${emails.map(() => '?').join(',')})
        OR (
          LOWER(COALESCE(name, '')) LIKE '%john doe%'
          AND LOWER(COALESCE(name, '')) LIKE '%test ramzan%'
        )
        OR (
          LOWER(TRIM(COALESCE(name, ''))) = 'testing crm'
          AND (
            LOWER(TRIM(COALESCE(email, ''))) LIKE 'onetwothreefourfive0%'
            OR LOWER(TRIM(COALESCE(email, ''))) LIKE 'onetwithreefourfive0%'
          )
        )`,
  )
  .all(...emails);

console.log('MATCHED_LEADS', JSON.stringify(leads, null, 2));

const beforeActs = leads.length
  ? db
      .prepare(
        `SELECT COUNT(*) AS c FROM lead_activities
         WHERE lead_id IN (${leads.map(() => '?').join(',')})
           AND (
             outcome IN ('demo_scheduled', 'demo_booked')
             OR summary LIKE '%→ demo_scheduled%'
             OR summary LIKE '%→ demo_booked%'
             OR summary LIKE '%demo_scheduled%'
           )`,
      )
      .get(...leads.map((l) => l.id)).c
  : 0;

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

console.log(
  JSON.stringify(
    {
      demoActivitiesBeforeDelete: beforeActs,
      ...result,
      remainingMatchingLeads: db
        .prepare(
          `SELECT COUNT(*) AS c FROM leads
           WHERE LOWER(TRIM(COALESCE(email, ''))) IN (${emails.map(() => '?').join(',')})`,
        )
        .get(...emails).c,
    },
    null,
    2,
  ),
);

db.close();
