# Brevo delivery diagnose — run on Windows CRM host (prints status, no secrets).
# Usage: .\scripts\windows\diagnose-brevo.ps1

$ErrorActionPreference = 'Continue'
$Root = if ($PSScriptRoot) {
  Resolve-Path (Join-Path $PSScriptRoot '..\..')
} else {
  Get-Location
}
Set-Location $Root
Write-Host "CRM root: $Root"

function Get-DotEnvValue([string]$key) {
  $envPath = Join-Path $Root '.env'
  if (-not (Test-Path $envPath)) { return $null }
  foreach ($line in Get-Content $envPath) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $parts = $line.Split('=', 2)
    if ($parts[0].Trim() -eq $key) {
      return $parts[1].Trim().Trim('"').Trim("'")
    }
  }
  return $null
}

$enabled = Get-DotEnvValue 'BREVO_ENABLED'
$apiKey = Get-DotEnvValue 'BREVO_API_KEY'
$sender = Get-DotEnvValue 'BREVO_SENDER_EMAIL'
$senderName = Get-DotEnvValue 'BREVO_SENDER_NAME'
$listId = Get-DotEnvValue 'BREVO_LIST_ID'

Write-Host ("BREVO_ENABLED=" + $enabled)
Write-Host ("BREVO_SENDER_EMAIL=" + $sender)
Write-Host ("BREVO_SENDER_NAME=" + $senderName)
Write-Host ("BREVO_LIST_ID=" + $listId)
Write-Host ("BREVO_API_KEY set: " + (-not [string]::IsNullOrWhiteSpace($apiKey)))
if ($apiKey) { Write-Host ("BREVO_API_KEY length: " + $apiKey.Length) }

if ([string]::IsNullOrWhiteSpace($apiKey)) {
  Write-Host 'ERROR: BREVO_API_KEY missing in .env'
  exit 1
}

$headers = @{
  'api-key' = $apiKey
  'accept' = 'application/json'
}

Write-Host '--- Account ---'
try {
  $acct = Invoke-RestMethod -Uri 'https://api.brevo.com/v3/account' -Headers $headers -TimeoutSec 30
  Write-Host ("email=" + $acct.email + " company=" + $acct.companyName)
  if ($acct.plan) { Write-Host ("plan=" + ($acct.plan | ConvertTo-Json -Compress)) }
} catch {
  Write-Host ("ACCOUNT FAILED: " + $_.Exception.Message)
  if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
}

Write-Host '--- Senders ---'
try {
  $senders = Invoke-RestMethod -Uri 'https://api.brevo.com/v3/senders' -Headers $headers -TimeoutSec 30
  foreach ($s in @($senders.senders)) {
    Write-Host ("sender id=$($s.id) email=$($s.email) name=$($s.name) active=$($s.active) verified=$($s.verified)")
  }
} catch {
  Write-Host ("SENDERS FAILED: " + $_.Exception.Message)
  if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
}

Write-Host '--- Domains ---'
try {
  $domains = Invoke-RestMethod -Uri 'https://api.brevo.com/v3/senders/domains' -Headers $headers -TimeoutSec 30
  Write-Host ($domains | ConvertTo-Json -Depth 6 -Compress)
} catch {
  Write-Host ("DOMAINS FAILED: " + $_.Exception.Message)
  if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
}

Write-Host '--- Recent transactional events (last ~50) ---'
try {
  $events = Invoke-RestMethod -Uri 'https://api.brevo.com/v3/smtp/statistics/events?limit=50&offset=0&sort=desc' -Headers $headers -TimeoutSec 30
  $rows = @($events.events)
  Write-Host ("event_count=" + $rows.Count)
  $byEvent = $rows | Group-Object event | Sort-Object Count -Descending
  foreach ($g in $byEvent) { Write-Host ("  $($g.Name)=$($g.Count)") }
  foreach ($e in $rows | Select-Object -First 40) {
    Write-Host ("evt=$($e.event) email=$($e.email) date=$($e.date) subject=$($e.subject) reason=$($e.reason) messageId=$($e.messageId)")
  }
} catch {
  Write-Host ("EVENTS FAILED: " + $_.Exception.Message)
  if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
}

