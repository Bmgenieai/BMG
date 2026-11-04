/**
 * Poll sending mailboxes (IMAP) for prospect replies that landed on From
 * instead of Reply-To. Always keep magic.retouching env mailbox + any
 * email_accounts with IMAP enabled (e.g. Christina).
 *
 * Env (legacy / Magic Retouching):
 *   SENDER_MAILBOX_SYNC=true
 *   SENDER_MAILBOX_IMAP_HOST / PORT / USER / PASS
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { db } from '../db.js';
import { ingestParsedReply } from './emailLog.js';

let timer = null;
let running = false;
let lastError = null;
let lastSyncAt = null;
let lastIngested = 0;

function truthy(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());
}

function envMailbox() {
  const user =
    (process.env.SENDER_MAILBOX_USER || process.env.BREVO_SENDER_EMAIL || '').trim() || null;
  const pass = (process.env.SENDER_MAILBOX_PASS || '').trim() || null;
  const enabled = truthy(process.env.SENDER_MAILBOX_SYNC) && Boolean(user && pass);
  if (!enabled) return null;
  return {
    id: 'env',
    label: user,
    host: (process.env.SENDER_MAILBOX_IMAP_HOST || 'mail2.benchmarkstudio.biz').trim(),
    port: Number(process.env.SENDER_MAILBOX_IMAP_PORT) || 993,
    user,
    pass,
  };
}

function accountMailboxes() {
  try {
    return db
      .prepare(
        `SELECT id, label, email, imap_host, imap_port, imap_user, imap_pass
         FROM email_accounts
         WHERE is_active = 1 AND imap_enabled = 1
           AND imap_user IS NOT NULL AND TRIM(imap_user) != ''
           AND imap_pass IS NOT NULL AND TRIM(imap_pass) != ''`,
      )
      .all()
      .map((a) => ({
        id: a.id,
        label: a.label || a.email,
        host: (a.imap_host || process.env.SENDER_MAILBOX_IMAP_HOST || 'mail2.benchmarkstudio.biz').trim(),
        port: Number(a.imap_port) || 993,
        user: String(a.imap_user).trim(),
        pass: String(a.imap_pass),
      }));
  } catch {
    return [];
  }
}

export function listSyncMailboxes() {
  const list = [];
  const env = envMailbox();
  if (env) list.push(env);
  for (const a of accountMailboxes()) {
    if (env && a.user.toLowerCase() === env.user.toLowerCase()) continue;
    list.push(a);
  }
  return list;
}

export function senderMailboxSyncConfig() {
  const boxes = listSyncMailboxes();
  const env = envMailbox();
  return {
    enabled: boxes.length > 0,
    configured: boxes.length > 0,
    host: env?.host || boxes[0]?.host || null,
    port: env?.port || boxes[0]?.port || 993,
    user: env?.user || boxes[0]?.user || null,
    mailboxes: boxes.map((b) => ({ id: b.id, user: b.user, label: b.label, host: b.host })),
    syncMs: Math.max(60_000, Number(process.env.SENDER_MAILBOX_SYNC_MS) || 120_000),
    lookbackDays: Math.min(
      365,
      Math.max(14, Number(process.env.SENDER_MAILBOX_LOOKBACK_DAYS) || 120),
    ),
    lastError,
    lastSyncAt,
    lastIngested,
  };
}

function ourAddresses() {
  const set = new Set();
  for (const raw of [
    process.env.SENDER_MAILBOX_USER,
    process.env.BREVO_SENDER_EMAIL,
  ]) {
    const e = String(raw || '')
      .trim()
      .toLowerCase();
    if (e) set.add(e);
  }
  try {
    for (const row of db.prepare(`SELECT email FROM email_accounts WHERE is_active = 1`).all()) {
      const e = String(row.email || '')
        .trim()
        .toLowerCase();
      if (e) set.add(e);
    }
  } catch {
    /* ignore */
  }
  return set;
}

function addrList(value) {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .map((a) => String(a?.address || a || '').trim().toLowerCase())
    .filter(Boolean);
}

function looksLikeReply(parsed) {
  if (parsed.inReplyTo) return true;
  if (parsed.references && (Array.isArray(parsed.references) ? parsed.references.length : true)) {
    return true;
  }
  const sub = String(parsed.subject || '');
  return /^(re|fw|fwd|automatic reply)\s*:/i.test(sub);
}

