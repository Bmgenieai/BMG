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
const CONTACT_FORMATS = ['company', 'employee'];

router.use(authRequired);

function leadSelect(extraWhere = '1=1', params = []) {
  return db
    .prepare(
      `SELECT l.*,
        u.name AS assigned_name,
        u.email AS assigned_email,
        c.name AS created_by_name,
        c.email AS created_by_email
       FROM leads l
       LEFT JOIN users u ON u.id = l.assigned_to
       LEFT JOIN users c ON c.id = l.created_by
       WHERE ${extraWhere}
       ORDER BY
         CASE WHEN l.next_follow_up_at IS NOT NULL AND l.next_follow_up_at <= datetime('now') THEN 0 ELSE 1 END,
         CASE WHEN l.next_follow_up_at IS NULL THEN 1 ELSE 0 END,
         l.next_follow_up_at ASC,
         l.created_at DESC`,
    )
    .all(...params);
}

function getLeadWithJoins(id) {
  return db
    .prepare(
      `SELECT l.*,
        u.name AS assigned_name,
        u.email AS assigned_email,
        c.name AS created_by_name,
        c.email AS created_by_email
       FROM leads l
       LEFT JOIN users u ON u.id = l.assigned_to
       LEFT JOIN users c ON c.id = l.created_by
       WHERE l.id = ?`,
    )
    .get(id);
}

function requireLeadAccess(req, res) {
  const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(req.params.id);
  if (!lead) {
    res.status(404).json({ error: 'Lead not found' });
    return null;
  }
  if (!canAccessLead(req.user, lead)) {
    res.status(403).json({ error: 'Permission denied' });
    return null;
  }
  return lead;
}

router.get('/meta', (_req, res) => {
  res.json({
    sources: Object.values(LEAD_SOURCES),
    statuses: LEAD_STATUSES,
    statusLabels: STATUS_LABELS,
    statusTabs: LEAD_STATUS_TABS,
    productTabs: PRODUCT_LEAD_TABS,
    contactFormats: CONTACT_FORMATS,
  });
});

/** Counts for sidebar tabs (marketing dashboard style). */
router.get('/counts', requireAnyPermission('leads:view_all', 'leads:view_own'), (req, res) => {
  const assigneeClause = !roleHasPermission(req.user.role, 'leads:view_all')
    ? 'AND (assigned_to = ? OR created_by = ?)'
    : '';
  const assigneeParam = assigneeClause ? [req.user.id, req.user.id] : [];

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
    clauses.push('(l.assigned_to = ? OR l.created_by = ?)');
    params.push(req.user.id, req.user.id);
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
      `(l.name LIKE ? OR l.email LIKE ? OR l.company LIKE ? OR l.phone LIKE ? OR l.country LIKE ? OR l.state LIKE ? OR l.job_title LIKE ? OR l.industry LIKE ?)`,
    );
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like, like, like);
  }

  const where = clauses.length ? clauses.join(' AND ') : '1=1';
  res.json(leadSelect(where, params));
});

router.get('/:id', requireAnyPermission('leads:view_all', 'leads:view_own'), (req, res) => {
  const lead = getLeadWithJoins(req.params.id);
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
  const employees = db
    .prepare(
      `SELECT e.*, us.name AS created_by_name FROM lead_employees e
       LEFT JOIN users us ON us.id = e.created_by
       WHERE e.lead_id = ? ORDER BY e.created_at ASC`,
    )
    .all(lead.id);
  res.json({ ...lead, activities, followUps, employees });
});

