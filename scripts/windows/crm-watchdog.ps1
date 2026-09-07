# CRM Watchdog — if CRM API is down, bring it back via PM2.
# Intended to run every 120 minutes via Scheduled Task "BMG-CRM-Watchdog".
#Requires -Version 5.1

$ErrorActionPreference = 'Continue'
$Root = if ($PSScriptRoot) {
  Resolve-Path (Join-Path $PSScriptRoot '..\..')
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

$port = if ($env:CRM_PORT) { $env:CRM_PORT } else { '4050' }
$healthUrl = "http://127.0.0.1:$port/api/health"
$logDir = Join-Path $env:LOCALAPPDATA 'BMG-CRM'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'crm-watchdog.log'

function Write-WatchLog([string]$msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  Write-Host $line
}

function Test-CrmHealthy {
  try {
    $res = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 10
    return [bool]$res.ok
  } catch {
    return $false
  }
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
    Write-WatchLog 'ERROR: pm2.cmd not found — cannot repair'
    return $false
  }

  Set-Location $Root
  Write-WatchLog "Repairing via PM2 ($pm2) in $Root"

  & $pm2 describe bmg-crm-api 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) {
    & $pm2 restart bmg-crm-api --update-env 2>&1 | Out-String | ForEach-Object { Write-WatchLog $_ }
  } else {
    & $pm2 start (Join-Path $Root 'src\server.js') --name bmg-crm-api 2>&1 | Out-String | ForEach-Object { Write-WatchLog $_ }
  }

  & $pm2 save 2>$null | Out-Null
  Start-Sleep -Seconds 3
  return (Test-CrmHealthy)
}

Write-WatchLog "Watchdog check → $healthUrl"

if (Test-CrmHealthy) {
  Write-WatchLog 'OK: CRM API healthy — no action'
  exit 0
}

Write-WatchLog 'DOWN: CRM API unhealthy — attempting restart'
if (Repair-CrmApi) {
  Write-WatchLog 'RECOVERED: CRM API is healthy again'
  exit 0
}

Write-WatchLog 'FAILED: CRM API still down after restart attempt'
exit 1
