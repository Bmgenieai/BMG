# BMGenie CRM API — pull, install, restart (Windows)
# Run from repo root (e.g. D:\crm-api.bmgenie.ai). .env and data/ are never deleted.

$ErrorActionPreference = 'Stop'
$Root = if ($PSScriptRoot) {
  Resolve-Path (Join-Path $PSScriptRoot '..\..')
} else {
  Get-Location
}
Set-Location $Root

# SSH sessions often lack System32 on PATH — fix before any native tools
$sys32 = Join-Path $env:SystemRoot 'System32'
if ($env:Path -notlike "*${sys32}*") {
  $env:Path = "$sys32;$env:Path"
}

Write-Host "==> CRM deploy in $Root"

if (-not (Test-Path .env)) {
  throw '.env missing — copy .env.example to .env once on the server'
}

# Upsert KEY=VALUE in .env (preserves other lines). Empty value = no-op.
function Set-DotEnvValue {
  param(
    [Parameter(Mandatory = $true)][string]$Key,
    [AllowEmptyString()][string]$Value
  )
  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace($Value)) { return }
  $envFile = Join-Path $Root '.env'
  $lines = @(Get-Content -Path $envFile -ErrorAction Stop)
  $pattern = '^\s*' + [regex]::Escape($Key) + '\s*='
  $found = $false
  $out = foreach ($line in $lines) {
    if ($line -match $pattern) {
      $found = $true
      "$Key=$Value"
    } else {
      $line
    }
  }
  if (-not $found) {
    $out += "$Key=$Value"
  }
  Set-Content -Path $envFile -Value $out -Encoding UTF8
  Write-Host "Upserted .env $Key"
}

# Main BMGenie API — required for Product analytics + live support-chat replies.
# Pipeline may inject BMGENIE_API_URL / CRM_INGEST_API_KEY (GitHub secrets).
# If BMGENIE_API_URL is unset, default production URL so Windows always can reach main API.
$bmgenieApiUrl = $env:BMGENIE_API_URL
if ([string]::IsNullOrWhiteSpace($bmgenieApiUrl)) {
  $bmgenieApiUrl = 'https://api.bmgenie.ai'
}
Set-DotEnvValue -Key 'BMGENIE_API_URL' -Value $bmgenieApiUrl.Trim()

if (-not [string]::IsNullOrWhiteSpace($env:CRM_INGEST_API_KEY)) {
  Set-DotEnvValue -Key 'CRM_INGEST_API_KEY' -Value $env:CRM_INGEST_API_KEY.Trim()
}

# Optional: pipeline injects mailbox sync (GitHub Actions secrets → env vars on the SSH session)
if (-not [string]::IsNullOrWhiteSpace($env:SENDER_MAILBOX_SYNC)) {
  Set-DotEnvValue -Key 'SENDER_MAILBOX_SYNC' -Value $env:SENDER_MAILBOX_SYNC.Trim()
}
if (-not [string]::IsNullOrWhiteSpace($env:SENDER_MAILBOX_IMAP_HOST)) {
  Set-DotEnvValue -Key 'SENDER_MAILBOX_IMAP_HOST' -Value $env:SENDER_MAILBOX_IMAP_HOST.Trim()
}
if (-not [string]::IsNullOrWhiteSpace($env:SENDER_MAILBOX_IMAP_PORT)) {
  Set-DotEnvValue -Key 'SENDER_MAILBOX_IMAP_PORT' -Value $env:SENDER_MAILBOX_IMAP_PORT.Trim()
}
if (-not [string]::IsNullOrWhiteSpace($env:SENDER_MAILBOX_USER)) {
  Set-DotEnvValue -Key 'SENDER_MAILBOX_USER' -Value $env:SENDER_MAILBOX_USER.Trim()
}
if (-not [string]::IsNullOrWhiteSpace($env:SENDER_MAILBOX_PASS)) {
  Set-DotEnvValue -Key 'SENDER_MAILBOX_PASS' -Value $env:SENDER_MAILBOX_PASS.Trim()
}
if (-not [string]::IsNullOrWhiteSpace($env:SENDER_MAILBOX_SYNC_MS)) {
  Set-DotEnvValue -Key 'SENDER_MAILBOX_SYNC_MS' -Value $env:SENDER_MAILBOX_SYNC_MS.Trim()
}
if (-not [string]::IsNullOrWhiteSpace($env:SENDER_MAILBOX_LOOKBACK_DAYS)) {
  Set-DotEnvValue -Key 'SENDER_MAILBOX_LOOKBACK_DAYS' -Value $env:SENDER_MAILBOX_LOOKBACK_DAYS.Trim()
}

