# Register BMG-CRM-Watchdog Scheduled Task (every 120 minutes).
# Run: Right-click PowerShell -> Run as administrator
#Requires -Version 5.1
#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'
$TaskName = 'BMG-CRM-Watchdog'

$sys32 = Join-Path $env:SystemRoot 'System32'
if ($env:Path -notlike "*${sys32}*") {
  $env:Path = "$sys32;$env:Path"
}

$Root = if ($PSScriptRoot) {
  (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
} else {
  'D:\crm-api.bmgenie.ai'
}

$watchdog = Join-Path $Root 'scripts\windows\crm-watchdog.ps1'
if (-not (Test-Path $watchdog)) {
  throw "Watchdog script not found: $watchdog. Run: git pull origin main"
}

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $psExe)) {
  throw "powershell.exe not found at $psExe"
}

$wrapperDir = Join-Path $env:LOCALAPPDATA 'BMG-CRM'
New-Item -ItemType Directory -Force -Path $wrapperDir | Out-Null
$wrapper = Join-Path $wrapperDir 'crm-watchdog.cmd'

# Use FULL paths - this machine often has a broken PATH (no System32)
$cmdLines = @(
  '@echo off'
  ('set PATH=%SystemRoot%\System32;%SystemRoot%;%SystemRoot%\System32\Wbem;%APPDATA%\npm;%ProgramFiles%\nodejs;%PATH%')
  ('"{0}" -NoProfile -ExecutionPolicy Bypass -File "{1}"' -f $psExe, $watchdog)
)
Set-Content -Path $wrapper -Value $cmdLines -Encoding ASCII

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Write-Host 'Enter the Windows password for THIS user (Task Scheduler).'
$cred = Get-Credential -UserName $env:USERNAME -Message 'Password for BMG CRM Watchdog task'
if (-not $cred) {
  throw 'Cancelled - no credential entered.'
}

$action = New-ScheduledTaskAction -Execute $wrapper
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 120) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

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
    -Description 'CRM Watchdog: every 120 min check health and pm2 restart if down' | Out-Null
} catch {
  $schtasks = Join-Path $env:SystemRoot 'System32\schtasks.exe'
  if (-not (Test-Path $schtasks)) {
    throw "Register-ScheduledTask failed: $_. Also missing $schtasks"
  }
  $user = $cred.UserName
  if ($user -notmatch '\\') { $user = "$env:USERDOMAIN\$user" }
  $pass = $cred.GetNetworkCredential().Password
  $tr = "`"$wrapper`""
  $out = & $schtasks /Create /TN $TaskName /TR $tr /SC MINUTE /MO 120 /RU $user /RP $pass /RL HIGHEST /F 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Both Register-ScheduledTask and schtasks failed. Last: $out / First: $_"
  }
}

# Smoke-test watchdog once now (same session - do not spawn nested powershell)
Write-Host 'Running watchdog once to verify...'
& $watchdog
if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
  Write-Warning "Watchdog exited with code $LASTEXITCODE - check logs"
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
Write-Host ("OK: '{0}' state={1} - every 120 minutes" -f $task.TaskName, $task.State)
Write-Host ("Log: {0}" -f (Join-Path $Root 'logs\crm-watchdog.log'))
Write-Host 'Start-ScheduledTask -TaskName BMG-CRM-Watchdog'
