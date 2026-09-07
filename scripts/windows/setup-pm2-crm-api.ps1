# One-time: run CRM API under PM2 + auto-start after Windows reboot.
# Run PowerShell as Administrator from D:\crm-api.bmgenie.ai
#Requires -Version 5.1

$ErrorActionPreference = 'Stop'
$Root = if ($PSScriptRoot) {
  Resolve-Path (Join-Path $PSScriptRoot '..\..')
} else {
  Get-Location
}
Set-Location $Root

$sys32 = Join-Path $env:SystemRoot 'System32'
if ($env:Path -notlike "*${sys32}*") {
  $env:Path = "$sys32;$env:Path"
}

Write-Host "==> CRM PM2 setup in $Root"

if (-not (Test-Path .env)) {
  throw '.env missing — copy .env.example to .env and fill secrets first'
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js not found. Install Node 20 LTS and reopen Admin PowerShell.'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw 'npm not found.'
}

Write-Host '==> Installing PM2 globally...'
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
  npm install -g pm2
}

Write-Host '==> Installing pm2-windows-startup (boot persistence)...'
if (-not (Get-Command pm2-startup -ErrorAction SilentlyContinue)) {
  npm install -g pm2-windows-startup
}

Write-Host '==> Ensuring dependencies...'
npm install

# Free port 4050 (IIS / old node)
try {
  Get-NetTCPConnection -LocalPort 4050 -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object {
      Write-Host "Stopping PID $($_.OwningProcess) on :4050"
      Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
    }
} catch {}

Write-Host '==> Starting bmg-crm-api on PM2...'
# delete may fail if process never existed — ignore that
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
pm2 delete bmg-crm-api 2>$null | Out-Null
$ErrorActionPreference = $prevEap

pm2 start src/server.js --name bmg-crm-api
if ($LASTEXITCODE -ne 0) { throw 'pm2 start failed' }

pm2 save
if ($LASTEXITCODE -ne 0) { throw 'pm2 save failed' }

Write-Host '==> Registering PM2 for Windows startup...'
try {
  pm2-startup install
  Write-Host 'pm2-startup registry entry OK (helps on user logon).'
} catch {
  Write-Warning "pm2-startup install failed: $_"
}

Write-Host '==> Registering boot Scheduled Task (survives power outage without login)...'
try {
  & (Join-Path $PSScriptRoot 'register-pm2-boot-task.ps1')
} catch {
  Write-Warning "Boot task registration failed: $_"
  Write-Warning 'Re-run as Admin: .\scripts\windows\register-pm2-boot-task.ps1'
}

Write-Host '==> Local health check...'
Start-Sleep -Seconds 2
$res = Invoke-RestMethod -Uri 'http://127.0.0.1:4050/api/health' -TimeoutSec 15
if (-not $res.ok) { throw "Health failed: $($res | ConvertTo-Json -Compress)" }
Write-Host "Health OK: $($res | ConvertTo-Json -Compress)"

Write-Host ''
Write-Host 'Done. Next:'
Write-Host '  1. Stop/disable IIS node hosting for CRM (keep reverse-proxy only if needed).'
Write-Host '  2. Ensure Cloudflare tunnel / DNS still points to this machine :4050.'
Write-Host '  3. Open https://crm-api.bmgenie.ai/api/health'
Write-Host '  4. GitHub → BMG → Actions → Deploy CRM API to Windows → Run workflow'
Write-Host ''
Write-Host 'Useful: pm2 status | pm2 logs bmg-crm-api | pm2 restart bmg-crm-api'
