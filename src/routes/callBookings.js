import { Router } from 'express';
import { db } from '../db.js';
import { authRequired, requireAnyPermission } from '../middleware/auth.js';
import {
  canUpdateLead,
  canAccessLead,
  roleHasPermission,
} from '../lib/permissions.js';
import {
  bookCallMeeting,
  callBookingCounts,
  listCallBookings,
} from '../lib/callBookings.js';

const router = Router();
router.use(authRequired);

router.get('/', requireAnyPermission('leads:view_all', 'leads:view_own'), (req, res) => {
  const rows = listCallBookings({
    q: req.query.q || '',
    status: req.query.status || '',
    limit: req.query.limit,
  });
  const canAll = roleHasPermission(req.user.role, 'leads:view_all');
  const filtered = canAll
    ? rows
    : rows.filter((r) => {
        const lead = r.lead_id
          ? db.prepare(`SELECT * FROM leads WHERE id = ?`).get(r.lead_id)
          : null;
        if (lead && canAccessLead(req.user, lead)) return true;
        return r.booked_by === req.user.id;
      });
  res.json(filtered);
});

router.get('/counts', requireAnyPermission('leads:view_all', 'leads:view_own'), (_req, res) => {
  res.json(callBookingCounts());
});

router.post(
  '/leads/:leadId',
  requireAnyPermission('leads:update_any', 'leads:update_own'),
  async (req, res) => {
    try {
      const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(req.params.leadId);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      if (!canUpdateLead(req.user, lead)) {
        return res.status(403).json({ error: 'Permission denied' });
      }

      const result = await bookCallMeeting({
        leadId: lead.id,
        user: req.user,
        scheduledLocal: req.body?.scheduledAt || req.body?.scheduled_local || req.body?.when,
        timezone: req.body?.timezone || req.body?.timeZone,
        phone: req.body?.phone,
        notes: req.body?.notes,
      });
      res.status(201).json(result);
    } catch (err) {
      const status = err.status || (err.code === 'BREVO_DISABLED' ? 503 : 500);
      res.status(status).json({ error: err.message || 'Failed to book call' });
    }
  },
);

export default router;
