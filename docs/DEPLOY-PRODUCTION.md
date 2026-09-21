# BMGenie CRM — production deployment guide

## Architecture

| Component | Host | Repo | URL |
|-----------|------|------|-----|
| CRM frontend | Vercel | `Bmgenieai/BMG-CRM` | https://crm.bmgenie.ai |
| CRM API | Windows PC (office) | `Bmgenieai/BMG` | https://crm-api.bmgenie.ai |
| Main bmgenie.ai API | Cloud Run | `Bmgenieai/backend` | https://api.bmgenie.ai |

Leads are **pushed from bmgenie.ai → CRM API** when users sign up, use free credits, purchase, or run out of paid credits.

---

## Step 1 — Windows CRM API (one-time)

On the machine at `D:\crm-api.bmgenie.ai`:

```powershell
cd D:\bmg-crm
git clone https://github.com/Bmgenieai/BMG.git .   # skip if already cloned
copy .env.example .env
notepad .env
npm install
npm run seed    # first time only
npm install -g pm2
pm2 start src/server.js --name bmg-crm-api
pm2 save
```

### Required `.env` on Windows (`D:\bmg-crm\.env`)

```env
PORT=4050
NODE_ENV=production
JWT_SECRET=<long-random-secret>

FRONTEND_URL=https://crm.bmgenie.ai
PUBLIC_API_URL=https://crm-api.bmgenie.ai
ALLOWED_ORIGINS=https://crm.bmgenie.ai,https://bmg-crm.vercel.app

# Shared with main bmgenie.ai API — MUST match exactly
CRM_INGEST_API_KEY=<generate-long-random-secret>

# Brevo cold email — paste from app.brevo.com → SMTP & API
BREVO_ENABLED=true
BREVO_API_KEY=xkeysib-xxxxxxxx
BREVO_SENDER_EMAIL=magic.retouching@bmgenie.ai
BREVO_SENDER_NAME=BMGenie Sales
BREVO_LIST_ID=2
```

**Where to add Brevo API key:** only in this Windows `.env` file — never commit it, never put it in Vercel.

Health check: `https://crm-api.bmgenie.ai/api/health`

---

## Step 2 — GitHub Actions pipeline (auto-deploy on push to main)

Pipeline: **Bmgenieai/BMG** → Actions → **Deploy CRM API to Windows**

### GitHub secrets (Bmgenieai/BMG → Settings → Secrets)

| Secret | Value |
|--------|--------|
| `DEPLOY_HOST` | Windows server public IP |
| `DEPLOY_USER` | SSH username |
| `SERVER_PASSWORD` | SSH password |
| `CRM_DEPLOY_PATH` | `D:\crm-api.bmgenie.ai` |

### Windows requirements

- **OpenSSH Server** installed and running (port 22)
- Folder linked to git (see `docs/GIT-AND-PIPELINE.md`)
- `.env` present in deploy folder

Every push to `main` runs: stop API → `git pull` → `npm install` → restart → health check.

### Manual deploy (if pipeline not ready)

```powershell
cd D:\crm-api.bmgenie.ai
.\scripts\windows\deploy-crm-api.ps1
```

---

## Step 3 — Vercel frontend (auto on push)

Repo: **Bmgenieai/BMG-CRM** → push to `main` → Vercel deploys automatically.

### Environment variable (Vercel dashboard)

```
VITE_API_URL=https://crm-api.bmgenie.ai
```

No Brevo key on Vercel — email sends go through the CRM API.

---

## Step 4 — Main bmgenie.ai API (lead sync)

On **Cloud Run** / production env for main API (`Bmgenieai/backend`):

```env
CRM_SYNC_ENABLED=true
CRM_API_URL=https://crm-api.bmgenie.ai/api
CRM_INGEST_API_KEY=<same-secret-as-Windows-CRM_INGEST_API_KEY>
```

Redeploy main API after setting these.

### What creates CRM leads automatically

