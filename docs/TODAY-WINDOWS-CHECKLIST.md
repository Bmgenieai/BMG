# Today on the Windows PC — checklist

Goal: CRM API runs on **PM2**, comes back after reboot, and **GitHub Actions** deploys without Remote Desktop.

Folder: `D:\crm-api.bmgenie.ai`  
Repo: `Bmgenieai/BMG` (`main`)

---

## 1. Stop IIS from owning the Node app

IIS can stay as reverse proxy later, but Node must **not** be started by IIS anymore.

1. Open **IIS Manager** → find the CRM site / app pool that runs the API.
2. **Stop** that site (or remove the handler that launches `node`).
3. Confirm port **4050** is free:
   ```powershell
   Get-NetTCPConnection -LocalPort 4050 -State Listen -ErrorAction SilentlyContinue
   ```
   (no rows = free)

If Cloudflare Tunnel points straight at `localhost:4050`, you do not need IIS for CRM at all.

---

## 2. Switch to PM2 + auto-start on reboot

**PowerShell as Administrator**, same Windows user as GitHub `DEPLOY_USER`:

```powershell
cd D:\crm-api.bmgenie.ai
git pull origin main
.\scripts\windows\setup-pm2-crm-api.ps1
```

Verify:

```powershell
pm2 status
# bmg-crm-api = online
curl http://127.0.0.1:4050/api/health
```

Public check (from any machine):

```text
https://crm-api.bmgenie.ai/api/health
```

Must return JSON `"ok": true` (not Cloudflare 502/523).

**Reboot test (important):** restart the PC once, wait 1–2 minutes, re-check the public health URL. If it fails after reboot, re-run `setup-pm2-crm-api.ps1` as Admin and ensure that user auto-logs-on **or** convert PM2 to a Windows service.

---

## 3. Fix CI/CD so you never RDP for deploys

Pipeline already exists: **Actions → Deploy CRM API to Windows**.  
Latest failure was: SSH session could not find `netstat` (PATH). Deploy script is fixed to use full paths / `Get-NetTCPConnection`.

### On Windows (one-time)

```powershell
# OpenSSH must be Automatic
Get-Service sshd
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd

# Firewall: allow TCP 22 (or your SSH port)
```

Test from your laptop:

```bash
ssh DEPLOY_USER@WINDOWS_PUBLIC_IP
```

### On GitHub (`Bmgenieai/BMG` secrets)

| Secret | Must be set |
|--------|-------------|
| `DEPLOY_HOST` | Windows public IP / hostname |
| `DEPLOY_USER` | Same user that owns PM2 |
| `SERVER_PASSWORD` | That user’s password |
| `CRM_DEPLOY_PATH` | `D:\crm-api.bmgenie.ai` |

### Test pipeline

1. GitHub → **BMG** → **Actions** → **Deploy CRM API to Windows** → **Run workflow**
2. Wait for green + `ALL_OK`
3. Confirm `https://crm-api.bmgenie.ai/api/health`

After that, every push to **BMG `main`** deploys automatically.

---

## 4. Confirm login works

1. `https://crm-api.bmgenie.ai/api/health` → OK  
2. `https://crm.bmgenie.ai/login` → sign in  

If health is OK but login still “CORS / Failed to fetch”, check Windows `.env`:

```env
FRONTEND_URL=https://crm.bmgenie.ai
ALLOWED_ORIGINS=https://crm.bmgenie.ai,https://bmg-crm.vercel.app
```

Then: `pm2 restart bmg-crm-api --update-env`

---

## Done when

- [ ] Local `http://127.0.0.1:4050/api/health` OK under **PM2**
- [ ] Public `https://crm-api.bmgenie.ai/api/health` OK
- [ ] Survives **reboot** without manual start
- [ ] GitHub Actions deploy is **green**
- [ ] CRM login works
