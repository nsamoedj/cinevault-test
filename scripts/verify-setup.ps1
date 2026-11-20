<#
.SYNOPSIS
  Checks the CineVault server setup (docs/server-setup.md) and writes a report.

.DESCRIPTION
  Read-only: changes nothing. Run from the repo:
    powershell -ExecutionPolicy Bypass -File .\scripts\verify-setup.ps1

  Writes setup-report.txt in the repo root. The report never contains
  passwords or API keys: for secrets in .env it only says whether they are set.
#>
param(
  [string]$ReportFile
)

$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
if (-not $ReportFile) { $ReportFile = Join-Path $repo 'setup-report.txt' }

$script:lines = New-Object System.Collections.Generic.List[string]
$script:counts = @{ OK = 0; WARN = 0; FAIL = 0 }

function Section([string]$title) {
  Write-Host ''
  Write-Host "== $title"
  $script:lines.Add('')
  $script:lines.Add("== $title")
}

function Check([string]$status, [string]$message) {
  $colors = @{ OK = 'Green'; WARN = 'Yellow'; FAIL = 'Red'; INFO = 'Gray' }
  $text = "  [{0,-4}] {1}" -f $status, $message
  Write-Host $text -ForegroundColor $colors[$status]
  $script:lines.Add($text)
  if ($script:counts.ContainsKey($status)) { $script:counts[$status]++ }
}

function Test-Command([string]$name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# Runs a native command; returns @{ Ok; Output } with output as trimmed lines.
function Invoke-Native([string]$exe, [string[]]$arguments) {
  $output = @(& $exe @arguments 2>&1 | ForEach-Object { "$_".TrimEnd() })
  return @{ Ok = ($LASTEXITCODE -eq 0); Output = $output }
}

# --- System -------------------------------------------------------------------
Section 'System'
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
if ($os) {
  Check INFO "$($os.Caption) (build $($os.BuildNumber))"
  $computer = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
  $cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
  Check INFO ('{0}, {1:N0} GB RAM' -f $cpu.Name.Trim(), ($computer.TotalPhysicalMemory / 1GB))
  $gpu = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'Intel' } | Select-Object -First 1
  if ($gpu) { Check OK "$($gpu.Name), driver $($gpu.DriverVersion)" }
  else { Check FAIL 'no Intel GPU found' }
} else {
  Check WARN 'not running on Windows, system checks skipped'
}

if (Test-Command powercfg) {
  # The last two hex values of the query are the AC and DC setting (0 = never).
  $sleep = (powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE) -join "`n"
  $values = [regex]::Matches($sleep, '0x([0-9a-fA-F]{8})')
  if ($values.Count -ge 2) {
    $ac = [Convert]::ToInt32($values[$values.Count - 2].Groups[1].Value, 16)
    if ($ac -eq 0) { Check OK 'sleep on AC power: never' }
    else { Check WARN "sleep on AC power after $([int]($ac / 60)) min (step 1: powercfg /change standby-timeout-ac 0)" }
  }
}

if (Test-Command Get-NetConnectionProfile) {
  foreach ($netProfile in Get-NetConnectionProfile -ErrorAction SilentlyContinue) {
    if ("$($netProfile.NetworkCategory)" -eq 'Private') { Check OK "network '$($netProfile.Name)' is Private" }
    else { Check WARN "network '$($netProfile.Name)' is $($netProfile.NetworkCategory), should be Private (step 1)" }
  }
}

if (Test-Command Get-NetIPAddress) {
  $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Loopback' } |
      ForEach-Object { $_.IPAddress })
  if ($ips.Count -gt 0) { Check INFO "LAN address(es): $($ips -join ', ')" }
}

# --- Tools --------------------------------------------------------------------
Section 'Tools'
foreach ($tool in @('git', 'ffmpeg', 'docker')) {
  if (Test-Command $tool) {
    $version = switch ($tool) {
      'git' { (Invoke-Native git @('--version')).Output | Select-Object -First 1 }
      'ffmpeg' { (Invoke-Native ffmpeg @('-hide_banner', '-version')).Output | Select-Object -First 1 }
      'docker' { (Invoke-Native docker @('--version')).Output | Select-Object -First 1 }
    }
    Check OK $version
  } else {
    Check FAIL "$tool not found (step 4)"
  }
}