Write-Host '--- Look up diagnostic messages ---'
foreach ($rawMid in @(
  '<202609261116.55664180455@smtp-relay.mailin.fr>',
  '<202609261120.20339665512@smtp-relay.mailin.fr>'
)) {
  try {
    $mid = [uri]::EscapeDataString($rawMid)
    $look = Invoke-RestMethod -Uri "https://api.brevo.com/v3/smtp/emails?messageId=$mid&limit=10" -Headers $headers -TimeoutSec 30
    Write-Host ("LOOKUP $rawMid => " + ($look | ConvertTo-Json -Depth 6 -Compress))
  } catch {
    Write-Host ("LOOKUP FAILED $rawMid : " + $_.Exception.Message)
    if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
  }
}

Write-Host '--- Events for jennyjiah5@gmail.com ---'
try {
  $jenny = Invoke-RestMethod -Uri 'https://api.brevo.com/v3/smtp/statistics/events?limit=20&offset=0&sort=desc&email=jennyjiah5@gmail.com' -Headers $headers -TimeoutSec 30
  foreach ($e in @($jenny.events)) {
    Write-Host ("jenny evt=$($e.event) date=$($e.date) subject=$($e.subject) reason=$($e.reason) messageId=$($e.messageId)")
  }
  if (-not $jenny.events -or @($jenny.events).Count -eq 0) { Write-Host 'jenny: no events returned' }
} catch {
  Write-Host ("JENNY EVENTS FAILED: " + $_.Exception.Message)
  if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
}

Write-Host '--- Bounce/blocked/error events (if any) ---'
foreach ($ev in @('hardBounces','softBounces','blocks','invalid','error','deferred','spam')) {
  try {
    $uri = "https://api.brevo.com/v3/smtp/statistics/events?limit=10&offset=0&sort=desc&event=$ev"
    $rows = @( (Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 30).events )
    Write-Host ("event=$ev count=$($rows.Count)")
    foreach ($e in $rows | Select-Object -First 5) {
      Write-Host ("  email=$($e.email) date=$($e.date) subject=$($e.subject) reason=$($e.reason)")
    }
  } catch {
    Write-Host ("event=$ev FAILED: " + $_.Exception.Message)
  }
}

Write-Host '--- CRM email_sent counts (SQLite) ---'
$js = @'
const Database = require('better-sqlite3');
const db = new Database('./data/crm.db', { readonly: true });
const byDay = db.prepare(`
  SELECT date(created_at) AS d, COUNT(*) AS c
  FROM lead_activities
  WHERE type = 'email_sent'
  GROUP BY date(created_at)
  ORDER BY d DESC LIMIT 14
`).all();
const recent = db.prepare(`
  SELECT a.created_at, a.summary, u.name AS user_name, l.email AS lead_email, l.name AS lead_name
  FROM lead_activities a
  LEFT JOIN users u ON u.id = a.user_id
  LEFT JOIN leads l ON l.id = a.lead_id
  WHERE a.type = 'email_sent'
  ORDER BY a.created_at DESC LIMIT 25
`).all();
let scheduled = [];
try {
  scheduled = db.prepare('SELECT status, COUNT(*) AS c FROM scheduled_emails GROUP BY status').all();
} catch (_) {}
console.log(JSON.stringify({ byDay, recent, scheduled }, null, 2));
'@
Set-Content -Path .\diag-brevo-tmp.cjs -Value $js -Encoding UTF8
node .\diag-brevo-tmp.cjs
Remove-Item .\diag-brevo-tmp.cjs -Force -ErrorAction SilentlyContinue

Write-Host 'BREVO_DIAG_DONE'
exit 0
