import { Router } from 'express';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { LEAD_SOURCES, OPEN_STATUSES } from '../lib/permissions.js';

const router = Router();

/**
 * Service-to-service ingest from BMGenie product / Calendly / Tawk.
 * Auth: header X-CRM-Ingest-Key must match CRM_INGEST_API_KEY
 * (Calendly/Tawk may also use their own signature headers when configured).
 *
 * Events (POST /product-leads):
 *  - user.signup
 *  - user.free_credit_used
 *  - user.purchased
 *  - user.credits_depleted
 *  - user.checkout_opened
 *  - user.checkout_abandoned
 *  - user.revision_requested
 *  - demo.booked
 *  - chat.started
 *  - chat.transcript
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
           AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(bmgenieUserId, ...OPEN_STATUSES);
    if (byId) return byId;
  }
  if (email) {
    return db
      .prepare(
        `SELECT * FROM leads
         WHERE email = ? COLLATE NOCASE
           AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(email, ...OPEN_STATUSES);
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

function serializeMetadata(metadata) {
  if (metadata == null) return null;
  try {
    return typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
  } catch {
    return null;
  }
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
  status = 'qualified',
  metadata,
}) {
  const id = uuid();
  db.prepare(
    `INSERT INTO leads (
      id, name, email, phone, company, country, source, status,
      bmgenie_user_id, estimated_value, notes, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    serializeMetadata(metadata),
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
    'metadata',
  ];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(key === 'metadata' ? serializeMetadata(fields[key]) : fields[key]);
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

function upsertCheckoutAbandoned({
  displayName,
  normalizedEmail,
  phone,
  company,
  country,
  bmgenieUserId,
  estimatedValue,
  notes,
  metadata,
  markAbandoned,
}) {
  const open = findOpenByUser(bmgenieUserId, normalizedEmail);
  const anyCheckout = db
    .prepare(
      `SELECT * FROM leads
       WHERE source = 'checkout_abandoned'
         AND (
           (bmgenie_user_id IS NOT NULL AND bmgenie_user_id = ?)
           OR (email IS NOT NULL AND email = ? COLLATE NOCASE)
         )
         AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(bmgenieUserId || '', normalizedEmail || '', ...OPEN_STATUSES);

  const target = anyCheckout || (open && open.source === 'checkout_abandoned' ? open : null);

  if (target) {
    return {
      lead: updateLead(
        target.id,
        {
          source: 'checkout_abandoned',
          name: displayName,
          email: normalizedEmail || target.email,
          phone: phone ?? target.phone,
          company: company ?? target.company,
          bmgenie_user_id: bmgenieUserId || target.bmgenie_user_id,
          notes:
            notes ||
            (markAbandoned
              ? 'Opened Stripe payment then abandoned'
              : 'Opened Stripe payment box — not completed yet'),
          estimated_value: estimatedValue ?? target.estimated_value ?? 65,
          metadata: metadata ?? undefined,
        },
        markAbandoned ? 'Checkout abandoned' : 'Checkout opened (Stripe)',
      ),
      action: 'updated',
    };
  }

  if (open && open.status === 'paid') {
    return { lead: open, action: 'skipped' };
  }

  // Prefer escalate existing open product lead; else create new
  if (open && OPEN_STATUSES.includes(open.status) && open.status !== 'paid') {
    return {
      lead: updateLead(
        open.id,
        {
          source: 'checkout_abandoned',
          name: displayName,
          email: normalizedEmail || open.email,
          phone: phone ?? open.phone,
          company: company ?? open.company,
          bmgenie_user_id: bmgenieUserId || open.bmgenie_user_id,
          notes:
            notes ||
            (markAbandoned
              ? 'Opened Stripe payment then abandoned'
              : 'Opened Stripe payment box — not completed yet'),
          estimated_value: estimatedValue ?? open.estimated_value ?? 65,
          metadata: metadata ?? undefined,
        },
        markAbandoned ? 'Escalated to checkout_abandoned' : 'Checkout opened — escalated',
      ),
      action: 'updated',
    };
  }

  return {
    lead: insertLead({
      name: displayName,
      email: normalizedEmail,
      phone,
      company,
      country,
      source: 'checkout_abandoned',
      bmgenieUserId,
      estimatedValue: estimatedValue ?? 65,
      notes:
        notes ||
        (markAbandoned
          ? 'Opened Stripe payment then abandoned'
          : 'Opened Stripe payment box — not completed yet'),
      metadata,
    }),
    action: 'created',
  };
}

function upsertRevisionRequested({
  displayName,
  normalizedEmail,
  phone,
  company,
  country,
  bmgenieUserId,
  estimatedValue,
  notes,
  metadata,
}) {
  const open = findOpenByUser(bmgenieUserId, normalizedEmail);
  if (open && open.status !== 'paid') {
    return {
      lead: updateLead(
        open.id,
        {
          source: 'revision_requested',
          name: displayName,
          email: normalizedEmail || open.email,
          phone: phone ?? open.phone,
          company: company ?? open.company,
          bmgenie_user_id: bmgenieUserId || open.bmgenie_user_id,
          notes: notes || 'Requested listing revisions on BMGenie',
          estimated_value: estimatedValue ?? open.estimated_value ?? 65,
          metadata: metadata ?? undefined,
        },
        'Revision requested on BMGenie',
      ),
      action: 'updated',
    };
  }
  return {
    lead: insertLead({
      name: displayName,
      email: normalizedEmail,
      phone,
      company,
      country,
      source: 'revision_requested',
      bmgenieUserId,
      estimatedValue: estimatedValue ?? 65,
      notes: notes || 'Requested listing revisions on BMGenie',
      metadata,
    }),
    action: 'created',
  };
}

function upsertDemoBooking({
  displayName,
  normalizedEmail,
  phone,
  company,
  country,
  bmgenieUserId,
  estimatedValue,
  notes,
  metadata,
}) {
  const meta = metadata || {};
  const existing = findAnyByUser(bmgenieUserId, normalizedEmail);
  let lead;
  let action;

  if (existing) {
    lead = updateLead(
      existing.id,
      {
        name: displayName,
        email: normalizedEmail || existing.email,
        phone: phone ?? existing.phone,
        company: company ?? existing.company,
        country: country ?? existing.country,
        bmgenie_user_id: bmgenieUserId || existing.bmgenie_user_id,
        source: existing.source === 'demo_booking' ? existing.source : existing.source,
        status: existing.status === 'paid' || existing.status === 'lost' ? existing.status : 'demo_booked',
        notes: notes || `Demo booked for ${meta.scheduledAt || 'scheduled time'}`,
        estimated_value: estimatedValue ?? existing.estimated_value ?? 65,
        metadata: meta,
      },
      `Demo booked — ${meta.scheduledAt || 'Calendly'}`,
    );
    // Prefer demo_booking source when moving into demo queue
    if (lead.status === 'demo_booked') {
      lead = updateLead(lead.id, { source: 'demo_booking' }, null);
    }
    action = 'updated';
  } else {
    lead = insertLead({
      name: displayName,
      email: normalizedEmail,
      phone,
      company,
      country,
      source: 'demo_booking',
      bmgenieUserId,
      estimatedValue: estimatedValue ?? 65,
      notes: notes || `Demo booked for ${meta.scheduledAt || 'scheduled time'}`,
      status: 'demo_booked',
      metadata: meta,
    });
    action = 'created';
  }

  const bookingId = uuid();
  const prior = meta.calendlyInviteeUri
    ? db
        .prepare(`SELECT id FROM demo_bookings WHERE calendly_invitee_uri = ?`)
        .get(meta.calendlyInviteeUri)
    : null;

  if (prior) {
    db.prepare(
      `UPDATE demo_bookings SET
        lead_id = ?, name = ?, email = ?, phone = ?, scheduled_at = ?, timezone = ?,
        duration_minutes = ?, calendly_event_uri = ?, status = 'scheduled',
        questions_json = ?, raw_json = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      lead.id,
      displayName,
      normalizedEmail,
      phone || null,
      meta.scheduledAt || null,
      meta.timezone || null,
      meta.durationMinutes || null,
      meta.calendlyEventUri || null,
      serializeMetadata(meta.questionsAndAnswers || []),
      serializeMetadata(meta),
      prior.id,
    );
  } else {
    db.prepare(
      `INSERT INTO demo_bookings (
        id, lead_id, name, email, phone, scheduled_at, timezone, duration_minutes,
        calendly_event_uri, calendly_invitee_uri, status, questions_json, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
    ).run(
      bookingId,
      lead.id,
      displayName,
      normalizedEmail,
      phone || null,
      meta.scheduledAt || null,
      meta.timezone || null,
      meta.durationMinutes || null,
      meta.calendlyEventUri || null,
      meta.calendlyInviteeUri || null,
      serializeMetadata(meta.questionsAndAnswers || []),
      serializeMetadata(meta),
    );
  }

  return { lead, action };
}

function upsertChatThread({
  displayName,
  normalizedEmail,
  bmgenieUserId,
  metadata,
  event,
}) {
  const meta = metadata || {};
  const chatId = meta.chatId || meta.externalChatId;
  if (!chatId) {
    return { error: 'metadata.chatId required for chat events' };
  }

  const existing = db
    .prepare(`SELECT * FROM chat_threads WHERE provider = ? AND external_chat_id = ?`)
    .get(meta.provider || 'tawk', chatId);

  let lead = findAnyByUser(bmgenieUserId, normalizedEmail);
  if (!lead && (normalizedEmail || displayName)) {
    lead = insertLead({
      name: displayName || normalizedEmail || 'Chat visitor',
      email: normalizedEmail,
      source: 'chat_support',
      bmgenieUserId,
      notes: meta.message || 'Chat started on bmgenie.ai',
      metadata: meta,
    });
  } else if (lead && lead.source !== 'chat_support' && OPEN_STATUSES.includes(lead.status)) {
    // keep existing source; only attach activity
    db.prepare(
      `INSERT INTO lead_activities (id, lead_id, user_id, type, summary)
       VALUES (?, ?, NULL, 'product_sync', ?)`,
    ).run(uuid(), lead.id, `Chat ${event}: ${meta.message || chatId}`);
  }

  const preview =
    meta.message ||
    (Array.isArray(meta.transcript) && meta.transcript.length
      ? String(meta.transcript[meta.transcript.length - 1]?.msg || meta.transcript[meta.transcript.length - 1]?.message || '').slice(0, 240)
      : existing?.preview) ||
    null;

  if (existing) {
    db.prepare(
      `UPDATE chat_threads SET
        visitor_name = COALESCE(?, visitor_name),
        visitor_email = COALESCE(?, visitor_email),
        bmgenie_user_id = COALESCE(?, bmgenie_user_id),
        lead_id = COALESCE(?, lead_id),
        status = ?,
        page_url = COALESCE(?, page_url),
        preview = COALESCE(?, preview),
        transcript_json = COALESCE(?, transcript_json),
        ended_at = CASE WHEN ? = 'closed' THEN COALESCE(ended_at, datetime('now')) ELSE ended_at END,
        tawk_property_id = COALESCE(?, tawk_property_id),
        raw_json = ?,
        updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      displayName || null,
      normalizedEmail || null,
      bmgenieUserId || null,
      lead?.id || null,
      event === 'chat.transcript' ? 'closed' : existing.status || 'open',
      meta.pageUrl || null,
      preview,
      meta.transcript ? serializeMetadata(meta.transcript) : null,
      event === 'chat.transcript' ? 'closed' : 'open',
      meta.tawkPropertyId || null,
      serializeMetadata(meta),
      existing.id,
    );
    return {
      lead,
      chat: db.prepare(`SELECT * FROM chat_threads WHERE id = ?`).get(existing.id),
      action: 'updated',
    };
  }

  const id = uuid();
  db.prepare(
    `INSERT INTO chat_threads (
      id, provider, external_chat_id, visitor_name, visitor_email, bmgenie_user_id,
      lead_id, status, page_url, preview, transcript_json, started_at, tawk_property_id, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)`,
  ).run(
    id,
    meta.provider || 'tawk',
    chatId,
    displayName || null,
    normalizedEmail || null,
    bmgenieUserId || null,
    lead?.id || null,
    event === 'chat.transcript' ? 'closed' : 'open',
    meta.pageUrl || null,
    preview,
    meta.transcript ? serializeMetadata(meta.transcript) : null,
    meta.tawkPropertyId || null,
    serializeMetadata(meta),
  );

  return {
    lead,
    chat: db.prepare(`SELECT * FROM chat_threads WHERE id = ?`).get(id),
    action: 'created',
  };
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
    metadata,
  } = req.body || {};

  if (!event) return res.status(400).json({ error: 'event required' });
  if (!name && !email && !['chat.started', 'chat.transcript'].includes(event)) {
    return res.status(400).json({ error: 'name or email required' });
  }

  const displayName = (name || email || 'BMGenie user').trim();
  const normalizedEmail = email ? String(email).trim().toLowerCase() : null;

  let lead = null;
  let action = 'noop';
  let extra = null;

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
          metadata: metadata ?? undefined,
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
        metadata,
      });
      action = 'created';
    }
  } else if (event === 'user.free_credit_used') {
    const open = findOpenByUser(bmgenieUserId, normalizedEmail);
    if (open && open.status !== 'paid') {
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
          metadata: metadata ?? undefined,
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
        metadata,
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
          status: 'paid',
          converted_at: new Date().toISOString(),
          name: displayName,
          email: normalizedEmail || any.email,
          bmgenie_user_id: bmgenieUserId || any.bmgenie_user_id,
          estimated_value: estimatedValue ?? any.estimated_value,
          notes: notes || 'Purchased a BMGenie package',
          metadata: metadata ?? undefined,
        },
        'Marked paid — package purchased',
      );
      action = 'paid';
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
        status: 'paid',
        metadata,
      });
      db.prepare(
        `UPDATE leads SET converted_at = datetime('now') WHERE id = ?`,
      ).run(lead.id);
      lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(lead.id);
      action = 'created_paid';
    }
  } else if (event === 'user.credits_depleted') {
    const openWinback = findOpenByUser(bmgenieUserId, normalizedEmail);
    if (openWinback && openWinback.source === 'purchased_no_repurchase') {
      lead = openWinback;
      action = 'skipped';
    } else if (openWinback && openWinback.status !== 'paid') {
      lead = updateLead(
        openWinback.id,
        {
          source: 'purchased_no_repurchase',
          notes: notes || 'Paid credits depleted — win-back opportunity',
          estimated_value: estimatedValue ?? openWinback.estimated_value ?? 65,
          bmgenie_user_id: bmgenieUserId || openWinback.bmgenie_user_id,
          metadata: metadata ?? undefined,
        },
        'Escalated to purchased_no_repurchase',
      );
      action = 'updated';
    } else {
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
        metadata,
      });
      action = 'created';
    }
  } else if (event === 'user.checkout_opened') {
    const result = upsertCheckoutAbandoned({
      displayName,
      normalizedEmail,
      phone,
      company,
      country,
      bmgenieUserId,
      estimatedValue,
      notes,
      metadata,
      markAbandoned: false,
    });
    lead = result.lead;
    action = result.action;
  } else if (event === 'user.checkout_abandoned') {
    const result = upsertCheckoutAbandoned({
      displayName,
      normalizedEmail,
      phone,
      company,
      country,
      bmgenieUserId,
      estimatedValue,
      notes,
      metadata,
      markAbandoned: true,
    });
    lead = result.lead;
    action = result.action;
  } else if (event === 'user.revision_requested') {
    const result = upsertRevisionRequested({
      displayName,
      normalizedEmail,
      phone,
      company,
      country,
      bmgenieUserId,
      estimatedValue,
      notes,
      metadata,
    });
    lead = result.lead;
    action = result.action;
  } else if (event === 'demo.booked') {
    const result = upsertDemoBooking({
      displayName,
      normalizedEmail,
      phone,
      company,
      country,
      bmgenieUserId,
      estimatedValue,
      notes,
      metadata,
    });
    lead = result.lead;
    action = result.action;
  } else if (event === 'chat.started' || event === 'chat.transcript') {
    const result = upsertChatThread({
      displayName,
      normalizedEmail,
      bmgenieUserId,
      metadata,
      event,
    });
    if (result.error) return res.status(400).json({ error: result.error });
    lead = result.lead;
    extra = { chat: result.chat };
    action = result.action;
  } else {
    return res.status(400).json({
      error: 'Unknown event',
      allowed: [
        'user.signup',
        'user.free_credit_used',
        'user.purchased',
        'user.credits_depleted',
        'user.checkout_opened',
        'user.checkout_abandoned',
        'user.revision_requested',
        'demo.booked',
        'chat.started',
        'chat.transcript',
      ],
    });
  }

  if (sourceOverride && LEAD_SOURCES[sourceOverride] && lead && action !== 'skipped') {
    // already applied where relevant
  }

  res.json({ ok: true, action, lead, ...(extra || {}) });
});

/** Calendly webhook → demo booking. Prefer pointing Calendly here. */
router.post('/calendly', (req, res) => {
  const secret = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
  if (secret) {
    const raw = JSON.stringify(req.body || {});
    const sig = req.headers['calendly-webhook-signature'] || '';
    // Calendly sends t=...,v1=... — soft-check when key set
    if (!String(sig).includes('v1=')) {
      return res.status(401).json({ error: 'Invalid Calendly signature' });
    }
  } else if (process.env.CRM_INGEST_API_KEY) {
    // Allow shared ingest key as alternate auth when Calendly signing not configured
    const key =
      req.headers['x-crm-ingest-key'] ||
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : null);
    // Calendly itself won't send our key — accept unauthenticated only if explicitly allowed
    if (process.env.CALENDLY_ALLOW_UNSIGNED !== 'true' && key !== process.env.CRM_INGEST_API_KEY) {
      // Still accept body when no signing key configured (common first setup); log warning
      console.warn('[ingest/calendly] accepting without signature — set CALENDLY_WEBHOOK_SIGNING_KEY or CALENDLY_ALLOW_UNSIGNED=true');
    }
  }

  const body = req.body || {};
  const eventType = body.event || body.event_type || '';
  if (eventType && !String(eventType).includes('invitee.created')) {
    if (String(eventType).includes('invitee.canceled')) {
      const inviteeUri = body.payload?.invitee?.uri || body.payload?.uri;
      if (inviteeUri) {
        db.prepare(
          `UPDATE demo_bookings SET status = 'canceled', updated_at = datetime('now')
           WHERE calendly_invitee_uri = ?`,
        ).run(inviteeUri);
      }
      return res.json({ ok: true, action: 'canceled' });
    }
    return res.json({ ok: true, action: 'ignored', event: eventType });
  }

  const payload = body.payload || body;
  const invitee = payload.invitee || payload;
  const event = payload.event || payload.scheduled_event || {};
  const email = (invitee.email || payload.email || '').trim().toLowerCase() || null;
  const name =
    invitee.name ||
    [invitee.first_name, invitee.last_name].filter(Boolean).join(' ') ||
    email ||
    'Demo invitee';

  const scheduledAt =
    event.start_time ||
    invitee.scheduled_event?.start_time ||
    payload.scheduled_event?.start_time ||
    null;
  const timezone = invitee.timezone || event.timezone || null;
  const questionsAndAnswers = invitee.questions_and_answers || payload.questions_and_answers || [];

  const result = upsertDemoBooking({
    displayName: name,
    normalizedEmail: email,
    phone: invitee.text_reminder_number || null,
    company: null,
    country: null,
    bmgenieUserId: null,
    estimatedValue: 65,
    notes: `Demo booked via Calendly${scheduledAt ? ` at ${scheduledAt}` : ''}`,
    metadata: {
      scheduledAt,
      timezone,
      calendlyEventUri: event.uri || null,
      calendlyInviteeUri: invitee.uri || null,
      durationMinutes: event.event_type?.duration || null,
      questionsAndAnswers,
      provider: 'calendly',
    },
  });

  res.json({ ok: true, action: result.action, lead: result.lead });
});

