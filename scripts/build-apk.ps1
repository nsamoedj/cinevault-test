<#
.SYNOPSIS
  Builds the Android APKs on the N100 itself, in Docker (no GitHub needed).

.DESCRIPTION
  Builds the app (apps/mobile) from the committed code in this folder (git
  pull first) in a Docker container with the Android SDK, and puts the APKs in
  downloads\, where Caddy serves them:

    https://<domain>/android   CineVault.apk (phones)
    https://<domain>/tv        CineVault-TV.apk (Android TV, also 32-bit)

    powershell -ExecutionPolicy Bypass -File .\scripts\build-apk.ps1
    .\scripts\build-apk.ps1 -Variant phone      only the phone APK
    .\scripts\build-apk.ps1 -Aab                also play\CineVault.aab for Google Play
                                                (phones, TVs and cars: docs\android.md, part 9)
    .\scripts\build-apk.ps1 -Fresh              start over (after a strange error)

  The first build downloads the Android SDK, the NDK and Gradle's libraries
  (5-8 GB, in Docker volumes) and takes 30-45 minutes. Later ones are one
  Gradle build for both APKs (ABI splits), and keep the android folder of the
  build before when the native setup didn't change (app.json, package.json,
  the plugins and modules, pnpm-lock.yaml): then only the JavaScript and what
  changed is built, about 5-10 minutes.
  While it runs the N100 is busy: build when nobody is watching.

  Signing: with the key of scripts\android-key.ps1 (Documents\CineVault-android).
  Without that key: -DebugKey signs with Expo's public debug key, the same file
  as in GitHub's builds without the key secrets, so it installs over those.
  Switching from the debug key to the own key means removing the app once.
