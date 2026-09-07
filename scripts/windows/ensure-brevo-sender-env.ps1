# TEMPORARY — one-shot Brevo sender bootstrap via CI/CD.
# Remove this file + its call in deploy-crm-api.ps1 after production send is verified.
# Sets BREVO_SENDER_EMAIL / BREVO_SENDER_NAME on the Windows .env (does NOT touch API key).
#Requires -Version 5.1
param(
    [Parameter(Mandatory = $true)]
    [string]$EnvFile,
    [string]$SenderEmail = 'magic.retouching@bmgenie.ai',
    [string]$SenderName = 'BMGenie Sales'
)

$ErrorActionPreference = 'Stop'

function Set-DotEnvValue {
    param(
        [string]$Path,
        [string]$Key,
        [string]$Value
    )

    if (-not (Test-Path $Path)) {
        throw ("Missing env file: " + $Path)
    }

    $lines = Get-Content -LiteralPath $Path -ErrorAction Stop
    $found = $false
    $out = foreach ($line in $lines) {
        if ($line -match ("^\s*" + [regex]::Escape($Key) + "\s*=")) {
            $found = $true
            ("{0}={1}" -f $Key, $Value)
        } else {
            $line
        }
    }

    if (-not $found) {
        $out += ''
        $out += '# Brevo sender (added by ensure-brevo-sender-env.ps1 — TEMPORARY)'
        $out += ("{0}={1}" -f $Key, $Value)
    }

    # UTF-8 without BOM — dotenv can break on a BOM from Set-Content -Encoding UTF8
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllLines((Resolve-Path $Path), [string[]]$out, $utf8NoBom)
}

Write-Host '==> TEMPORARY: ensuring Brevo sender env in .env'

Set-DotEnvValue -Path $EnvFile -Key 'BREVO_SENDER_EMAIL' -Value $SenderEmail.Trim()
Set-DotEnvValue -Path $EnvFile -Key 'BREVO_SENDER_NAME' -Value $SenderName.Trim()

Write-Host ("Brevo sender ready: {0} <{1}>" -f $SenderName, $SenderEmail)
