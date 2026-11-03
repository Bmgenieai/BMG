/**
 * One-shot BD departure handover on production SQLite.
 *
 * Moves CURRENT ownership from FROM_EMAIL → TO_EMAIL:
 *   - leads.assigned_to (+ assigned_at / assigned_by)
 *   - open follow_ups.assigned_to
 *   - chat_threads.assigned_to_user_id
 *   - pending scheduled_emails.user_id
 *
 * Leaves historical attribution alone (still shows as the leaving BD):
 *   - lead_activities.user_id
 *   - leads.created_by, follow_ups.created_by
 *   - email_messages.user_id, completed follow-ups, imports, revenue, chat reply JSON
 *
 * Soft-deactivates the leaving user after transfer.
 * Creates the destination BD account if missing (prints a one-time temp password).
 *
 * Usage (on Windows deploy folder):
 *   node .\scripts\windows\handover-bd-user.cjs
 *
 * Optional env:
 *   FROM_EMAIL=ramzan.hashmi@bmgenie.ai
 *   TO_EMAIL=nabeelhassan@bmgenie.ai
 *   TO_NAME=Nabeel Hassan
 *   DRY_RUN=1   — count only, no writes
 */
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');

const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'crm.db');
const FROM_EMAIL = String(process.env.FROM_EMAIL || 'ramzan.hashmi@bmgenie.ai')
  .trim()
  .toLowerCase();
const TO_EMAIL = String(process.env.TO_EMAIL || 'nabeelhassan@bmgenie.ai')
  .trim()
  .toLowerCase();
const TO_NAME = String(process.env.TO_NAME || 'Nabeel Hassan').trim();
const DRY_RUN = String(process.env.DRY_RUN || '').trim() === '1';

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

function getUserByEmail(email) {
  return db
    .prepare(
      `SELECT id, email, name, role, is_active, created_at
       FROM users WHERE email = ? COLLATE NOCASE`,
    )
    .get(email);
}

function countsFor(userId) {
  return {
    leads_assigned: db
      .prepare(`SELECT COUNT(*) AS c FROM leads WHERE assigned_to = ?`)
      .get(userId).c,
    followups_open: db
      .prepare(
        `SELECT COUNT(*) AS c FROM follow_ups
         WHERE assigned_to = ? AND status IN ('pending','overdue')`,
      )
      .get(userId).c,
    followups_all: db
      .prepare(`SELECT COUNT(*) AS c FROM follow_ups WHERE assigned_to = ?`)
      .get(userId).c,
    chats_assigned: db
      .prepare(`SELECT COUNT(*) AS c FROM chat_threads WHERE assigned_to_user_id = ?`)
      .get(userId).c,
    scheduled_pending: db
      .prepare(
        `SELECT COUNT(*) AS c FROM scheduled_emails
         WHERE user_id = ? AND status = 'pending'`,
      )
      .get(userId).c,
    activities_historical: db
      .prepare(`SELECT COUNT(*) AS c FROM lead_activities WHERE user_id = ?`)
      .get(userId).c,
    leads_created: db
      .prepare(`SELECT COUNT(*) AS c FROM leads WHERE created_by = ?`)
      .get(userId).c,
    emails_sent: db
      .prepare(`SELECT COUNT(*) AS c FROM email_messages WHERE user_id = ?`)
      .get(userId).c,
  };
}

const fromUser = getUserByEmail(FROM_EMAIL);
if (!fromUser) {
  console.error('FROM_USER_NOT_FOUND', FROM_EMAIL);
  process.exit(1);
}

let toUser = getUserByEmail(TO_EMAIL);
let createdTo = false;
let tempPassword = null;

console.log('DB_PATH', dbPath);
console.log('DRY_RUN', DRY_RUN);
console.log('FROM_USER', JSON.stringify(fromUser));
console.log('TO_USER_BEFORE', toUser ? JSON.stringify(toUser) : 'NOT_FOUND');
console.log('FROM_COUNTS_BEFORE', JSON.stringify(countsFor(fromUser.id), null, 2));

