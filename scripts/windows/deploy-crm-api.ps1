# BMGenie CRM API — pull, install, restart PM2 (Windows)
# Run from repo root (e.g. D:\bmg-crm). .env is never deleted.

$ErrorActionPreference = 'Stop'
$Root = if ($PSScriptRoot) {
  Resolve-Path (Join-Path $PSScriptRoot '..\..')
} else {
  Get-Location
}
Set-Location $Root

Write-Host "==> CRM deploy in $Root"

if (-not (Test-Path .env)) {
  throw '.env missing — copy .env.example to .env once on the server'
}

git fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'git fetch failed' }
git reset --hard origin/main
if ($LASTEXITCODE -ne 0) { throw 'git reset --hard failed' }
git clean -fd -e .env -e .env.local -e node_modules -e data
git pull origin main
if ($LASTEXITCODE -ne 0) { throw 'git pull failed' }

if (Test-Path package-lock.json) {
  npm ci
} else {
  npm install
}
if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }

$pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
if (-not $pm2) {
  throw 'pm2 not found — run: npm install -g pm2'
}

$existing = pm2 jlist | ConvertFrom-Json | Where-Object { $_.name -eq 'bmg-crm-api' }
if ($existing) {
  pm2 restart bmg-crm-api --update-env
} else {
  pm2 start src/server.js --name bmg-crm-api
}
if ($LASTEXITCODE -ne 0) { throw 'pm2 restart/start failed' }
pm2 save

Write-Host 'CRM deploy OK'
exit 0
