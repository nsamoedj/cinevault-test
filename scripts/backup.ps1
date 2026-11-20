<#
.SYNOPSIS
  Backs up the CineVault database: accounts, watch progress, manual matches.

.DESCRIPTION
  Makes a pg_dump of the database in the db container, checks that it can be
  read back, and keeps the last 14 daily and 8 weekly backups. The media, the
  image cache and .env are not part of it (docs/server-setup.md, step 18).

    powershell -ExecutionPolicy Bypass -File .\scripts\backup.ps1             (back up now)
    powershell -ExecutionPolicy Bypass -File .\scripts\backup.ps1 -Install    (every night at 03:30)
    powershell -ExecutionPolicy Bypass -File .\scripts\backup.ps1 -Status

  Where: BACKUP_DIR in .env, by default Documents\CineVault-backups.
  How many: BACKUP_KEEP_DAILY (14) and BACKUP_KEEP_WEEKLY (8).

  -Install    a scheduled task that backs up every night (-At 03:30); a missed
              run (the N100 was off) happens as soon as possible afterwards
  -Uninstall  remove the scheduled task
  -Status     the task, the last backups and the log
  -Tag        a name for a one-off backup, e.g. before-update; tagged
              backups are never removed automatically
#>
param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Status,
  [string]$Tag,
  [string]$At = '03:30',
  [string]$BackupDir
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
$taskName = 'CineVault Backup'

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

$envValues = Read-Env
if (-not $BackupDir) { $BackupDir = $envValues['BACKUP_DIR'] }
if (-not $BackupDir) { $BackupDir = Join-Path $HOME (Join-Path 'Documents' 'CineVault-backups') }
$keepDaily = 14
$keepWeekly = 8
if ($envValues['BACKUP_KEEP_DAILY'] -match '^\d+$') { $keepDaily = [int]$envValues['BACKUP_KEEP_DAILY'] }
if ($envValues['BACKUP_KEEP_WEEKLY'] -match '^\d+$') { $keepWeekly = [int]$envValues['BACKUP_KEEP_WEEKLY'] }
$log = Join-Path $BackupDir 'backup.log'
# Automatic backups; tagged ones (cinevault-<date>-<tag>.dump) are kept.
$automatic = '^cinevault-(\d{4}-\d{2}-\d{2})_(\d{4})\.dump$'

function Write-Log([string]$message) {
  New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
  Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message" -Encoding UTF8
}

function Get-Backups {
  if (-not (Test-Path $BackupDir)) { return @() }
  return @(Get-ChildItem -Path $BackupDir -Filter 'cinevault-*.dump' -File | Sort-Object Name -Descending)
}

function Format-Size([long]$bytes) {
  if ($bytes -ge 1MB) { return '{0:N1} MB' -f ($bytes / 1MB) }
  return '{0:N0} KB' -f [Math]::Max(1, $bytes / 1KB)
}

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "  [OK] scheduled task '$taskName' removed (the backups themselves stay)" -ForegroundColor Green
  exit 0
}

if ($Install) {
  $time = [datetime]::ParseExact($At, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`"" `
    -WorkingDirectory $repo
  $trigger = New-ScheduledTaskTrigger -Daily -At $time
  # Docker Desktop runs in the user's session, so the task does too.
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description 'CineVault: nightly backup of the database' -Force | Out-Null
  Write-Host "  [OK] scheduled task '$taskName' backs up every night at $At to $BackupDir" -ForegroundColor Green
  Write-Host '== A first backup now'
  # Falls through to a backup.
}

if ($Status) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    $info = $task | Get-ScheduledTaskInfo
    Write-Host "  scheduled task: $($task.State), last run $($info.LastRunTime) (result $($info.LastTaskResult)), next $($info.NextRunTime)"
  } else {
    Write-Host '  no scheduled task (run with -Install)' -ForegroundColor Yellow
  }
  $backups = Get-Backups
  Write-Host "  $($backups.Count) backup(s) in $BackupDir"
  $backups | Select-Object -First 5 | ForEach-Object { Write-Host "    $($_.Name)  $(Format-Size $_.Length)" }
  if (Test-Path $log) {
    Write-Host '  log:'
    Get-Content $log -Tail 5 | ForEach-Object { Write-Host "    $_" }
  }
  exit 0
}

# --- Back up ------------------------------------------------------------------

