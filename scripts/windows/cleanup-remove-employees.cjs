/**
 * One-shot: hard-delete specific employee accounts from production SQLite.
 * Leads stay; assigned_to / created_by / activity user_id become NULL where FKs allow.
 * Follow-ups assigned to these users are removed (ON DELETE CASCADE).
 */
const Database = require('better-sqlite3');
const db = new Database('./data/crm.db');
db.pragma('foreign_keys = ON');

const emails = [
  'sajid-ceo@bmgenie.ai',
  'sales1@bmgenie.ai',
  'maaz@bmgenie.ai',
  'sajid-director@bmgenie.ai',
  'sales2@bmgenie.ai',
].map((e) => e.toLowerCase());

const users = db
  .prepare(
    `SELECT id, email, name, role, is_active
     FROM users
     WHERE LOWER(TRIM(email)) IN (${emails.map(() => '?').join(',')})`,
  )
  .all(...emails);

console.log('MATCHED_USERS', JSON.stringify(users, null, 2));

const missing = emails.filter(
  (e) => !users.some((u) => String(u.email).toLowerCase() === e),
);
if (missing.length) {
  console.log('NOT_FOUND', JSON.stringify(missing));
}

if (!users.length) {
  console.log('NOTHING_TO_DELETE');
  process.exit(0);
}

const ids = users.map((u) => u.id);

const result = db.transaction(() => {
  // Break self-references on users.created_by before delete
  const clearCreatedBy = db.prepare(
    `UPDATE users SET created_by = NULL WHERE created_by IN (${ids.map(() => '?').join(',')})`,
  );
  const createdByCleared = clearCreatedBy.run(...ids).changes;

  const del = db.prepare('DELETE FROM users WHERE id = ?');
  let removed = 0;
  for (const id of ids) {
    removed += del.run(id).changes;
  }
  return { createdByCleared, removed };
})();

const remaining = db
  .prepare(
    `SELECT email FROM users
     WHERE LOWER(TRIM(email)) IN (${emails.map(() => '?').join(',')})`,
  )
  .all(...emails)
  .map((r) => r.email);

console.log('DELETE_RESULT', JSON.stringify(result));
console.log('STILL_PRESENT', JSON.stringify(remaining));
console.log('CLEANUP_REMOVE_EMPLOYEES_DONE');
db.close();
