# Quick health check after CRM deploy (Windows)
$ErrorActionPreference = 'Stop'
$port = if ($env:CRM_PORT) { $env:CRM_PORT } else { '4050' }
$url = "http://127.0.0.1:$port/api/health"
Write-Host "Checking $url"
$res = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 15
if (-not $res.ok) { throw "Health failed: $($res | ConvertTo-Json -Compress)" }
Write-Host "Health OK: $($res | ConvertTo-Json -Compress)"
exit 0
