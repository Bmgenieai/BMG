# Brevo (email) for BMGenie CRM

## Goal
Cold / sales outreach + transactional mail from CRM (leads), via **Brevo**.

## What you create in Brevo (account owner)
1. Sign up / log in: https://app.brevo.com  
2. **Sender** verified (e.g. `sales@bmgenie.ai` or `noreply@bmgenie.ai`)  
3. **SMTP & API** → API key (`xkeysib-...`)  
4. Optional: a contact list / campaign for cold email  

## Env on Windows CRM API (`.env`)

```env
BREVO_API_KEY=xkeysib-...
BREVO_SENDER_EMAIL=sales@bmgenie.ai
BREVO_SENDER_NAME=BMGenie Sales
BREVO_ENABLED=true
```

Never commit the API key. Add to office `.env` after first deploy works.

## Planned CRM features (phased)
1. **Phase 1:** Send one-off email to a lead from CRM (transactional API)  
2. **Phase 2:** Sync lead → Brevo contact list  
3. **Phase 3:** Campaign / cold sequences (Brevo Campaigns or automation)

## Local workspace
`/var/www/BMG2/BmGenie-CRM/backend` → push to `Bmgenieai/BMG` when ready.
