/**
 * CRM sending accounts (Brevo From addresses).
 */
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';

function normalizeEmail(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase();
}

const PUBLIC_COLS = `
  id, label, email, name, is_active, is_default, verified,
  imap_host, imap_port, imap_user, imap_enabled,
  created_at, updated_at
`;

/** If table empty and BREVO_SENDER_EMAIL is set, create the default account. */
export function ensureDefaultAccountFromEnv() {
  const count = db.prepare(`SELECT COUNT(*) AS c FROM email_accounts`).get().c;
  if (count > 0) return;
  const envEmail = (process.env.BREVO_SENDER_EMAIL || '').trim().toLowerCase();
  const envName = (process.env.BREVO_SENDER_NAME || 'BMGenie Sales').trim();
  if (!envEmail) return;
  const id = uuid();
  db.prepare(
    `INSERT INTO email_accounts (
       id, label, email, name, is_active, is_default, verified
     ) VALUES (?, ?, ?, ?, 1, 1, 1)`,
  ).run(id, envName || envEmail, envEmail, envName || envEmail);
}

export function listEmailAccounts({ activeOnly = false } = {}) {
  ensureDefaultAccountFromEnv();
  if (activeOnly) {
    return db
      .prepare(
        `SELECT ${PUBLIC_COLS} FROM email_accounts
         WHERE is_active = 1
         ORDER BY is_default DESC, label COLLATE NOCASE ASC`,
      )
      .all();
  }
  return db
    .prepare(
      `SELECT ${PUBLIC_COLS} FROM email_accounts
       ORDER BY is_default DESC, label COLLATE NOCASE ASC`,
    )
    .all();
}

export function getEmailAccount(id) {
  if (!id) return null;
  return db.prepare(`SELECT ${PUBLIC_COLS} FROM email_accounts WHERE id = ?`).get(id) || null;
}

export function getEmailAccountPrivate(id) {
  if (!id) return null;
  return db.prepare(`SELECT * FROM email_accounts WHERE id = ?`).get(id) || null;
}

