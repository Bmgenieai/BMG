/**
 * Brevo API helper for BMGenie CRM cold email + contact sync.
 * Enabled when BREVO_ENABLED=true and BREVO_API_KEY is set.
 */
import { LEAD_SOURCES } from './permissions.js';

const BREVO_API = 'https://api.brevo.com/v3';

export function brevoEnabled() {
  return (
    process.env.BREVO_ENABLED === 'true' &&
    Boolean((process.env.BREVO_API_KEY || '').trim())
  );
}

function apiKey() {
  return (process.env.BREVO_API_KEY || '').trim();
}

function defaultListId() {
  const raw = (process.env.BREVO_LIST_ID || '').trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function senderConfig() {
  const senderEmail = (process.env.BREVO_SENDER_EMAIL || '').trim();
  const senderName = (process.env.BREVO_SENDER_NAME || 'BMGenie Sales').trim();
  if (!senderEmail) {
    throw new Error('BREVO_SENDER_EMAIL is required');
  }
  return { email: senderEmail, name: senderName };
}

function assertEnabled() {
  if (!brevoEnabled()) {
    const err = new Error('Brevo is not enabled (set BREVO_ENABLED=true and BREVO_API_KEY)');
    err.code = 'BREVO_DISABLED';
    throw err;
  }
}

/** @param {string} path @param {RequestInit} [options] */
export async function brevoFetch(path, options = {}) {
  assertEnabled();
  const res = await fetch(`${BREVO_API}${path}`, {
    ...options,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': apiKey(),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (!res.ok) {
    const err = new Error(data?.message || `Brevo error ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function firstName(fullName) {
  const n = (fullName || '').trim();
  if (!n) return 'there';
  return n.split(/\s+/)[0] || n;
}

/**
 * Merge {{tags}} in cold email copy.
 * @param {string} text
 * @param {{ name?: string, company?: string, country?: string, source?: string, email?: string }} lead
 * @param {{ name?: string, email?: string }} [sender]
 */
export function applyMergeTags(text, lead, sender) {
  const sourceLabel = LEAD_SOURCES[lead.source]?.label || lead.source || '';
  const tags = {
    name: lead.name || 'there',
    first_name: firstName(lead.name),
    company: lead.company || 'your studio',
    country: lead.country || '',
    email: lead.email || '',
    source: lead.source || '',
    source_label: sourceLabel,
    sender_name: sender?.name || process.env.BREVO_SENDER_NAME || 'BMGenie Sales',
    sender_email: sender?.email || process.env.BREVO_SENDER_EMAIL || '',
  };
  return String(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => tags[key] ?? '');
}

/** Built-in cold email templates keyed by lead source (or general). */
export const COLD_EMAIL_TEMPLATES = [
  {
    id: 'signup_intro',
    label: 'Signup — no listing yet',
    sources: ['signup_no_listing'],
    subject: '{{first_name}}, quick question about your BMGenie account',
    htmlContent: `<p>Hi {{first_name}},</p>
<p>I noticed you signed up for BMGenie but haven't created a listing yet. Many real-estate photographers tell us they weren't sure where to start.</p>
<p>We can walk you through your first AI-enhanced listing in about 5 minutes — would a quick call this week work?</p>
<p>Best,<br>{{sender_name}}<br>BMGenie Sales</p>`,
    textContent: `Hi {{first_name}},

I noticed you signed up for BMGenie but haven't created a listing yet. Many real-estate photographers tell us they weren't sure where to start.

We can walk you through your first AI-enhanced listing in about 5 minutes — would a quick call this week work?

Best,
{{sender_name}}
BMGenie Sales`,
  },
  {
    id: 'free_credit_nudge',
    label: 'Free credit — no purchase',
    sources: ['free_credit_no_purchase'],
    subject: '{{first_name}}, how did your first BMGenie listing go?',
    htmlContent: `<p>Hi {{first_name}},</p>
<p>You used your free listing credit on BMGenie — we'd love to hear how it went.</p>
<p>If you're posting regularly, our Professional pack (29 listings) saves most US &amp; EU studios time and money vs. one-off edits.</p>
<p>Reply here or book a 10-min demo and we'll show you the workflow.</p>
<p>Cheers,<br>{{sender_name}}</p>`,
    textContent: `Hi {{first_name}},

You used your free listing credit on BMGenie — we'd love to hear how it went.

If you're posting regularly, our Professional pack (29 listings) saves most US & EU studios time and money vs. one-off edits.

Reply here or book a 10-min demo and we'll show you the workflow.

Cheers,
{{sender_name}}`,
  },
  {
    id: 'winback_repurchase',
    label: 'Win-back — credits depleted',
    sources: ['purchased_no_repurchase'],
    subject: '{{first_name}}, ready for your next BMGenie pack?',
    htmlContent: `<p>Hi {{first_name}},</p>
<p>Your BMGenie listing credits have run out — hope the last batch helped you win more listings.</p>
<p>We can renew your pack or suggest a plan that fits {{company}}'s volume. Want us to hold a Starter or Professional slot for you?</p>
<p>Best,<br>{{sender_name}}</p>`,
    textContent: `Hi {{first_name}},

Your BMGenie listing credits have run out — hope the last batch helped you win more listings.

We can renew your pack or suggest a plan that fits your studio's volume. Want us to hold a Starter or Professional slot for you?

Best,
{{sender_name}}`,
  },
  {
    id: 'meta_intro',
    label: 'Meta / CSV lead intro',
    sources: ['csv_import', 'manual'],
    subject: 'BMGenie for {{company}} — AI listing photos',
    htmlContent: `<p>Hi {{first_name}},</p>
<p>I'm reaching out from BMGenie — we help real-estate media teams deliver HDR-quality listing photos with AI, fast.</p>
<p>Studios in {{country}} typically start with a free listing credit, then scale on pay-as-you-go packs from $16.</p>
<p>Open to a quick intro call?</p>
<p>{{sender_name}}<br>BMGenie Sales</p>`,
    textContent: `Hi {{first_name}},

I'm reaching out from BMGenie — we help real-estate media teams deliver HDR-quality listing photos with AI, fast.

Studios typically start with a free listing credit, then scale on pay-as-you-go packs from $16.

Open to a quick intro call?

{{sender_name}}
BMGenie Sales`,
  },
  {
    id: 'general_followup',
    label: 'General follow-up',
    sources: ['*'],
    subject: 'Following up — BMGenie',
    htmlContent: `<p>Hi {{first_name}},</p>
<p>Just following up on BMGenie — happy to answer questions about AI listing enhancement for {{company}}.</p>
<p>Let me know if you'd like a short demo.</p>
<p>Best,<br>{{sender_name}}</p>`,
    textContent: `Hi {{first_name}},

Just following up on BMGenie — happy to answer questions about AI listing enhancement.

Let me know if you'd like a short demo.

Best,
{{sender_name}}`,
  },
];

export function getTemplatesForSource(source) {
  const specific = COLD_EMAIL_TEMPLATES.filter(
    (t) => t.sources.includes('*') === false && t.sources.includes(source),
  );
  const general = COLD_EMAIL_TEMPLATES.filter((t) => t.sources.includes('*'));
  return [...specific, ...general];
}

export function getTemplateById(id) {
  return COLD_EMAIL_TEMPLATES.find((t) => t.id === id) || null;
}

/**
 * @param {{ toEmail: string, toName?: string, subject: string, htmlContent?: string, textContent?: string }} opts
 */
export async function sendTransactionalEmail(opts) {
  assertEnabled();
  const sender = senderConfig();
  const body = {
    sender,
    to: [{ email: opts.toEmail, name: opts.toName || undefined }],
    subject: opts.subject,
    htmlContent: opts.htmlContent || undefined,
    textContent: opts.textContent || opts.subject,
  };
  return brevoFetch('/smtp/email', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Create or update a Brevo contact and optionally add to list(s).
 * @param {{ email: string, name?: string, phone?: string, company?: string, country?: string, leadId?: string, source?: string, listIds?: number[] }} opts
 */
export async function upsertContact(opts) {
  assertEnabled();
  const listIds = opts.listIds?.length ? opts.listIds : defaultListId() ? [defaultListId()] : [];

  const attributes = {};
  if (opts.name) {
    attributes.FIRSTNAME = firstName(opts.name);
    attributes.LASTNAME = opts.name.split(/\s+/).slice(1).join(' ') || undefined;
  }
  if (opts.phone) attributes.SMS = opts.phone;
  if (opts.company) attributes.COMPANY = opts.company;
  if (opts.country) attributes.COUNTRY = opts.country;
  if (opts.source) attributes.LEAD_SOURCE = opts.source;
  if (opts.leadId) attributes.CRM_LEAD_ID = opts.leadId;

  const payload = {
    email: opts.email.trim().toLowerCase(),
    attributes,
    updateEnabled: true,
  };
  if (listIds.length) payload.listIds = listIds;

  return brevoFetch('/contacts', { method: 'POST', body: JSON.stringify(payload) });
}

/** @returns {Promise<{ lists: Array<{ id: number, name: string, totalSubscribers?: number }> }>} */
export async function getContactLists() {
  const data = await brevoFetch('/contacts/lists?limit=50&offset=0');
  const lists = (data.lists || []).map((l) => ({
    id: l.id,
    name: l.name,
    totalSubscribers: l.totalSubscribers ?? l.totalBlacklisted,
  }));
  return { lists, defaultListId: defaultListId() };
}

export function getBrevoPublicConfig() {
  return {
    enabled: brevoEnabled(),
    sender: process.env.BREVO_SENDER_EMAIL || null,
    senderName: process.env.BREVO_SENDER_NAME || null,
    defaultListId: defaultListId(),
  };
}
