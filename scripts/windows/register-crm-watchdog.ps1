# Register "BMG-CRM-Watchdog" Scheduled Task — runs every 120 minutes.
# MUST: Right-click PowerShell → Run as administrator
#Requires -Version 5.1
#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'
$TaskName = 'BMG-CRM-Watchdog'

$Root = if ($PSScriptRoot) {
  Resolve-Path (Join-Path $PSScriptRoot '..\..')
} else {
  'D:\crm-api.bmgenie.ai'
}

$watchdog = Join-Path $Root 'scripts\windows\crm-watchdog.ps1'
if (-not (Test-Path $watchdog)) {
  throw "Watchdog script not found: $watchdog — git pull origin main first"
}

$wrapperDir = Join-Path $env:LOCALAPPDATA 'BMG-CRM'
New-Item -ItemType Directory -Force -Path $wrapperDir | Out-Null
$wrapper = Join-Path $wrapperDir 'crm-watchdog.cmd'
@"
@echo off
set PATH=%APPDATA%\npm;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%SystemRoot%\System32;%PATH%
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$watchdog"
"@ | Set-Content -Path $wrapper -Encoding ASCII

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute $wrapper
# Every 120 minutes, starting now
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 120) -RepetitionDuration ([TimeSpan]::MaxValue)

Write-Host 'Enter the Windows password for THIS user (Task Scheduler).'
$cred = Get-Credential -UserName $env:USERNAME -Message 'Password for BMG CRM Watchdog task'
if (-not $cred) { throw 'Cancelled — no credential entered.' }

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
  -MultipleInstances IgnoreNew

try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -User $cred.UserName `
    -Password $cred.GetNetworkCredential().Password `
    -RunLevel Highest `
    -Settings $settings `
    -Description 'CRM Watchdog: every 120 min check localhost:4050/api/health and pm2 restart if down' | Out-Null
} catch {
  throw "Register-ScheduledTask failed: $_. Use 'Run as administrator'."
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
Write-Host "OK: '$($task.TaskName)' state=$($task.State) — every 120 minutes"
Write-Host "Script: $watchdog"
Write-Host "Log:    $env:LOCALAPPDATA\BMG-CRM\crm-watchdog.log"
Write-Host ''
Write-Host 'Test once now:'
Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$watchdog`""
Write-Host 'Or: Start-ScheduledTask -TaskName BMG-CRM-Watchdog'
