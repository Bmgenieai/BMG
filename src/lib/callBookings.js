/**
 * BD-booked calls/meetings (LinkedIn etc.) → Call bookings tab + internal notify.
 * Notify always From magic.retouching@ (Reply-To same) for inbox placement.
 */
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { sendTransactionalEmail } from './brevo.js';
import { getEmailAccountByEmail, resolveSendAccount } from './emailAccounts.js';
import { normalizeCampaignTimezone } from './campaignTimezones.js';
import { zonedDateTime, toScheduleSql } from './campaignSchedule.js';

export const CALL_NOTIFY_TO = [
  'sajid@bmgenie.ai',
  'asbah.iqbal@bmgenie.ai',
  'musayyab@bmgenie.ai',
];

export const CALL_NOTIFY_FROM = 'magic.retouching@bmgenie.ai';

const CALL_TZ_LABELS = {
  'America/Los_Angeles': 'Pacific Time',
  'America/Denver': 'Mountain Time',
  'America/Phoenix': 'Arizona Time',
  'America/Chicago': 'Central Time',
  'America/New_York': 'Eastern Time',
  'Europe/London': 'UK Time',
  'Europe/Dublin': 'Ireland Time',
  'Asia/Karachi': 'Pakistan Time',
  UTC: 'UTC',
};

function resolveMagicSender() {
  const account =
    getEmailAccountByEmail(CALL_NOTIFY_FROM) ||
    getEmailAccountByEmail(process.env.BREVO_SENDER_EMAIL);
  if (account) {
    const resolved = resolveSendAccount(account.id);
    return {
      accountId: resolved.accountId,
      sender: {
        email: CALL_NOTIFY_FROM,
        name: resolved.sender.name || 'BMGenie Sales',
      },
    };
  }
  return {
    accountId: null,
    sender: {
      email: CALL_NOTIFY_FROM,
      name: (process.env.BREVO_SENDER_NAME || 'BMGenie Sales').trim(),
    },
  };
}

