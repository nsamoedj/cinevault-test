<#
.SYNOPSIS
  Restarts Docker Desktop when the API no longer sees the media disk.

.DESCRIPTION
  Docker Desktop shares the Windows disk (MEDIA_ROOT) with the API container.
  Sometimes it loses that share (the disk was gone for a moment, Windows slept
  or updated): the library folders then look empty in the container, while
  Windows, Sonarr, Radarr and the transcoder still see them. The scanner then
  finds nothing new (docs/server-setup.md, step 42). Restarting only the API
  does not help (mkdir /run/desktop/mnt/host/d: file exists); quitting Docker
  Desktop, wsl --shutdown and starting it again does.

  This script checks that, and does the restart itself:

    powershell -ExecutionPolicy Bypass -File .\scripts\media-watchdog.ps1             (check once, restart if needed)
    powershell -ExecutionPolicy Bypass -File .\scripts\media-watchdog.ps1 -Install    (check every 10 minutes)
    powershell -ExecutionPolicy Bypass -File .\scripts\media-watchdog.ps1 -Status

  When does it restart?
  - The folders in MEDIA_ROOT that have something in them on Windows (Movies,
    Series, Anime) are all empty or unreadable in the API container, on two
    checks in a row (a few minutes apart: not on a hiccup).
  - Not while the transcoder plays something, for at most -MaxWaitMinutes
    (60); after that it restarts anyway, since new media stay away until then.
  - Not when Windows itself doesn't see MEDIA_ROOT: then the disk is really
    gone, and a restart doesn't help.
  - Once an hour at most. Still broken after a restart: it leaves it for 6
    hours and says so in the log.
  - Docker Desktop not running at all (twice in a row): it starts it.

  The restart: Docker Desktop quit, wsl --shutdown (this stops every WSL
  distribution, not only Docker's), Docker Desktop started, docker compose
  up -d, and a scan. Playback stops for a minute or two.

  -Install    a scheduled task that checks every -EveryMinutes (10) minutes, in
              your Windows session (Docker Desktop runs there)
  -Uninstall  remove the scheduled task
  -Status     the task and the last lines of logs\media-watchdog.log
  -CheckOnly  look and report, change nothing
  -Force      restart now, without the checks
#>
param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Status,
  [switch]$CheckOnly,
  [switch]$Force,
  [int]$EveryMinutes = 10,
  [int]$MaxWaitMinutes = 60
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
$taskName = 'CineVault Media Watchdog'
$logDir = Join-Path $repo 'logs'
$log = Join-Path $logDir 'media-watchdog.log'
$stateFile = Join-Path $logDir 'media-watchdog.json'
# Folders on every Windows disk that are no library.
$systemFolders = @('$RECYCLE.BIN', 'System Volume Information', 'Recovery', 'found.000')

function Read-Env {
  $values = @{}
  if (Test-Path .env) {
    foreach ($line in Get-Content .env) {
      $line = $line.TrimStart([char]0xFEFF)
      if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$') { $values[$Matches[1]] = $Matches[2].Trim('"', "'") }
    }
  }
  return $values
}

function Write-Log([string]$message) {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message"
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Host "  $message"
  # Keep the log small: the last 2000 lines.
  $lines = @(Get-Content $log)
  if ($lines.Count -gt 2500) { $lines | Select-Object -Last 2000 | Set-Content -Path $log -Encoding UTF8 }
}

function Read-State {
  $state = @{ strikes = 0; dockerDown = 0; waitingSince = $null; lastRestart = $null; pausedUntil = $null }
  if (Test-Path $stateFile) {
    try {
      $saved = Get-Content $stateFile -Raw | ConvertFrom-Json
      foreach ($key in @('strikes', 'dockerDown', 'waitingSince', 'lastRestart', 'pausedUntil')) {
        if ($null -ne $saved.$key) { $state[$key] = $saved.$key }
      }
    } catch {
      # A broken state file: start over.
    }
  }
  return $state
}

function Save-State($state) {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $state | ConvertTo-Json | Set-Content -Path $stateFile -Encoding UTF8
}

function Get-Time($value) {
  if (-not $value) { return $null }
  # PowerShell 7 reads ISO times from JSON as dates already.
  if ($value -is [datetime]) { return $value }
  return [datetime]::Parse($value, [Globalization.CultureInfo]::InvariantCulture)
}

function Format-Time([datetime]$value) {
  return $value.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
}

function Test-Docker {
  docker info *> $null
  return ($LASTEXITCODE -eq 0)
}

# The library folders as Windows sees them: the folders in MEDIA_ROOT with something in them.
function Get-WindowsFolders([string]$root) {
  if (-not $root -or -not (Test-Path -LiteralPath $root)) { return $null }
  $folders = @()
  foreach ($dir in Get-ChildItem -LiteralPath $root -Directory -Force -ErrorAction SilentlyContinue) {
    if ($systemFolders -contains $dir.Name -or $dir.Name.StartsWith('.')) { continue }
    $first = Get-ChildItem -LiteralPath $dir.FullName -Force -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($first) { $folders += $dir.Name }
  }
  # The comma keeps an empty list a list (PowerShell would make it $null: "no disk").
  return ,$folders
}

# Whether the API container sees something in /media/<folder>; $null when the container doesn't answer.
function Test-ContainerFolder([string]$folder) {
  $output = docker compose exec -T api sh -c "ls -A '/media/$folder' 2>/dev/null | head -n 1" 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return [bool]("$output".Trim())
}

# How many sessions the transcoder plays now (0 when it doesn't answer).
function Get-Playing($envValues) {
  $port = '8766'
  if ($envValues['TRANSCODER_PORT'] -match '^\d+$') { $port = $envValues['TRANSCODER_PORT'] }
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 5 `
      -Headers @{ Authorization = "Bearer $($envValues['TRANSCODER_TOKEN'])" }
    return [int]$health.sessions.running
  } catch {
    return 0
  }
}

function Wait-For([scriptblock]$condition, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $condition) { return $true }
    Start-Sleep -Seconds 5
  }
  return $false
}

function Start-DockerDesktop {
  $exe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (Test-Path $exe) { Start-Process -FilePath $exe | Out-Null; return }
  docker desktop start *> $null
}

function Stop-DockerDesktop {
  # Docker Desktop 4.37 and later have docker desktop stop; else end the processes.
  docker desktop stop *> $null
  if ($LASTEXITCODE -ne 0) {
    foreach ($name in @('Docker Desktop', 'com.docker.backend', 'com.docker.build', 'com.docker.proxy')) {
      Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Seconds 5
}

function Start-Scan($envValues) {
  $port = '3000'
  if ($envValues['API_PORT'] -match '^\d+$') { $port = $envValues['API_PORT'] }
  $token = $envValues['API_TOKEN']
  if (-not $token) { return }
  try {
    Invoke-RestMethod -Method Post -Uri "http://localhost:$port/api/scan" -ContentType 'application/json' -Body '{}' `
      -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 15 | Out-Null
    Write-Log 'scan started'
  } catch {
    Write-Log "could not start a scan: $($_.Exception.Message)"
  }
}