if (!toUser) {
  tempPassword = crypto.randomBytes(12).toString('hex'); // 24 hex chars
  const id = uuid();
  if (!DRY_RUN) {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, name, role, phone, is_active, created_by)
       VALUES (?, ?, ?, ?, 'telesales', NULL, 1, NULL)`,
    ).run(id, TO_EMAIL, bcrypt.hashSync(tempPassword, 10), TO_NAME);
    createdTo = true;
    toUser = getUserByEmail(TO_EMAIL);
  } else {
    createdTo = true;
    toUser = {
      id: '(dry-run-new)',
      email: TO_EMAIL,
      name: TO_NAME,
      role: 'telesales',
      is_active: 1,
    };
  }
  console.log('TO_USER_CREATED', createdTo, TO_EMAIL, TO_NAME);
  if (tempPassword) {
    console.log('TO_USER_TEMP_PASSWORD', tempPassword);
    console.log(
      'TO_USER_PASSWORD_NOTE',
      'Share once with Nabeel; he should change it after first login (Employees admin can reset).',
    );
  }
} else {
  // Ensure active BD (telesales) so assign validation / queues work
  if (!DRY_RUN) {
    if (toUser.role !== 'telesales' && toUser.role !== 'manager') {
      db.prepare(
        `UPDATE users SET role = 'telesales', updated_at = datetime('now') WHERE id = ?`,
      ).run(toUser.id);
    }
    if (!toUser.is_active) {
      db.prepare(
        `UPDATE users SET is_active = 1, updated_at = datetime('now') WHERE id = ?`,
      ).run(toUser.id);
    }
    toUser = getUserByEmail(TO_EMAIL);
  }
}

if (fromUser.id === toUser.id) {
  console.error('FROM_AND_TO_SAME_USER');
  process.exit(1);
}

const leadIds = db
  .prepare(`SELECT id FROM leads WHERE assigned_to = ?`)
  .all(fromUser.id)
  .map((r) => r.id);

const result = DRY_RUN
  ? {
      leadsMoved: leadIds.length,
      followupsMoved: countsFor(fromUser.id).followups_open,
      chatsMoved: countsFor(fromUser.id).chats_assigned,
      scheduledMoved: countsFor(fromUser.id).scheduled_pending,
      activitiesLogged: leadIds.length,
      fromDeactivated: true,
      createdTo,
    }
  : db.transaction(() => {
      const nowAssign = db.prepare(
        `UPDATE leads SET
           assigned_to = ?,
           assigned_at = datetime('now'),
           assigned_by = ?,
           updated_at = datetime('now')
         WHERE id = ?`,
      );
      const insertAct = db.prepare(
        `INSERT INTO lead_activities (id, lead_id, user_id, type, summary)
         VALUES (?, ?, ?, 'assigned', ?)`,
      );
      const summary = `Handover from ${fromUser.name} → ${toUser.name} (BD departure)`;

      let leadsMoved = 0;
      let activitiesLogged = 0;
      for (const leadId of leadIds) {
        leadsMoved += nowAssign.run(toUser.id, toUser.id, leadId).changes;
        insertAct.run(uuid(), leadId, toUser.id, summary);
        activitiesLogged += 1;
      }

      const followupsMoved = db
        .prepare(
          `UPDATE follow_ups SET assigned_to = ?
           WHERE assigned_to = ? AND status IN ('pending','overdue')`,
        )
        .run(toUser.id, fromUser.id).changes;

      const chatsMoved = db
        .prepare(
          `UPDATE chat_threads SET
             assigned_to_user_id = ?,
             assigned_at = datetime('now')
           WHERE assigned_to_user_id = ?`,
        )
        .run(toUser.id, fromUser.id).changes;

      const scheduledMoved = db
        .prepare(
          `UPDATE scheduled_emails SET user_id = ?
           WHERE user_id = ? AND status = 'pending'`,
        )
        .run(toUser.id, fromUser.id).changes;

      const fromDeactivated = db
        .prepare(
          `UPDATE users SET is_active = 0, updated_at = datetime('now') WHERE id = ?`,
        )
        .run(fromUser.id).changes;

      return {
        leadsMoved,
        followupsMoved,
        chatsMoved,
        scheduledMoved,
        activitiesLogged,
        fromDeactivated,
        createdTo,
      };
    })();

console.log('HANDOVER_RESULT', JSON.stringify(result, null, 2));
console.log(
  'FROM_COUNTS_AFTER',
  JSON.stringify(countsFor(fromUser.id), null, 2),
);
console.log('TO_COUNTS_AFTER', JSON.stringify(countsFor(toUser.id), null, 2));
console.log(
  'HISTORICAL_NOTE',
  'lead_activities / created_by / sent emails for the leaving BD were NOT rewritten — past work still shows as them; new work on these leads will show as the new BD.',
);
console.log(
  'FROM_USER_AFTER',
  JSON.stringify(getUserByEmail(FROM_EMAIL) || fromUser),
);
console.log('TO_USER_AFTER', JSON.stringify(getUserByEmail(TO_EMAIL) || toUser));
console.log(DRY_RUN ? 'HANDOVER_DRY_RUN_DONE' : 'HANDOVER_BD_USER_DONE');
db.close();
