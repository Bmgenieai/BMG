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

db.exec('DELETE FROM revenue_events');
db.exec('DELETE FROM follow_ups');
db.exec('DELETE FROM lead_activities');
db.exec('DELETE FROM leads');
db.exec('DELETE FROM import_batches');
db.exec('DELETE FROM users');

const userIds = {};
const insertUser = db.prepare(
  `INSERT INTO users (id, email, password_hash, name, role, phone) VALUES (?, ?, ?, ?, ?, ?)`,
);
for (const u of users) {
  const id = uuid();
  userIds[u.role === 'telesales' ? u.email : u.role] = id;
  if (u.role === 'telesales') userIds[u.email] = id;
  userIds[u.role] = userIds[u.role] || id;
  insertUser.run(id, u.email, hash, u.name, u.role, u.phone);
}

// Fix telesales ids map
const allUsers = db.prepare(`SELECT id, email, role FROM users`).all();
for (const u of allUsers) {
  userIds[u.email] = u.id;
  if (u.role !== 'telesales') userIds[u.role] = u.id;
}

const sampleLeads = [
  {
    name: 'Bright Lens Studio',
    email: 'hello@brightlens.us',
    phone: '+1-415-555-2001',
    company: 'Bright Lens',
    country: 'US',
    source: 'signup_no_listing',
    status: 'new',
    estimated_value: 65,
  },
  {
    name: 'Nordic Frames AB',
    email: 'ops@nordicframes.se',
    company: 'Nordic Frames',
    country: 'SE',
    source: 'signup_no_listing',
    status: 'new',
    estimated_value: 450,
  },
  {
    name: 'Coastal HDR Photos',
    email: 'mia@coastalhdr.com',
    phone: '+1-305-555-8811',
    company: 'Coastal HDR',
    country: 'US',
    source: 'free_credit_no_purchase',
    status: 'contacted',
    estimated_value: 65,
    assigned: 'sales1@bmgenie.ai',
  },
  {
    name: 'London Property Media',
    email: 'desk@lpm.co.uk',
    company: 'LPM',
    country: 'UK',
    source: 'free_credit_no_purchase',
    status: 'follow_up_scheduled',
    estimated_value: 450,
    assigned: 'sales1@bmgenie.ai',
  },
  {
    name: 'Apex Agency Elite',
    email: 'billing@apexagency.io',
    company: 'Apex Agency',
    country: 'US',
    source: 'purchased_no_repurchase',
    status: 'contacted',
    estimated_value: 450,
    assigned: 'sales2@bmgenie.ai',
  },
  {
    name: 'Berlin Home Shots',
    email: 'team@berlinshots.de',
    company: 'Berlin Home Shots',
    country: 'DE',
    source: 'purchased_no_repurchase',
    status: 'new',
    estimated_value: 65,
  },
  {
    name: 'Meta Lead — PhotoPro NYC',
    email: 'leads@photopro.nyc',
    phone: '+1-212-555-0199',
    company: 'PhotoPro NYC',
    country: 'US',
    source: 'csv_import',
    status: 'new',
    estimated_value: 65,
  },
  {
    name: 'Meta Lead — Dublin Estates Visuals',
    email: 'info@dev.ie',
    company: 'Dublin Estates Visuals',
    country: 'IE',
    source: 'csv_import',
    status: 'converted',
    estimated_value: 450,
    assigned: 'sales2@bmgenie.ai',
  },
  {
    name: 'Pacific Edit Co',
    email: 'sam@pacificedit.com',
    company: 'Pacific Edit',
    country: 'US',
    source: 'manual',
    status: 'lost',
    estimated_value: 16,
    assigned: 'sales1@bmgenie.ai',
    lost_reason: 'Using competitor',
  },
  {
    name: 'Amsterdam Listings Lab',
    email: 'hello@listingslab.nl',
    company: 'Listings Lab',
    country: 'NL',
    source: 'signup_no_listing',
    status: 'new',
    estimated_value: 65,
  },
];

const insertLead = db.prepare(
  `INSERT INTO leads (id, name, email, phone, company, country, source, status, assigned_to, assigned_at, assigned_by, estimated_value, notes, next_follow_up_at, converted_at, lost_reason)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

for (const L of sampleLeads) {
  const id = uuid();
  const assignee = L.assigned ? userIds[L.assigned] : null;
  const nextFu =
    L.status === 'follow_up_scheduled'
      ? new Date(Date.now() + 86400000).toISOString()
      : L.status === 'contacted'
        ? new Date(Date.now() - 3600000).toISOString()
        : null;
  insertLead.run(
    id,
    L.name,
    L.email,
    L.phone || null,
    L.company || null,
    L.country || null,
    L.source,
    L.status,
    assignee,
    assignee ? new Date().toISOString() : null,
    assignee ? userIds.manager : null,
    L.estimated_value || 0,
    `Seed lead · ${L.source}`,
    nextFu,
    L.status === 'converted' ? new Date().toISOString() : null,
    L.lost_reason || null,
  );

  db.prepare(
    `INSERT INTO lead_activities (id, lead_id, user_id, type, summary)
     VALUES (?, ?, ?, 'created', ?)`,
  ).run(uuid(), id, userIds.manager, 'Seeded sample lead');

  if (assignee && nextFu) {
    db.prepare(
      `INSERT INTO follow_ups (id, lead_id, assigned_to, due_at, note, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      uuid(),
      id,
      assignee,
      nextFu,
      'Seed follow-up',
      new Date(nextFu) < new Date() ? 'overdue' : 'pending',
      userIds.manager,
    );
  }

  if (L.status === 'converted') {
    db.prepare(
      `INSERT INTO revenue_events (id, lead_id, amount, currency, label, recorded_by)
       VALUES (?, ?, ?, 'USD', ?, ?)`,
    ).run(uuid(), id, L.estimated_value || 450, 'Agency Elite / package', userIds.ceo);
  }
}

db.prepare(
  `INSERT INTO revenue_events (id, amount, currency, label, recorded_by, occurred_at)
   VALUES (?, 1290, 'USD', 'Stripe credit packs (synced)', ?, datetime('now','-7 days'))`,
).run(uuid(), userIds.ceo);

console.log('BMGenie CRM seeded.');
console.log('Logins (password: password123):');
for (const u of users) {
  console.log(`  ${u.role.padEnd(10)} ${u.email}`);
}
