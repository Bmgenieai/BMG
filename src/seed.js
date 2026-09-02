import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { db, migrate } from './db.js';

migrate();

const hash = bcrypt.hashSync('password123', 10);

const users = [
  { email: 'ceo@bmgenie.ai', name: 'CEO Benchmark', role: 'ceo', phone: '+1-202-555-0100' },
  { email: 'manager@bmgenie.ai', name: 'Sara Manager', role: 'manager', phone: '+1-202-555-0101' },
  { email: 'sales1@bmgenie.ai', name: 'Jordan Sales', role: 'telesales', phone: '+1-202-555-0102' },
  { email: 'sales2@bmgenie.ai', name: 'Taylor Sales', role: 'telesales', phone: '+1-202-555-0103' },
];

/** Wipe leads and related data; keep users table structure. */
db.exec('DELETE FROM revenue_events');
db.exec('DELETE FROM follow_ups');
db.exec('DELETE FROM lead_activities');
db.exec('DELETE FROM leads');
db.exec('DELETE FROM import_batches');
db.exec('DELETE FROM users');

const insertUser = db.prepare(
  `INSERT INTO users (id, email, password_hash, name, role, phone) VALUES (?, ?, ?, ?, ?, ?)`,
);
for (const u of users) {
  insertUser.run(uuid(), u.email, hash, u.name, u.role, u.phone);
}

console.log('BMGenie CRM seeded (staff accounts only — no sample leads).');
console.log('Change passwords after first login. Initial password: password123');
for (const u of users) {
  console.log(`  ${u.role.padEnd(10)} ${u.email}`);
}
