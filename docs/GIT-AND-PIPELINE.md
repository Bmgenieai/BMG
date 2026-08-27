# Connect git on Windows so CRM backend auto-deploys

Do this **after** `http://127.0.0.1:4050/api/health` works and `.env` exists.

The office zip had **no `.git`**. Pipeline needs the folder linked to GitHub **`Bmgenieai/BMG`**.

## One-time on `D:\bmg-crm` (remote or TeamViewer)

```powershell
cd D:\bmg-crm

# Keep .env and SQLite data — never delete them
git init
git remote add origin https://github.com/Bmgenieai/BMG.git
git fetch origin main
git checkout -B main origin/main

# If git complains about local files, prefer remote code but KEEP .env:
#   git reset --hard origin/main
#   (then confirm .env still exists; restore from ENV-FOR-WINDOWS.env if needed)

git status
# Should track origin/main. .env must remain untracked (in .gitignore).
```

Ensure `.gitignore` includes:

```
.env
.env.local
node_modules/
data/
*.db
```

## GitHub Actions secrets (`Bmgenieai/BMG`)

Repo → **Settings → Secrets and variables → Actions**

| Secret | Value |
|--------|--------|
| `DEPLOY_HOST` | Same as main BMGenie Windows SSH (or `202.59.75.242`) |
| `DEPLOY_USER` | Windows SSH user |
| `SERVER_PASSWORD` | Windows SSH password |
| `CRM_DEPLOY_PATH` | `D:\bmg-crm` (optional; workflow defaults to this) |

Use the **same** `DEPLOY_*` secrets as `Bmgenieai/backend` if it is the same PC.

## How deploys work after that

```text
Push to Bmgenieai/BMG  main
    → GitHub Action "Deploy CRM API to Windows"
    → SSH into PC
    → git pull in D:\bmg-crm
    → npm ci
    → pm2 restart bmg-crm-api
    → verify http://127.0.0.1:4050/api/health
```

Frontend is separate:

```text
Push to Bmgenieai/BMG-CRM  main  →  Vercel  →  crm.bmgenie.ai
```

## First test of pipeline

1. From your laptop: tiny change on `BMG` (e.g. README) → push as Bmgenieai author  
2. GitHub → **BMG** → **Actions** → workflow green  
3. On Windows: `pm2 status` still online; health still OK  

Office person does **not** need to redeploy after this.
