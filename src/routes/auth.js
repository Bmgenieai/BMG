import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { authRequired, signToken } from '../middleware/auth.js';
import { PERMISSIONS, roleHasPermission } from '../lib/permissions.js';

const router = Router();

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  const user = db
    .prepare(`SELECT * FROM users WHERE email = ? COLLATE NOCASE`)
    .get(String(email).trim());
  if (!user || !user.is_active) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = signToken(user);
  const permissions = Object.keys(PERMISSIONS).filter((p) =>
    roleHasPermission(user.role, p),
  );
  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      phone: user.phone,
    },
    permissions,
  });
});

router.get('/me', authRequired, (req, res) => {
  const permissions = Object.keys(PERMISSIONS).filter((p) =>
    roleHasPermission(req.user.role, p),
  );
  res.json({ user: req.user, permissions });
});

export default router;
