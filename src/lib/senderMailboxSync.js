/**
 * Poll magic.retouching@ (or BREVO_SENDER_EMAIL) IMAP inbox for prospect replies
 * that bypassed Reply-To and landed on the From address. Ingest into Email replies
 * with the same threading as Brevo inbound parsing.
 *
 * Env:
 *   SENDER_MAILBOX_SYNC=true
 *   SENDER_MAILBOX_IMAP_HOST=imap.gmail.com
 *   SENDER_MAILBOX_IMAP_PORT=993
 *   SENDER_MAILBOX_USER=magic.retouching@bmgenie.ai
 *   SENDER_MAILBOX_PASS=<Google App Password>
 *   SENDER_MAILBOX_SYNC_MS=120000   (optional, default 2 min)
 *   SENDER_MAILBOX_LOOKBACK_DAYS=120 (optional — import older inbox replies)
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { ingestParsedReply } from './emailLog.js';

let timer = null;
let running = false;
let lastError = null;
let lastSyncAt = null;
let lastIngested = 0;

function truthy(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());
}

export function senderMailboxSyncConfig() {
  const user =
    (process.env.SENDER_MAILBOX_USER || process.env.BREVO_SENDER_EMAIL || '').trim() || null;
  const pass = (process.env.SENDER_MAILBOX_PASS || '').trim() || null;
  const enabled = truthy(process.env.SENDER_MAILBOX_SYNC) && Boolean(user && pass);
  return {
    enabled,
    configured: Boolean(user && pass),
    host: (process.env.SENDER_MAILBOX_IMAP_HOST || 'imap.gmail.com').trim(),
    port: Number(process.env.SENDER_MAILBOX_IMAP_PORT) || 993,
    user,
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
  return /^(re|fw|fwd)\s*:/i.test(sub);
}

async function processMessage(client, seq) {
  const downloaded = await client.download(seq);
  const parsed = await simpleParser(downloaded.source);

  const fromEmail = String(parsed.from?.value?.[0]?.address || '').trim().toLowerCase();
  const fromName = parsed.from?.value?.[0]?.name || null;
  if (!fromEmail) return { skipped: 'no_from' };

  const ours = ourAddresses();
  if (ours.has(fromEmail)) return { skipped: 'from_self' };

  if (!looksLikeReply(parsed)) return { skipped: 'not_reply' };

  const messageId = parsed.messageId
    ? String(parsed.messageId).replace(/^<|>$/g, '')
    : null;
  const providerMessageId = messageId ? `mailbox:${messageId}` : `mailbox:uid-${seq}-${parsed.date?.getTime() || Date.now()}`;

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

  const result = ingestParsedReply({
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
      messageId,
      from: fromEmail,
      to: toEmails,
      subject: parsed.subject,
    },
    source: 'sender_mailbox',
    // Only keep mail we can attach to a CRM lead / outbound thread
    requireLeadMatch: true,
  });

  return result;
}

export async function syncSenderMailboxOnce() {
  const cfg = senderMailboxSyncConfig();
  if (!cfg.enabled) {
    return { ok: false, skipped: 'disabled' };
  }
  if (running) return { ok: false, skipped: 'busy' };
  running = true;
  let ingested = 0;
  let scanned = 0;
  let skipped = 0;

  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: true,
    auth: { user: cfg.user, pass: process.env.SENDER_MAILBOX_PASS },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Unseen + all mail in lookback window (catches older replies already in inbox)
      const since = new Date(Date.now() - cfg.lookbackDays * 24 * 60 * 60 * 1000);
      const uids = await client.search({ seen: false });
      const recent = await client.search({ since });
      const set = new Set([...(uids || []), ...(recent || [])]);
      const list = [...set].sort((a, b) => a - b).slice(-800);

      for (const seq of list) {
        scanned += 1;
        try {
          const result = await processMessage(client, seq);
          if (result?.ok && !result.skipped) {
            ingested += 1;
            try {
              await client.messageFlagsAdd(seq, ['\\Seen']);
            } catch {
              /* ignore */
            }
          } else if (result?.skipped === 'duplicate' && result.ok) {
            try {
              await client.messageFlagsAdd(seq, ['\\Seen']);
            } catch {
              /* ignore */
            }
            skipped += 1;
          } else {
            skipped += 1;
          }
        } catch (err) {
          skipped += 1;
          console.warn('[sender-mailbox] message failed', seq, err.message);
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
    lastError = null;
    lastSyncAt = new Date().toISOString();
    lastIngested = ingested;
    if (ingested > 0) {
      console.log(`[sender-mailbox] synced ingested=${ingested} scanned=${scanned} skipped=${skipped}`);
    }
    return { ok: true, ingested, scanned, skipped };
  } catch (err) {
    lastError =
      err.responseText ||
      err.serverResponseCode ||
      err.message ||
      String(err);
    if (err.responseText && err.message && err.responseText !== err.message) {
      lastError = `${err.message}: ${err.responseText}`;
    }
    console.warn('[sender-mailbox] sync failed:', lastError);
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
    return { ok: false, error: lastError };
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
    `[sender-mailbox] polling ${cfg.user} via ${cfg.host}:${cfg.port} every ${Math.round(cfg.syncMs / 1000)}s`,
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
