/**
 * In-CRM email campaigns (Brevo transactional delivery).
 */
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { canUpdateLead } from './permissions.js';
import { resolveSendAccount } from './emailAccounts.js';

function sqlDate(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export function listCampaigns() {
  return db
    .prepare(
      `SELECT c.*,
              a.label AS account_label,
              a.email AS account_email,
              u.name AS created_by_name,
              (SELECT COUNT(*) FROM email_campaign_leads cl WHERE cl.campaign_id = c.id) AS lead_count,
              (SELECT COUNT(*) FROM email_campaign_steps cs WHERE cs.campaign_id = c.id) AS step_count
       FROM email_campaigns c
       LEFT JOIN email_accounts a ON a.id = c.email_account_id
       LEFT JOIN users u ON u.id = c.created_by
       ORDER BY c.created_at DESC`,
    )
    .all();
}

export function getCampaign(id) {
  const campaign = db
    .prepare(
      `SELECT c.*,
              a.label AS account_label,
              a.email AS account_email,
              u.name AS created_by_name
       FROM email_campaigns c
       LEFT JOIN email_accounts a ON a.id = c.email_account_id
       LEFT JOIN users u ON u.id = c.created_by
       WHERE c.id = ?`,
    )
    .get(id);
  if (!campaign) return null;

  const steps = db
    .prepare(
      `SELECT * FROM email_campaign_steps
       WHERE campaign_id = ?
       ORDER BY step_order ASC`,
    )
    .all(id);

  const leads = db
    .prepare(
      `SELECT cl.*, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company
       FROM email_campaign_leads cl
       JOIN leads l ON l.id = cl.lead_id
       WHERE cl.campaign_id = ?
       ORDER BY cl.enrolled_at DESC`,
    )
    .all(id);

  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status = 'stopped' THEN 1 ELSE 0 END) AS stopped,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         COUNT(*) AS total
       FROM email_campaign_leads
       WHERE campaign_id = ?`,
    )
    .get(id);

  return { ...campaign, steps, leads, counts };
}

export function createCampaign(body, { userId }) {
  const name = String(body.name || '').trim();
  if (!name) {
    const err = new Error('Campaign name required');
    err.status = 400;
    throw err;
  }

  let accountId = body.emailAccountId || body.email_account_id || null;
  if (accountId) {
    resolveSendAccount(accountId);
  } else {
    accountId = resolveSendAccount(null).accountId;
  }

  const id = uuid();
  db.prepare(
    `INSERT INTO email_campaigns (id, name, status, email_account_id, created_by)
     VALUES (?, ?, 'draft', ?, ?)`,
  ).run(id, name, accountId, userId);

  const steps = Array.isArray(body.steps) ? body.steps : [];
  if (steps.length) {
    replaceSteps(id, steps);
  }

  return getCampaign(id);
}

export function updateCampaign(id, body) {
  const row = db.prepare(`SELECT * FROM email_campaigns WHERE id = ?`).get(id);
  if (!row) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }
  if (row.status !== 'draft' && row.status !== 'paused') {
    const err = new Error('Only draft or paused campaigns can be edited');
    err.status = 400;
    throw err;
  }

  const name = body.name != null ? String(body.name).trim() : row.name;
  if (!name) {
    const err = new Error('Campaign name required');
    err.status = 400;
    throw err;
  }

  let accountId = row.email_account_id;
  if (body.emailAccountId !== undefined || body.email_account_id !== undefined) {
    accountId = body.emailAccountId ?? body.email_account_id ?? null;
    if (accountId) resolveSendAccount(accountId);
  }

  db.prepare(
    `UPDATE email_campaigns
     SET name = ?, email_account_id = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(name, accountId, id);

  if (Array.isArray(body.steps)) {
    replaceSteps(id, body.steps);
  }

  return getCampaign(id);
}

function replaceSteps(campaignId, steps) {
  db.prepare(`DELETE FROM email_campaign_steps WHERE campaign_id = ?`).run(campaignId);
  const insert = db.prepare(
    `INSERT INTO email_campaign_steps (
       id, campaign_id, step_order, delay_days, subject, html_content, text_content, template_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  steps.forEach((s, i) => {
    const order = Number(s.step_order || s.stepOrder || i + 1) || i + 1;
    const delay = Math.max(0, Number(s.delay_days ?? s.delayDays ?? 0) || 0);
    const subject = s.subject != null ? String(s.subject) : null;
    const html = s.html_content ?? s.htmlContent ?? null;
    const text = s.text_content ?? s.textContent ?? null;
    const templateId = s.template_id || s.templateId || null;
    if (!templateId && !subject) {
      const err = new Error(`Step ${order}: subject or template required`);
      err.status = 400;
      throw err;
    }
    if (!templateId && !html && !text) {
      const err = new Error(`Step ${order}: body required`);
      err.status = 400;
      throw err;
    }
    insert.run(
      uuid(),
      campaignId,
      order,
      delay,
      subject,
      html,
      text,
      templateId,
    );
  });
}

export function addLeads(campaignId, leadIds, { user, skipPerm = false } = {}) {
  const campaign = db.prepare(`SELECT * FROM email_campaigns WHERE id = ?`).get(campaignId);
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }
  if (!['draft', 'paused', 'active'].includes(campaign.status)) {
    const err = new Error('Cannot add leads to this campaign');
    err.status = 400;
    throw err;
  }

  const ids = [...new Set((leadIds || []).filter(Boolean))];
  if (!ids.length) {
    const err = new Error('leadIds[] required');
    err.status = 400;
    throw err;
  }

  const placeholders = ids.map(() => '?').join(',');
  let leads = db
    .prepare(
      `SELECT * FROM leads WHERE id IN (${placeholders}) AND email IS NOT NULL AND email != ''`,
    )
    .all(...ids);

  if (!skipPerm && user) {
    leads = leads.filter((l) => canUpdateLead(user, l));
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO email_campaign_leads (id, campaign_id, lead_id, status)
     VALUES (?, ?, ?, ?)`,
  );
  const status = campaign.status === 'active' ? 'active' : 'pending';
  let added = 0;
  const tx = db.transaction(() => {
    for (const lead of leads) {
      const r = insert.run(uuid(), campaignId, lead.id, status);
      if (r.changes) added += 1;
    }
  });
  tx();

  return { added, total: leads.length };
}

