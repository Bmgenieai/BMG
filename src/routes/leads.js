import { Router } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { authRequired, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import {
  LEAD_SOURCES,
  LEAD_STATUSES,
  LEAD_STATUS_TABS,
  PRODUCT_LEAD_TABS,
  STATUS_LABELS,
  canAccessLead,
  roleHasPermission,
} from '../lib/permissions.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const router = Router();

router.use(authRequired);

function leadSelect(extraWhere = '1=1', params = []) {
  return db
    .prepare(
      `SELECT l.*,
        u.name AS assigned_name,
        u.email AS assigned_email
       FROM leads l
       LEFT JOIN users u ON u.id = l.assigned_to
       WHERE ${extraWhere}
       ORDER BY
         CASE WHEN l.next_follow_up_at IS NOT NULL AND l.next_follow_up_at <= datetime('now') THEN 0 ELSE 1 END,
         CASE WHEN l.next_follow_up_at IS NULL THEN 1 ELSE 0 END,
         l.next_follow_up_at ASC,
         l.created_at DESC`,
    )
    .all(...params);
}

router.get('/meta', (_req, res) => {
  res.json({
    sources: Object.values(LEAD_SOURCES),
    statuses: LEAD_STATUSES,
    statusLabels: STATUS_LABELS,
    statusTabs: LEAD_STATUS_TABS,
    productTabs: PRODUCT_LEAD_TABS,
  });
});

/** Counts for sidebar tabs (marketing dashboard style). */
router.get('/counts', requireAnyPermission('leads:view_all', 'leads:view_own'), (req, res) => {
  const assigneeClause = !roleHasPermission(req.user.role, 'leads:view_all')
    ? 'AND assigned_to = ?'
    : '';
  const assigneeParam = assigneeClause ? [req.user.id] : [];

  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM leads WHERE 1=1 ${assigneeClause}`)
    .get(...assigneeParam).c;

  const byStatus = db
    .prepare(
      `SELECT status, COUNT(*) AS c FROM leads WHERE 1=1 ${assigneeClause} GROUP BY status`,
    )
    .all(...assigneeParam);
  const statusMap = Object.fromEntries(byStatus.map((r) => [r.status, r.c]));

  const statusCounts = {};
  for (const tab of LEAD_STATUS_TABS) {
    if (tab.statuses) {
      statusCounts[tab.slug] = tab.statuses.reduce((s, st) => s + (statusMap[st] || 0), 0);
    } else {
      statusCounts[tab.slug] = statusMap[tab.status] || 0;
    }
  }

  const bySource = db
    .prepare(
      `SELECT source, COUNT(*) AS c FROM leads WHERE 1=1 ${assigneeClause} GROUP BY source`,
    )
    .all(...assigneeParam);
  const sourceMap = Object.fromEntries(bySource.map((r) => [r.source, r.c]));
  const productCounts = Object.fromEntries(
    PRODUCT_LEAD_TABS.map((t) => [t.slug, sourceMap[t.source] || 0]),
  );

  res.json({ total, statusCounts, productCounts });
});

router.get('/', requireAnyPermission('leads:view_all', 'leads:view_own'), (req, res) => {
  const { source, status, assigned_to, q, unassigned } = req.query;
  const clauses = [];
  const params = [];

  if (!roleHasPermission(req.user.role, 'leads:view_all')) {
    clauses.push('l.assigned_to = ?');
    params.push(req.user.id);
  } else if (assigned_to) {
    clauses.push('l.assigned_to = ?');
    params.push(assigned_to);
  }

  if (unassigned === '1' || unassigned === 'true') {
    clauses.push('l.assigned_to IS NULL');
  }
  if (source) {
    clauses.push('l.source = ?');
    params.push(source);
  }
  if (status) {
    const statuses = String(status).split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.length > 1) {
      clauses.push(`l.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    } else {
      clauses.push('l.status = ?');
      params.push(statuses[0]);
    }
  }
  if (q) {
    clauses.push(
      `(l.name LIKE ? OR l.email LIKE ? OR l.company LIKE ? OR l.phone LIKE ? OR l.country LIKE ?)`,
    );
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }

  const where = clauses.length ? clauses.join(' AND ') : '1=1';
  res.json(leadSelect(where, params));
});

