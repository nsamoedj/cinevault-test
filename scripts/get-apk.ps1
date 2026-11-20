<#
.SYNOPSIS
  Puts the newest Android APKs on the N100, so a TV can install CineVault from it.

.DESCRIPTION
  The repository is private, so a TV can't download the APK from GitHub. This
  script fetches CineVault.apk and CineVault-TV.apk from the release
  "android-latest" into the folder downloads\ in the repo. Caddy serves them:

    http://<N100>:8765/tv        CineVault-TV.apk (Android TV, also 32-bit)
    http://<N100>:8765/android   CineVault.apk (phones)

  On the TV, type that address in the Downloader app (docs/android.md, TV).

  It uses the GitHub CLI (winget install GitHub.cli, then gh auth login once).
  Without it, it opens the release page: save both APKs in downloads\ yourself.

    powershell -ExecutionPolicy Bypass -File .\scripts\get-apk.ps1
#>
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
$dir = Join-Path $repo 'downloads'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$slug = 'nsamoedj/CineVault'
try {
  $origin = "$(git remote get-url origin 2>$null)"
  if ($origin -match 'github\.com[:/]([^/]+/[^/]+?)(\.git)?$') { $slug = $Matches[1] }
} catch {
  # No git: the default repository.
}

$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $gh) {
  # Just installed with winget: this terminal's PATH doesn't have it yet.
  $installed = Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'
  if (Test-Path $installed) { $gh = Get-Command $installed }
}
if ($gh) {
  Write-Host "== Downloading the APKs of android-latest ($slug)"
  # Windows PowerShell 5.1 turns gh's progress on stderr into errors.
  $ErrorActionPreference = 'Continue'
  & $gh.Source release download android-latest --repo $slug --pattern '*.apk' --dir $dir --clobber
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($code -ne 0) {
    throw "gh release download failed (exit code $code). Logged in? Run: & '$($gh.Source)' auth login"
  }
} else {
  $page = "https://github.com/$slug/releases/tag/android-latest"
  Write-Host 'The GitHub CLI (gh) is not installed. Opening the release page:' -ForegroundColor Yellow
  Write-Host "  $page"
  Write-Host "Save CineVault-TV.apk and CineVault.apk in: $dir" -ForegroundColor Yellow
  Write-Host '(Or install the CLI once: winget install GitHub.cli, then gh auth login.)'
  Start-Process $page
  return
}

Get-ChildItem $dir -Filter '*.apk' | ForEach-Object {
  Write-Host ("  [OK] {0} ({1:N0} MB, {2:yyyy-MM-dd HH:mm})" -f $_.Name, ($_.Length / 1MB), $_.LastWriteTime) -ForegroundColor Green
}

$webPort = 8765
$line = Get-Content .env -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\s*WEB_PORT\s*=\s*(\d+)' } | Select-Object -First 1
if ($line -match '(\d+)\s*$') { $webPort = [int]$Matches[1] }
Write-Host ''
Write-Host 'On the TV, in the Downloader app, open:'
if (Get-Command Get-NetIPAddress -ErrorAction SilentlyContinue) {
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.|100\.)' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Loopback' } |
    ForEach-Object { Write-Host "  http://$($_.IPAddress):$webPort/tv" -ForegroundColor Green }
} else {
  Write-Host "  http://<N100>:$webPort/tv"
}