# Quit Docker Desktop, wsl --shutdown, start it, bring CineVault up again. True when the API sees the media again.
function Restart-Docker($envValues, [string[]]$folders) {
  Write-Log 'restarting Docker Desktop: quit, wsl --shutdown, start'
  Stop-DockerDesktop
  wsl.exe --shutdown 2>$null | Out-Null
  Start-Sleep -Seconds 5
  Start-DockerDesktop
  if (-not (Wait-For { Test-Docker } 300)) {
    Write-Log 'Docker Desktop did not start within 5 minutes'
    return $false
  }
  docker compose up -d 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Log "docker compose up -d failed (exit code $LASTEXITCODE)" }
  $port = '3000'
  if ($envValues['API_PORT'] -match '^\d+$') { $port = $envValues['API_PORT'] }
  $apiUp = Wait-For {
    try { (Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$port/api/health" -TimeoutSec 5).StatusCode -eq 200 } catch { $false }
  } 180
  if (-not $apiUp) { Write-Log 'the API did not answer within 3 minutes after the restart' }
  $seen = @($folders | Where-Object { Test-ContainerFolder $_ })
  if ($seen.Count -eq 0) {
    Write-Log "after the restart the API still sees none of $($folders -join ', ')"
    return $false
  }
  Write-Log "the API sees the media again ($($seen -join ', '))"
  Start-Scan $envValues
  return $true
}

# --- Install, uninstall, status ----------------------------------------------------

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "  [OK] scheduled task '$taskName' removed" -ForegroundColor Green
  exit 0
}

