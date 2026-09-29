# Brevo (email) for BMGenie CRM

## Goal
Cold / sales outreach from CRM via **Brevo** transactional API + contact list sync + **email replies inbox**.

## Brevo account setup
1. Log in: https://app.brevo.com (Bmgenie account)
2. **Senders** — verify domain or email (e.g. `magic.retouching@bmgenie.ai`)
3. **SMTP & API** → create API key (`xkeysib-...`)
4. **CRM → Lists** — note list ID (e.g. `#2` for "Your first list")

## CRM API `.env` (Windows / local)

```env
BREVO_ENABLED=true
BREVO_API_KEY=xkeysib-your-key-here
BREVO_SENDER_EMAIL=magic.retouching@bmgenie.ai
BREVO_SENDER_NAME=BMGenie Sales
BREVO_LIST_ID=2
BREVO_WEBHOOK_SECRET=long-random-secret
BREVO_REPLY_DOMAIN=reply.bmgenie.ai
```

Restart after changes: `pm2 restart bmg-crm-api`

Never commit the API key.

## Email replies inbox (BD / Ramzan & Laiba)

Brevo supports full reply capture via **Inbound Parsing**. CRM shows them under **Inbound → Email replies**.

### 1. DNS (required for reply bodies)

Create subdomain `reply.bmgenie.ai` (must differ from the sending domain). Add MX:

| Host | Type | Priority | Value |
|------|------|----------|-------|
| `reply.bmgenie.ai` | MX | 10 | `inbound1.sendinblue.com.` |
| `reply.bmgenie.ai` | MX | 20 | `inbound2.sendinblue.com.` |

Wait for DNS propagation.

### 2. Brevo inbound webhook

`POST https://api.brevo.com/v3/webhooks` with API key:

```json
{
  "type": "inbound",
  "events": ["inboundEmailProcessed"],
  "url": "https://crm-api.bmgenie.ai/api/email/webhooks/brevo-inbound?secret=YOUR_BREVO_WEBHOOK_SECRET",
  "domain": "reply.bmgenie.ai",
  "description": "CRM email replies inbox"
}
```

Keep the existing **transactional** webhook for open/click/reply events:

`https://crm-api.bmgenie.ai/api/email/webhooks/brevo?secret=...`

### 3. How matching works

When CRM sends cold email and `BREVO_REPLY_DOMAIN` is set, Brevo `replyTo` is set to `lead-<leadId>@reply.bmgenie.ai`. Prospect replies go to Brevo → inbound webhook → CRM stores subject + body and links the lead.

Without inbound DNS, the Replies tab still lists **reply notifications** from the transactional `reply` event (no body until inbound is live).

## CRM features (implemented)

| Feature | Where |
|---------|--------|
| Cold email templates by lead source | `/email` page + lead drawer |
| Send one-off email | Lead drawer → **Cold email (Brevo)** |
| Bulk send (managers) | `/email` → select leads → Send |
| Sync lead → Brevo contact list | Lead drawer or bulk **Sync to Brevo** |
| Merge tags | `{{first_name}}`, `{{name}}`, `{{company}}`, `{{country}}`, `{{sender_name}}` |
| Email replies inbox | `/email-replies` (Inbound nav) |

## API routes

- `GET /api/email/status` — Brevo configured? inbound domain?
- `GET /api/email/templates` — built-in cold templates
- `GET /api/email/lists` — Brevo contact lists
- `POST /api/email/leads/:id/send` — send to one lead
- `POST /api/email/leads/:id/sync` — upsert contact + add to list
- `POST /api/email/bulk-send` — managers, max 25/request
- `POST /api/email/sync-bulk` — managers, max 100 contacts
- `POST /api/email/preview` — preview merged copy
- `GET /api/email/replies` — replies inbox (`?unread=1&q=`)
- `GET /api/email/replies/counts` — unread / total
- `GET /api/email/replies/:id` — one reply
- `POST /api/email/replies/:id/read` — mark read/unread
- `POST /api/email/webhooks/brevo` — transactional events
- `POST /api/email/webhooks/brevo-inbound` — inbound parse bodies

## Templates (by lead source)

- **signup_no_listing** — intro for users who signed up but never listed
- **free_credit_no_purchase** — nudge after free credit used
- **purchased_no_repurchase** — win-back when credits depleted
- **csv_import / manual** — Meta / outbound intro
- **general_followup** — catch-all

Sending auto-marks `new` leads as `contacted` and logs `email_sent` activity.

## Phase 3 (future)
Brevo Marketing Campaigns / automations for multi-step sequences — use list sync today, campaigns in Brevo UI.
Compose-reply-from-CRM (threading) can be added once inbound is live in production.