#>
param(
  [ValidateSet('all', 'phone', 'tv')]
  [string]$Variant = 'all',
  [switch]$Fresh,
  # Also the app bundle for the Play Console (play\CineVault.aab, not served by Caddy).
  [switch]$Aab,
  # Cores for the build; the N100 has 4, one stays free for streaming.
  [ValidateRange(1, 16)]
  [int]$Cpus = 3,
  [string]$KeyDir = (Join-Path $HOME (Join-Path 'Documents' 'CineVault-android')),
  # Sign with Expo's public debug key (as GitHub did without the key secrets).
  [switch]$DebugKey
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
$downloads = Join-Path $repo 'downloads'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
$image = 'cinevault-android-builder'

function Ok($text) { Write-Host "  [OK] $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  [!]  $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "  [FAIL] $text" -ForegroundColor Red; exit 1 }

# Docker reports progress on stderr; Windows PowerShell 5.1 would stop on that.
function Invoke-Native([scriptblock]$command) {
  $ErrorActionPreference = 'Continue'
  try {
    & $command 2>&1 | ForEach-Object { "$_" } | ForEach-Object { Write-Host $_ }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = 'Stop'
  }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'docker not found: start Docker Desktop first' }
$ErrorActionPreference = 'Continue'
docker info *> $null
$dockerUp = $LASTEXITCODE -eq 0
$ErrorActionPreference = 'Stop'
if (-not $dockerUp) { Fail 'Docker Desktop is not running: start it and try again' }

# Only committed code is built.
$ErrorActionPreference = 'Continue'
$changes = git status --porcelain -- apps/mobile packages/shared 2>$null
$commit = "$(git rev-parse --short HEAD 2>$null)"
$ErrorActionPreference = 'Stop'
if ($changes) { Warn 'apps/mobile or packages/shared has changes that are not committed: they are not in the build' }
Ok "code: commit $commit"

# The signing key and its password (from github-secrets.txt of android-key.ps1).
$keystore = Join-Path $KeyDir 'cinevault-upload.keystore'
$secrets = Join-Path $KeyDir 'github-secrets.txt'
$password = $null
$alias = 'cinevault'
if (-not $DebugKey) {
  if (-not (Test-Path $keystore)) {
    Write-Host "  [FAIL] no signing key in $KeyDir. Either:" -ForegroundColor Red
    Write-Host '         - make one with .\scripts\android-key.ps1 (then remove the app from phone and TV once), or'
    Write-Host '         - build with -DebugKey: Expo''s debug key, like the APKs from GitHub so far (installs over them)'
    exit 1
  }
  if (-not (Test-Path $secrets)) { Fail "$secrets is missing: it has the key's password" }
  $lines = Get-Content $secrets
  for ($i = 0; $i -lt $lines.Count - 1; $i++) {
    if ($lines[$i] -match '^Name:\s+ANDROID_UPLOAD_KEYSTORE_PASSWORD\s*$' -and $lines[$i + 1] -match '^Value:\s+(\S+)') {
      $password = $Matches[1]
    }
    if ($lines[$i] -match '^Name:\s+ANDROID_UPLOAD_KEY_ALIAS\s*$' -and $lines[$i + 1] -match '^Value:\s+(\S+)') {
      $alias = $Matches[1]
    }
  }
  if (-not $password) { Fail "no password found in $secrets" }
  Ok "signing key: $keystore"
} else {
  Warn 'signing with the debug key: installs over APKs signed with it (the ones from GitHub so far), not over ones with the own key'
}

Write-Host "`n== Build environment ($image)"
$code = Invoke-Native { docker build -t $image -f docker/android-builder/Dockerfile docker/android-builder }
if ($code -ne 0) { Fail "docker build failed (exit code $code)" }

if ($Fresh) {
  Write-Host "`n== Starting over: removing the copy of the code and the caches"
  Invoke-Native { docker volume rm cinevault-android-work } | Out-Null
}

$variants = switch ($Variant) { 'phone' { 'phone' } 'tv' { 'tv' } default { 'tv phone' } }
$started = Get-Date
$env:CINEVAULT_KEY_PASSWORD = $password
$env:CINEVAULT_KEY_ALIAS = $alias
$env:VARIANTS = $variants
$env:AAB = if ($Aab) { '1' } else { '0' }
$play = Join-Path $repo 'play'
if ($Aab) { New-Item -ItemType Directory -Force -Path $play | Out-Null }
try {
  # Gradle's output, for when a build fails (not in downloads\, which Caddy serves).
  $logs = Join-Path $repo 'logs'
  New-Item -ItemType Directory -Force -Path $logs | Out-Null
  $mounts = @('-v', "${repo}:/src:ro", '-v', "${downloads}:/out", '-v', "${logs}:/logs", '-v', 'cinevault-android-work:/work',
    '-v', 'cinevault-android-sdk:/opt/android-sdk')
  if ($Aab) { $mounts += @('-v', "${play}:/play") }
  if (-not $DebugKey) { $mounts += @('-v', "${KeyDir}:/keys:ro") }
  $code = Invoke-Native {
    docker run --rm --cpus $Cpus -e CINEVAULT_KEY_PASSWORD -e CINEVAULT_KEY_ALIAS -e VARIANTS -e AAB @mounts `
      $image bash /src/docker/android-builder/build.sh
  }
} finally {
  Remove-Item Env:CINEVAULT_KEY_PASSWORD, Env:CINEVAULT_KEY_ALIAS, Env:VARIANTS, Env:AAB -ErrorAction SilentlyContinue
}
$minutes = [math]::Round(((Get-Date) - $started).TotalMinutes)
if ($code -ne 0) { Fail "the build failed after $minutes min (exit code $code). The reason is under 'What went wrong' above; the whole output is in logs\android-build.log. Try again with -Fresh if it keeps failing." }

Write-Host ''
Ok "built in $minutes min: $(Get-Content (Join-Path $downloads 'build.txt'))"
Get-ChildItem $downloads -Filter '*.apk' | ForEach-Object {
  Write-Host ("       {0}  {1:N0} MB  {2}" -f $_.Name, ($_.Length / 1MB), $_.LastWriteTime)
}
$domain = $null
if (Test-Path (Join-Path $repo '.env')) {
  $line = Get-Content (Join-Path $repo '.env') | Where-Object { $_ -match '^PUBLIC_DOMAIN=(.+)$' } | Select-Object -First 1
  if ($line -and $line -match '^PUBLIC_DOMAIN=(.+)$') { $domain = $Matches[1].Trim() }
}
$base = if ($domain) { "https://$domain" } else { 'http://<N100>:8765' }
Write-Host "       Phone: $base/android    TV: $base/tv"
if ($Aab -and (Test-Path (Join-Path $play 'CineVault.aab'))) {
  Write-Host "       Google Play: $(Join-Path $play 'CineVault.aab') (upload it in the Play Console: docs\android.md, part 9)"
}
