# BMGenie CRM API — pull, install, restart (Windows)
# Run from repo root (e.g. D:\crm-api.bmgenie.ai). .env and data/ are never deleted.

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

function Stop-PortListener {
  param([int]$Port = 4050)
  $lines = netstat -ano | Select-String ":$Port" | Select-String 'LISTENING'
  foreach ($line in $lines) {
    if ($line -match '\s(\d+)\s*$') {
      $pid = [int]$Matches[1]
      if ($pid -gt 0) {
        Write-Host "Stopping process on port $Port (PID $pid)"
        taskkill /PID $pid /F 2>$null | Out-Null
      }
    }
  }
  Start-Sleep -Seconds 2
}

function Restart-CrmApi {
  $pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
  if ($pm2) {
    try {
      $existing = pm2 jlist 2>$null | ConvertFrom-Json | Where-Object { $_.name -eq 'bmg-crm-api' }
      if ($existing) {
        pm2 restart bmg-crm-api --update-env
        if ($LASTEXITCODE -eq 0) {
          pm2 save 2>$null | Out-Null
          Write-Host 'Restarted via PM2'
          return
        }
      } else {
        pm2 start src/server.js --name bmg-crm-api
        if ($LASTEXITCODE -eq 0) {
          pm2 save 2>$null | Out-Null
          Write-Host 'Started via PM2'
          return
        }
      }
    } catch {
      Write-Host "PM2 restart skipped: $_"
    }
  }

  $pool = $env:CRM_APP_POOL_NAME
  if ($pool) {
    Import-Module WebAdministration -ErrorAction Stop
    Restart-WebAppPool -Name $pool
    Write-Host "Restarted IIS app pool: $pool"
    return
  }

  Write-Host 'Starting node directly (no PM2 / no CRM_APP_POOL_NAME)'
  Start-Process -FilePath 'node' -ArgumentList 'src/server.js' -WorkingDirectory $Root -WindowStyle Hidden
}

Stop-PortListener -Port 4050

git fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'git fetch failed' }
git reset --hard origin/main
if ($LASTEXITCODE -ne 0) { throw 'git reset --hard failed' }
git clean -fd -e .env -e .env.local -e node_modules -e data -e web.config
git pull origin main
if ($LASTEXITCODE -ne 0) { throw 'git pull failed' }

# npm install is more reliable on Windows when native modules are locked (better-sqlite3)
npm install
if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }

Restart-CrmApi

Write-Host 'CRM deploy OK'
exit 0
