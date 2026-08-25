import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { roleHasPermission } from '../lib/permissions.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

export function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '12h' },
  );
}

export function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db
      .prepare(
        `SELECT id, email, name, role, phone, is_active FROM users WHERE id = ?`,
      )
      .get(payload.id);
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Account inactive or not found' });
    }
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roleHasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: 'Permission denied', permission });
    }
    next();
  };
}

/** Pass if user has ANY of the listed permissions */
export function requireAnyPermission(...permissions) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const ok = permissions.some((p) => roleHasPermission(req.user.role, p));
    if (!ok) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    next();
  };
}
