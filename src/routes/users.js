import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { authRequired, requirePermission } from '../middleware/auth.js';
import { ROLES } from '../lib/permissions.js';

const router = Router();

router.use(authRequired);

router.get('/', requirePermission('admin:employees'), (_req, res) => {
  const users = db
    .prepare(
      `SELECT id, email, name, role, phone, is_active, created_at, updated_at
       FROM users ORDER BY role, name`,
    )
    .all();
  res.json(users);
});

router.get('/reps', requirePermission('leads:assign'), (_req, res) => {
  const reps = db
    .prepare(
      `SELECT id, name, email, role FROM users
       WHERE is_active = 1 AND role IN ('telesales','manager')
       ORDER BY role, name`,
    )
    .all();
  res.json(reps);
});

router.post('/', requirePermission('admin:employees'), (req, res) => {
  const { email, password, name, role, phone } = req.body || {};
  if (!email || !password || !name || !role) {
    return res.status(400).json({ error: 'email, password, name, role required' });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const existing = db.prepare(`SELECT id FROM users WHERE email = ? COLLATE NOCASE`).get(email);
  if (existing) {
    return res.status(409).json({ error: 'Email already exists' });
  }
  const id = uuid();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, name, role, phone, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    String(email).trim().toLowerCase(),
    bcrypt.hashSync(password, 10),
    name.trim(),
    role,
    phone || null,
    req.user.id,
  );
  const user = db
    .prepare(
      `SELECT id, email, name, role, phone, is_active, created_at FROM users WHERE id = ?`,
    )
    .get(id);
  res.status(201).json(user);
});

router.patch('/:id', requirePermission('admin:employees'), (req, res) => {
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { name, role, phone, is_active, password } = req.body || {};
  if (role && !ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
  }
  if (password && String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  db.prepare(
    `UPDATE users SET
      name = COALESCE(?, name),
      role = COALESCE(?, role),
      phone = COALESCE(?, phone),
      is_active = COALESCE(?, is_active),
      password_hash = COALESCE(?, password_hash),
      updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    name ?? null,
    role ?? null,
    phone !== undefined ? phone : null,
    is_active === undefined ? null : is_active ? 1 : 0,
    password ? bcrypt.hashSync(password, 10) : null,
    user.id,
  );

  const updated = db
    .prepare(
      `SELECT id, email, name, role, phone, is_active, created_at, updated_at FROM users WHERE id = ?`,
    )
    .get(user.id);
  res.json(updated);
});

router.delete('/:id', requirePermission('admin:employees'), (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  const user = db.prepare(`SELECT id FROM users WHERE id = ?`).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Soft delete
  db.prepare(
    `UPDATE users SET is_active = 0, updated_at = datetime('now') WHERE id = ?`,
  ).run(user.id);
  res.json({ ok: true });
});

export default router;