export function getDefaultEmailAccount() {
  const activeDefault = db
    .prepare(
      `SELECT ${PUBLIC_COLS} FROM email_accounts
       WHERE is_active = 1 AND is_default = 1
       LIMIT 1`,
    )
    .get();
  if (activeDefault) return activeDefault;
  return (
    db
      .prepare(
        `SELECT ${PUBLIC_COLS} FROM email_accounts
         WHERE is_active = 1
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get() || null
  );
}

/**
 * Resolve Brevo sender { email, name } + account id.
 * Falls back to default account, then BREVO_SENDER_* env.
 */
export function resolveSendAccount(emailAccountId = null) {
  ensureDefaultAccountFromEnv();
  let account = null;
  if (emailAccountId) {
    account = getEmailAccount(emailAccountId);
    if (!account) {
      const err = new Error('Email account not found');
      err.status = 400;
      throw err;
    }
    if (!account.is_active) {
      const err = new Error('Email account is inactive');
      err.status = 400;
      throw err;
    }
  } else {
    account = getDefaultEmailAccount();
  }

  if (account) {
    return {
      accountId: account.id,
      sender: { email: account.email, name: account.name || account.label },
      account,
    };
  }

  const envEmail = (process.env.BREVO_SENDER_EMAIL || '').trim();
  if (!envEmail) {
    const err = new Error('No sending email account configured');
    err.status = 400;
    throw err;
  }
  return {
    accountId: null,
    sender: {
      email: envEmail,
      name: (process.env.BREVO_SENDER_NAME || 'BMGenie Sales').trim(),
    },
    account: null,
  };
}

export function createEmailAccount(body, { userId = null } = {}) {
  const email = normalizeEmail(body.email);
  const name = String(body.name || '').trim();
  const label = String(body.label || name || email).trim();
  if (!email || !email.includes('@')) {
    const err = new Error('Valid email required');
    err.status = 400;
    throw err;
  }
  if (!name) {
    const err = new Error('Display name required');
    err.status = 400;
    throw err;
  }

  const dup = db.prepare(`SELECT id FROM email_accounts WHERE lower(email) = ?`).get(email);
  if (dup) {
    const err = new Error('An account with this email already exists');
    err.status = 409;
    throw err;
  }

  const count = db.prepare(`SELECT COUNT(*) AS c FROM email_accounts`).get().c;
  const makeDefault = body.is_default === true || count === 0;
  const id = uuid();

  if (makeDefault) {
    db.prepare(`UPDATE email_accounts SET is_default = 0`).run();
  }

  db.prepare(
    `INSERT INTO email_accounts (
       id, label, email, name, is_active, is_default, verified,
       imap_host, imap_port, imap_user, imap_pass, imap_enabled, created_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    label,
    email,
    name,
    body.is_active === false ? 0 : 1,
    makeDefault ? 1 : 0,
    body.verified === true ? 1 : 0,
    body.imap_host ? String(body.imap_host).trim() : null,
    body.imap_port != null ? Number(body.imap_port) || null : null,
    body.imap_user ? String(body.imap_user).trim() : null,
    body.imap_pass ? String(body.imap_pass) : null,
    body.imap_enabled === true ? 1 : 0,
    userId,
  );

  return getEmailAccount(id);
}

export function updateEmailAccount(id, body) {
  const row = getEmailAccountPrivate(id);
  if (!row) {
    const err = new Error('Email account not found');
    err.status = 404;
    throw err;
  }

  const email =
    body.email != null ? normalizeEmail(body.email) : normalizeEmail(row.email);
  const name = body.name != null ? String(body.name).trim() : row.name;
  const label =
    body.label != null ? String(body.label).trim() : row.label || name;

  if (!email || !email.includes('@')) {
    const err = new Error('Valid email required');
    err.status = 400;
    throw err;
  }
  if (!name) {
    const err = new Error('Display name required');
    err.status = 400;
    throw err;
  }

  if (email !== normalizeEmail(row.email)) {
    const dup = db.prepare(`SELECT id FROM email_accounts WHERE lower(email) = ?`).get(email);
    if (dup) {
      const err = new Error('An account with this email already exists');
      err.status = 409;
      throw err;
    }
  }

  if (body.is_default === true) {
    db.prepare(`UPDATE email_accounts SET is_default = 0`).run();
  }

  const isActive = body.is_active != null ? (body.is_active ? 1 : 0) : row.is_active;
  const isDefault =
    body.is_default === true ? 1 : body.is_default === false ? 0 : row.is_default;
  const verified = body.verified != null ? (body.verified ? 1 : 0) : row.verified;

  db.prepare(
    `UPDATE email_accounts SET
       label = ?, email = ?, name = ?,
       is_active = ?, is_default = ?, verified = ?,
       imap_host = ?, imap_port = ?, imap_user = ?,
       imap_pass = CASE WHEN ? IS NOT NULL THEN ? ELSE imap_pass END,
       imap_enabled = ?,
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    label,
    email,
    name,
    isActive,
    isDefault,
    verified,
    body.imap_host != null ? String(body.imap_host).trim() || null : row.imap_host,
    body.imap_port != null ? Number(body.imap_port) || null : row.imap_port,
    body.imap_user != null ? String(body.imap_user).trim() || null : row.imap_user,
    body.imap_pass != null ? String(body.imap_pass) : null,
    body.imap_pass != null ? String(body.imap_pass) : null,
    body.imap_enabled != null ? (body.imap_enabled ? 1 : 0) : row.imap_enabled,
    id,
  );

  // Ensure at least one default among active accounts
  const def = getDefaultEmailAccount();
  if (!def) {
    const first = db
      .prepare(`SELECT id FROM email_accounts WHERE is_active = 1 ORDER BY created_at ASC LIMIT 1`)
      .get();
    if (first) {
      db.prepare(`UPDATE email_accounts SET is_default = 1 WHERE id = ?`).run(first.id);
    }
  }

  return getEmailAccount(id);
}
