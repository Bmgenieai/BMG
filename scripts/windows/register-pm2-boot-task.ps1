# Register a Windows Scheduled Task that resurrects PM2 after reboot
# even if nobody is at the login screen (electricity / internet recovery).
# Run as Administrator once (same user as DEPLOY_USER / wasim).
#Requires -Version 5.1

$ErrorActionPreference = 'Stop'
$TaskName = 'BMG-CRM-PM2-Resurrect'

$npmPm2 = Join-Path $env:APPDATA 'npm\pm2.cmd'
if (-not (Test-Path $npmPm2)) {
  $found = Get-Command pm2.cmd -ErrorAction SilentlyContinue
  if ($found) { $npmPm2 = $found.Source }
}
if (-not $npmPm2 -or -not (Test-Path $npmPm2)) {
  throw 'pm2.cmd not found. Start CRM with PM2 first, then re-run this script.'
}

$wrapperDir = Join-Path $env:LOCALAPPDATA 'BMG-CRM'
New-Item -ItemType Directory -Force -Path $wrapperDir | Out-Null
$wrapper = Join-Path $wrapperDir 'pm2-resurrect.cmd'
@"
@echo off
set PATH=%APPDATA%\npm;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%PATH%
call "$npmPm2" resurrect
"@ | Set-Content -Path $wrapper -Encoding ASCII

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute $wrapper
$trigger = New-ScheduledTaskTrigger -AtStartup
# Delay 1 minute so disks / Cloudflare tunnel can come up
$trigger.Delay = 'PT1M'

Write-Host 'Enter the Windows password for THIS user (stored only in Task Scheduler).'
Write-Host 'Needed so PM2 can start after reboot without anyone logging in.'
$cred = Get-Credential -UserName $env:USERNAME -Message 'Password for BMG CRM PM2 boot task'

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -User $cred.UserName `
  -Password $cred.GetNetworkCredential().Password `
  -RunLevel Highest `
  -Settings $settings | Out-Null

Write-Host "OK: Scheduled task '$TaskName' will run 'pm2 resurrect' 1 min after every boot."
Write-Host "Check: Get-ScheduledTask -TaskName $TaskName | Format-List TaskName,State"
Write-Host ''
Write-Host 'Also ensure Cloudflare tunnel service is Automatic:'
Write-Host '  Get-Service *cloud* | Format-Table Name,Status,StartType'
Write-Host '  (Set-Service cloudflared -StartupType Automatic; Start-Service cloudflared)'