export function removeLead(campaignId, leadId) {
  const campaign = db.prepare(`SELECT * FROM email_campaigns WHERE id = ?`).get(campaignId);
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }
  if (campaign.status === 'active') {
    db.prepare(
      `UPDATE scheduled_emails
       SET status = 'cancelled', error = ?
       WHERE campaign_id = ? AND lead_id = ? AND status IN ('pending', 'sending')`,
    ).run('Removed from campaign', campaignId, leadId);
  }
  return db
    .prepare(`DELETE FROM email_campaign_leads WHERE campaign_id = ? AND lead_id = ?`)
    .run(campaignId, leadId).changes;
}

/**
 * Launch: schedule each step for each lead via scheduled_emails worker.
 */
export function launchCampaign(campaignId, { userId }) {
  const campaign = db.prepare(`SELECT * FROM email_campaigns WHERE id = ?`).get(campaignId);
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }
  if (campaign.status !== 'draft' && campaign.status !== 'paused') {
    const err = new Error('Only draft or paused campaigns can be launched');
    err.status = 400;
    throw err;
  }

  const steps = db
    .prepare(
      `SELECT * FROM email_campaign_steps WHERE campaign_id = ? ORDER BY step_order ASC`,
    )
    .all(campaignId);
  if (!steps.length) {
    const err = new Error('Add at least one email step before launch');
    err.status = 400;
    throw err;
  }

  const members = db
    .prepare(
      `SELECT cl.*, l.email AS lead_email
       FROM email_campaign_leads cl
       JOIN leads l ON l.id = cl.lead_id
       WHERE cl.campaign_id = ? AND cl.status IN ('pending', 'active', 'stopped')
         AND l.email IS NOT NULL AND l.email != ''`,
    )
    .all(campaignId);
  if (!members.length) {
    const err = new Error('Add at least one lead with an email before launch');
    err.status = 400;
    throw err;
  }

  resolveSendAccount(campaign.email_account_id);

  const now = new Date();
  const insert = db.prepare(
    `INSERT INTO scheduled_emails (
       id, batch_id, lead_id, user_id, subject, html_content, text_content,
       template_id, sync_to_brevo, scheduled_at, status,
       email_account_id, campaign_id, campaign_step_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'pending', ?, ?, ?)`,
  );

  const batchId = uuid();
  let scheduled = 0;

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE email_campaigns
       SET status = 'active', launched_at = COALESCE(launched_at, ?), updated_at = datetime('now')
       WHERE id = ?`,
    ).run(sqlDate(now), campaignId);

    db.prepare(
      `UPDATE email_campaign_leads
       SET status = 'active', stopped_reason = NULL, completed_at = NULL
       WHERE campaign_id = ? AND status IN ('pending', 'stopped')`,
    ).run(campaignId);

    // Cancel leftover pending from a previous pause
    db.prepare(
      `UPDATE scheduled_emails
       SET status = 'cancelled', error = 'Re-launched'
       WHERE campaign_id = ? AND status IN ('pending', 'sending')`,
    ).run(campaignId);

    for (const member of members) {
      for (const step of steps) {
        const when = new Date(now.getTime() + (Number(step.delay_days) || 0) * 86_400_000);
        insert.run(
          uuid(),
          batchId,
          member.lead_id,
          userId,
          step.subject || null,
          step.html_content || null,
          step.text_content || null,
          step.template_id || null,
          sqlDate(when),
          campaign.email_account_id || null,
          campaignId,
          step.id,
        );
        scheduled += 1;
      }
    }
  });
  tx();

  return { ok: true, batchId, scheduled, leads: members.length, steps: steps.length };
}

export function pauseCampaign(campaignId) {
  const campaign = db.prepare(`SELECT * FROM email_campaigns WHERE id = ?`).get(campaignId);
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }
  if (campaign.status !== 'active') {
    const err = new Error('Only active campaigns can be paused');
    err.status = 400;
    throw err;
  }
  db.prepare(
    `UPDATE scheduled_emails
     SET status = 'cancelled', error = ?
     WHERE campaign_id = ? AND status IN ('pending', 'sending')`,
  ).run('Campaign paused', campaignId);
  db.prepare(
    `UPDATE email_campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?`,
  ).run(campaignId);
  return getCampaign(campaignId);
}

export function cancelCampaign(campaignId) {
  const campaign = db.prepare(`SELECT * FROM email_campaigns WHERE id = ?`).get(campaignId);
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }
  db.prepare(
    `UPDATE scheduled_emails
     SET status = 'cancelled', error = ?
     WHERE campaign_id = ? AND status IN ('pending', 'sending')`,
  ).run('Campaign cancelled', campaignId);
  db.prepare(
    `UPDATE email_campaign_leads
     SET status = 'stopped', stopped_reason = 'Campaign cancelled', completed_at = datetime('now')
     WHERE campaign_id = ? AND status IN ('pending', 'active')`,
  ).run(campaignId);
  db.prepare(
    `UPDATE email_campaigns SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`,
  ).run(campaignId);
  return getCampaign(campaignId);
}
