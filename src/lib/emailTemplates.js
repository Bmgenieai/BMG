/**
 * DB-backed email templates (seeds built-in COLD_EMAIL_TEMPLATES so BDs can create, edit, and save).
 */
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { COLD_EMAIL_TEMPLATES, findInvalidMergeTags } from './brevo.js';

let seeded = false;

export function ensureSeededTemplates() {
  if (seeded) return;
  seeded = true;
  try {
    const count = db.prepare(`SELECT COUNT(*) AS c FROM email_templates`).get().c;
    if (count > 0) return;
    const ins = db.prepare(
      `INSERT OR IGNORE INTO email_templates
         (id, name, subject, html_content, text_content, category, is_system)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    );
    const tx = db.transaction(() => {
      for (const t of COLD_EMAIL_TEMPLATES) {
        ins.run(
          t.id,
          t.label,
          t.subject,
          t.htmlContent || null,
          t.textContent || null,
          (t.sources && t.sources[0]) || 'cold_outreach',
        );
      }
    });
    tx();
  } catch (err) {
    console.warn('[email-templates] seed failed:', err.message);
  }
}

function mapTemplateRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    label: row.name,
    subject: row.subject,
    htmlContent: row.html_content || '',
    textContent: row.text_content || '',
    category: row.category || 'cold_outreach',
    isSystem: Boolean(row.is_system),
    createdBy: row.created_by || null,
    createdByName: row.created_by_name || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listEmailTemplates() {
  ensureSeededTemplates();
  const rows = db
    .prepare(
      `SELECT t.*, u.name AS created_by_name
       FROM email_templates t
       LEFT JOIN users u ON u.id = t.created_by
       ORDER BY t.is_system ASC, t.updated_at DESC, t.name COLLATE NOCASE ASC`,
    )
    .all();
  return rows.map(mapTemplateRow);
}

export function getDbTemplateById(id) {
  if (!id) return null;
  ensureSeededTemplates();
  const row = db
    .prepare(
      `SELECT t.*, u.name AS created_by_name
       FROM email_templates t
       LEFT JOIN users u ON u.id = t.created_by
       WHERE t.id = ?`,
    )
    .get(id);
  return mapTemplateRow(row);
}

export function createEmailTemplate(body, { userId = null } = {}) {
  ensureSeededTemplates();
  const name = String(body.name || body.label || '').trim();
  const subject = String(body.subject || '').trim();
  const htmlContent = body.htmlContent ?? body.html_content ?? '';
  const textContent = body.textContent ?? body.text_content ?? '';
  const category = String(body.category || 'cold_outreach').trim() || 'cold_outreach';

  if (!name) {
    const err = new Error('Template name is required');
    err.status = 400;
    throw err;
  }
  if (!subject) {
    const err = new Error('Template subject is required');
    err.status = 400;
    throw err;
  }
  if (!String(htmlContent).trim() && !String(textContent).trim()) {
    const err = new Error('Template body is required');
    err.status = 400;
    throw err;
  }

  const id = `tpl_${uuid().slice(0, 12)}`;
  db.prepare(
    `INSERT INTO email_templates
       (id, name, subject, html_content, text_content, category, is_system, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    id,
    name,
    subject,
    String(htmlContent),
    String(textContent),
    category,
    userId,
    userId,
  );

  const template = getDbTemplateById(id);
  const invalidTags = [
    ...new Set([
      ...findInvalidMergeTags(subject),
      ...findInvalidMergeTags(htmlContent),
      ...findInvalidMergeTags(textContent),
    ]),
  ];
  return { template, invalidTags };
}

export function updateEmailTemplate(id, body, { userId = null } = {}) {
  ensureSeededTemplates();
  const existing = db.prepare(`SELECT * FROM email_templates WHERE id = ?`).get(id);
  if (!existing) {
    const err = new Error('Template not found');
    err.status = 404;
    throw err;
  }

  const name =
    body.name != null || body.label != null
      ? String(body.name ?? body.label).trim()
      : existing.name;
  const subject =
    body.subject != null ? String(body.subject).trim() : existing.subject;
  const htmlContent =
    body.htmlContent !== undefined || body.html_content !== undefined
      ? String(body.htmlContent ?? body.html_content ?? '')
      : existing.html_content || '';
  const textContent =
    body.textContent !== undefined || body.text_content !== undefined
      ? String(body.textContent ?? body.text_content ?? '')
      : existing.text_content || '';
  const category =
    body.category != null ? String(body.category).trim() || 'cold_outreach' : existing.category;

  if (!name) {
    const err = new Error('Template name is required');
    err.status = 400;
    throw err;
  }
  if (!subject) {
    const err = new Error('Template subject is required');
    err.status = 400;
    throw err;
  }

  db.prepare(
    `UPDATE email_templates
     SET name = ?, subject = ?, html_content = ?, text_content = ?, category = ?,
         updated_by = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(name, subject, htmlContent, textContent, category, userId, id);

  const template = getDbTemplateById(id);
  const invalidTags = [
    ...new Set([
      ...findInvalidMergeTags(subject),
      ...findInvalidMergeTags(htmlContent),
      ...findInvalidMergeTags(textContent),
    ]),
  ];
  return { template, invalidTags };
}

export function deleteEmailTemplate(id) {
  ensureSeededTemplates();
  const r = db.prepare(`DELETE FROM email_templates WHERE id = ?`).run(id);
  if (!r.changes) {
    const err = new Error('Template not found');
    err.status = 404;
    throw err;
  }
  return { ok: true, id };
}
