# Connect git + auto-deploy pipeline (Windows CRM API)

Production folder on office PC: **`D:\crm-api.bmgenie.ai`**  
GitHub repo: **`Bmgenieai/BMG`** (branch `main`)

## One-time: link zip folder to GitHub

If the server was deployed from a zip (no `.git`), run once in **PowerShell as Administrator**:

```powershell
cd D:\crm-api.bmgenie.ai

Copy-Item .env D:\.env.crm.backup -Force
Copy-Item -Recurse data D:\data.crm.backup -Force -ErrorAction SilentlyContinue

git init
git remote add origin https://github.com/Bmgenieai/BMG.git
git fetch origin main
git reset --hard origin/main

Copy-Item D:\.env.crm.backup .env -Force
Copy-Item -Recurse D:\data.crm.backup data -Force -ErrorAction SilentlyContinue

npm install
```

Start/restart the API (IIS site or PM2) after first pull.

## GitHub Actions secrets

**Bmgenieai/BMG** → Settings → Secrets and variables → Actions

| Secret | Value |
|--------|--------|
| `DEPLOY_HOST` | Windows public IP (e.g. same as main BMGenie server) |
| `DEPLOY_USER` | SSH username (e.g. `Wasim`) |
| `SERVER_PASSWORD` | SSH password |
| `CRM_DEPLOY_PATH` | `D:\crm-api.bmgenie.ai` |

Use the same `DEPLOY_*` secrets as the main backend repo if it is the same machine.

## Enable SSH on Windows (required for pipeline)

On the Windows PC:

1. **Settings → Apps → Optional features → OpenSSH Server** → Install  
2. **Services** → `OpenSSH SSH Server` → Start + Automatic  
3. Firewall: allow inbound **TCP 22** (or your SSH port)

Test from your laptop:

```bash
ssh Wasim@YOUR_WINDOWS_IP
```

## What happens on every push to `main`

```text
Push to Bmgenieai/BMG main
  → GitHub Action "Deploy CRM API to Windows"
  → SSH into Windows PC
  → D:\crm-api.bmgenie.ai\scripts\windows\deploy-crm-api.ps1
       • stop API (PM2 or kill port 4050)
       • git pull
       • npm install
       • restart (PM2 or touch web.config for IIS)
  → verify http://127.0.0.1:4050/api/health
```

## Manual deploy (fallback)

```powershell
cd D:\crm-api.bmgenie.ai
.\scripts\windows\deploy-crm-api.ps1
.\scripts\windows\verify-crm-api.ps1
```

## First pipeline test

1. Push any commit to `Bmgenieai/BMG` `main`
2. GitHub → **Actions** → **Deploy CRM API to Windows** → should go green
3. Check `https://crm-api.bmgenie.ai/api/health`

Frontend deploys separately: push **BMG-CRM** → Vercel → `crm.bmgenie.ai`
