import { db } from '../db.js';
import {
  applyMergeTags,
  getTemplateById,
  sendTransactionalEmail,
  upsertContact,
} from './brevo.js';
import { getAccountSendQuota, resolveSendAccount } from './emailAccounts.js';
import { recordEmailSend } from './emailLog.js';
import { getEmailSuppression, reasonStopMessage } from './emailSuppression.js';
import { claimLeadIfUnassigned } from './leadAutomation.js';
import {
  CAMPAIGN_SEND_END_HOUR,
  CAMPAIGN_SEND_START_HOUR,
  isCampaignSendWindowNow,
  resolveProspectTimezone,
} from './campaignTimezones.js';

const TICK_MS = 30_000;
const BATCH_LIMIT = 50;

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

function formatMessageIdHeader(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed : `<${trimmed.replace(/^<|>$/g, '')}>`;
}

function buildFollowupThreadContext(campaignId, leadId) {
  const prior = db
    .prepare(
      `SELECT id, brevo_message_id, subject
       FROM email_messages
       WHERE campaign_id = ? AND lead_id = ?
       ORDER BY sent_at ASC`,
    )
    .all(campaignId, leadId);
  if (!prior.length) return null;

  const firstSubject = String(prior[0]?.subject || '').trim();
  const baseSubject = firstSubject.replace(/^(re\s*:\s*)+/i, '').trim();
  const threadSubject = baseSubject ? `Re: ${baseSubject}` : null;

  const refs = [];
  for (const m of prior) {
    const h = formatMessageIdHeader(m.brevo_message_id);
    if (h && !refs.includes(h)) refs.push(h);
  }
  const latestRef = refs.length ? refs[refs.length - 1] : null;
  const headers = {};
  if (latestRef) headers['In-Reply-To'] = latestRef;
  if (refs.length) headers.References = refs.join(' ');

  return {
    threadSubject,
    headers: Object.keys(headers).length ? headers : undefined,
  };
}