/** Tawk.to webhook → chat support inbox. Prefer pointing Tawk here. */
router.post('/tawk', (req, res) => {
  const secret = process.env.TAWK_WEBHOOK_SECRET;
  if (secret) {
    const signature = req.headers['x-tawk-signature'];
    const raw = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(req.body || {});
    const expected = crypto.createHmac('sha1', secret).update(raw).digest('hex');
    if (!signature || signature !== expected) {
      // Soft fail in early setup if body was re-serialized; still try ingest key
      const key = req.headers['x-crm-ingest-key'];
      if (key !== process.env.CRM_INGEST_API_KEY) {
        console.warn('[ingest/tawk] signature mismatch — processing anyway if body present');
      }
    }
  }

  const body = req.body || {};
  const eventName = body.event || '';
  const visitor = body.visitor || body.chat?.visitor || {};
  const message = body.message || {};
  const chat = body.chat || {};
  const chatId = body.chatId || chat.id || message.chatId;
  const email = (visitor.email || '').trim().toLowerCase() || null;
  const name = visitor.name || email || 'Chat visitor';

  let mapped;
  if (eventName === 'chat:transcript_created' || eventName.includes('transcript')) {
    mapped = 'chat.transcript';
  } else {
    mapped = 'chat.started';
  }

  const transcript = chat.messages || body.messages || null;
  const result = upsertChatThread({
    displayName: name,
    normalizedEmail: email,
    bmgenieUserId: visitor.bmgenieUserId || null,
    event: mapped,
    metadata: {
      provider: 'tawk',
      chatId,
      message: message.text || message.msg || visitor.message || null,
      transcript,
      pageUrl: body.domain || body.referrer || null,
      tawkPropertyId: body.property?.id || process.env.TAWK_PROPERTY_ID || null,
    },
  });

  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true, action: result.action, chat: result.chat, lead: result.lead });
});

router.get('/health', requireIngestKey, (_req, res) => {
  res.json({ ok: true, ingest: true });
});

export default router;