function Stop-PortListener {
  param([int]$Port = 4050)

  $pids = @()

  # Prefer PowerShell cmdlet (works over SSH without netstat PATH issues)
  try {
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
      if ($c.OwningProcess -gt 0) { $pids += [int]$c.OwningProcess }
    }
  } catch {
    Write-Host "Get-NetTCPConnection unavailable: $_"
  }

  if (-not $pids) {
    $netstat = Join-Path $env:SystemRoot 'System32\netstat.exe'
    if (Test-Path $netstat) {
      $lines = & $netstat -ano 2>$null | Select-String ":$Port" | Select-String 'LISTENING'
      foreach ($line in $lines) {
        if ($line -match '\s(\d+)\s*$') {
          $procId = [int]$Matches[1]
          if ($procId -gt 0) { $pids += $procId }
        }
      }
    } else {
      Write-Host 'netstat.exe not found — will rely on PM2 restart only'
    }
  }

  $pids = $pids | Select-Object -Unique
  foreach ($procId in $pids) {
    Write-Host "Stopping process on port $Port (PID $procId)"
    & taskkill.exe /PID $procId /F 2>$null | Out-Null
  }
  if ($pids.Count -gt 0) { Start-Sleep -Seconds 2 }
}

function Restart-CrmApi {
  # Prefer pm2.cmd so PowerShell doesn't wrap stderr as terminating errors
  $pm2Exe = $null
  $pm2Cmd = Join-Path $env:APPDATA 'npm\pm2.cmd'
  if (Test-Path $pm2Cmd) {
    $pm2Exe = $pm2Cmd
  } elseif (Get-Command pm2.cmd -ErrorAction SilentlyContinue) {
    $pm2Exe = (Get-Command pm2.cmd).Source
  } elseif (Get-Command pm2 -ErrorAction SilentlyContinue) {
    $pm2Exe = (Get-Command pm2).Source
  }

  if ($pm2Exe) {
    Write-Host "Using PM2 at $pm2Exe"
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'

    # Avoid `pm2 jlist | ConvertFrom-Json` — PM2 JSON has duplicate username/USERNAME keys on Windows
    & $pm2Exe restart bmg-crm-api --update-env 2>&1 | Out-Host
    if ($LASTEXITCODE -eq 0) {
      & $pm2Exe save 2>&1 | Out-Null
      $ErrorActionPreference = $prevEap
      Write-Host 'Restarted via PM2'
      return
    }

    & $pm2Exe start src/server.js --name bmg-crm-api 2>&1 | Out-Host
    if ($LASTEXITCODE -eq 0) {
      & $pm2Exe save 2>&1 | Out-Null
      $ErrorActionPreference = $prevEap
      Write-Host 'Started via PM2'
      return
    }

    $ErrorActionPreference = $prevEap
    throw "PM2 restart/start failed (exit $LASTEXITCODE)"
  }

  $pool = $env:CRM_APP_POOL_NAME
  if ($pool) {
    Import-Module WebAdministration -ErrorAction Stop
    Restart-WebAppPool -Name $pool
    Write-Host "Restarted IIS app pool: $pool"
    return
  }

  throw 'PM2 not available and CRM_APP_POOL_NAME not set — install PM2 (see scripts/windows/setup-pm2-crm-api.ps1)'
}

Stop-PortListener -Port 4050

# Repo may already be at origin/main (workflow pulls before invoking this script).
# Still sync here for manual runs.
git fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'git fetch failed' }
git reset --hard origin/main
if ($LASTEXITCODE -ne 0) { throw 'git reset --hard failed' }
git clean -fd -e .env -e .env.local -e node_modules -e data -e web.config

# npm install is more reliable on Windows when native modules are locked (better-sqlite3)
npm install
if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }

Restart-CrmApi

Write-Host 'CRM deploy OK'
exit 0