| User action on bmgenie.ai | CRM lead source | CRM status |
|---------------------------|-----------------|------------|
| Signs up (no purchase) | `signup_no_listing` | Qualified |
| Uses free credit, no purchase | `free_credit_no_purchase` | Qualified |
| Buys a package | — | **Paid** |
| Uses all paid credits, no repurchase | `purchased_no_repurchase` | Qualified (win-back) |
| Opens Stripe then abandons | `checkout_abandoned` | Open |
| Requests listing revisions | `revision_requested` | Open |
| Books Calendly demo | `demo_booking` | **Demo booked** (+ **Book a demo** tab) |
| Starts Tawk chat | `chat_support` | Chat thread in **Chat support** |

View product queues in CRM sidebar under **From bmgenie.ai**. CEO **Product analytics** page shows daily counts (live from main API when `BMGENIE_API_URL` is set).

### Webhooks to configure (ops)

| Provider | CRM endpoint |
|----------|----------------|
| Calendly (`invitee.created`) | `https://crm-api.bmgenie.ai/api/ingest/calendly` |
| Tawk.to (chat start / transcript) | `https://crm-api.bmgenie.ai/api/ingest/tawk` |

Optional Windows `.env`:

```env
BMGENIE_API_URL=https://api.bmgenie.ai
CALENDLY_ALLOW_UNSIGNED=true
TAWK_PROPERTY_ID=6aaf9e58d673343444374636
```

### Test ingest from office PC

```powershell
curl -X POST https://crm-api.bmgenie.ai/api/ingest/product-leads `
  -H "Content-Type: application/json" `
  -H "X-CRM-Ingest-Key: YOUR_SHARED_SECRET" `
  -d '{"event":"user.signup","bmgenieUserId":"test-1","name":"Test User","email":"test@example.com"}'
```

Expected: `{"ok":true,"action":"created",...}`

Also try checkout / revision / chat:

```powershell
curl -X POST https://crm-api.bmgenie.ai/api/ingest/product-leads `
  -H "Content-Type: application/json" `
  -H "X-CRM-Ingest-Key: YOUR_SHARED_SECRET" `
  -d '{"event":"user.checkout_abandoned","bmgenieUserId":"test-2","name":"Abandon User","email":"abandon@example.com","metadata":{"stripePaymentIntentId":"pi_test","packageType":"professional"}}'
```

---

## Step 5 — Brevo setup (cold email)

1. https://app.brevo.com → **Senders** → verify `magic.retouching@bmgenie.ai`
2. **SMTP & API** → Create API key → copy `xkeysib-…`
3. **CRM → Lists** → note list ID (e.g. `#2`)
4. Paste into Windows `.env` (see Step 1)
5. `pm2 restart bmg-crm-api --update-env`
6. CRM → **Cold email** → status should show **Connected**

---

## Deploy checklist

- [ ] Windows `.env` complete (JWT, CRM_INGEST_API_KEY, Brevo)
- [ ] `pm2 status` shows `bmg-crm-api` online
- [ ] `https://crm-api.bmgenie.ai/api/health` returns OK
- [ ] Vercel `VITE_API_URL` set and redeployed
- [ ] Main API `CRM_*` env vars set and redeployed
- [ ] Test signup on bmgenie.ai → lead appears in CRM **New Leads**
- [ ] Brevo status **Connected** in CRM Cold email page

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| No leads from bmgenie.ai | Check main API logs for `CRM sync failed`; verify matching `CRM_INGEST_API_KEY` and `CRM_API_URL` |
| CRM UI can't reach API | Vercel `VITE_API_URL`; Windows firewall port 4050; Cloudflare DNS `crm-api.bmgenie.ai` |
| Brevo "Not configured" | `BREVO_ENABLED=true` + valid API key on Windows only; restart PM2 |
| Pipeline fails | SSH secrets; ensure `D:\bmg-crm` is git repo tracking `origin/main` |
