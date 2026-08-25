import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { LEAD_SOURCES, OPEN_STATUSES } from '../lib/permissions.js';

const router = Router();

/**
 * Service-to-service ingest from BMGenie product.
 * Auth: header X-CRM-Ingest-Key must match CRM_INGEST_API_KEY.
 *
 * Events:
 *  - user.signup            → source signup_no_listing (new / unassigned)
 *  - user.free_credit_used  → escalate to free_credit_no_purchase (if not purchased)
 *  - user.purchased         → mark converted (won)
 *  - user.credits_depleted  → win-back lead purchased_no_repurchase (if not already open)
 */

function requireIngestKey(req, res, next) {
  const expected = process.env.CRM_INGEST_API_KEY;
  if (!expected) {
    return res.status(503).json({ error: 'CRM ingest not configured (CRM_INGEST_API_KEY)' });
  }
  const provided =
    req.headers['x-crm-ingest-key'] ||
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null);
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'Invalid ingest key' });
  }
  next();
}

function findOpenByUser(bmgenieUserId, email) {
  if (bmgenieUserId) {
    const byId = db
      .prepare(
        `SELECT * FROM leads
         WHERE bmgenie_user_id = ?
           AND status IN ('new','contacted','follow_up_scheduled')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(bmgenieUserId);
    if (byId) return byId;
  }
  if (email) {
    return db
      .prepare(
        `SELECT * FROM leads
         WHERE email = ? COLLATE NOCASE
           AND status IN ('new','contacted','follow_up_scheduled')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(email);
  }
  return null;
}

function findAnyByUser(bmgenieUserId, email) {
  if (bmgenieUserId) {
    const byId = db
      .prepare(
        `SELECT * FROM leads WHERE bmgenie_user_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(bmgenieUserId);
    if (byId) return byId;
  }
  if (email) {
    return db
      .prepare(
        `SELECT * FROM leads WHERE email = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT 1`,
      )
      .get(email);
  }
  return null;
}

function insertLead({
  name,
  email,
  phone,
  company,
  country,
  source,
  bmgenieUserId,
  estimatedValue,
  notes,
  status = 'new',
}) {
  const id = uuid();
  db.prepare(
    `INSERT INTO leads (
      id, name, email, phone, company, country, source, status,
      bmgenie_user_id, estimated_value, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    email || null,
    phone || null,
    company || null,
    country || null,
    source,
    status,
    bmgenieUserId || null,
    Number(estimatedValue) || 0,
    notes || null,
  );
  db.prepare(
    `INSERT INTO lead_activities (id, lead_id, user_id, type, summary)
     VALUES (?, ?, NULL, 'product_sync', ?)`,
  ).run(uuid(), id, notes || `Synced from BMGenie (${source})`);
  return db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id);
}

function updateLead(id, fields, activitySummary) {
  const allowed = [
    'name',
    'email',
    'phone',
    'company',
    'country',
    'source',
    'status',
    'notes',
    'estimated_value',
    'bmgenie_user_id',
    'converted_at',
    'lost_reason',
  ];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(fields[key]);
    }
  }
  if (!sets.length) return db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id);
  sets.push(`updated_at = datetime('now')`);
  params.push(id);
  db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (activitySummary) {
    db.prepare(
      `INSERT INTO lead_activities (id, lead_id, user_id, type, summary)
       VALUES (?, ?, NULL, 'product_sync', ?)`,
    ).run(uuid(), id, activitySummary);
  }
  return db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id);
}

