import { db } from '../db.js';
import {
  applyMergeTags,
  getTemplateById,
  sendTransactionalEmail,
  upsertContact,
} from './brevo.js';
import { resolveSendAccount } from './emailAccounts.js';
import { recordEmailSend } from './emailLog.js';
import { claimLeadIfUnassigned } from './leadAutomation.js';

const TICK_MS = 30_000;
const BATCH_LIMIT = 15;

function senderFromUserId(userId, emailAccountId = null) {
  const user = db.prepare(`SELECT id, name, email FROM users WHERE id = ?`).get(userId);
  const resolved = resolveSendAccount(emailAccountId || null);
  return {
    user,
    accountId: resolved.accountId,
    sender: {
      name: resolved.sender.name || user?.name || 'BMGenie Sales',
      email: resolved.sender.email,
    },
  };
}

function resolveContent(row, lead, sender) {
  if (row.template_id) {
    const tpl = getTemplateById(row.template_id);
    if (!tpl) throw new Error('Unknown template');
    return {
      subject: applyMergeTags(row.subject || tpl.subject, lead, sender),
      htmlContent: applyMergeTags(row.html_content || tpl.htmlContent, lead, sender),
      textContent: applyMergeTags(row.text_content || tpl.textContent, lead, sender),
    };
  }
  return {
    subject: applyMergeTags(row.subject, lead, sender),
    htmlContent: row.html_content ? applyMergeTags(row.html_content, lead, sender) : undefined,
    textContent: row.text_content ? applyMergeTags(row.text_content, lead, sender) : undefined,
  };
}

async function processOne(row) {
  const claimed = db
    .prepare(
      `UPDATE scheduled_emails SET status = 'sending'
       WHERE id = ? AND status = 'pending'`,
    )
    .run(row.id);
  if (!claimed.changes) return;

  const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(row.lead_id);
  if (!lead?.email) {
    db.prepare(
      `UPDATE scheduled_emails SET status = 'failed', error = ?, sent_at = datetime('now')
       WHERE id = ?`,
    ).run('Lead missing or has no email', row.id);
    return;
  }

  const { user, sender, accountId } = senderFromUserId(
    row.user_id,
    row.email_account_id || null,
  );
  if (!user) {
    db.prepare(
      `UPDATE scheduled_emails SET status = 'failed', error = ?, sent_at = datetime('now')
       WHERE id = ?`,
    ).run('Scheduling user no longer exists', row.id);
    return;
  }

  try {
    const content = resolveContent(row, lead, sender);
    if (!content.subject || (!content.htmlContent && !content.textContent)) {
      throw new Error('Missing subject or body');
    }

    if (row.sync_to_brevo) {
      await upsertContact({
        email: lead.email,
        name: lead.name,
        phone: lead.phone,
        company: lead.company,
        country: lead.country,
        leadId: lead.id,
        source: lead.source,
      }).catch(() => {});
    }

    const result = await sendTransactionalEmail({
      toEmail: lead.email,
      toName: lead.name || undefined,
      subject: content.subject,
      htmlContent: content.htmlContent,
      textContent: content.textContent,
      leadId: lead.id,
      sender,
    });

    recordEmailSend({
      leadId: lead.id,
      userId: row.user_id,
      subject: content.subject,
      toEmail: lead.email,
      templateId: row.template_id || null,
      brevoMessageId: result?.messageId || result?.message_id || null,
      source: row.campaign_id ? 'campaign' : 'scheduled',
      summaryPrefix: row.campaign_id ? 'Campaign email' : 'Brevo scheduled',
      htmlContent: content.htmlContent || null,
      textContent: content.textContent || null,
      emailAccountId: accountId,
      campaignId: row.campaign_id || null,
      campaignStepId: row.campaign_step_id || null,
    });

    claimLeadIfUnassigned(lead.id, row.user_id);

    db.prepare(
      `UPDATE scheduled_emails
       SET status = 'sent', sent_at = datetime('now'), error = NULL
       WHERE id = ?`,
    ).run(row.id);

    if (row.campaign_id) {
      const pending = db
        .prepare(
          `SELECT COUNT(*) AS c FROM scheduled_emails
           WHERE campaign_id = ? AND lead_id = ? AND status IN ('pending', 'sending')`,
        )
        .get(row.campaign_id, lead.id).c;
      if (!pending) {
        db.prepare(
          `UPDATE email_campaign_leads
           SET status = 'completed', completed_at = datetime('now')
           WHERE campaign_id = ? AND lead_id = ? AND status = 'active'`,
        ).run(row.campaign_id, lead.id);
      }
      const open = db
        .prepare(
          `SELECT COUNT(*) AS c FROM email_campaign_leads
           WHERE campaign_id = ? AND status IN ('pending', 'active')`,
        )
        .get(row.campaign_id).c;
      if (!open) {
        db.prepare(
          `UPDATE email_campaigns
           SET status = 'completed', updated_at = datetime('now')
           WHERE id = ? AND status = 'active'`,
        ).run(row.campaign_id);
      }
    }
  } catch (err) {
    db.prepare(
      `UPDATE scheduled_emails
       SET status = 'failed', error = ?, sent_at = datetime('now')
       WHERE id = ?`,
    ).run(String(err?.message || err).slice(0, 500), row.id);
  }
}

export async function processDueScheduledEmails() {
  const due = db
    .prepare(
      `SELECT * FROM scheduled_emails
       WHERE status = 'pending'
         AND datetime(REPLACE(REPLACE(scheduled_at, 'T', ' '), 'Z', '')) <= datetime('now')
       ORDER BY scheduled_at ASC
       LIMIT ?`,
    )
    .all(BATCH_LIMIT);

  for (const row of due) {
    await processOne(row);
    await new Promise((r) => setTimeout(r, 200));
  }
  return due.length;
}

let timer = null;

export function startScheduledEmailWorker() {
  if (timer) return;
  const tick = () => {
    processDueScheduledEmails().catch((err) => {
      console.warn('[scheduled-email]', err?.message || err);
    });
  };
  tick();
  timer = setInterval(tick, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`Scheduled email worker started (every ${TICK_MS / 1000}s)`);
}