if ($Install) {
  if ($EveryMinutes -lt 5) { throw 'Check at most every 5 minutes (-EveryMinutes 5 or more)' }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`"" `
    -WorkingDirectory $repo
  $every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
  $logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $logon.Delay = 'PT5M'
  # Docker Desktop runs in the user's session, so the task does too.
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($every, $logon) -Settings $settings `
    -Principal $principal -Description 'CineVault: restarts Docker Desktop when the API loses the media disk' -Force | Out-Null
  Write-Host "  [OK] scheduled task '$taskName' checks every $EveryMinutes minutes (log: logs\media-watchdog.log)" -ForegroundColor Green
  Write-Host '== A first check now'
  # Falls through to a check.
}

if ($Status) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    $info = $task | Get-ScheduledTaskInfo
    Write-Host "  scheduled task: $($task.State), last run $($info.LastRunTime) (result $($info.LastTaskResult)), next $($info.NextRunTime)"
  } else {
    Write-Host '  no scheduled task (run with -Install)' -ForegroundColor Yellow
  }
  if (Test-Path $log) {
    Write-Host '  log:'
    Get-Content $log -Tail 10 | ForEach-Object { Write-Host "    $_" }
  } else {
    Write-Host '  no log yet'
  }
  exit 0
}

# --- Check ---------------------------------------------------------------------------

$envValues = Read-Env
$state = Read-State
$now = Get-Date
$root = $envValues['MEDIA_ROOT']
if (-not $root) { throw 'MEDIA_ROOT is not set in .env' }

if ($Force) {
  $found = Get-WindowsFolders $root
  $folders = @()
  if ($found) { $folders = @($found) }
  if ($CheckOnly) { Write-Host '  -Force with -CheckOnly: nothing done'; exit 0 }
  Write-Log 'restart asked for by hand (-Force)'
  $ok = Restart-Docker $envValues @($folders)
  $state.strikes = 0; $state.waitingSince = $null; $state.lastRestart = Format-Time (Get-Date)
  if (-not $ok) { $state.pausedUntil = Format-Time ((Get-Date).AddHours(6)) } else { $state.pausedUntil = $null }
  Save-State $state
  exit 0
}

$paused = Get-Time $state.pausedUntil
if ($paused -and $now -lt $paused -and -not $CheckOnly) {
  Write-Host "  paused until $paused after a restart that did not help (see logs\media-watchdog.log)"
  exit 0
}

# Docker Desktop not running at all: start it (on the second check in a row).
if (-not (Test-Docker)) {
  $state.dockerDown = [int]$state.dockerDown + 1
  if ($CheckOnly) { Write-Host '  Docker Desktop is not running'; exit 0 }
  if ($state.dockerDown -ge 2) {
    Write-Log 'Docker Desktop is not running: starting it'
    Start-DockerDesktop
    if (Wait-For { Test-Docker } 300) {
      docker compose up -d 2>&1 | Out-Null
      Write-Log 'Docker Desktop is running again'
      $state.dockerDown = 0
    } else {
      Write-Log 'Docker Desktop did not start within 5 minutes'
    }
  }
  Save-State $state
  exit 0
}
$state.dockerDown = 0

$folders = Get-WindowsFolders $root
if ($null -eq $folders) {
  # Windows itself doesn't see the disk: a restart of Docker doesn't bring it back.
  Write-Host "  Windows does not see MEDIA_ROOT ($root): nothing to do for Docker"
  $state.strikes = 0
  Save-State $state
  exit 0
}
if (@($folders).Count -eq 0) {
  Write-Host "  no folders with media in $root"
  Save-State $state
  exit 0
}

$results = @{}
foreach ($folder in $folders) { $results[$folder] = Test-ContainerFolder $folder }
if ($results.Values -contains $null) {
  # The API container doesn't run (an update, a restart): not this script's business.
  Write-Host '  the API container does not answer (docker compose ps); checking again next time'
  Save-State $state
  exit 0
}
$seen = @($folders | Where-Object { $results[$_] })
if ($seen.Count -gt 0) {
  if ($state.strikes -gt 0) { Write-Log "the API sees the media again by itself ($($seen -join ', '))" }
  if ($CheckOnly) { Write-Host "  [OK] the API sees $($seen -join ', ')" -ForegroundColor Green }
  $state.strikes = 0; $state.waitingSince = $null; $state.pausedUntil = $null
  Save-State $state
  exit 0
}

# Every folder looks empty in the container.
if ($CheckOnly) {
  Write-Host "  [FAIL] the API sees none of $($folders -join ', '), Windows does: Docker Desktop lost the disk" -ForegroundColor Red
  exit 1
}
$state.strikes = [int]$state.strikes + 1
if ($state.strikes -eq 1) {
  Write-Log "the API sees none of $($folders -join ', ') (Windows does); restart on the next check if it stays so"
  Save-State $state
  exit 0
}
$last = Get-Time $state.lastRestart
if ($last -and ($now - $last).TotalMinutes -lt 60) {
  Write-Host "  the last restart was at $last; waiting an hour between restarts"
  Save-State $state
  exit 0
}
$playing = Get-Playing $envValues
if ($playing -gt 0) {
  if (-not $state.waitingSince) { $state.waitingSince = Format-Time $now }
  $waited = ($now - (Get-Time $state.waitingSince)).TotalMinutes
  if ($waited -lt $MaxWaitMinutes) {
    Write-Log "the API lost the media disk, but $playing stream(s) play; restart when they stop (or after $MaxWaitMinutes minutes)"
    Save-State $state
    exit 0
  }
  Write-Log "still $playing stream(s) after $MaxWaitMinutes minutes: restarting anyway"
}

$ok = Restart-Docker $envValues @($folders)
$state.strikes = 0; $state.waitingSince = $null; $state.lastRestart = Format-Time (Get-Date)
if ($ok) {
  $state.pausedUntil = $null
} else {
  $state.pausedUntil = Format-Time ((Get-Date).AddHours(6))
  Write-Log 'not trying again for 6 hours; restart the N100, or see docs/server-setup.md, step 42'
}
Save-State $state