router.post('/', requirePermission('leads:create'), (req, res) => {
  const {
    name,
    email,
    phone,
    company,
    country,
    state,
    job_title,
    industry,
    contact_format: rawFormat,
    source: rawSource,
    notes,
    estimated_value,
    bmgenie_user_id,
  } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!industry || !String(industry).trim()) {
    return res.status(400).json({ error: 'industry required' });
  }

  const contactFormat = CONTACT_FORMATS.includes(rawFormat) ? rawFormat : 'company';
  const isTelesales = req.user.role === 'telesales';
  const source = rawSource || (isTelesales ? 'telesales' : 'manual');
  if (!LEAD_SOURCES[source]) {
    return res.status(400).json({ error: 'Invalid source', allowed: Object.keys(LEAD_SOURCES) });
  }
  // Telesales can only create telesales-sourced leads
  if (isTelesales && source !== 'telesales') {
    return res.status(403).json({ error: 'Telesales can only create telesales leads' });
  }

  const nameTrim = name.trim();
  const industryTrim = String(industry).trim();
  // Company format: primary name is the company; keep company column in sync when omitted
  const companyVal =
    contactFormat === 'company'
      ? company?.trim() || nameTrim
      : company?.trim() || null;

  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO leads (
      id, name, email, phone, company, country, state, job_title, industry, contact_format,
      source, notes, estimated_value, bmgenie_user_id, created_by, assigned_to, assigned_at, assigned_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    nameTrim,
    email || null,
    phone || null,
    companyVal,
    country || null,
    state || null,
    contactFormat === 'employee' ? job_title || null : null,
    industryTrim,
    contactFormat,
    source,
    notes || null,
    Number(estimated_value) || 0,
    bmgenie_user_id || null,
    req.user.id,
    req.user.id,
    now,
    req.user.id,
  );
  db.prepare(
    `INSERT INTO lead_activities (id, lead_id, user_id, type, summary)
     VALUES (?, ?, ?, 'created', ?)`,
  ).run(
    uuid(),
    id,
    req.user.id,
    `Lead created by ${req.user.name} (${LEAD_SOURCES[source].label}, ${contactFormat})`,
  );
  res.status(201).json(getLeadWithJoins(id));
});

