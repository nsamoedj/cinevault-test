<#
.SYNOPSIS
  Opens CineVault to the internet on PUBLIC_DOMAIN (HTTPS), and checks that it works.

.DESCRIPTION
  Caddy (the web container) serves PUBLIC_DOMAIN from .env, e.g. cine-vault.nl,
  over HTTPS with a Let's Encrypt certificate that it gets and renews itself.
  For that, TCP ports 80 and 443 must reach the N100: forwarded in the router
  and allowed by the Windows Firewall (docs/server-setup.md, step 20).

    powershell -ExecutionPolicy Bypass -File .\scripts\public-access.ps1             (check)
    powershell -ExecutionPolicy Bypass -File .\scripts\public-access.ps1 -Install    (as administrator)
    powershell -ExecutionPolicy Bypass -File .\scripts\public-access.ps1 -Uninstall  (as administrator)

  -Install    firewall rules that let TCP 80 and 443 in, on every network profile
              (the network is Public on the N100, and port forwarding arrives there)
  -Uninstall  remove those rules: CineVault is then only reachable at home again
  Without a switch: checks DNS, the public IP address, the firewall, the ports
  and the certificate. Changes nothing.
#>
param(
  [switch]$Install,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
. (Join-Path $PSScriptRoot 'lib\public-access.ps1')

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

function Assert-Admin {
  $identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this as administrator: right-click PowerShell, "Run as administrator".'
  }
}

$envValues = Read-Env
$httpPort = if ($envValues['HTTP_PORT'] -match '^\d+$') { [int]$envValues['HTTP_PORT'] } else { 80 }
$httpsPort = if ($envValues['HTTPS_PORT'] -match '^\d+$') { [int]$envValues['HTTPS_PORT'] } else { 443 }

if ($Install) {
  Assert-Admin
  foreach ($rule in $script:firewallRules) {
    $port = if ($rule.Port -eq 80) { $httpPort } else { $httpsPort }
    Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $rule.Name -Description 'CineVault: Caddy (Docker Desktop) for PUBLIC_DOMAIN over HTTPS' `
      -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Any | Out-Null
    Write-Host "  [OK] firewall rule '$($rule.Name)': TCP $port in" -ForegroundColor Green
  }
  Write-Host ''
}

if ($Uninstall) {
  Assert-Admin
  foreach ($rule in $script:firewallRules) {
    Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Write-Host "  [OK] firewall rule '$($rule.Name)' removed" -ForegroundColor Green
  }
  Write-Host '  Also remove the port forwarding of 80 and 443 in the router.'
  return
}

$script:failed = 0
$colors = @{ OK = 'Green'; WARN = 'Yellow'; FAIL = 'Red'; INFO = 'Gray' }
Write-Host '== Public access'
Test-PublicAccess $envValues['PUBLIC_DOMAIN'] $httpPort $httpsPort {
  param($status, $message)
  Write-Host ("  [{0,-4}] {1}" -f $status, $message) -ForegroundColor $colors[$status]
  if ($status -eq 'FAIL') { $script:failed++ }
}
if ($script:failed -gt 0) { exit 1 }