router.get('/:id', requireAnyPermission('leads:view_all', 'leads:view_own'), (req, res) => {
  const lead = db
    .prepare(
      `SELECT l.*, u.name AS assigned_name, u.email AS assigned_email
       FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
       WHERE l.id = ?`,
    )
    .get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (!canAccessLead(req.user, lead)) {
    return res.status(403).json({ error: 'Permission denied' });
  }
  const activities = db
    .prepare(
      `SELECT a.*, us.name AS user_name FROM lead_activities a
       LEFT JOIN users us ON us.id = a.user_id
       WHERE a.lead_id = ? ORDER BY a.created_at DESC`,
    )
    .all(lead.id);
  const followUps = db
    .prepare(
      `SELECT f.*, us.name AS assignee_name FROM follow_ups f
       LEFT JOIN users us ON us.id = f.assigned_to
       WHERE f.lead_id = ? ORDER BY f.due_at ASC`,
    )
    .all(lead.id);
  res.json({ ...lead, activities, followUps });
});

router.post('/', requirePermission('leads:create'), (req, res) => {
  const {
    name,
    email,
    phone,
    company,
    country,
    source = 'manual',
    notes,
    estimated_value,
    bmgenie_user_id,
  } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!LEAD_SOURCES[source]) {
    return res.status(400).json({ error: 'Invalid source', allowed: Object.keys(LEAD_SOURCES) });
  }
  const id = uuid();
  db.prepare(
    `INSERT INTO leads (id, name, email, phone, company, country, source, notes, estimated_value, bmgenie_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name.trim(),
    email || null,
    phone || null,
    company || null,
    country || null,
    source,
    notes || null,
    Number(estimated_value) || 0,
    bmgenie_user_id || null,
  );
  db.prepare(
    `INSERT INTO lead_activities (id, lead_id, user_id, type, summary)
     VALUES (?, ?, ?, 'created', ?)`,
  ).run(uuid(), id, req.user.id, `Lead created (${LEAD_SOURCES[source].label})`);
  const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id);
  res.status(201).json(lead);
});

router.patch('/:id', requireAnyPermission('leads:update_any', 'leads:update_own'), (req, res) => {
  const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (!canAccessLead(req.user, lead) && !roleHasPermission(req.user.role, 'leads:update_any')) {
    return res.status(403).json({ error: 'Permission denied' });
  }

  const {
    name,
    email,
    phone,
    company,
    country,
    status,
    notes,
    estimated_value,
    lost_reason,
    next_follow_up_at,
  } = req.body || {};

  if (status && !LEAD_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const convertedAt =
    status === 'converted' && lead.status !== 'converted'
      ? new Date().toISOString()
      : lead.converted_at;

  db.prepare(
    `UPDATE leads SET
      name = COALESCE(?, name),
      email = COALESCE(?, email),
      phone = COALESCE(?, phone),
      company = COALESCE(?, company),
      country = COALESCE(?, country),
      status = COALESCE(?, status),
      notes = COALESCE(?, notes),
      estimated_value = COALESCE(?, estimated_value),
      lost_reason = COALESCE(?, lost_reason),
      next_follow_up_at = COALESCE(?, next_follow_up_at),
      converted_at = ?,
      updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    name ?? null,
    email !== undefined ? email : null,
    phone !== undefined ? phone : null,
    company !== undefined ? company : null,
    country !== undefined ? country : null,
    status ?? null,
    notes !== undefined ? notes : null,
    estimated_value !== undefined ? Number(estimated_value) : null,
    lost_reason !== undefined ? lost_reason : null,
    next_follow_up_at !== undefined ? next_follow_up_at : null,
    convertedAt,
    lead.id,
  );

  if (status && status !== lead.status) {
    db.prepare(
      `INSERT INTO lead_activities (id, lead_id, user_id, type, summary, outcome)
       VALUES (?, ?, ?, 'status_change', ?, ?)`,
    ).run(uuid(), lead.id, req.user.id, `Status: ${lead.status} → ${status}`, status);
  }

  res.json(db.prepare(`SELECT * FROM leads WHERE id = ?`).get(lead.id));
});

