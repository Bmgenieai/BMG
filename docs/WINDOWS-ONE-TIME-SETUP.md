# One-time setup on the Windows BMGenie machine (office)
#
# After this, pushes to Bmgenieai/BMG main auto-deploy via GitHub Actions.
# You should not need to redeploy manually.

## 1. Folder + clone

```powershell
mkdir D:\bmg-crm -Force
cd D:\bmg-crm
git clone https://github.com/Bmgenieai/BMG.git .
```

## 2. Env file (create once — never overwritten by deploy)

```powershell
copy .env.example .env
notepad .env
```

Set at least:

```
PORT=4050
NODE_ENV=production
JWT_SECRET=<long-random-secret>
CRM_INGEST_API_KEY=<shared-secret-with-main-bmgenie-api>
```

## 3. Install + seed + PM2

```powershell
npm install
npm run seed
npm install -g pm2
pm2 start src/server.js --name bmg-crm-api
pm2 save
```

Optional: Windows firewall allow inbound TCP **4050** (or only via IIS/Cloudflare tunnel).

## 4. Public DNS (Cloudflare — usually done by another person)

| Type | Name | Target | Proxy |
|------|------|--------|--------|
| A or CNAME | `crm-api` | Windows public IP / tunnel host | as needed |

Health check: `https://crm-api.bmgenie.ai/api/health`  
(or `http://SERVER_IP:4050/api/health` until DNS is ready)

## 5. GitHub Actions secrets (Bmgenieai/BMG repo)

Same Windows SSH secrets as main API if same machine, or dedicated ones:

| Secret | Example |
|--------|---------|
| `DEPLOY_HOST` | Windows public IP / hostname |
| `DEPLOY_USER` | SSH user |
| `SERVER_PASSWORD` | SSH password |
| `CRM_DEPLOY_PATH` | `D:\bmg-crm` (optional; default in workflow) |

## 6. After first setup

Push to `main` on **BMG** → Actions → **Deploy CRM API** pulls + `npm install` + `pm2 restart bmg-crm-api`.

## 7. Point Vercel CRM UI at this API

Vercel project **bmg-crm** → Environment Variables:

```
VITE_API_URL=https://crm-api.bmgenie.ai
```

Redeploy frontend after saving.