if (Test-Command node) {
  $nodeVersion = ((Invoke-Native node @('--version')).Output | Select-Object -First 1).TrimStart('v')
  $parts = $nodeVersion.Split('.') | ForEach-Object { [int]$_ }
  if ($parts[0] -gt 22 -or ($parts[0] -eq 22 -and $parts[1] -ge 18)) { Check OK "Node.js $nodeVersion (for the transcoder)" }
  else { Check FAIL "Node.js $nodeVersion is too old for the transcoder, 22.18+ needed (step 14)" }
} else {
  Check WARN 'Node.js not found: needed for the transcoder (step 14: winget install OpenJS.NodeJS.LTS)'
}

if (Test-Command git) {
  $branch = (Invoke-Native git @('rev-parse', '--abbrev-ref', 'HEAD')).Output | Select-Object -First 1
  $commit = (Invoke-Native git @('log', '-1', '--format=%h %cs %s')).Output | Select-Object -First 1
  Check INFO "repo: $branch @ $commit"
}

# --- Docker -------------------------------------------------------------------
Section 'Docker'
$dockerUp = $false
if (Test-Command docker) {
  $server = Invoke-Native docker @('version', '--format', '{{.Server.Version}}')
  if ($server.Ok -and $server.Output[0]) {
    $dockerUp = $true
    Check OK "Docker engine running (server $($server.Output[0]))"
  } else {
    Check FAIL 'Docker engine not reachable: start Docker Desktop (step 3)'
  }
  $context = (Invoke-Native docker @('context', 'show')).Output | Select-Object -First 1
  if ($context -eq 'desktop-linux') { Check OK "context: $context" }
  elseif ($context) { Check WARN "context: $context (expected desktop-linux, step 3)" }
  $compose = Invoke-Native docker @('compose', 'version', '--short')
  if ($compose.Ok) { Check INFO "compose $($compose.Output[0])" }
  $buildx = Invoke-Native docker @('buildx', 'version')
  if ($buildx.Ok) { Check INFO ($buildx.Output | Select-Object -First 1) }
}

$wslConfig = if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.wslconfig' } else { $null }
if ($wslConfig -and (Test-Path $wslConfig)) {
  $memory = Select-String -Path $wslConfig -Pattern '^\s*memory\s*=\s*(\S+)' | Select-Object -First 1
  if ($memory) { Check OK ".wslconfig memory=$($memory.Matches[0].Groups[1].Value)" }
  else { Check INFO '.wslconfig exists without a memory limit' }
} elseif ($env:USERPROFILE) {
  Check INFO 'no .wslconfig (optional memory limit, step 3)'
}

# --- .env ---------------------------------------------------------------------
Section '.env'
$envValues = @{}
if (Test-Path .env) {
  foreach ($line in Get-Content .env) {
    $line = $line.TrimStart([char]0xFEFF)
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$') {
      $envValues[$Matches[1]] = $Matches[2].Trim('"', "'")
    }
  }
  Check OK '.env exists'

  foreach ($key in @('POSTGRES_USER', 'POSTGRES_DB')) {
    if ($envValues[$key]) { Check OK "$key = $($envValues[$key])" } else { Check FAIL "$key is empty" }
  }

  $password = $envValues['POSTGRES_PASSWORD']
  if (-not $password) { Check FAIL 'POSTGRES_PASSWORD is empty (step 8)' }
  elseif ($password -eq 'change-me') { Check FAIL 'POSTGRES_PASSWORD is still the example value change-me (step 8)' }
  elseif ($password -notmatch '^[A-Za-z0-9]+$') { Check WARN 'POSTGRES_PASSWORD contains characters other than letters/digits; that can break DATABASE_URL' }
  elseif ($password.Length -lt 16) { Check WARN "POSTGRES_PASSWORD is set but short ($($password.Length) characters)" }
  else { Check OK "POSTGRES_PASSWORD is set ($($password.Length) characters)" }

  $mediaRoot = $envValues['MEDIA_ROOT']
  if (-not $mediaRoot) {
    Check FAIL 'MEDIA_ROOT is empty (step 8)'
  } elseif (-not (Test-Path $mediaRoot)) {
    Check FAIL "MEDIA_ROOT = $mediaRoot does not exist"
  } else {
    Check OK "MEDIA_ROOT = $mediaRoot"
    foreach ($library in @('Movies', 'Series', 'Anime')) {
      $path = Join-Path $mediaRoot $library
      if (Test-Path $path) {
        $count = @(Get-ChildItem $path -Directory -ErrorAction SilentlyContinue).Count
        Check OK "$library found ($count folders)"
      } else {
        Check WARN "$library not found in MEDIA_ROOT"
      }
    }
  }

  $transcode = $envValues['TRANSCODE_TMP']
  if (-not $transcode) { Check FAIL 'TRANSCODE_TMP is empty (step 8)' }
  elseif (Test-Path $transcode) { Check OK "TRANSCODE_TMP = $transcode" }
  else { Check FAIL "TRANSCODE_TMP = $transcode does not exist (step 7)" }

  if ($envValues['TRANSCODER_TOKEN']) { Check OK 'TRANSCODER_TOKEN is set' }
  else { Check WARN 'TRANSCODER_TOKEN is empty: no transcoding (step 14: scripts\transcoder.ps1 -Install)' }

  foreach ($key in @('TMDB_API_KEY', 'OPENSUBTITLES_API_KEY')) {
    if ($envValues[$key]) { Check OK "$key is set" } else { Check INFO "$key is empty (needed later)" }
  }
  foreach ($key in @('JWT_SECRET', 'API_TOKEN', 'WEBHOOK_TOKEN')) {
    $value = "$($envValues[$key])"
    if ($value.Length -ge 32) { Check OK "$key is set ($($value.Length) characters)" }
    elseif ($value) { Check WARN "$key is shorter than 32 characters: remove the line and run scripts\up.ps1" }
    else { Check WARN "$key is empty: scripts\up.ps1 creates it (step 16)" }
  }
} else {
  Check FAIL '.env not found in the repo root (step 8)'
}

