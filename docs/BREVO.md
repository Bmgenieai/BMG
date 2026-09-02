# Brevo (email) for BMGenie CRM

## Goal
Cold / sales outreach from CRM via **Brevo** transactional API + contact list sync.

## Brevo account setup
1. Log in: https://app.brevo.com (Bmgenie account)
2. **Senders** — verify domain or email (e.g. `sales@bmgenie.ai`)
3. **SMTP & API** → create API key (`xkeysib-...`)
4. **CRM → Lists** — note list ID (e.g. `#2` for "Your first list")

## CRM API `.env` (Windows / local)

```env
BREVO_ENABLED=true
BREVO_API_KEY=xkeysib-your-key-here
BREVO_SENDER_EMAIL=sales@bmgenie.ai
BREVO_SENDER_NAME=BMGenie Sales
BREVO_LIST_ID=2
```

Restart after changes: `pm2 restart bmg-crm-api`

Never commit the API key.

## CRM features (implemented)

| Feature | Where |
|---------|--------|
| Cold email templates by lead source | `/email` page + lead drawer |
| Send one-off email | Lead drawer → **Cold email (Brevo)** |
| Bulk send (managers) | `/email` → select leads → Send |
| Sync lead → Brevo contact list | Lead drawer or bulk **Sync to Brevo** |
| Merge tags | `{{first_name}}`, `{{name}}`, `{{company}}`, `{{country}}`, `{{sender_name}}` |

## API routes

- `GET /api/email/status` — Brevo configured?
- `GET /api/email/templates` — built-in cold templates
- `GET /api/email/lists` — Brevo contact lists
- `POST /api/email/leads/:id/send` — send to one lead
- `POST /api/email/leads/:id/sync` — upsert contact + add to list
- `POST /api/email/bulk-send` — managers, max 25/request
- `POST /api/email/sync-bulk` — managers, max 100 contacts
- `POST /api/email/preview` — preview merged copy

## Templates (by lead source)

- **signup_no_listing** — intro for users who signed up but never listed
- **free_credit_no_purchase** — nudge after free credit used
- **purchased_no_repurchase** — win-back when credits depleted
- **csv_import / manual** — Meta / outbound intro
- **general_followup** — catch-all

Sending auto-marks `new` leads as `contacted` and logs `email_sent` activity.

## Phase 3 (future)
Brevo Marketing Campaigns / automations for multi-step sequences — use list sync today, campaigns in Brevo UI.
