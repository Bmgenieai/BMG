import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import './db.js';
import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import leadsRoutes from './routes/leads.js';
import distributionRoutes from './routes/distribution.js';
import followUpsRoutes from './routes/followUps.js';
import workingTreeRoutes from './routes/workingTree.js';
import analyticsRoutes from './routes/analytics.js';
import ingestRoutes from './routes/ingest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 4050;
const PUBLIC_API_URL = (process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
const FRONTEND_URL = (process.env.FRONTEND_URL || '').replace(/\/$/, '');

/** Comma-separated allowlist; defaults to FRONTEND_URL (+ localhost in non-production). */
function corsOrigins() {
  const fromEnv = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const list = new Set(fromEnv);
  if (FRONTEND_URL) list.add(FRONTEND_URL);
  if (process.env.NODE_ENV !== 'production') {
    list.add('http://localhost:5173');
    list.add('http://127.0.0.1:5173');
  }
  return [...list];
}

const allowed = corsOrigins();
app.use(
  cors({
    origin(origin, cb) {
      // Allow non-browser / same-origin / server-to-server (no Origin header)
      if (!origin) return cb(null, true);
      if (allowed.length === 0) return cb(null, true);
      if (allowed.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    product: 'BMGenie CRM',
    time: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    frontendUrl: FRONTEND_URL || null,
    publicApiUrl: PUBLIC_API_URL || null,
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/distribution', distributionRoutes);
app.use('/api/follow-ups', followUpsRoutes);
app.use('/api/working-tree', workingTreeRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/ingest', ingestRoutes);

// cPanel / production: serve React build from frontend/dist at site root
const distPath = path.join(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => {
  console.log(`BMGenie CRM API listening on http://localhost:${PORT}/api`);
  if (FRONTEND_URL) console.log(`FRONTEND_URL=${FRONTEND_URL}`);
  if (PUBLIC_API_URL) console.log(`PUBLIC_API_URL=${PUBLIC_API_URL}`);
  if (fs.existsSync(distPath)) {
    console.log(`Serving frontend from ${distPath}`);
  }
});