$user = $envValues['POSTGRES_USER']
$database = $envValues['POSTGRES_DB']
if (-not $user -or -not $database) { throw 'POSTGRES_USER and POSTGRES_DB must be set in .env' }

$suffix = ''
if ($Tag) {
  if ($Tag -notmatch '^[A-Za-z0-9-]{1,40}$') { throw 'A tag has letters, digits and dashes only, e.g. before-update' }
  $suffix = "-$Tag"
}
$name = "cinevault-$(Get-Date -Format 'yyyy-MM-dd_HHmm')$suffix.dump"
$target = Join-Path $BackupDir $name
$partial = "$target.partial"
$inner = '/tmp/cinevault-backup.dump'

try {
  New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
  # pg_dump writes inside the container and the file is copied out: a binary
  # dump must not pass through a PowerShell pipeline, which re-encodes it.
  docker compose exec -T db pg_dump -U $user -d $database --format=custom --compress=6 --file=$inner
  if ($LASTEXITCODE -ne 0) { throw "pg_dump failed (exit code $LASTEXITCODE). Is Docker Desktop running? (docker compose ps)" }
  # Readable again? A damaged dump fails here, not on the day it is needed.
  docker compose exec -T db pg_restore --list $inner | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'the new backup cannot be read back (pg_restore --list failed)' }
  docker compose cp "db:$inner" $partial
  if ($LASTEXITCODE -ne 0) { throw "copying the backup out of the container failed (exit code $LASTEXITCODE)" }
  docker compose exec -T db rm -f $inner | Out-Null
  if ((Get-Item $partial).Length -lt 1KB) { throw 'the backup is suspiciously small' }
  Move-Item -Force $partial $target
} catch {
  Remove-Item -Force -ErrorAction SilentlyContinue $partial
  Write-Log "FAIL $($_.Exception.Message)"
  Write-Host "  [FAIL] $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

$size = Format-Size (Get-Item $target).Length

# Keep the newest daily backups, and the newest of each of the last weeks.
$dated = @(Get-Backups | Where-Object { $_.Name -match $automatic } | ForEach-Object {
    $date = [datetime]::ParseExact(($_.Name -replace $automatic, '$1'), 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
    [pscustomobject]@{ File = $_; Day = $date.ToString('yyyy-MM-dd'); Week = $date.AddDays(-(([int]$date.DayOfWeek + 6) % 7)).ToString('yyyy-MM-dd') }
  })
# Group-Object returns its groups in its own order: sort them, newest first.
function Select-Newest($groups, [int]$count) {
  $groups | Sort-Object Name -Descending | Select-Object -First $count | ForEach-Object {
    ($_.Group | Sort-Object { $_.File.Name } -Descending | Select-Object -First 1).File.Name
  }
}
$keep = @{ $name = $true }
Select-Newest ($dated | Group-Object Day) $keepDaily | ForEach-Object { $keep[$_] = $true }
Select-Newest ($dated | Group-Object Week) $keepWeekly | ForEach-Object { $keep[$_] = $true }
$removed = 0
foreach ($backup in $dated) {
  if (-not $keep[$backup.File.Name]) {
    Remove-Item -Force $backup.File.FullName
    $removed++
  }
}

Write-Log "OK $name $size$(if ($removed) { ", $removed old backup(s) removed" })"
Write-Host "  [OK] $target ($size)" -ForegroundColor Green
if ($removed) { Write-Host "  [OK] $removed old backup(s) removed (keeping $keepDaily daily, $keepWeekly weekly)" -ForegroundColor Green }

# Beheer -> Gezondheid: tell the API (only Windows sees this folder). Never fails the backup.
$token = "$($envValues['API_TOKEN'])".Trim()
$port = if ($envValues['API_PORT'] -match '^\d+$') { $envValues['API_PORT'] } else { '3000' }
if ($token) {
  try {
    $report = @{ file = $name; size = (Get-Item $target).Length; at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
    Invoke-RestMethod -Method Post -Uri "http://localhost:$port/api/admin/health/backup" -TimeoutSec 10 `
      -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' -Body $report | Out-Null
    Write-Host '  [OK] reported to CineVault (Beheer -> Gezondheid)' -ForegroundColor Green
  } catch {
    Write-Log "WARN could not report the backup to the API: $($_.Exception.Message)"
    Write-Host "  [WARN] could not report the backup to CineVault: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}
exit 0
