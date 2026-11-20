<#
.SYNOPSIS
  Searches the intro, recap and end credits of every episode now, in one go,
  and the end credits of every film.

.DESCRIPTION
  Normally the server looks for them only while nobody watches, a few
  episodes at a time. This asks it to do every episode still to do, one
  after the other (also while someone watches), and shows how far it is.

  Run from the repo, with the containers and the transcoder up:
    powershell -ExecutionPolicy Bypass -File .\scripts\intro-search.ps1
    powershell -ExecutionPolicy Bypass -File .\scripts\intro-search.ps1 -All
    powershell -ExecutionPolicy Bypass -File .\scripts\intro-search.ps1 -Stop

  -All     look at every episode again, also those done already (what an
           admin set by hand stays). The fingerprints are cached, so that is
           mostly comparing.
  -Stop    back to searching only while nobody watches.
  -NoWait  start it and return; the server goes on by itself.

  Ctrl+C stops only the progress on screen; the server goes on. Watching
  while it runs can stutter: it reads a lot from the media disk.
#>
param(
  [switch]$All,
  [switch]$Stop,
  [switch]$NoWait
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

function Get-StatusCode($errorRecord) {
  $response = $errorRecord.Exception.Response
  if ($response) { return [int]$response.StatusCode }
  return 0
}

function Show-Status($s) {
  $credits = if ($null -ne $s.creditsChecked) { $s.creditsChecked } else { 0 }
  $recap = if ($null -ne $s.recapChecked) { $s.recapChecked } else { 0 }
  $line = '  intro {0}/{1} ({2} found) | credits {3}/{1} ({4} found) | recap {5}/{1} ({6} found)' -f `
    $s.checked, $s.episodes, $s.found, $credits, $s.creditsFound, $recap, $s.recapFound
  if ($s.films) {
    $line += ' | films {0}/{1} ({2} found)' -f $s.filmsChecked, $s.films, $s.filmsFound
  }
  $line
}

try {
  $status = Invoke-RestMethod "$api/intro/status"
} catch {
  if ((Get-StatusCode $_) -eq 401) {
    throw 'The API does not accept API_TOKEN. Restart it with scripts\up.ps1, so it reads .env again.'
  }
  if ((Get-StatusCode $_) -eq 404) {
    throw 'This API is too old for this script. Update it with scripts\up.ps1.'
  }
  throw "CineVault API not reachable on port $port. Start it with scripts\up.ps1"
}

if ($Stop) {
  Invoke-RestMethod -Method Delete -Uri "$api/intro/run" | Out-Null
  Write-Host '== Back to searching only while nobody watches'
  Write-Host (Show-Status $status)
  return
}

$body = @{}
if ($All) { $body.all = $true }
try {
  $status = Invoke-RestMethod -Method Post -Uri "$api/intro/run" -ContentType 'application/json' `
    -Body ($body | ConvertTo-Json -Compress)
} catch {
  if ((Get-StatusCode $_) -eq 404) { throw 'This API is too old for this script. Update it with scripts\up.ps1.' }
  throw
}
if (-not $status.rush) {
  Write-Host '== Nothing left to search: every episode was looked at.'
  Write-Host (Show-Status $status)
  Write-Host '   Use -All to look at every episode again.'
  return
}
Write-Host ('== Searching every episode now' + $(if ($All) { ' (all of them again)' } else { '' }))
if ($NoWait) {
  Write-Host (Show-Status $status)
  Write-Host '   The server goes on by itself; run this script again to follow it.'
  return
}

# Progress: the episodes with all three looked at, and the films.
function Get-Done($s) {
  $credits = if ($null -ne $s.creditsChecked) { $s.creditsChecked } else { $s.episodes }
  $recap = if ($null -ne $s.recapChecked) { $s.recapChecked } else { $s.episodes }
  $films = if ($s.filmsChecked) { $s.filmsChecked } else { 0 }
  [Math]::Min($s.checked, [Math]::Min($credits, $recap)) + $films
}
function Get-Total($s) {
  $films = if ($s.films) { $s.films } else { 0 }
  $s.episodes + $films
}
function Get-Minutes($iso) {
  if (-not $iso) { return 0 }
  [Math]::Floor(((Get-Date) - [DateTime]::Parse($iso).ToLocalTime()).TotalMinutes)
}
$parts = @{ start = 'the start'; middle = 'the middle'; end = 'the end' }
$started = Get-Date
$doneAtStart = Get-Done $status
$last = ''
$lastShown = Get-Date
while ($true) {
  Start-Sleep -Seconds 10
  try {
    $status = Invoke-RestMethod "$api/intro/status"
  } catch {
    Write-Host '  (API not reachable, trying again)'
    continue
  }
  $done = Get-Done $status
  $left = (Get-Total $status) - $done
  $line = Show-Status $status
  $elapsed = ((Get-Date) - $started).TotalSeconds
  if ($done -gt $doneAtStart -and $left -gt 0) {
    $rate = ($done - $doneAtStart) / $elapsed
    $eta = [TimeSpan]::FromSeconds([Math]::Round($left / $rate))
    $line += ' | about {0}:{1:00} left' -f [Math]::Floor($eta.TotalHours), $eta.Minutes
  }
  if ($status.waiting -eq 'transcoder') { $line += ' | waiting for the transcoder (scripts\transcoder.ps1)' }
  if ($line -ne $last) {
    Write-Host $line
    if ($status.current) { Write-Host "    now: $($status.current)" }
    $last = $line
    $lastShown = Get-Date
  } elseif ($status.rush -and ((Get-Date) - $lastShown).TotalSeconds -ge 60) {
    # Nothing new: say what it is doing, so it doesn't look stuck.
    $minutes = Get-Minutes $status.currentSince
    Write-Host ("    still on: $($status.current) ($minutes min)")
    if ($status.reading) {
      $what = if ($status.reading.path -eq $status.current) { 'this file' } else { $status.reading.path }
      Write-Host ("      reading $($parts[$status.reading.part]) of $what ($(Get-Minutes $status.reading.since) min)")
    }
    $lastShown = Get-Date
  }
  if (-not $status.rush) { break }
}

Write-Host ''
$took = (Get-Date) - $started
$time = '{0}:{1:00}:{2:00}' -f [Math]::Floor($took.TotalHours), $took.Minutes, $took.Seconds
if ($status.rushStopped -eq 'transcoder') {
  Write-Host "== Stopped after ${time}: the transcoder did not answer" -ForegroundColor Yellow
  Write-Host (Show-Status $status)
  Write-Host '   Restart it with scripts\transcoder.ps1 -Restart, look at logs\transcoder.log,'
  Write-Host '   and run this script again: it goes on where it was.'
  return
}
if ($status.rushStopped -eq 'stuck') {
  Write-Host "== Stopped after ${time}: one episode could not be marked" -ForegroundColor Yellow
  Write-Host (Show-Status $status)
  Write-Host '   See: docker compose logs api | Select-String "intro search"'
  return
}
Write-Host "== Done in $time"
Write-Host (Show-Status $status)
Write-Host '   A wrong intro, recap or end credits: correct it in the player, under Instellingen.'