# Scripts log in to the API with API_TOKEN.
$apiHeaders = @{ Authorization = "Bearer $($envValues['API_TOKEN'])" }

# --- Containers ---------------------------------------------------------------
Section 'Containers'
if ($dockerUp) {
  $ps = Invoke-Native docker @('compose', 'ps', '--all', '--format', 'json')
  $text = ($ps.Output -join "`n").Trim()
  $containers = @()
  # Windows PowerShell 5.1 emits a JSON array as one object; ForEach-Object unrolls it.
  if ($text.StartsWith('[')) { $containers = @($text | ConvertFrom-Json | ForEach-Object { $_ }) }
  elseif ($text) { $containers = @($ps.Output | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json }) }

  foreach ($service in @('db', 'api', 'web')) {
    $container = $containers | Where-Object { $_.Service -eq $service } | Select-Object -First 1
    if (-not $container) { Check FAIL "$service container not found (step 9: scripts\up.ps1)" }
    elseif ($container.Health -eq 'healthy') { Check OK "$service is $($container.State), healthy" }
    else { Check FAIL "$service is $($container.State), health: $($container.Health) (docker compose logs $service)" }
  }

  $port = 3000
  if ($envValues['API_PORT'] -match '^\d+$') { $port = [int]$envValues['API_PORT'] }
  try {
    $health = Invoke-RestMethod -Uri "http://localhost:$port/api/health" -TimeoutSec 5
    if ($health.status -eq 'ok') { Check OK "http://localhost:$port/api/health: ok, database $($health.database), version $($health.version)" }
    else { Check FAIL "/api/health: status $($health.status), database $($health.database)" }
  } catch {
    Check FAIL "/api/health not reachable on port ${port}: $($_.Exception.Message)"
  }

  $webPort = 8765
  if ($envValues['WEB_PORT'] -match '^\d+$') { $webPort = [int]$envValues['WEB_PORT'] }
  try {
    $page = Invoke-WebRequest -Uri "http://localhost:$webPort/" -UseBasicParsing -TimeoutSec 5
    $viaCaddy = Invoke-RestMethod -Uri "http://localhost:$webPort/api/health" -TimeoutSec 5
    if ($page.Content -match 'id="root"' -and $viaCaddy.status -eq 'ok') {
      Check OK "web interface on http://localhost:$webPort/ (API reachable through Caddy)"
    } else {
      Check FAIL "web interface on port $webPort answers, but not as expected"
    }
  } catch {
    Check FAIL "web interface not reachable on port ${webPort}: $($_.Exception.Message)"
  }

  $media = Invoke-Native docker @('compose', 'exec', '-T', 'api', 'ls', '/media')
  if ($media.Ok) { Check OK "/media in the api container: $(($media.Output | Where-Object { $_ }) -join ', ')" }
  else { Check FAIL "cannot list /media in the api container: $($media.Output | Select-Object -Last 1)" }

  $readOnly = Invoke-Native docker @('compose', 'exec', '-T', 'api', 'sh', '-c', 'touch /media/.cinevault-write-test 2>/dev/null && rm -f /media/.cinevault-write-test && echo writable || echo read-only')
  if (($readOnly.Output -join '') -match 'read-only') { Check OK '/media is read-only in the container' }
  else { Check FAIL '/media is writable in the container; it should be mounted :ro' }
  # Docker Desktop sometimes loses the disk; this task restarts it (docs/server-setup.md, step 42).
  $watchdog = Get-ScheduledTask -TaskName 'CineVault Media Watchdog' -ErrorAction SilentlyContinue
  if ($watchdog) { Check OK "scheduled task 'CineVault Media Watchdog': $($watchdog.State)" }
  elseif (Test-Command Get-ScheduledTask) { Check WARN 'no media watchdog: run scripts\media-watchdog.ps1 -Install (step 42)' }

  $ffprobe = Invoke-Native docker @('compose', 'exec', '-T', 'api', 'ffprobe', '-hide_banner', '-version')
  if ($ffprobe.Ok) { Check OK "ffprobe in the api container: $($ffprobe.Output | Select-Object -First 1)" }
  else { Check FAIL 'ffprobe missing in the api container: rebuild with scripts\up.ps1' }

  $cache = Invoke-Native docker @('compose', 'exec', '-T', 'api', 'sh', '-c', 'touch /cache/.cinevault-write-test && rm -f /cache/.cinevault-write-test && echo writable')
  if (($cache.Output -join '') -match 'writable') { Check OK '/cache is writable in the container' }
  else { Check FAIL '/cache is not writable in the container' }

  try {
    $libraries = @(Invoke-RestMethod -Uri "http://localhost:$port/api/libraries" -Headers $apiHeaders -TimeoutSec 5 | ForEach-Object { $_ })
    if ($libraries.Count -gt 0) {
      Check OK ("libraries: " + (($libraries | ForEach-Object { "$($_.name) ($($_.type), $($_.itemCount) titles)" }) -join ', '))
    } else {
      Check WARN 'no libraries yet: check that MEDIA_ROOT contains Movies, Series and Anime, then restart'
    }
  } catch {
    Check WARN "could not list libraries: $($_.Exception.Message)"
  }

  # Accounts (phase 5): only counted, no names or passwords.
  try {
    $auth = Invoke-RestMethod -Uri "http://localhost:$port/api/auth/status" -TimeoutSec 5
    if ($auth.setupRequired) {
      Check WARN "no accounts yet: open http://localhost:$webPort/ and make the admin account (step 16)"
    } else {
      $users = @(Invoke-RestMethod -Uri "http://localhost:$port/api/users" -Headers $apiHeaders -TimeoutSec 5 | ForEach-Object { $_ })
      $admins = @($users | Where-Object { $_.role -eq 'ADMIN' }).Count
      Check OK "accounts: $($users.Count) ($admins admin)"
    }
  } catch {
    $code = 0
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -eq 401) { Check FAIL 'the API does not accept API_TOKEN: restart it with scripts\up.ps1' }
    else { Check WARN "could not check the accounts: $($_.Exception.Message)" }
  }

  if ($envValues['POSTGRES_USER'] -and $envValues['POSTGRES_DB']) {
    $sql = "select count(*) from _prisma_migrations where finished_at is not null; select count(*) from information_schema.tables where table_schema = 'public' and table_name <> '_prisma_migrations';"
    $db = Invoke-Native docker @('compose', 'exec', '-T', 'db', 'psql', '-U', $envValues['POSTGRES_USER'], '-d', $envValues['POSTGRES_DB'], '-Atc', $sql)
    if ($db.Ok -and $db.Output.Count -ge 2) { Check OK "database: $($db.Output[0]) migration(s) applied, $($db.Output[1]) tables" }
    else { Check FAIL "cannot query the database: $($db.Output | Select-Object -Last 1)" }
  }
} else {
  Check FAIL 'skipped: Docker engine not running'
}