function formatWhenLocal(date, timeZone) {
  return date.toLocaleString('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function buildNotifyContent({ lead, booking, bookedByName }) {
  const tz = booking.timezone || 'America/Los_Angeles';
  const when = new Date(
    String(booking.scheduled_at).includes('T')
      ? booking.scheduled_at
      : `${String(booking.scheduled_at).replace(' ', 'T')}Z`,
  );
  const whenLabel = Number.isNaN(when.getTime())
    ? booking.scheduled_at
    : `${formatWhenLocal(when, tz)} (${CALL_TZ_LABELS[tz] || tz})`;

  const lines = [
    'Call / meeting booked from BMGenie CRM',
    '',
    `Lead: ${booking.name || lead.name || '—'}`,
    `Email: ${booking.email || lead.email || '—'}`,
    `Phone: ${booking.phone || lead.phone || '—'}`,
    `Company: ${booking.company || lead.company || '—'}`,
    `When: ${whenLabel}`,
    `Timezone: ${CALL_TZ_LABELS[tz] || tz}`,
    `Booked by: ${bookedByName || 'BD'}`,
    booking.notes ? `Notes: ${booking.notes}` : null,
    '',
    `CRM lead: https://crm.bmgenie.ai/leads?id=${lead.id}`,
  ].filter((x) => x != null);

  const text = lines.join('\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#111">
<p><strong>Call / meeting booked from BMGenie CRM</strong></p>
<table style="border-collapse:collapse">
<tr><td style="padding:4px 12px 4px 0;color:#555">Lead</td><td>${escapeHtml(booking.name || lead.name || '—')}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#555">Email</td><td>${escapeHtml(booking.email || lead.email || '—')}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#555">Phone</td><td>${escapeHtml(booking.phone || lead.phone || '—')}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#555">Company</td><td>${escapeHtml(booking.company || lead.company || '—')}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#555">When</td><td>${escapeHtml(whenLabel)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#555">Booked by</td><td>${escapeHtml(bookedByName || 'BD')}</td></tr>
${booking.notes ? `<tr><td style="padding:4px 12px 4px 0;color:#555">Notes</td><td>${escapeHtml(booking.notes)}</td></tr>` : ''}
</table>
<p style="margin-top:16px"><a href="https://crm.bmgenie.ai/leads?id=${encodeURIComponent(lead.id)}">Open lead in CRM</a></p>
</div>`;

  const subject = `Call booked: ${booking.name || lead.name || 'Lead'} — ${whenLabel}`;
  return { subject, text, html };
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {{ leadId: string, user: object, scheduledLocal: string, timezone: string, phone?: string, notes?: string }} opts
 * scheduledLocal: YYYY-MM-DDTHH:mm (datetime-local)
 */
export async function bookCallMeeting(opts) {
  const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(opts.leadId);
  if (!lead) {
    const err = new Error('Lead not found');
    err.status = 404;
    throw err;
  }

  const timezone = normalizeCampaignTimezone(opts.timezone || 'America/Los_Angeles');
  const local = String(opts.scheduledLocal || '').trim();
  const m = local.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) {
    const err = new Error('Date and time required (YYYY-MM-DDTHH:mm)');
    err.status = 400;
    throw err;
  }
  const [, ymd, hh, mm] = m;
  const when = zonedDateTime(ymd, Number(hh), Number(mm), 0, timezone);
  if (Number.isNaN(when.getTime())) {
    const err = new Error('Invalid date/time');
    err.status = 400;
    throw err;
  }

  const phone = String(opts.phone || lead.phone || '').trim() || null;
  const notes = String(opts.notes || '').trim() || null;
  const id = uuid();
  const scheduledSql = toScheduleSql(when);

  db.prepare(
    `INSERT INTO call_bookings (
       id, lead_id, booked_by, name, email, phone, company,
       scheduled_at, timezone, notes, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')`,
  ).run(
    id,
    lead.id,
    opts.user?.id || null,
    lead.name || null,
    lead.email || null,
    phone,
    lead.company || null,
    scheduledSql,
    timezone,
    notes,
  );

  if (phone && phone !== lead.phone) {
    db.prepare(
      `UPDATE leads SET phone = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(phone, lead.id);
  }

  // Funnel: meeting booked
  db.prepare(
    `UPDATE leads SET status = 'demo_scheduled', updated_at = datetime('now') WHERE id = ?`,
  ).run(lead.id);

  const whenLabel = formatWhenLocal(when, timezone);
  db.prepare(
    `INSERT INTO lead_activities (id, lead_id, user_id, type, summary)
     VALUES (?, ?, ?, 'meeting_scheduled', ?)`,
  ).run(
    uuid(),
    lead.id,
    opts.user?.id || null,
    `Call booked ${whenLabel} (${CALL_TZ_LABELS[timezone] || timezone})${notes ? ` — ${notes}` : ''}`,
  );

  const booking = db.prepare(`SELECT * FROM call_bookings WHERE id = ?`).get(id);
  const { sender } = resolveMagicSender();
  const content = buildNotifyContent({
    lead,
    booking,
    bookedByName: opts.user?.name,
  });

  const notifyErrors = [];
  for (const toEmail of CALL_NOTIFY_TO) {
    try {
      await sendTransactionalEmail({
        toEmail,
        toName: toEmail.split('@')[0],
        subject: content.subject,
        htmlContent: content.html,
        textContent: content.text,
        leadId: lead.id,
        tags: ['call-booking-notify'],
        sender,
        replyTo: { email: sender.email, name: sender.name },
        skipListUnsubscribe: true,
      });
    } catch (err) {
      notifyErrors.push(`${toEmail}: ${err.message || err}`);
    }
  }

  if (notifyErrors.length) {
    db.prepare(
      `UPDATE call_bookings
       SET notify_error = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(notifyErrors.join('; ').slice(0, 2000), id);
  } else {
    db.prepare(
      `UPDATE call_bookings
       SET notify_sent_at = datetime('now'), notify_error = NULL, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(id);
  }

  return {
    booking: db.prepare(`SELECT * FROM call_bookings WHERE id = ?`).get(id),
    notifySent: notifyErrors.length === 0,
    notifyErrors,
    from: sender.email,
    notified: CALL_NOTIFY_TO,
  };
}

export function listCallBookings({ q = '', status = '', limit = 500 } = {}) {
  const clauses = ['1=1'];
  const params = [];
  if (status) {
    clauses.push('b.status = ?');
    params.push(status);
  }
  if (q) {
    const like = `%${q}%`;
    clauses.push(
      '(b.name LIKE ? OR b.email LIKE ? OR b.phone LIKE ? OR b.company LIKE ? OR l.name LIKE ?)',
    );
    params.push(like, like, like, like, like);
  }
  return db
    .prepare(
      `SELECT b.*,
              l.status AS lead_status,
              l.assigned_to,
              u.name AS booked_by_name,
              au.name AS assigned_name
       FROM call_bookings b
       LEFT JOIN leads l ON l.id = b.lead_id
       LEFT JOIN users u ON u.id = b.booked_by
       LEFT JOIN users au ON au.id = l.assigned_to
       WHERE ${clauses.join(' AND ')}
       ORDER BY b.scheduled_at ASC
       LIMIT ?`,
    )
    .all(...params, Math.min(Math.max(Number(limit) || 500, 1), 1000));
}

export function callBookingCounts() {
  const total = db.prepare(`SELECT COUNT(*) AS c FROM call_bookings`).get().c;
  const upcoming = db
    .prepare(
      `SELECT COUNT(*) AS c FROM call_bookings
       WHERE status = 'scheduled'
         AND datetime(REPLACE(REPLACE(scheduled_at, 'T', ' '), 'Z', '')) >= datetime('now')`,
    )
    .get().c;
  const today = db
    .prepare(
      `SELECT COUNT(*) AS c FROM call_bookings
       WHERE date(REPLACE(REPLACE(scheduled_at, 'T', ' '), 'Z', '')) = date('now')`,
    )
    .get().c;
  return { total, upcoming, today };
}
