<#
.SYNOPSIS
  Builds the images and (re)starts CineVault with Docker Compose.

.DESCRIPTION
  Run from anywhere:
    powershell -ExecutionPolicy Bypass -File .\scripts\up.ps1

  Builds with `docker build` instead of `docker compose up --build`: on Windows,
  Compose's Bake builder rejects apps\api\Dockerfile with "additional privileges
  requested: pass --allow=fs.read=...". Waits until the API and the web
  interface answer, then prints the address to open.

  Creates JWT_SECRET (signs logins), API_TOKEN (for these scripts) and
  WEBHOOK_TOKEN (for Sonarr and Radarr, scripts/arr-webhook.ps1) in .env when
  they are missing. None is ever printed.

  -NoBuild  start with the existing images (skip the build)

  With PUBLIC_DOMAIN in .env, Caddy also serves CineVault over HTTPS on ports
  80 and 443 (docs/server-setup.md, step 20).
#>
param(
  [switch]$NoBuild,
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

# The API reports this commit in /api/health, to check that the new code runs.
$commit = 'unknown'
try {
  $head = git rev-parse --short HEAD
  if ($LASTEXITCODE -eq 0 -and $head) { $commit = "$head".Trim() }
} catch {
  # No git: the build still works, the commit just shows as unknown.
}

# Secrets the API needs: made once, kept in .env (never in git).
function New-Secret {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
}
if (-not (Test-Path .env)) { throw '.env not found in the repo root (docs/server-setup.md, step 8)' }
$lines = @(Get-Content .env)
$changed = $false
foreach ($key in @('JWT_SECRET', 'API_TOKEN', 'WEBHOOK_TOKEN')) {
  $index = -1
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match "^\s*$key\s*=") { $index = $i } }
  if ($index -ge 0 -and $lines[$index] -match "^\s*$key\s*=\s*(\S{32,})\s*$") { continue }
  $line = "$key=$(New-Secret)"
  if ($index -ge 0) { $lines[$index] = $line } else { $lines += $line }
  $changed = $true
  Write-Host "  [OK] $key created in .env" -ForegroundColor Green
}
if ($changed) {
  # No byte order mark (Set-Content -Encoding UTF8 writes one in Windows PowerShell),
  # or Docker Compose misreads the first line.
  [System.IO.File]::WriteAllLines((Join-Path (Get-Location) '.env'), [string[]]$lines, (New-Object System.Text.UTF8Encoding $false))
}
$apiToken = ($lines | Where-Object { $_ -match '^\s*API_TOKEN\s*=' } | Select-Object -Last 1) -replace '^\s*API_TOKEN\s*=\s*', ''
$apiHeaders = @{ Authorization = "Bearer $($apiToken.Trim())" }

if (-not $NoBuild) {
  foreach ($image in @('api', 'web')) {
    Write-Host "== Building image cinevault-$image (commit $commit)"
    docker build -f "apps/$image/Dockerfile" -t "cinevault-$image" --build-arg "GIT_COMMIT=$commit" .
    if ($LASTEXITCODE -ne 0) { throw "docker build of cinevault-$image failed (exit code $LASTEXITCODE)" }
  }
}

function Get-EnvPort([string]$name, [int]$default) {
  $line = Get-Content .env -ErrorAction SilentlyContinue |
    Where-Object { $_ -match "^\s*$name\s*=\s*(\d+)" } | Select-Object -First 1
  if ($line -match '(\d+)\s*$') { return [int]$Matches[1] }
  return $default
}

# Caddy (the web container) also publishes 80 and 443, for PUBLIC_DOMAIN over
# HTTPS. Another program on those ports makes the web container fail to start.
. (Join-Path $PSScriptRoot 'lib\public-access.ps1')
foreach ($port in @((Get-EnvPort 'HTTP_PORT' 80), (Get-EnvPort 'HTTPS_PORT' 443))) {
  $others = @(Get-PortOwners $port | Where-Object { $_ -notmatch $script:dockerProcess })
  if ($others.Count -gt 0) {
    Write-Host "  [!] Port $port is in use by $($others -join ', '). Stop that program, or set HTTP_PORT/HTTPS_PORT in .env (docs\server-setup.md, step 20)." -ForegroundColor Yellow
  }
}