# --- Transcoder ---------------------------------------------------------------
Section 'Transcoder'
$task = Get-ScheduledTask -TaskName 'CineVault Transcoder' -ErrorAction SilentlyContinue
if ($task) { Check OK "scheduled task 'CineVault Transcoder': $($task.State)" }
elseif (Test-Command Get-ScheduledTask) { Check WARN 'no scheduled task: run scripts\transcoder.ps1 -Install (step 14)' }

$transcoderPort = 8766
if ($envValues['TRANSCODER_PORT'] -match '^\d+$') { $transcoderPort = [int]$envValues['TRANSCODER_PORT'] }
$onHost = $false
try {
  $headers = @{ Authorization = "Bearer $($envValues['TRANSCODER_TOKEN'])" }
  $transcoder = Invoke-RestMethod -Uri "http://127.0.0.1:$transcoderPort/health" -Headers $headers -TimeoutSec 5
  $onHost = $true
  if ($transcoder.hwaccel -eq 'qsv') { Check OK "transcoder on port ${transcoderPort}: video on the GPU (QSV), $($transcoder.ffmpeg)" }
  elseif ($transcoder.ready) { Check WARN "transcoder on port ${transcoderPort} encodes on the CPU: $(@($transcoder.notes) -join '; ')" }
  else { Check WARN "transcoder on port ${transcoderPort} is still testing FFmpeg" }
  if ($transcoder.ready) {
    if ($transcoder.tonemap) { Check OK 'HDR to SDR tone mapping on the GPU works' }
    else { Check WARN 'no HDR tone mapping on the GPU: transcoded HDR films look flat (remux and direct play are fine)' }
    Check INFO "at most $($transcoder.maxTranscodes) transcodes at a time (TRANSCODER_MAX_TRANSCODES)"
  }
} catch {
  Check FAIL "transcoder not reachable on 127.0.0.1:${transcoderPort}: $($_.Exception.Message) (scripts\transcoder.ps1 -Status)"
}

