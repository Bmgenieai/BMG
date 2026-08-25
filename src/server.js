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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 4050;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, product: 'BMGenie CRM', time: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/distribution', distributionRoutes);
app.use('/api/follow-ups', followUpsRoutes);
app.use('/api/working-tree', workingTreeRoutes);
app.use('/api/analytics', analyticsRoutes);

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
  if (fs.existsSync(distPath)) {
    console.log(`Serving frontend from ${distPath}`);
  }
});