async function processMessage(client, uid, mailboxMeta) {
  const downloaded = await client.download(uid, undefined, { uid: true });
  if (!downloaded?.content) return { skipped: 'no_content' };
  const parsed = await simpleParser(downloaded.content);

  const fromEmail = String(parsed.from?.value?.[0]?.address || '').trim().toLowerCase();
  const fromName = parsed.from?.value?.[0]?.name || null;
  if (!fromEmail) return { skipped: 'no_from' };

  const ours = ourAddresses();
  if (ours.has(fromEmail)) return { skipped: 'from_self' };

  if (!looksLikeReply(parsed)) return { skipped: 'not_reply' };

  const messageId = parsed.messageId
    ? String(parsed.messageId).replace(/^<|>$/g, '')
    : null;
  const providerMessageId = messageId
    ? `mailbox:${mailboxMeta.user}:${messageId}`
    : `mailbox:${mailboxMeta.user}:uid-${uid}-${parsed.date?.getTime() || Date.now()}`;

  const toEmails = [
    ...addrList(parsed.to?.value),
    ...addrList(parsed.cc?.value),
    ...addrList(parsed.bcc?.value),
  ];

  const references = Array.isArray(parsed.references)
    ? parsed.references.join(' ')
    : parsed.references
      ? String(parsed.references)
      : null;

  return ingestParsedReply({
    providerMessageId,
    fromEmail,
    fromName,
    toEmails,
    inReplyTo: parsed.inReplyTo || null,
    references,
    subject: parsed.subject || null,
    bodyText: parsed.text || null,
    bodyHtml: typeof parsed.html === 'string' ? parsed.html : null,
    bodyMarkdown: null,
    spamScore: null,
    receivedAt: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
    raw: {
      ingestSource: 'sender_mailbox',
      mailboxUser: mailboxMeta.user,
      mailboxHost: mailboxMeta.host,
      messageId,
      from: fromEmail,
      to: toEmails,
      subject: parsed.subject,
    },
    source: 'brevo_inbound',
    requireLeadMatch: false,
  });
}

async function syncOneMailbox(box, lookbackDays) {
  let ingested = 0;
  let scanned = 0;
  let skipped = 0;
  const skipReasons = {};

  const client = new ImapFlow({
    host: box.host,
    port: box.port,
    secure: true,
    auth: { user: box.user, pass: box.pass },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
      const uids = await client.search({ seen: false });
      const recent = await client.search({ since });
      const set = new Set([...(uids || []), ...(recent || [])]);
      const list = [...set].sort((a, b) => a - b).slice(-800);

      for (const uid of list) {
        scanned += 1;
        try {
          const result = await processMessage(client, uid, box);
          if (result?.ok && !result.skipped) {
            ingested += 1;
            try {
              await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
            } catch {
              /* ignore */
            }
          } else if (result?.skipped === 'duplicate' && result.ok) {
            try {
              await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
            } catch {
              /* ignore */
            }
            skipped += 1;
            skipReasons.duplicate = (skipReasons.duplicate || 0) + 1;
          } else {
            skipped += 1;
            const reason = result?.skipped || result?.error || 'unknown';
            skipReasons[reason] = (skipReasons[reason] || 0) + 1;
          }
        } catch (err) {
          skipped += 1;
          const reason = `throw:${err.message || 'error'}`;
          skipReasons[reason] = (skipReasons[reason] || 0) + 1;
          console.warn('[sender-mailbox] message failed', box.user, uid, err.message);
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
    return { ok: true, user: box.user, ingested, scanned, skipped, skipReasons };
  } catch (err) {
    let error =
      err.responseText ||
      err.serverResponseCode ||
      err.message ||
      String(err);
    if (err.responseText && err.message && err.responseText !== err.message) {
      error = `${err.message}: ${err.responseText}`;
    }
    console.warn('[sender-mailbox] sync failed:', box.user, error);
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
    return { ok: false, user: box.user, error };
  }
}

export async function syncSenderMailboxOnce() {
  const cfg = senderMailboxSyncConfig();
  if (!cfg.enabled) {
    return { ok: false, skipped: 'disabled' };
  }
  if (running) return { ok: false, skipped: 'busy' };
  running = true;

  const boxes = listSyncMailboxes();
  let ingested = 0;
  const results = [];

  try {
    for (const box of boxes) {
      const r = await syncOneMailbox(box, cfg.lookbackDays);
      results.push(r);
      if (r.ok) ingested += r.ingested || 0;
      else lastError = r.error;
    }
    if (results.every((r) => r.ok)) lastError = null;
    lastSyncAt = new Date().toISOString();
    lastIngested = ingested;
    if (ingested > 0) {
      console.log(`[sender-mailbox] synced ingested=${ingested} mailboxes=${boxes.length}`);
    }
    return { ok: true, ingested, results };
  } finally {
    running = false;
  }
}

export function startSenderMailboxSync() {
  const cfg = senderMailboxSyncConfig();
  if (!cfg.enabled) {
    if (truthy(process.env.SENDER_MAILBOX_SYNC)) {
      console.warn(
        '[sender-mailbox] SENDER_MAILBOX_SYNC on but USER/PASS missing — skipping IMAP poll',
      );
    }
    return;
  }
  console.log(
    `[sender-mailbox] polling ${cfg.mailboxes.map((m) => m.user).join(', ')} every ${Math.round(cfg.syncMs / 1000)}s`,
  );
  const tick = () => {
    syncSenderMailboxOnce().catch((err) => {
      console.warn('[sender-mailbox] tick error', err.message);
    });
  };
  tick();
  timer = setInterval(tick, cfg.syncMs);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopSenderMailboxSync() {
  if (timer) clearInterval(timer);
  timer = null;
}