if ($dockerUp) {
  try {
    $status = Invoke-RestMethod -Uri "http://localhost:$port/api/transcoder" -Headers $apiHeaders -TimeoutSec 10
    if ($status.available) { Check OK 'the API reaches the transcoder (host.docker.internal)' }
    elseif ($onHost) { Check FAIL "the API does not reach the transcoder: $($status.error) (step 14: TRANSCODER_HOST=0.0.0.0)" }
    else { Check FAIL "the API does not reach the transcoder: $($status.error)" }
  } catch {
    Check FAIL "cannot ask the API about the transcoder: $($_.Exception.Message)"
  }
}

# --- Backups ------------------------------------------------------------------
Section 'Backups'
$backupDir = $envValues['BACKUP_DIR']
if (-not $backupDir) { $backupDir = Join-Path $HOME (Join-Path 'Documents' 'CineVault-backups') }
$backupTask = Get-ScheduledTask -TaskName 'CineVault Backup' -ErrorAction SilentlyContinue
if ($backupTask) { Check OK "scheduled task 'CineVault Backup': $($backupTask.State)" }
elseif (Test-Command Get-ScheduledTask) { Check WARN 'no nightly backup: run scripts\backup.ps1 -Install (step 18)' }
$latest = $null
if (Test-Path $backupDir) {
  $latest = Get-ChildItem -Path $backupDir -Filter 'cinevault-*.dump' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
}
if ($latest) {
  $age = (Get-Date) - $latest.LastWriteTime
  $count = @(Get-ChildItem -Path $backupDir -Filter 'cinevault-*.dump' -File).Count
  $line = "latest backup $($latest.Name), $([int]$age.TotalHours) h ago ($count in $backupDir)"
  if ($age.TotalHours -le 48) { Check OK $line } else { Check WARN "${line}: older than 2 days (scripts\backup.ps1 -Status)" }
} else {
  Check WARN "no backups yet in $backupDir (step 18)"
}

# --- Public access ------------------------------------------------------------
Section 'Public access'
. (Join-Path $PSScriptRoot 'lib\public-access.ps1')
$httpPort = if ($envValues['HTTP_PORT'] -match '^\d+$') { [int]$envValues['HTTP_PORT'] } else { 80 }
$httpsPort = if ($envValues['HTTPS_PORT'] -match '^\d+$') { [int]$envValues['HTTPS_PORT'] } else { 443 }
Test-PublicAccess $envValues['PUBLIC_DOMAIN'] $httpPort $httpsPort { param($status, $message) Check $status $message }

if ($dockerUp) {
  # The API should only be published on the N100 itself; the apps go through Caddy.
  $apiPorts = (Invoke-Native docker @('compose', 'port', 'api', '3000')).Output | Where-Object { $_ }
  if ($apiPorts | Where-Object { $_ -notmatch '^127\.0\.0\.1:' }) { Check WARN "API port is open to the network ($($apiPorts -join ', ')): remove API_BIND from .env" }
  elseif ($apiPorts) { Check OK "API port only on this machine ($($apiPorts -join ', '))" }
}

# --- Report -------------------------------------------------------------------
$summary = "== Result: $($script:counts.OK) OK, $($script:counts.WARN) warnings, $($script:counts.FAIL) failed"
Write-Host ''
Write-Host $summary
$header = @("CineVault setup report, $(Get-Date -Format 'yyyy-MM-dd HH:mm')", 'Contains no passwords or API keys.')
Set-Content -Path $ReportFile -Encoding UTF8 -Value ($header + $script:lines + @('', $summary))
Write-Host "Report written to $ReportFile"
if ($script:counts.FAIL -gt 0) { exit 1 }
exit 0
