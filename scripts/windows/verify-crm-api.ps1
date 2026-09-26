# Quick health check after CRM deploy (Windows)
$ErrorActionPreference = 'Stop'
$sys32 = Join-Path $env:SystemRoot 'System32'
if ($env:Path -notlike "*${sys32}*") {
  $env:Path = "$sys32;$env:Path"
}
$port = if ($env:CRM_PORT) { $env:CRM_PORT } else { '4050' }
$url = "http://127.0.0.1:$port/api/health"
Write-Host "Checking $url"
$ok = $false
foreach ($i in 1..8) {
  try {
    $res = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 10
    if ($res.ok) {
      Write-Host "Health OK: $($res | ConvertTo-Json -Compress)"
      if ($res.deployMarker) {
        Write-Host "deployMarker: $($res.deployMarker)"
      }
      $ok = $true
      break
    }
  } catch {
    Write-Host "Attempt $i failed: $_"
    Start-Sleep -Seconds 2
  }
}
if (-not $ok) { throw "Health check failed for $url" }

# Temporary: Brevo delivery diagnose (safe to leave; prints status only)
$brevoDiag = Join-Path $PSScriptRoot 'diagnose-brevo.ps1'
if (Test-Path $brevoDiag) {
  Write-Host '==> Running Brevo delivery diagnose'
  & $brevoDiag
}

exit 0
