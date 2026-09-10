import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DATABASE_PATH || path.join(dataDir, 'crm.db');
export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('ceo','manager','telesales')),
      phone TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT
    );

    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      company TEXT,
      country TEXT,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'qualified',
      assigned_to TEXT REFERENCES users(id) ON DELETE SET NULL,
      assigned_at TEXT,
      assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      bmgenie_user_id TEXT,
      estimated_value REAL DEFAULT 0,
      notes TEXT,
      next_follow_up_at TEXT,
      converted_at TEXT,
      lost_reason TEXT,
      import_batch_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source);
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_leads_follow_up ON leads(next_follow_up_at);

    CREATE TABLE IF NOT EXISTS lead_activities (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      summary TEXT NOT NULL,
      outcome TEXT,
      next_follow_up_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_activities_lead ON lead_activities(lead_id);

    CREATE TABLE IF NOT EXISTS follow_ups (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      assigned_to TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      due_at TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','cancelled','overdue')),
      completed_at TEXT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_followups_assignee ON follow_ups(assigned_to, status);
    CREATE INDEX IF NOT EXISTS idx_followups_due ON follow_ups(due_at);

    CREATE TABLE IF NOT EXISTS import_batches (
      id TEXT PRIMARY KEY,
      filename TEXT,
      source_label TEXT DEFAULT 'csv_import',
      row_count INTEGER DEFAULT 0,
      imported_count INTEGER DEFAULT 0,
      skipped_count INTEGER DEFAULT 0,
      uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS revenue_events (
      id TEXT PRIMARY KEY,
      lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      label TEXT,
      recorded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lead_employees (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      job_title TEXT,
      notes TEXT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_lead_employees_lead ON lead_employees(lead_id);
  `);

  // Additive columns for telesales lead-gen (safe on existing DBs)
  const leadAlters = [
    `ALTER TABLE leads ADD COLUMN state TEXT`,
    `ALTER TABLE leads ADD COLUMN job_title TEXT`,
    `ALTER TABLE leads ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL`,
    `ALTER TABLE leads ADD COLUMN industry TEXT`,
    `ALTER TABLE leads ADD COLUMN contact_format TEXT DEFAULT 'company'`,
  ];
  for (const sql of leadAlters) {
    try {
      db.exec(sql);
    } catch {
      /* column already exists */
    }
  }

  // One-time: legacy disposition → sales funnel stages
  const statusMigrates = [
    [`UPDATE leads SET status = 'qualified' WHERE status IN ('new','contacted')`, 'qualified'],
    [
      `UPDATE leads SET status = 'conversation' WHERE status IN ('interested','neutral','follow_up_scheduled')`,
      'conversation',
    ],
    [`UPDATE leads SET status = 'lost' WHERE status = 'not_interested'`, 'lost'],
    [`UPDATE leads SET status = 'paid' WHERE status = 'converted'`, 'paid'],
  ];
  for (const [sql] of statusMigrates) {
    try {
      db.exec(sql);
    } catch {
      /* ignore */
    }
  }
}

migrate();
