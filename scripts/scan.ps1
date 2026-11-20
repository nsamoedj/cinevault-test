<#
.SYNOPSIS
  Scans the CineVault libraries and shows progress and unmatched titles.

.DESCRIPTION
  Run from the repo, with the containers up (scripts\up.ps1):
    powershell -ExecutionPolicy Bypass -File .\scripts\scan.ps1
    powershell -ExecutionPolicy Bypass -File .\scripts\scan.ps1 -Library Movies
    powershell -ExecutionPolicy Bypass -File .\scripts\scan.ps1 -Refresh

  -Library   scan one library by name (default: all)
  -Refresh   fetch metadata again for every title (matched titles by their known id)
  -ListOnly  don't scan, only list unmatched/failed titles
#>
param(
  [string]$Library,
  [switch]$Refresh,
  [switch]$ListOnly
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

$port = 3000
$envLine = Get-Content .env -ErrorAction SilentlyContinue |
  Where-Object { $_ -match '^\s*API_PORT\s*=\s*(\d+)' } | Select-Object -First 1
if ($envLine -match '(\d+)\s*$') { $port = [int]$Matches[1] }
$api = "http://localhost:$port/api"

# The API needs a login; scripts use API_TOKEN from .env (scripts\up.ps1 makes it).
$tokenLine = Get-Content .env -ErrorAction SilentlyContinue |
  Where-Object { $_ -match '^\s*API_TOKEN\s*=' } | Select-Object -Last 1
$token = "$tokenLine" -replace '^\s*API_TOKEN\s*=\s*', ''
if (-not $token.Trim()) { throw 'API_TOKEN is empty in .env. Run scripts\up.ps1 once; it creates one.' }
$PSDefaultParameterValues['Invoke-RestMethod:Headers'] = @{ Authorization = "Bearer $($token.Trim())" }

# Invoke-RestMethod returns a JSON array as one object; unroll it into items.
function Get-Json([string]$url) {
  Invoke-RestMethod $url | ForEach-Object { $_ }
}

function Get-StatusCode($errorRecord) {
  $response = $errorRecord.Exception.Response
  if ($response) { return [int]$response.StatusCode }
  return 0
}

try {
  $libraries = @(Get-Json "$api/libraries")
} catch {
  if ((Get-StatusCode $_) -eq 401) {
    throw 'The API does not accept API_TOKEN. Restart it with scripts\up.ps1, so it reads .env again.'
  }
  throw "CineVault API not reachable on port $port. Start it with scripts\up.ps1"
}
if ($libraries.Count -eq 0) { throw 'No libraries. Check MEDIA_ROOT in .env (folders Movies, Series, Anime).' }

$body = @{}
if ($Library) {
  $match = $libraries | Where-Object { $_.name -eq $Library } | Select-Object -First 1
  if (-not $match) { throw "Library '$Library' not found. Known: $(($libraries | ForEach-Object { $_.name }) -join ', ')" }
  $body.libraryId = $match.id
}
if ($Refresh) { $body.refreshMetadata = $true }

if (-not $ListOnly) {
  try {
    Invoke-RestMethod -Method Post -Uri "$api/scan" -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress) | Out-Null
    Write-Host '== Scan started'
  } catch {
    if ((Get-StatusCode $_) -eq 409) { Write-Host '== A scan is already running; following it' }
    else { throw }
  }

  $last = ''
  while ($true) {
    $status = Invoke-RestMethod "$api/scan"
    $line = '  {0,-9} {1,-8} files {2} found, {3} probed ({4} errors) | titles {5}/{6}: {7} matched, {8} unmatched, {9} failed' -f `
      $status.phase, $status.libraryName, $status.filesFound, $status.filesProbed, $status.probeErrors,
      ($status.itemsMatched + $status.itemsUnmatched + $status.itemsFailed), $status.itemsTotal,
      $status.itemsMatched, $status.itemsUnmatched, $status.itemsFailed
    if ($line -ne $last) { Write-Host $line; $last = $line }
    if (-not $status.running) { break }
    Start-Sleep -Seconds 2
  }

  Write-Host ''
  Write-Host ('== Done: {0} files, {1} probed, {2} removed; {3} titles matched, {4} unmatched, {5} failed' -f `
      $status.filesFound, $status.filesProbed, $status.filesRemoved,
      $status.itemsMatched, $status.itemsUnmatched, $status.itemsFailed)
  if ($status.errors.Count -gt 0) {
    Write-Host ''
    Write-Host "== Problems (first $([Math]::Min(20, $status.errors.Count)) of $($status.errors.Count))"
    $status.errors | Select-Object -First 20 | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
  }
}

Write-Host ''
Write-Host '== Titles that need attention'
$any = $false
foreach ($lib in @(Get-Json "$api/libraries")) {
  foreach ($state in @('UNMATCHED', 'FAILED')) {
    $page = Invoke-RestMethod "$api/libraries/$($lib.id)/items?status=$state&pageSize=200"
    foreach ($item in @($page.items | ForEach-Object { $_ })) {
      $any = $true
      $year = if ($item.year) { " ($($item.year))" } else { '' }
      Write-Host ("  [{0,-9}] {1,-7} {2}{3}  id={4}" -f $state, $lib.name, $item.title, $year, $item.id)
    }
  }
}
if (-not $any) { Write-Host '  none' -ForegroundColor Green }
