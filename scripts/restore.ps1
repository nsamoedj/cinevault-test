<#
.SYNOPSIS
  Puts a backup of the CineVault database back (see scripts\backup.ps1).

.DESCRIPTION
  Replaces the whole database with the backup: accounts, watch progress and
  matches as they were then. Before that it backs up the current database
  (tag before-restore), so a restore can be undone.

    powershell -ExecutionPolicy Bypass -File .\scripts\restore.ps1                 (the newest backup)
    powershell -ExecutionPolicy Bypass -File .\scripts\restore.ps1 -File <path>
    powershell -ExecutionPolicy Bypass -File .\scripts\restore.ps1 -List

  The API is stopped meanwhile and started again afterwards; on start it
  applies any newer migrations, so an older backup works with newer code.
#>
param(
  [string]$File,
  [switch]$List,
  # Skip the question (for scripts).
  [switch]$Force,
  [string]$BackupDir
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo

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
$user = $envValues['POSTGRES_USER']
$database = $envValues['POSTGRES_DB']
if (-not $user -or -not $database) { throw 'POSTGRES_USER and POSTGRES_DB must be set in .env' }

$backups = @()
if (Test-Path $BackupDir) {
  $backups = @(Get-ChildItem -Path $BackupDir -Filter 'cinevault-*.dump' -File | Sort-Object Name -Descending)
}

if ($List) {
  if ($backups.Count -eq 0) { Write-Host "  no backups in $BackupDir" -ForegroundColor Yellow }
  $backups | ForEach-Object { Write-Host ('  {0}  {1:yyyy-MM-dd HH:mm}  {2:N1} MB' -f $_.Name, $_.LastWriteTime, ($_.Length / 1MB)) }
  exit 0
}

if ($File) {
  if (-not (Test-Path $File)) { throw "$File not found" }
  $backup = Get-Item $File
} else {
  if ($backups.Count -eq 0) { throw "no backups in $BackupDir (scripts\backup.ps1 makes them)" }
  # The newest nightly one; tagged backups (before-restore, ...) only with -File.
  $nightly = @($backups | Where-Object { $_.Name -match '^cinevault-\d{4}-\d{2}-\d{2}_\d{4}\.dump$' })
  $backup = if ($nightly.Count -gt 0) { $nightly[0] } else { $backups[0] }
}

Write-Host "== Restore $($backup.Name) ($('{0:yyyy-MM-dd HH:mm}' -f $backup.LastWriteTime))"
Write-Host '   This replaces the current database: accounts, watch progress and matches' -ForegroundColor Yellow
Write-Host '   go back to how they were then. The current database is backed up first.' -ForegroundColor Yellow
if (-not $Force) {
  $answer = Read-Host '   Type RESTORE to continue'
  if ($answer -cne 'RESTORE') {
    Write-Host '   Nothing changed.'
    exit 1
  }
}

# A way back, in case this was the wrong backup.
& (Join-Path $PSScriptRoot 'backup.ps1') -Tag before-restore -BackupDir $BackupDir
if ($LASTEXITCODE -ne 0) { throw 'backing up the current database failed; nothing was restored' }

$inner = '/tmp/cinevault-restore.dump'
$failed = $null
Write-Host '== Stopping the API'
docker compose stop api | Out-Null
try {
  docker compose cp $backup.FullName "db:$inner"
  if ($LASTEXITCODE -ne 0) { throw "copying the backup into the container failed (exit code $LASTEXITCODE)" }
  # All or nothing: the backup goes into a database of its own, and only when
  # that worked does it take the place of the current one. (Restoring over the
  # current one fails for a backup from before a newer migration: its tables
  # are not in the backup, and they still point at the old ones.)
  $staging = "${database}_restore"
  $previous = "${database}_previous"
  docker compose exec -T db psql -U $user -d postgres -v ON_ERROR_STOP=1 -q `
    -c "DROP DATABASE IF EXISTS $staging WITH (FORCE)" -c "CREATE DATABASE $staging"
  if ($LASTEXITCODE -ne 0) { throw "making a database for the restore failed (exit code $LASTEXITCODE); the database is unchanged" }
  docker compose exec -T db pg_restore -U $user -d $staging --no-owner --exit-on-error $inner
  if ($LASTEXITCODE -ne 0) {
    docker compose exec -T db psql -U $user -d postgres -q -c "DROP DATABASE IF EXISTS $staging WITH (FORCE)" | Out-Null
    throw "pg_restore failed (exit code $LASTEXITCODE); the database is unchanged"
  }
  # The swap: the old database aside, the restored one in its place, then the old one away.
  docker compose exec -T db psql -U $user -d postgres -v ON_ERROR_STOP=1 -q `
    -c "DROP DATABASE IF EXISTS $previous WITH (FORCE)" `
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$database' AND pid <> pg_backend_pid()" `
    -c "ALTER DATABASE $database RENAME TO $previous" `
    -c "ALTER DATABASE $staging RENAME TO $database" `
    -c "DROP DATABASE $previous WITH (FORCE)"
  if ($LASTEXITCODE -ne 0) { throw "swapping in the restored database failed (exit code $LASTEXITCODE); check with docker compose exec db psql -U $user -l" }
  docker compose exec -T db rm -f $inner | Out-Null
} catch {
  $failed = $_.Exception.Message
} finally {
  Write-Host '== Starting the API'
  docker compose start api | Out-Null
}

if ($failed) {
  Write-Host "  [FAIL] $failed" -ForegroundColor Red
  exit 1
}
Write-Host "  [OK] $($backup.Name) restored. Log in again on your devices if asked." -ForegroundColor Green
exit 0
