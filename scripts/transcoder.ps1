<#
.SYNOPSIS
  Installs, starts and checks the CineVault transcoder (native on Windows, for QSV).

.DESCRIPTION
  The transcoder runs next to Docker Desktop, because Docker Desktop can't pass
  the Intel GPU into a container. It needs Node.js 22.18+ (24 LTS recommended:
  winget install OpenJS.NodeJS.LTS) and FFmpeg (winget install Gyan.FFmpeg).
  Settings come from .env (TRANSCODER_*, MEDIA_ROOT, TRANSCODE_TMP).

    powershell -ExecutionPolicy Bypass -File .\scripts\transcoder.ps1 -Install
    powershell -ExecutionPolicy Bypass -File .\scripts\transcoder.ps1 -Status
    powershell -ExecutionPolicy Bypass -File .\scripts\transcoder.ps1 -Restart
    powershell -ExecutionPolicy Bypass -File .\scripts\transcoder.ps1          (run here, Ctrl+C stops)

  -Install    create TRANSCODER_TOKEN in .env if missing, and a scheduled task
              that starts the transcoder when you log on (and restarts it if it stops)
  -Uninstall  remove the scheduled task
  -Restart    restart the task, e.g. after git pull
  -Status     show the task and what the transcoder reports
  -Service    used by the scheduled task: run and restart on a crash, log to logs\transcoder.log
#>
param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Restart,
  [switch]$Status,
  [switch]$Service
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
$taskName = 'CineVault Transcoder'
$main = Join-Path $repo 'apps\transcoder\src\main.ts'
$logDir = Join-Path $repo 'logs'
$log = Join-Path $logDir 'transcoder.log'

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

function Get-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw 'Node.js not found. Install it with: winget install OpenJS.NodeJS.LTS (then open a new terminal)' }
  $version = (& $node.Source --version).TrimStart('v')
  $parts = $version.Split('.') | ForEach-Object { [int]$_ }
  if ($parts[0] -lt 22 -or ($parts[0] -eq 22 -and $parts[1] -lt 18)) {
    throw "Node.js $version is too old (22.18 or newer needed): winget upgrade OpenJS.NodeJS.LTS"
  }
  return $node.Source
}

function Get-Health {
  $envValues = Read-Env
  $port = if ($envValues['TRANSCODER_PORT'] -match '^\d+$') { $envValues['TRANSCODER_PORT'] } else { '8766' }
  $headers = @{ Authorization = "Bearer $($envValues['TRANSCODER_TOKEN'])" }
  return Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -Headers $headers -TimeoutSec 5
}

function Show-Health {
  try {
    $health = Get-Health
    Write-Host "  [OK] transcoder answers: $($health.ffmpeg)" -ForegroundColor Green
    $video = if ($health.hwaccel -eq 'qsv') { 'on the GPU (QSV)' } else { 'on the CPU' }
    $tonemap = if ($health.tonemap) { 'on' } else { 'off' }
    Write-Host "       video $video, HDR tone mapping $tonemap, at most $($health.maxTranscodes) transcodes"
    foreach ($note in @($health.notes)) { if ($note) { Write-Host "       $note" -ForegroundColor Yellow } }
    Write-Host "       sessions: $($health.sessions.running) running, $($health.sessions.queued) queued"
  } catch {
    Write-Host "  [!] transcoder not reachable: $($_.Exception.Message)" -ForegroundColor Yellow
    if (Test-Path $log) {
      Write-Host '      last lines of logs\transcoder.log:'
      Get-Content $log -Tail 8 | ForEach-Object { Write-Host "      $_" }
    }
  }
}

if ($Service) {
  # Run by the scheduled task: keep the transcoder running. It writes its own
  # log (TRANSCODER_LOG); its console output goes nowhere in a hidden window.
  $ErrorActionPreference = 'Continue'
  $node = Get-Node
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $env:TRANSCODER_LOG = $log
  while ($true) {
    & $node $main 2>$null | Out-Null
    Add-Content -Path $log -Value "$(Get-Date -Format s) transcoder stopped (exit code $LASTEXITCODE), restarting in 10 s"
    Start-Sleep -Seconds 10
  }
}

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed the scheduled task '$taskName'."
  exit 0
}

if ($Install) {
  $null = Get-Node
  if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    throw 'FFmpeg not found. Install it with: winget install Gyan.FFmpeg (then open a new terminal)'
  }
  if (-not (Test-Path .env)) { throw '.env not found in the repo root (docs/server-setup.md, step 8)' }
  $envValues = Read-Env
  foreach ($key in @('MEDIA_ROOT', 'TRANSCODE_TMP')) {
    if (-not $envValues[$key]) { throw "$key is empty in .env" }
  }
  New-Item -ItemType Directory -Force -Path $envValues['TRANSCODE_TMP'] | Out-Null

  if (-not $envValues['TRANSCODER_TOKEN']) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
    $lines = @(Get-Content .env)
    $index = -1
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^\s*TRANSCODER_TOKEN\s*=') { $index = $i } }
    if ($index -ge 0) { $lines[$index] = "TRANSCODER_TOKEN=$token" } else { $lines += "TRANSCODER_TOKEN=$token" }
    # No byte order mark (Set-Content -Encoding UTF8 writes one in Windows PowerShell),
    # or Docker Compose misreads the first line.
    [System.IO.File]::WriteAllLines((Join-Path $repo '.env'), [string[]]$lines, (New-Object System.Text.UTF8Encoding $false))
    Write-Host '  [OK] TRANSCODER_TOKEN created in .env (a shared secret between API and transcoder)' -ForegroundColor Green
    Write-Host '       Restart the API so it knows the token: scripts\up.ps1' -ForegroundColor Yellow
  } else {
    Write-Host '  [OK] TRANSCODER_TOKEN is set in .env' -ForegroundColor Green
  }

  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Service" `
    -WorkingDirectory $repo
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description 'CineVault: FFmpeg with Intel QSV for the API in Docker' -Force | Out-Null
  Write-Host "  [OK] scheduled task '$taskName' starts the transcoder when you log on" -ForegroundColor Green
  $Restart = $true
}

if ($Restart) {
  # The transcoder's node processes, before stopping them: Windows does not stop
  # their FFmpeg children with them, so those are stopped below too.
  $nodes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*apps\transcoder\src\main.ts*' })
  $nodeIds = @($nodes | ForEach-Object { $_.ProcessId })
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  # The task runs a PowerShell loop around node; stop leftovers of an earlier run too.
  $nodes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($nodeIds.Count -gt 0) {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { ($_.Name -eq 'ffmpeg.exe' -or $_.Name -eq 'ffprobe.exe') -and ($nodeIds -contains $_.ParentProcessId) } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  Start-ScheduledTask -TaskName $taskName
  Write-Host '== Starting the transcoder (the self test takes a few seconds)'
  $deadline = (Get-Date).AddSeconds(45)
  do {
    Start-Sleep -Seconds 2
    try { $ready = (Get-Health).ready } catch { $ready = $false }
  } until ($ready -or (Get-Date) -gt $deadline)
  Show-Health
  exit 0
}

if ($Status) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) { Write-Host "  scheduled task: $($task.State)" } else { Write-Host '  no scheduled task (run with -Install)' -ForegroundColor Yellow }
  Show-Health
  exit 0
}

# No switch: run in this window.
$node = Get-Node
& $node $main
exit $LASTEXITCODE
