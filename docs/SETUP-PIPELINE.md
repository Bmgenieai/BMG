# GitHub Actions — auto-deploy CRM API to Windows

After this one-time setup, every push to **`Bmgenieai/BMG`** `main` deploys automatically. No Remote Desktop needed.

**Server folder:** `D:\crm-api.bmgenie.ai`  
**GitHub repo:** https://github.com/Bmgenieai/BMG

---

## Prerequisites on Windows (one-time)

1. **Git** installed — https://git-scm.com/download/win  
2. **Node.js 20** installed  
3. Folder linked to GitHub (already done if `git pull origin main` works):

```powershell
cd D:\crm-api.bmgenie.ai
git status
# Should show: On branch main, tracking origin/main
```

4. **`.env`** exists in that folder (never committed)  
5. **OpenSSH Server** enabled on Windows (for GitHub Actions SSH):

```powershell
# Run as Administrator — one time
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
```

6. Firewall allows SSH (port 22) from GitHub Actions runners (or your office IP if restricted).

---

## GitHub secrets (Bmgenieai/BMG repo)

Go to: **GitHub → Bmgenieai/BMG → Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value | Example |
|--------|--------|---------|
| `DEPLOY_HOST` | Windows public IP or hostname | `202.59.75.242` |
| `DEPLOY_USER` | Windows login that can SSH + write to D:\ | `Wasim` or `Administrator` |
| `SERVER_PASSWORD` | That user's password | *(your password)* |
| `CRM_DEPLOY_PATH` | CRM API folder | `D:\crm-api.bmgenie.ai` |

Use the **same** `DEPLOY_*` secrets as main BMGenie backend if it's the same PC.

---

## What the pipeline does on each push

```text
Push to BMG main
  → GitHub Action "Deploy CRM API to Windows"
  → SSH into Windows
  → cd D:\crm-api.bmgenie.ai
  → stop process on port 4050
  → git pull
  → npm install
  → restart (PM2, or IIS app pool, or node)
  → health check http://127.0.0.1:4050/api/health
```

Workflow file: `.github/workflows/deploy-crm-api.yml`

---

## Restart method (pick one on the server)

### A) PM2 (recommended if it works for your SSH user)

```powershell
npm install -g pm2
cd D:\crm-api.bmgenie.ai
pm2 start src/server.js --name bmg-crm-api
pm2 save
```

Run PM2 setup **as the same Windows user** that `DEPLOY_USER` uses for SSH.

### B) IIS app pool

If CRM runs under IIS, set a **system environment variable** on the server:

```text
CRM_APP_POOL_NAME = YourAppPoolName
```

The deploy script will `Restart-WebAppPool` instead of PM2.

---

## Test the pipeline

1. Push any commit to `Bmgenieai/BMG` `main`  
2. GitHub → **Actions** → **Deploy CRM API to Windows** → should turn green  
3. Check: https://crm-api.bmgenie.ai/api/health

### Manual trigger

Actions → **Deploy CRM API to Windows** → **Run workflow**

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| SSH connection failed | Check `DEPLOY_HOST`, port 22 open, OpenSSH running |
| `fatal: not a git repository` | Run git init + remote on server (see GIT-AND-PIPELINE.md) |
| `npm install` EPERM | Deploy script stops port 4050 first; ensure SSH user can taskkill |
| PM2 EPERM on `.pm2` | Use Administrator as `DEPLOY_USER`, or use IIS app pool restart |
| Health check fails | `pm2 logs bmg-crm-api` or check `.env` / port 4050 |

---

## Manual deploy (fallback)

```powershell
cd D:\crm-api.bmgenie.ai
git pull origin main
npm install
pm2 restart bmg-crm-api --update-env
```

Or run the script directly:

```powershell
cd D:\crm-api.bmgenie.ai
.\scripts\windows\deploy-crm-api.ps1
```
