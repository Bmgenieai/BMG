# Register BMG-CRM-Watchdog Scheduled Task (every 120 minutes).
# Run: Right-click PowerShell -> Run as administrator
#Requires -Version 5.1
#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'
$TaskName = 'BMG-CRM-Watchdog'

$Root = if ($PSScriptRoot) {
  (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
} else {
  'D:\crm-api.bmgenie.ai'
}

$watchdog = Join-Path $Root 'scripts\windows\crm-watchdog.ps1'
if (-not (Test-Path $watchdog)) {
  throw "Watchdog script not found: $watchdog. Run: git pull origin main"
}

$wrapperDir = Join-Path $env:LOCALAPPDATA 'BMG-CRM'
New-Item -ItemType Directory -Force -Path $wrapperDir | Out-Null
$wrapper = Join-Path $wrapperDir 'crm-watchdog.cmd'

$cmdLines = @(
  '@echo off'
  'set PATH=%APPDATA%\npm;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%SystemRoot%\System32;%PATH%'
  ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $watchdog)
)
Set-Content -Path $wrapper -Value $cmdLines -Encoding ASCII

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Write-Host 'Enter the Windows password for THIS user (Task Scheduler).'
$cred = Get-Credential -UserName $env:USERNAME -Message 'Password for BMG CRM Watchdog task'
if (-not $cred) {
  throw 'Cancelled - no credential entered.'
}

# schtasks /SC MINUTE /MO 120 = every 120 minutes, indefinite (avoids invalid MaxValue duration)
$user = $cred.UserName
if ($user -notmatch '\\') {
  $user = "$env:USERDOMAIN\$user"
}
$pass = $cred.GetNetworkCredential().Password
$tr = "`"$wrapper`""

$create = & schtasks.exe /Create /TN $TaskName /TR $tr /SC MINUTE /MO 120 /RU $user /RP $pass /RL HIGHEST /F
if ($LASTEXITCODE -ne 0) {
  throw "schtasks create failed (exit $LASTEXITCODE): $create"
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
Write-Host ("OK: '{0}' state={1} - every 120 minutes" -f $task.TaskName, $task.State)
Write-Host ("Script: {0}" -f $watchdog)
Write-Host ("Log:    {0}\BMG-CRM\crm-watchdog.log" -f $env:LOCALAPPDATA)
Write-Host ''
Write-Host 'Test once now:'
Write-Host '  Start-ScheduledTask -TaskName BMG-CRM-Watchdog'
Write-Host ("  Get-Content {0}\BMG-CRM\crm-watchdog.log -Tail 10" -f $env:LOCALAPPDATA)
