# PII-safe & secret-safe Brevo + CRM email diagnostic for CI deploy logs.
$ErrorActionPreference = 'Continue'
$Root = if ($PSScriptRoot) {
  Resolve-Path (Join-Path $PSScriptRoot '..\..')
} else {
  Get-Location
}
Set-Location $Root
Write-Host "=== Brevo & CRM Email Diagnostics (CI-safe) ==="

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
$replyDomain = Get-DotEnvValue 'BREVO_REPLY_DOMAIN'
$webhookSecret = Get-DotEnvValue 'BREVO_WEBHOOK_SECRET'
$mboxSync = Get-DotEnvValue 'SENDER_MAILBOX_SYNC'
$mboxHost = Get-DotEnvValue 'SENDER_MAILBOX_IMAP_HOST'
$mboxUser = Get-DotEnvValue 'SENDER_MAILBOX_USER'
$mboxPass = Get-DotEnvValue 'SENDER_MAILBOX_PASS'

Write-Host ("BREVO_ENABLED=$enabled")
Write-Host ("BREVO_SENDER_EMAIL=$sender")
Write-Host ("BREVO_SENDER_NAME=$senderName")
Write-Host ("BREVO_LIST_ID=$listId")
Write-Host ("BREVO_REPLY_DOMAIN=$replyDomain")
Write-Host ("BREVO_API_KEY_SET=" + (-not [string]::IsNullOrWhiteSpace($apiKey)))
Write-Host ("BREVO_WEBHOOK_SECRET_SET=" + (-not [string]::IsNullOrWhiteSpace($webhookSecret)))
Write-Host ("SENDER_MAILBOX_SYNC=$mboxSync host=$mboxHost user=$mboxUser pass_set=" + (-not [string]::IsNullOrWhiteSpace($mboxPass)))

if (-not [string]::IsNullOrWhiteSpace($apiKey)) {
  $headers = @{
    'api-key' = $apiKey
    'accept' = 'application/json'
  }

  Write-Host '--- Brevo Account ---'
  try {
    $acct = Invoke-RestMethod -Uri 'https://api.brevo.com/v3/account' -Headers $headers -TimeoutSec 25
    Write-Host ("company=" + $acct.companyName)
    if ($acct.plan) { Write-Host ("plan=" + ($acct.plan | ConvertTo-Json -Compress)) }
    if ($acct.relay) { Write-Host ("relay=" + ($acct.relay | ConvertTo-Json -Compress)) }
  } catch {
    Write-Host ("ACCOUNT FAILED: " + $_.Exception.Message)
    if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
  }

  Write-Host '--- Brevo Senders ---'
  try {
    $senders = Invoke-RestMethod -Uri 'https://api.brevo.com/v3/senders' -Headers $headers -TimeoutSec 25
    foreach ($s in @($senders.senders)) {
      Write-Host ("sender id=$($s.id) email=$($s.email) name=$($s.name) active=$($s.active) verified=$($s.verified)")
    }
  } catch {
    Write-Host ("SENDERS FAILED: " + $_.Exception.Message)
    if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
  }

  Write-Host '--- Brevo Domains ---'
  try {
    $domains = Invoke-RestMethod -Uri 'https://api.brevo.com/v3/senders/domains' -Headers $headers -TimeoutSec 25
    Write-Host ($domains | ConvertTo-Json -Depth 6 -Compress)
  } catch {
    Write-Host ("DOMAINS FAILED: " + $_.Exception.Message)
    if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
  }

  Write-Host '--- Brevo Recent 100 Events (aggregate) ---'
  try {
    $events = Invoke-RestMethod -Uri 'https://api.brevo.com/v3/smtp/statistics/events?limit=100&offset=0&sort=desc' -Headers $headers -TimeoutSec 25
    $rows = @($events.events)
    Write-Host ("event_count=" + $rows.Count)
    if ($rows.Count -gt 0) {
      Write-Host ("latest_date=" + $rows[0].date + " oldest_date=" + $rows[$rows.Count - 1].date)
    }
    $byEvent = $rows | Group-Object event | Sort-Object Count -Descending
    foreach ($g in $byEvent) { Write-Host ("  $($g.Name)=$($g.Count)") }
  } catch {
    Write-Host ("EVENTS FAILED: " + $_.Exception.Message)
    if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
  }

  Write-Host '--- Brevo Bounce/Blocked/Error Summary (masked recipients) ---'
  foreach ($ev in @('hardBounces','softBounces','blocks','invalid','error','deferred','spam')) {
    try {
      $uri = "https://api.brevo.com/v3/smtp/statistics/events?limit=10&offset=0&sort=desc&event=$ev"
      $rows = @( (Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 25).events )
      Write-Host ("event=$ev count=$($rows.Count)")
      foreach ($e in $rows | Select-Object -First 5) {
        $dom = if ($e.email -and $e.email -match '@(.+)$') { $Matches[1] } else { 'unknown' }
        Write-Host ("  domain=@$dom date=$($e.date) reason=$($e.reason)")
      }
    } catch {
      Write-Host ("event=$ev FAILED: " + $_.Exception.Message)
    }
  }
} else {
  Write-Host 'BREVO_API_KEY missing in .env; skipping Brevo API calls'
}

Write-Host '--- CRM SQLite Email Summary (no PII) ---'
$js = @'
const Database = require('better-sqlite3');
const db = new Database('./data/crm.db', { readonly: true });

const accounts = db.prepare(`
  SELECT id, label, email, name, is_active, is_default, verified,
         imap_enabled, imap_host, imap_port, imap_user
  FROM email_accounts
  ORDER BY is_default DESC, created_at ASC
`).all();

const msgStatus = db.prepare(`
  SELECT status, email_account_id, COUNT(*) AS c
  FROM email_messages
  GROUP BY status, email_account_id
  ORDER BY c DESC
`).all();

const msgByDay = db.prepare(`
  SELECT date(created_at) AS d, COUNT(*) AS c
  FROM email_messages
  GROUP BY date(created_at)
  ORDER BY d DESC LIMIT 10
`).all();

const evtCounts = db.prepare(`
  SELECT event, COUNT(*) AS c
  FROM email_events
  GROUP BY event
  ORDER BY c DESC
`).all();

let scheduledStatus = [];
let scheduledErrors = [];
try {
  scheduledStatus = db.prepare('SELECT status, COUNT(*) AS c FROM scheduled_emails GROUP BY status').all();
  scheduledErrors = db.prepare(`
    SELECT error, COUNT(*) AS c
    FROM scheduled_emails
    WHERE status = 'failed'
    GROUP BY error
    ORDER BY c DESC LIMIT 10
  `).all();
} catch (_) {}

let campaigns = [];
try {
  campaigns = db.prepare('SELECT status, COUNT(*) AS c FROM email_campaigns GROUP BY status').all();
} catch (_) {}

let replies = null;
try {
  replies = db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread FROM email_replies').get();
} catch (_) {}

console.log(JSON.stringify({
  accounts,
  msgStatus,
  msgByDay,
  evtCounts,
  scheduledStatus,
  scheduledErrors,
  campaigns,
  replies,
}, null, 2));
'@
Set-Content -Path .\diag-brevo-ci-tmp.cjs -Value $js -Encoding UTF8
node .\diag-brevo-ci-tmp.cjs
Remove-Item .\diag-brevo-ci-tmp.cjs -Force -ErrorAction SilentlyContinue
Write-Host '=== END Brevo & CRM Email Diagnostics ==='
exit 0
