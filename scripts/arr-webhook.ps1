<#
.SYNOPSIS
  The address for Sonarr and Radarr, so CineVault scans right after a download.

.DESCRIPTION
  Sonarr and Radarr can call an address after every download, upgrade, rename
  or deleted file ("Connect" -> "Webhook"). CineVault then scans that library
  at once, instead of at the next hourly scan.

  This script prints that address, with the WEBHOOK_TOKEN from .env in it
  (scripts\up.ps1 creates the token), and checks that CineVault answers it.
  The token can only start a scan; still, keep the address to yourself.

  Setting it up in Sonarr and in Radarr: docs/server-setup.md, step 24.

    powershell -ExecutionPolicy Bypass -File .\scripts\arr-webhook.ps1
#>
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not (Test-Path .env)) { throw '.env not found in the repo root (docs/server-setup.md, step 8)' }
$values = @{}
foreach ($line in Get-Content .env) {
  if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*?)\s*$') { $values[$Matches[1]] = $Matches[2] }
}
$token = "$($values['WEBHOOK_TOKEN'])"
if ($token.Length -lt 32) {
  throw 'WEBHOOK_TOKEN is missing in .env: run scripts\up.ps1 first, it creates one'
}
$port = if ("$($values['WEB_PORT'])" -match '^\d+$') { $values['WEB_PORT'] } else { '8765' }

$local = "http://127.0.0.1:$port/api/hooks/arr?token=$token"
$docker = "http://host.docker.internal:$port/api/hooks/arr?token=$token"

Write-Host ''
Write-Host 'Address for the Webhook in Sonarr and Radarr (Settings -> Connect -> + -> Webhook):'
Write-Host ''
Write-Host '  Sonarr/Radarr installed on this PC:' -ForegroundColor Cyan
Write-Host "    $local"
Write-Host '  Sonarr/Radarr in Docker on this PC:' -ForegroundColor Cyan
Write-Host "    $docker"
Write-Host ''
Write-Host 'Method: POST. Leave Username and Password empty.'
Write-Host 'Turn on: On Import (On Download), On Upgrade, On Rename, and the "Delete" events.'
Write-Host ''

try {
  $answer = Invoke-RestMethod -Method Post -Uri $local -ContentType 'application/json' `
    -Body '{"eventType":"Test"}' -TimeoutSec 10
  if ($answer.test) { Write-Host '  [OK] CineVault answers this address' -ForegroundColor Green }
  else { Write-Host "  [WARN] Unexpected answer: $($answer | ConvertTo-Json -Compress)" -ForegroundColor Yellow }
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  if ($code -eq 404) {
    Write-Host '  [FAIL] The API does not know WEBHOOK_TOKEN yet: run scripts\up.ps1' -ForegroundColor Red
  } elseif ($code -eq 401) {
    Write-Host '  [FAIL] The API has another WEBHOOK_TOKEN: run scripts\up.ps1 to restart it' -ForegroundColor Red
  } else {
    Write-Host "  [FAIL] No answer on port $port ($($_.Exception.Message)). Is CineVault running?" -ForegroundColor Red
  }
}