# Caddy serves the Android APKs from here (scripts\get-apk.ps1); made here so Docker doesn't.
New-Item -ItemType Directory -Force -Path downloads | Out-Null

Write-Host '== Starting containers'
docker compose up -d
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed (exit code $LASTEXITCODE)" }

# Polls $url until $test accepts the response or the timeout passes.
function Wait-For([string]$url, [scriptblock]$test, [int]$seconds, [string]$service) {
  Write-Host "== Waiting for $url"
  $deadline = (Get-Date).AddSeconds($seconds)
  while ($true) {
    try {
      $response = Invoke-RestMethod -Uri $url -TimeoutSec 5
      if (& $test $response) { return $response }
    } catch {
      # Not up yet (connection refused, or 503 while the database starts).
    }
    if ((Get-Date) -gt $deadline) {
      docker compose ps
      throw "$url did not answer within $seconds s. Check: docker compose logs $service"
    }
    Start-Sleep -Seconds 2
  }
}

$apiPort = Get-EnvPort 'API_PORT' 3000
$webPort = Get-EnvPort 'WEB_PORT' 8765

$health = Wait-For "http://localhost:$apiPort/api/health" { param($r) $r.status -eq 'ok' } $TimeoutSeconds 'api'
Write-Host "  [OK] API is up (version $($health.version), commit $($health.commit), database $($health.database))" -ForegroundColor Green
if ($health.commit -ne $commit) {
  Write-Host "  [!] The API runs commit '$($health.commit)', but this folder is at '$commit'. Run up.ps1 without -NoBuild." -ForegroundColor Yellow
}

# The web interface goes through Caddy, which also forwards /api.
Wait-For "http://localhost:$webPort/api/health" { param($r) $r.status -eq 'ok' } 60 'web' | Out-Null
Write-Host '  [OK] Web interface is up' -ForegroundColor Green

# Transcoding needs the native transcoder (scripts\transcoder.ps1); direct play works without.
try {
  $transcoder = Invoke-RestMethod -Uri "http://localhost:$apiPort/api/transcoder" -Headers $apiHeaders -TimeoutSec 10
  if ($transcoder.available) {
    $where = if ($transcoder.hwaccel -eq 'qsv') { 'on the GPU (QSV)' } else { 'on the CPU' }
    Write-Host "  [OK] Transcoder reachable, video $where" -ForegroundColor Green
  } else {
    Write-Host "  [!] No transcoding: $($transcoder.error)" -ForegroundColor Yellow
    Write-Host '      See docs\server-setup.md, step 14 (scripts\transcoder.ps1 -Install).' -ForegroundColor Yellow
  }
} catch {
  Write-Host "  [!] Could not ask the API about the transcoder: $($_.Exception.Message)" -ForegroundColor Yellow
}

docker compose ps

Write-Host ''
Write-Host "Open CineVault: http://localhost:$webPort/" -ForegroundColor Green
$domain = (Get-Content .env | Where-Object { $_ -match '^\s*PUBLIC_DOMAIN\s*=\s*(\S+)' } | Select-Object -Last 1) -replace '^\s*PUBLIC_DOMAIN\s*=\s*', ''
if ($domain) {
  Write-Host "  from anywhere: https://$($domain.Trim())/ (check it with scripts\public-access.ps1)"
}
try {
  $auth = Invoke-RestMethod -Uri "http://localhost:$apiPort/api/auth/status" -TimeoutSec 5
  if ($auth.setupRequired) {
    Write-Host '  First visit: make the admin account there (docs\server-setup.md, step 16).' -ForegroundColor Yellow
  }
} catch {
  # Only a hint; the API answered above.
}
if (Get-Command Get-NetIPAddress -ErrorAction SilentlyContinue) {
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Loopback' } |
    ForEach-Object { Write-Host "  from other devices at home: http://$($_.IPAddress):$webPort/" }
}
