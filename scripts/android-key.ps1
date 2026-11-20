<#
.SYNOPSIS
  Makes CineVault's own signing key for the Android app (once).

.DESCRIPTION
  Android only installs a new version of an app over the old one when both are
  signed with the same key. This script makes that key with keytool in a
  Docker container (no Java needed on Windows). scripts\build-apk.ps1 signs
  with it; the three values in github-secrets.txt are for GitHub Actions
  (docs/android.md).

    powershell -ExecutionPolicy Bypass -File .\scripts\android-key.ps1

  Where: Documents\CineVault-android (-OutDir), with
    cinevault-upload.keystore  the key itself: keep it, and back it up
    github-secrets.txt         the values for the repository secrets

  The key is never overwritten. Without it (lost or never made), a new APK
  only installs after the app has been removed from the phone.
#>
param(
  [string]$OutDir = (Join-Path $HOME (Join-Path 'Documents' 'CineVault-android')),
  [string]$Alias = 'cinevault'
)

$ErrorActionPreference = 'Stop'
$keystore = Join-Path $OutDir 'cinevault-upload.keystore'
$secrets = Join-Path $OutDir 'github-secrets.txt'

if (Test-Path $keystore) {
  Write-Host "  [OK] there is already a key: $keystore" -ForegroundColor Green
  Write-Host "       The values for GitHub are in $secrets"
  exit 0
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host '  [FAIL] docker not found: start Docker Desktop first' -ForegroundColor Red
  exit 1
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$bytes = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$password = -join ($bytes | ForEach-Object { $_.ToString('x2') })

# The password goes in as an environment variable, not on the command line.
# keytool reports on stderr; Windows PowerShell 5.1 would stop on that.
$env:CINEVAULT_KEY_PASSWORD = $password
$ErrorActionPreference = 'Continue'
try {
  docker run --rm -e CINEVAULT_KEY_PASSWORD -v "${OutDir}:/out" eclipse-temurin:21-jre `
    keytool -genkeypair -storetype PKCS12 -keystore /out/cinevault-upload.keystore `
    -alias $Alias -keyalg RSA -keysize 4096 -validity 10000 -dname 'CN=CineVault' `
    -storepass:env CINEVAULT_KEY_PASSWORD -keypass:env CINEVAULT_KEY_PASSWORD 2>&1 |
    ForEach-Object { "$_" } | Where-Object { $_ -notmatch 'password' } | ForEach-Object { Write-Host "       $_" }
  $exitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = 'Stop'
  Remove-Item Env:CINEVAULT_KEY_PASSWORD -ErrorAction SilentlyContinue
}
if ($exitCode -ne 0) { throw "keytool failed (exit $exitCode)" }
if (-not (Test-Path $keystore)) { throw "no key was written to $keystore" }

$base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($keystore))
$text = @(
  'CineVault Android signing key: the values for GitHub.',
  'GitHub -> the repository -> Settings -> Secrets and variables -> Actions ->',
  'New repository secret. Make three secrets, with these names and values:',
  '',
  'Name:  ANDROID_UPLOAD_KEYSTORE',
  "Value: $base64",
  '',
  'Name:  ANDROID_UPLOAD_KEYSTORE_PASSWORD',
  "Value: $password",
  '',
  'Name:  ANDROID_UPLOAD_KEY_ALIAS',
  "Value: $Alias",
  '',
  'Keep this folder (and a copy of it). Do not share it and do not commit it.'
)
[IO.File]::WriteAllLines($secrets, $text, (New-Object System.Text.UTF8Encoding $false))

Write-Host "  [OK] key made: $keystore" -ForegroundColor Green
Write-Host '       Build the app with it: .\scripts\build-apk.ps1'
Write-Host '       The first APK with this key only installs after removing the app (phone and TV) once.'
Write-Host "       For builds on GitHub: add the three secrets in $secrets (docs/android.md)."
Write-Host '       Back up this folder: without the key, updates need the app removed again.'
