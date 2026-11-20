# CRM Watchdog - keeps CRM API (PM2) and public tunnel (cloudflared) alive.
# Runs every 2 minutes, at Windows startup, and on network reconnect via Scheduled Task BMG-CRM-Watchdog.
#Requires -Version 5.1

$ErrorActionPreference = 'Continue'
$Root = if ($PSScriptRoot) {
  (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
} else {
  'D:\crm-api.bmgenie.ai'
}

$sys32 = Join-Path $env:SystemRoot 'System32'
if ($env:Path -notlike "*${sys32}*") {
  $env:Path = "$sys32;$env:Path"
}
$npmBin = Join-Path $env:APPDATA 'npm'
if ($env:Path -notlike "*${npmBin}*") {
  $env:Path = "$npmBin;$env:Path"
}
$gitCmd = Join-Path $env:ProgramFiles 'Git\cmd'
if ((Test-Path $gitCmd) -and ($env:Path -notlike "*${gitCmd}*")) {
  $env:Path = "$gitCmd;$env:Path"
}

function Get-DotEnvValue([string]$key) {
  $envPath = Join-Path $Root '.env'
  if (-not (Test-Path $envPath)) { return $null }
  foreach ($line in Get-Content $envPath -ErrorAction SilentlyContinue) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $parts = $line.Split('=', 2)
    if ($parts[0].Trim() -eq $key) {
      return $parts[1].Trim().Trim('"').Trim("'")
    }
  }
  return $null
}

$port = if ($env:CRM_PORT) { $env:CRM_PORT } else { Get-DotEnvValue 'PORT' }
if ([string]::IsNullOrWhiteSpace($port)) { $port = '4050' }
$healthUrl = "http://127.0.0.1:$port/api/health"

$publicBase = Get-DotEnvValue 'PUBLIC_API_URL'
if ([string]::IsNullOrWhiteSpace($publicBase)) { $publicBase = 'https://crm-api.bmgenie.ai' }
$publicHealthUrl = ($publicBase.TrimEnd('/')) + '/api/health'

# Prefer project logs folder (easier to find than LOCALAPPDATA under Task Scheduler)
$logDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'crm-watchdog.log'
# Also mirror under LOCALAPPDATA when available
$altLogDir = Join-Path $env:LOCALAPPDATA 'BMG-CRM'
try { New-Item -ItemType Directory -Force -Path $altLogDir | Out-Null } catch {}
$altLogFile = Join-Path $altLogDir 'crm-watchdog.log'

# Rotate log if > 5 MB
foreach ($lf in @($logFile, $altLogFile)) {
  try {
    if ((Test-Path $lf) -and ((Get-Item $lf).Length -gt 5MB)) {
      Move-Item -Path $lf -Destination "$lf.1" -Force -ErrorAction SilentlyContinue
    }
  } catch {}
}

function Write-WatchLog([string]$msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
  Add-Content -Path $logFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
  Add-Content -Path $altLogFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
  Write-Host $line
}

function Test-HealthUrl([string]$url) {
  try {
    $res = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 10
    return [bool]$res.ok
  } catch {
    return $false
  }
}

function Wait-LocalHealthy([int]$attempts = 5) {
  for ($i = 1; $i -le $attempts; $i++) {
    if (Test-HealthUrl $healthUrl) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Stop-HungPortListener([int]$listenPort) {
  $pids = @()
  try {
    $conns = Get-NetTCPConnection -LocalPort $listenPort -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
      if ($c.OwningProcess -gt 0) { $pids += [int]$c.OwningProcess }
    }
  } catch {}
  $pids = $pids | Select-Object -Unique
  foreach ($procId in $pids) {
    Write-WatchLog "Stopping unresponsive listener on port $listenPort (PID $procId)"
    & taskkill.exe /PID $procId /F 2>$null | Out-Null
  }
  if ($pids.Count -gt 0) { Start-Sleep -Seconds 2 }
}

function Get-Pm2Cmd {
  $pm2Cmd = Join-Path $env:APPDATA 'npm\pm2.cmd'
  if (Test-Path $pm2Cmd) { return $pm2Cmd }
  $found = Get-Command pm2.cmd -ErrorAction SilentlyContinue
  if ($found) { return $found.Source }
  return $null
}

function Repair-CrmApi {
  $pm2 = Get-Pm2Cmd
  if (-not $pm2) {
    Write-WatchLog 'ERROR: pm2.cmd not found - cannot repair'
    return $false
  }

  Set-Location $Root
  Write-WatchLog "Repairing via PM2 ($pm2) in $Root"

  Stop-HungPortListener -listenPort ([int]$port)

  # If PM2 daemon was down (e.g. after reboot), resurrect saved processes first
  & $pm2 describe bmg-crm-api 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-WatchLog 'bmg-crm-api not in PM2 list - trying pm2 resurrect'
    & $pm2 resurrect 2>&1 | Out-String | ForEach-Object { if ($_.Trim()) { Write-WatchLog $_.Trim() } }
    Start-Sleep -Seconds 2
    if (Wait-LocalHealthy -attempts 3) {
      return $true
    }
  }

  & $pm2 describe bmg-crm-api 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) {
    & $pm2 restart bmg-crm-api --update-env 2>&1 | Out-String | ForEach-Object { if ($_.Trim()) { Write-WatchLog $_.Trim() } }
  } else {
    $serverJs = Join-Path $Root 'src\server.js'
    & $pm2 start $serverJs --name bmg-crm-api 2>&1 | Out-String | ForEach-Object { if ($_.Trim()) { Write-WatchLog $_.Trim() } }
  }

  & $pm2 save 2>$null | Out-Null
  return (Wait-LocalHealthy -attempts 6)
}