router.post('/product-leads', requireIngestKey, (req, res) => {
  const {
    event,
    source: sourceOverride,
    bmgenieUserId,
    name,
    email,
    phone,
    company,
    country,
    estimatedValue,
    notes,
  } = req.body || {};

  if (!event) return res.status(400).json({ error: 'event required' });
  if (!name && !email) {
    return res.status(400).json({ error: 'name or email required' });
  }

  const displayName = (name || email || 'BMGenie user').trim();
  const normalizedEmail = email ? String(email).trim().toLowerCase() : null;

  let lead = null;
  let action = 'noop';

  if (event === 'user.signup') {
    const existing = findAnyByUser(bmgenieUserId, normalizedEmail);
    if (existing) {
      lead = updateLead(
        existing.id,
        {
          name: displayName,
          email: normalizedEmail,
          phone: phone ?? existing.phone,
          company: company ?? existing.company,
          country: country ?? existing.country,
          bmgenie_user_id: bmgenieUserId || existing.bmgenie_user_id,
          source:
            OPEN_STATUSES.includes(existing.status) && existing.source === 'signup_no_listing'
              ? existing.source
              : existing.source,
        },
        'Signup sync — lead already existed',
      );
      action = 'updated';
    } else {
      lead = insertLead({
        name: displayName,
        email: normalizedEmail,
        phone,
        company,
        country,
        source: sourceOverride || 'signup_no_listing',
        bmgenieUserId,
        estimatedValue: estimatedValue ?? 65,
        notes: notes || 'Signed up on BMGenie — no listings yet',
      });
      action = 'created';
    }
  } else if (event === 'user.free_credit_used') {
    const open = findOpenByUser(bmgenieUserId, normalizedEmail);
    if (open && open.status !== 'converted') {
      lead = updateLead(
        open.id,
        {
          source: 'free_credit_no_purchase',
          name: displayName,
          email: normalizedEmail || open.email,
          phone: phone ?? open.phone,
          company: company ?? open.company,
          bmgenie_user_id: bmgenieUserId || open.bmgenie_user_id,
          notes: notes || 'Used free listing credit — has not purchased a package',
          estimated_value: estimatedValue ?? open.estimated_value ?? 65,
        },
        'Escalated to free_credit_no_purchase',
      );
      action = 'updated';
    } else if (!open) {
      lead = insertLead({
        name: displayName,
        email: normalizedEmail,
        phone,
        company,
        country,
        source: 'free_credit_no_purchase',
        bmgenieUserId,
        estimatedValue: estimatedValue ?? 65,
        notes: notes || 'Used free listing credit — has not purchased a package',
      });
      action = 'created';
    } else {
      lead = open;
      action = 'skipped';
    }
  } else if (event === 'user.purchased') {
    const open = findOpenByUser(bmgenieUserId, normalizedEmail);
    const any = open || findAnyByUser(bmgenieUserId, normalizedEmail);
    if (any) {
      lead = updateLead(
        any.id,
        {
          status: 'converted',
          converted_at: new Date().toISOString(),
          name: displayName,
          email: normalizedEmail || any.email,
          bmgenie_user_id: bmgenieUserId || any.bmgenie_user_id,
          estimated_value: estimatedValue ?? any.estimated_value,
          notes: notes || 'Purchased a BMGenie package',
        },
        'Marked converted — package purchased',
      );
      action = 'converted';
    } else {
      lead = insertLead({
        name: displayName,
        email: normalizedEmail,
        phone,
        company,
        country,
        source: sourceOverride || 'manual',
        bmgenieUserId,
        estimatedValue: estimatedValue ?? 65,
        notes: notes || 'Purchased a BMGenie package',
        status: 'converted',
      });
      db.prepare(
        `UPDATE leads SET converted_at = datetime('now') WHERE id = ?`,
      ).run(lead.id);
      lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(lead.id);
      action = 'created_converted';
    }
  } else if (event === 'user.credits_depleted') {
    // Win-back: paid once, credits gone, no repurchase yet
    const openWinback = findOpenByUser(bmgenieUserId, normalizedEmail);
    if (openWinback && openWinback.source === 'purchased_no_repurchase') {
      lead = openWinback;
      action = 'skipped';
    } else if (openWinback && openWinback.status !== 'converted') {
      lead = updateLead(
        openWinback.id,
        {
          source: 'purchased_no_repurchase',
          notes: notes || 'Paid credits depleted — win-back opportunity',
          estimated_value: estimatedValue ?? openWinback.estimated_value ?? 65,
          bmgenie_user_id: bmgenieUserId || openWinback.bmgenie_user_id,
        },
        'Escalated to purchased_no_repurchase',
      );
      action = 'updated';
    } else {
      // Don't reopen if they just converted moments ago with remaining credits path —
      // only create win-back when no open lead exists
      const recentConverted = db
        .prepare(
          `SELECT * FROM leads
           WHERE (bmgenie_user_id = ? OR email = ? COLLATE NOCASE)
             AND status = 'converted'
             AND converted_at >= datetime('now', '-1 day')
           ORDER BY converted_at DESC LIMIT 1`,
        )
        .get(bmgenieUserId || '', normalizedEmail || '');
      if (recentConverted && !openWinback) {
        // Still create win-back as a fresh open lead for repurchase outreach
      }
      lead = insertLead({
        name: displayName,
        email: normalizedEmail,
        phone,
        company,
        country,
        source: 'purchased_no_repurchase',
        bmgenieUserId,
        estimatedValue: estimatedValue ?? 65,
        notes: notes || 'Paid credits depleted — win-back opportunity',
      });
      action = 'created';
    }
  } else {
    return res.status(400).json({
      error: 'Unknown event',
      allowed: [
        'user.signup',
        'user.free_credit_used',
        'user.purchased',
        'user.credits_depleted',
      ],
    });
  }

  if (sourceOverride && LEAD_SOURCES[sourceOverride] && lead && action !== 'skipped') {
    // already applied where relevant
  }

  res.json({ ok: true, action, lead });
});

router.get('/health', requireIngestKey, (_req, res) => {
  res.json({ ok: true, ingest: true });
});

export default router;