router.post(
  '/:id/activities',
  requireAnyPermission('leads:update_any', 'leads:update_own'),
  (req, res) => {
    const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!canAccessLead(req.user, lead)) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    const { type = 'note', summary, outcome, next_follow_up_at, status } = req.body || {};
    if (!summary) return res.status(400).json({ error: 'summary required' });

    const actId = uuid();
    db.prepare(
      `INSERT INTO lead_activities (id, lead_id, user_id, type, summary, outcome, next_follow_up_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(actId, lead.id, req.user.id, type, summary, outcome || null, next_follow_up_at || null);

    if (next_follow_up_at || status) {
      db.prepare(
        `UPDATE leads SET
          next_follow_up_at = COALESCE(?, next_follow_up_at),
          status = COALESCE(?, status),
          updated_at = datetime('now')
         WHERE id = ?`,
      ).run(next_follow_up_at || null, status || null, lead.id);
    }

    res.status(201).json(db.prepare(`SELECT * FROM lead_activities WHERE id = ?`).get(actId));
  },
);

router.post(
  '/import/csv',
  requirePermission('leads:import'),
  upload.single('file'),
  (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'CSV file required (field: file)' });
    const sourceLabel = req.body?.source_label || 'csv_import';
    if (!LEAD_SOURCES[sourceLabel] && sourceLabel !== 'csv_import') {
      // allow csv_import only as canonical, or map meta → csv_import
    }
    const source = 'csv_import';

    let records;
    try {
      records = parse(req.file.buffer.toString('utf8'), {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });
    } catch (e) {
      return res.status(400).json({ error: 'Invalid CSV', detail: e.message });
    }

    const batchId = uuid();
    db.prepare(
      `INSERT INTO import_batches (id, filename, source_label, row_count, uploaded_by)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(batchId, req.file.originalname, sourceLabel, records.length, req.user.id);

    let imported = 0;
    let skipped = 0;
    const insert = db.prepare(
      `INSERT INTO leads (id, name, email, phone, company, country, source, notes, estimated_value, import_batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const tx = db.transaction(() => {
      for (const row of records) {
        const name =
          row.name || row.Name || row.full_name || row['Full Name'] || row.email || row.Email;
        if (!name) {
          skipped += 1;
          continue;
        }
        const email = row.email || row.Email || null;
        const phone = row.phone || row.Phone || row.mobile || null;
        const company = row.company || row.Company || null;
        const country = row.country || row.Country || null;
        const notes = row.notes || row.Notes || `Imported from ${req.file.originalname}`;
        const estimated = Number(row.estimated_value || row.value || 0) || 0;
        const id = uuid();
        insert.run(id, String(name), email, phone, company, country, source, notes, estimated, batchId);
        db.prepare(
          `INSERT INTO lead_activities (id, lead_id, user_id, type, summary)
           VALUES (?, ?, ?, 'imported', ?)`,
        ).run(uuid(), id, req.user.id, `CSV import (${sourceLabel})`);
        imported += 1;
      }
      db.prepare(
        `UPDATE import_batches SET imported_count = ?, skipped_count = ? WHERE id = ?`,
      ).run(imported, skipped, batchId);
    });
    tx();

    res.status(201).json({
      batchId,
      rowCount: records.length,
      imported,
      skipped,
      source,
    });
  },
);

export default router;