async function processOne(row, throttledAccounts) {
  const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(row.lead_id);
  if (!lead?.email) {
    db.prepare(
      `UPDATE scheduled_emails SET status = 'failed', error = ?, sent_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
    ).run('Lead missing or has no email', row.id);
    return { sent: false };
  }

  // 1. Global suppression check (hard bounce, spam, unsubscribe, manual)
  const suppression = getEmailSuppression(lead.email);
  if (suppression) {
    const msg = reasonStopMessage(suppression.reason);
    db.prepare(
      `UPDATE scheduled_emails SET status = 'cancelled', error = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(msg, row.id);
    if (row.campaign_id) {
      db.prepare(
        `UPDATE email_campaign_leads
         SET status = 'stopped', stopped_reason = ?, completed_at = datetime('now')
         WHERE campaign_id = ? AND lead_id = ? AND status IN ('pending', 'active')`,
      ).run(msg, row.campaign_id, lead.id);
    }
    return { sent: false };
  }

  // 2. Campaign-level guard: if campaign is paused/cancelled or lead already stopped/replied
  if (row.campaign_id) {
    if (row.campaign_status && row.campaign_status !== 'active') {
      return { sent: false };
    }
    const cl = db
      .prepare(
        `SELECT status, email_account_id FROM email_campaign_leads
         WHERE campaign_id = ? AND lead_id = ?`,
      )
      .get(row.campaign_id, lead.id);
    if (cl && cl.status === 'stopped') {
      db.prepare(
        `UPDATE scheduled_emails SET status = 'cancelled', error = 'Lead stopped in campaign'
         WHERE id = ? AND status = 'pending'`,
      ).run(row.id);
      return { sent: false };
    }
    if (!row.email_account_id && cl?.email_account_id) {
      row.email_account_id = cl.email_account_id;
    }

    // 3. Mon–Fri business hours in prospect's local timezone (or campaign timezone)
    const effectiveTz =
      row.use_prospect_timezone !== 0
        ? resolveProspectTimezone(lead, row.campaign_timezone)
        : row.campaign_timezone;
    const startH = row.send_window_start ?? CAMPAIGN_SEND_START_HOUR;
    const endH = row.send_window_end ?? CAMPAIGN_SEND_END_HOUR;
    if (!isCampaignSendWindowNow(new Date(), effectiveTz, startH, endH)) {
      return { sent: false, deferredWindow: true };
    }
  }

  // 4. Resolve sender & enforce daily cap + minimum send spacing per sender inbox
  let senderInfo;
  try {
    senderInfo = senderFromUserId(row.user_id, row.email_account_id || null);
  } catch (err) {
    db.prepare(
      `UPDATE scheduled_emails SET status = 'failed', error = ?, sent_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
    ).run(String(err?.message || err).slice(0, 500), row.id);
    return { sent: false };
  }

  const { user, sender, accountId } = senderInfo;
  if (!user) {
    db.prepare(
      `UPDATE scheduled_emails SET status = 'failed', error = ?, sent_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
    ).run('Scheduling user no longer exists', row.id);
    return { sent: false };
  }

  const acctKey = accountId || 'default';
  if (throttledAccounts.has(acctKey)) {
    return { sent: false, throttled: true };
  }

  const quota = getAccountSendQuota(accountId);
  if (quota.capReached || quota.spacingBlocked) {
    throttledAccounts.add(acctKey);
    return { sent: false, throttled: true };
  }

  // Claim the row atomically right before dispatch
  const claimed = db
    .prepare(
      `UPDATE scheduled_emails SET status = 'sending'
       WHERE id = ? AND status = 'pending'`,
    )
    .run(row.id);
  if (!claimed.changes) return { sent: false };

  try {
    const content = resolveContent(row, lead, sender);

    // Step 1 = first email; step 2+ = follow-up (same thread when enabled)
    let summaryPrefix = row.campaign_id ? 'Campaign email' : 'Brevo scheduled';
    let source = row.campaign_id ? 'campaign' : 'scheduled';
    let stepOrder = 1;
    let extraHeaders;
    let finalSubject = content.subject;

    if (row.campaign_id && row.campaign_step_id) {
      const step = db
        .prepare(`SELECT step_order FROM email_campaign_steps WHERE id = ?`)
        .get(row.campaign_step_id);
      if (step && Number(step.step_order) >= 2) {
        stepOrder = Number(step.step_order);
        summaryPrefix = 'Campaign follow-up';
        source = 'followup';

        if (row.thread_followups !== 0) {
          const threadCtx = buildFollowupThreadContext(row.campaign_id, lead.id);
          if (threadCtx) {
            extraHeaders = threadCtx.headers;
            if (threadCtx.threadSubject) {
              finalSubject = threadCtx.threadSubject;
            }
          }
        }
      }
    }

    if (!finalSubject || (!content.htmlContent && !content.textContent)) {
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
      subject: finalSubject,
      htmlContent: content.htmlContent,
      textContent: content.textContent,
      leadId: lead.id,
      sender,
      headers: extraHeaders,
    });

    const variantLabel = row.variant_key ? ` (variant ${row.variant_key})` : '';
    if (row.campaign_id) {
      summaryPrefix = `${summaryPrefix}${stepOrder >= 2 ? ` #${stepOrder}` : ''}${variantLabel}`;
    }

    recordEmailSend({
      leadId: lead.id,
      userId: row.user_id,
      subject: finalSubject,
      toEmail: lead.email,
      templateId: row.template_id || null,
      brevoMessageId: result?.messageId || result?.message_id || null,
      source,
      summaryPrefix,
      htmlContent: content.htmlContent || null,
      textContent: content.textContent || null,
      emailAccountId: accountId,
      campaignId: row.campaign_id || null,
      campaignStepId: row.campaign_step_id || null,
      campaignVariantId: row.campaign_variant_id || null,
      variantKey: row.variant_key || null,
    });

    claimLeadIfUnassigned(lead.id, row.user_id);

    db.prepare(
      `UPDATE scheduled_emails
       SET status = 'sent', sent_at = datetime('now'), error = NULL
       WHERE id = ?`,
    ).run(row.id);

    // If this inbox enforces spacing > 0s, block further sends on this same inbox during this tick
    if (quota.minDelaySeconds > 0) {
      throttledAccounts.add(acctKey);
    }

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

    return { sent: true };
  } catch (err) {
    db.prepare(
      `UPDATE scheduled_emails
       SET status = 'failed', error = ?, sent_at = datetime('now')
       WHERE id = ?`,
    ).run(String(err?.message || err).slice(0, 500), row.id);
    return { sent: false };
  }
}

export async function processDueScheduledEmails() {
  const due = db
    .prepare(
      `SELECT s.*,
              c.status AS campaign_status,
              c.timezone AS campaign_timezone,
              c.send_window_start,
              c.send_window_end,
              c.use_prospect_timezone,
              c.thread_followups
       FROM scheduled_emails s
       LEFT JOIN email_campaigns c ON c.id = s.campaign_id
       WHERE s.status = 'pending'
         AND datetime(REPLACE(REPLACE(s.scheduled_at, 'T', ' '), 'Z', '')) <= datetime('now')
       ORDER BY s.scheduled_at ASC
       LIMIT ?`,
    )
    .all(BATCH_LIMIT);

  const throttledAccounts = new Set();
  let sentCount = 0;

  for (const row of due) {
    const res = await processOne(row, throttledAccounts);
    if (res?.sent) {
      sentCount += 1;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return sentCount;
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