router.patch('/:id', requireAnyPermission('leads:update_any', 'leads:update_own'), (req, res) => {
  const lead = requireLeadAccess(req, res);
  if (!lead) return;

  const {
    name,
    email,
    phone,
    company,
    country,
    state,
    job_title,
    industry,
    contact_format,
    status,
    notes,
    estimated_value,
    lost_reason,
    next_follow_up_at,
  } = req.body || {};

  if (status && !LEAD_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (contact_format != null && !CONTACT_FORMATS.includes(contact_format)) {
    return res.status(400).json({ error: 'Invalid contact_format', allowed: CONTACT_FORMATS });
  }
  if (industry !== undefined && industry !== null && !String(industry).trim()) {
    return res.status(400).json({ error: 'industry required' });
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
      state = COALESCE(?, state),
      job_title = COALESCE(?, job_title),
      industry = COALESCE(?, industry),
      contact_format = COALESCE(?, contact_format),
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
    state !== undefined ? state : null,
    job_title !== undefined ? job_title : null,
    industry !== undefined ? String(industry).trim() : null,
    contact_format ?? null,
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

  res.json(getLeadWithJoins(lead.id));
});

router.post(
  '/:id/activities',
  requireAnyPermission('leads:update_any', 'leads:update_own'),
  (req, res) => {
    const lead = requireLeadAccess(req, res);
    if (!lead) return;
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

/** Company contacts (employees) under a lead */
router.get(
  '/:id/employees',
  requireAnyPermission('leads:view_all', 'leads:view_own'),
  (req, res) => {
    const lead = requireLeadAccess(req, res);
    if (!lead) return;
    const rows = db
      .prepare(
        `SELECT e.*, us.name AS created_by_name FROM lead_employees e
         LEFT JOIN users us ON us.id = e.created_by
         WHERE e.lead_id = ? ORDER BY e.created_at ASC`,
      )
      .all(lead.id);
    res.json(rows);
  },
);

router.post(
  '/:id/employees',
  requireAnyPermission('leads:update_any', 'leads:update_own'),
  (req, res) => {
    const lead = requireLeadAccess(req, res);
    if (!lead) return;
    const { name, phone, email, job_title, notes } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name required' });
    }
    const id = uuid();
    db.prepare(
      `INSERT INTO lead_employees (id, lead_id, name, phone, email, job_title, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      lead.id,
      String(name).trim(),
      phone || null,
      email || null,
      job_title || null,
      notes || null,
      req.user.id,
    );
    db.prepare(
      `INSERT INTO lead_activities (id, lead_id, user_id, type, summary)
       VALUES (?, ?, ?, 'employee_added', ?)`,
    ).run(uuid(), lead.id, req.user.id, `Employee added: ${String(name).trim()}`);
    res.status(201).json(db.prepare(`SELECT * FROM lead_employees WHERE id = ?`).get(id));
  },
);

router.patch(
  '/:id/employees/:empId',
  requireAnyPermission('leads:update_any', 'leads:update_own'),
  (req, res) => {
    const lead = requireLeadAccess(req, res);
    if (!lead) return;
    const emp = db
      .prepare(`SELECT * FROM lead_employees WHERE id = ? AND lead_id = ?`)
      .get(req.params.empId, lead.id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const { name, phone, email, job_title, notes } = req.body || {};
    db.prepare(
      `UPDATE lead_employees SET
        name = COALESCE(?, name),
        phone = COALESCE(?, phone),
        email = COALESCE(?, email),
        job_title = COALESCE(?, job_title),
        notes = COALESCE(?, notes),
        updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      name !== undefined ? String(name).trim() || emp.name : null,
      phone !== undefined ? phone : null,
      email !== undefined ? email : null,
      job_title !== undefined ? job_title : null,
      notes !== undefined ? notes : null,
      emp.id,
    );
    res.json(db.prepare(`SELECT * FROM lead_employees WHERE id = ?`).get(emp.id));
  },
);

router.delete(
  '/:id/employees/:empId',
  requireAnyPermission('leads:update_any', 'leads:update_own'),
  (req, res) => {
    const lead = requireLeadAccess(req, res);
    if (!lead) return;
    const emp = db
      .prepare(`SELECT * FROM lead_employees WHERE id = ? AND lead_id = ?`)
      .get(req.params.empId, lead.id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    db.prepare(`DELETE FROM lead_employees WHERE id = ?`).run(emp.id);
    db.prepare(
      `INSERT INTO lead_activities (id, lead_id, user_id, type, summary)
       VALUES (?, ?, ?, 'employee_removed', ?)`,
    ).run(uuid(), lead.id, req.user.id, `Employee removed: ${emp.name}`);
    res.json({ ok: true });
  },
);

function csvCell(row, ...keys) {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
  }
  return null;
}

router.post(
  '/import/csv',
  requirePermission('leads:import'),
  upload.single('file'),
  (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'CSV file required (field: file)' });
    const sourceLabel = req.body?.source_label || 'csv_import';
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
      `INSERT INTO leads (
        id, name, email, phone, company, country, state, job_title, industry, contact_format,
        source, notes, estimated_value, import_batch_id, created_by, assigned_to, assigned_at, assigned_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      for (const row of records) {
        const name = csvCell(
          row,
          'name',
          'Name',
          'full_name',
          'Full Name',
          'email',
          'Email',
        );
        if (!name) {
          skipped += 1;
          continue;
        }
        const email = csvCell(row, 'email', 'Email');
        const phone = csvCell(row, 'contact', 'Contact', 'phone', 'Phone', 'mobile', 'Mobile');
        const company = csvCell(row, 'company', 'Company');
        const country = csvCell(row, 'country', 'Country');
        const state = csvCell(row, 'state', 'State');
        const jobTitle = csvCell(row, 'job_title', 'Job Title', 'job title', 'title', 'Title');
        const industry = csvCell(row, 'industry', 'Industry');
        const rawFormat = String(
          csvCell(row, 'contact_format', 'Contact Format', 'format', 'Format') || 'company',
        )
          .trim()
          .toLowerCase();
        const contactFormat = CONTACT_FORMATS.includes(rawFormat) ? rawFormat : 'company';
        const notes =
          csvCell(row, 'follow_up_notes', 'Follow up notes', 'notes', 'Notes') ||
          `Imported from ${req.file.originalname}`;
        const estimated =
          Number(
            csvCell(row, 'estimated_revenue', 'estimated_value', 'Estimated Revenue', 'value') || 0,
          ) || 0;
        const companyVal =
          contactFormat === 'company' ? company || name : company || null;
        const id = uuid();
        insert.run(
          id,
          name,
          email,
          phone,
          companyVal,
          country,
          state,
          contactFormat === 'employee' ? jobTitle : null,
          industry || null,
          contactFormat,
          source,
          notes,
          estimated,
          batchId,
          req.user.id,
          req.user.id,
          now,
          req.user.id,
        );
        db.prepare(
          `INSERT INTO lead_activities (id, lead_id, user_id, type, summary)
           VALUES (?, ?, ?, 'imported', ?)`,
        ).run(
          uuid(),
          id,
          req.user.id,
          `CSV / Google Sheet import by ${req.user.name} (${sourceLabel})`,
        );
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
