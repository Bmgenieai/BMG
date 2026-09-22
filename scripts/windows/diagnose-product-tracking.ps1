# Diagnose product signup → CRM visibility (no secrets printed)
$ErrorActionPreference = 'Continue'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not (Test-Path (Join-Path $root '.env'))) {
  $root = (Get-Location).Path
}
Set-Location $root
Write-Host "CRM root: $root"

function Get-DotEnvValue([string]$key) {
  $path = Join-Path $root '.env'
  if (-not (Test-Path $path)) { return $null }
  foreach ($line in Get-Content $path) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $parts = $line.Split('=', 2)
    if ($parts[0].Trim() -eq $key) {
      return $parts[1].Trim().Trim('"').Trim("'")
    }
  }
  return $null
}

$ingestKey = Get-DotEnvValue 'CRM_INGEST_API_KEY'
$bmgenieUrl = Get-DotEnvValue 'BMGENIE_API_URL'
Write-Host ("CRM_INGEST_API_KEY set: " + (-not [string]::IsNullOrWhiteSpace($ingestKey)))
Write-Host ("BMGENIE_API_URL set: " + (-not [string]::IsNullOrWhiteSpace($bmgenieUrl)))
if ($bmgenieUrl) { Write-Host ("BMGENIE_API_URL: " + $bmgenieUrl) }

$today = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
Write-Host "UTC date: $today"

# Local SQLite counts (better-sqlite via node)
$nodeScript = @'
const Database = require('better-sqlite3');
const db = new Database('./data/crm.db', { readonly: true });
const today = new Date().toISOString().slice(0, 10);
const total = db.prepare('SELECT COUNT(*) AS c FROM leads').get().c;
const signup = db.prepare("SELECT COUNT(*) AS c FROM leads WHERE source='signup_no_listing'").get().c;
const signupToday = db.prepare(
  "SELECT COUNT(*) AS c FROM leads WHERE source='signup_no_listing' AND date(COALESCE(signed_up_at, created_at))=date(?)"
).get(today).c;
const recent = db.prepare(
  "SELECT email, source, status, created_at FROM leads WHERE source IN ('signup_no_listing','free_credit_no_purchase') ORDER BY created_at DESC LIMIT 8"
).all();
console.log(JSON.stringify({ total, signup, signupToday, today, recent }, null, 2));
'@
$tmp = Join-Path $env:TEMP 'crm-diag-leads.js'
Set-Content -Path $tmp -Value $nodeScript -Encoding UTF8
Write-Host '--- Local CRM leads ---'
node $tmp

# Live main analytics (if configured)
if ($bmgenieUrl -and $ingestKey) {
  $base = $bmgenieUrl.TrimEnd('/')
  $headers = @{ 'X-CRM-Ingest-Key' = $ingestKey; 'Accept' = 'application/json' }
  foreach ($path in @('/api/crm-analytics/daily-new-users', '/api/crm-analytics/daily-no-listings')) {
    $url = "$base$path`?date=$today"
    Write-Host "--- GET $url ---"
    try {
      $res = Invoke-RestMethod -Uri $url -Headers $headers -TimeoutSec 20
      Write-Host ("count=" + $res.count + " timezone=" + $res.timezone + " definition=" + $res.definition)
      if ($res.users) {
        $emails = @($res.users | ForEach-Object { $_.email }) -join ', '
        Write-Host ("emails: " + $emails)
      }
    } catch {
      Write-Host ("FAILED: " + $_.Exception.Message)
      if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
    }
  }
} else {
  Write-Host 'SKIP main analytics pull (BMGENIE_API_URL or key missing)'
}

# Test ingest round-trip with a unique diagnostic email
if ($ingestKey) {
  $diagEmail = "crm-diag-$(Get-Date -Format 'yyyyMMddHHmmss')@example.com"
  $body = @{
    event = 'user.signup'
    bmgenieUserId = "diag-$(Get-Date -Format 'yyyyMMddHHmmss')"
    name = 'CRM Diagnostic User'
    email = $diagEmail
    notes = 'Windows diagnose-product-tracking.ps1'
  } | ConvertTo-Json
  Write-Host "--- POST local ingest as $diagEmail ---"
  try {
    $ing = Invoke-RestMethod -Uri 'http://127.0.0.1:4050/api/ingest/product-leads' `
      -Method Post -ContentType 'application/json' `
      -Headers @{ 'X-CRM-Ingest-Key' = $ingestKey } `
      -Body $body -TimeoutSec 15
    Write-Host ("ingest ok action=" + $ing.action + " leadId=" + $ing.lead.id)
  } catch {
    Write-Host ("ingest FAILED: " + $_.Exception.Message)
    if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
  }
} else {
  Write-Host 'SKIP ingest test (key missing)'
}

Write-Host 'DIAG_DONE'
exit 0