function Test-InternetUp {
  try {
    $null = [System.Net.Dns]::GetHostAddresses('cloudflare.com')
    return $true
  } catch {
    return $false
  }
}

function Repair-CloudflareTunnelIfNeeded {
  $cfServices = @(Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*cloudflared*' })
  if (-not $cfServices -or $cfServices.Count -eq 0) {
    return
  }

  $stopped = @($cfServices | Where-Object { $_.Status -ne 'Running' })
  if ($stopped.Count -gt 0) {
    foreach ($svc in $stopped) {
      Write-WatchLog "Cloudflare tunnel service '$($svc.Name)' is $($svc.Status) - starting"
      try {
        Start-Service -Name $svc.Name -ErrorAction Stop
      } catch {
        Write-WatchLog "Failed to start '$($svc.Name)': $_"
      }
    }
    Start-Sleep -Seconds 4
  }

  if (-not (Test-InternetUp)) {
    Write-WatchLog 'INFO: internet DNS unreachable - skipping public URL check'
    return
  }

  if (Test-HealthUrl $publicHealthUrl) {
    return
  }

  Write-WatchLog "WARN: local API is UP, internet is UP, but $publicHealthUrl failed - restarting cloudflared"
  foreach ($svc in $cfServices) {
    try {
      Restart-Service -Name $svc.Name -Force -ErrorAction Stop
      Write-WatchLog "Restarted service '$($svc.Name)'"
    } catch {
      Write-WatchLog "Failed to restart '$($svc.Name)': $_"
    }
  }
  Start-Sleep -Seconds 5
  if (Test-HealthUrl $publicHealthUrl) {
    Write-WatchLog "RECOVERED: $publicHealthUrl is reachable again"
  } else {
    Write-WatchLog "WARN: $publicHealthUrl still unreachable after cloudflared restart"
  }
}

function Sync-CrmFromOriginIfUpdated {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    return
  }
  if (-not (Test-InternetUp)) {
    return
  }

  $lockFile = Join-Path $Root '.deploy.lock'
  if (Test-Path $lockFile) {
    $ageMinutes = ((Get-Date) - (Get-Item $lockFile).LastWriteTime).TotalMinutes
    if ($ageMinutes -lt 10) {
      Write-WatchLog 'INFO: deploy lock active - skipping auto-pull'
      return
    }
    Remove-Item -Path $lockFile -Force -ErrorAction SilentlyContinue
  }

  Set-Location $Root
  & git fetch origin main 2>$null
  if ($LASTEXITCODE -ne 0) {
    return
  }

  $localSha = (& git rev-parse HEAD 2>$null | Out-String).Trim()
  $remoteSha = (& git rev-parse origin/main 2>$null | Out-String).Trim()
  if (-not $localSha -or -not $remoteSha -or ($localSha -eq $remoteSha)) {
    return
  }

  $failMarker = Join-Path $logDir 'last-auto-deploy-fail.txt'
  if (Test-Path $failMarker) {
    $raw = (Get-Content $failMarker -Raw -ErrorAction SilentlyContinue).Trim()
    $parts = $raw.Split('|', 2)
    if ($parts.Length -eq 2 -and $parts[0] -eq $remoteSha) {
      try {
        $prevFail = [datetime]::Parse($parts[1])
        if (((Get-Date) - $prevFail).TotalMinutes -lt 15) {
          Write-WatchLog "INFO: skipping retry of failed commit $remoteSha (cooldown)"
          return
        }
      } catch {}
    }
  }

  Write-WatchLog "UPDATE: origin/main moved $localSha -> $remoteSha - running auto-deploy"
  $deployScript = Join-Path $Root 'scripts\windows\deploy-crm-api.ps1'
  try {
    & $deployScript 2>&1 | Out-String | ForEach-Object { if ($_.Trim()) { Write-WatchLog $_.Trim() } }
    if ($LASTEXITCODE -ne 0) { throw "deploy-crm-api.ps1 exited $LASTEXITCODE" }
    if (Wait-LocalHealthy -attempts 8) {
      Remove-Item -Path $failMarker -Force -ErrorAction SilentlyContinue
      Write-WatchLog "AUTO-DEPLOYED: now running $remoteSha"
    } else {
      throw 'Health check failed after auto-deploy'
    }
  } catch {
    Set-Content -Path $failMarker -Value "$remoteSha|$((Get-Date).ToString('o'))" -Encoding ASCII -ErrorAction SilentlyContinue
    Write-WatchLog "AUTO-DEPLOY FAILED for $remoteSha : $_"
  }
}

Write-WatchLog "Watchdog check -> $healthUrl"

Sync-CrmFromOriginIfUpdated

$localOk = Test-HealthUrl $healthUrl
if (-not $localOk) {
  Write-WatchLog 'DOWN: local CRM API unhealthy - attempting restart'
  $localOk = Repair-CrmApi
  if ($localOk) {
    Write-WatchLog 'RECOVERED: local CRM API is healthy again'
  } else {
    Write-WatchLog 'FAILED: local CRM API still down after restart attempt'
    exit 1
  }
}

Repair-CloudflareTunnelIfNeeded
Write-WatchLog 'OK: CRM API healthy'
exit 0
