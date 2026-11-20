# Checks for the public HTTPS address (PUBLIC_DOMAIN), shared by
# scripts\public-access.ps1 and scripts\verify-setup.ps1 (dot-sourced).
# Works in Windows PowerShell 5.1 and PowerShell 7. Changes nothing.

$script:firewallRules = @(
  @{ Name = 'CineVault HTTP'; Port = 80 },
  @{ Name = 'CineVault HTTPS'; Port = 443 }
)

# Docker Desktop listens for published ports with these processes.
$script:dockerProcess = '^(com\.docker\.|wslrelay|vpnkit|docker)'

# Windows PowerShell 5.1 does not offer TLS 1.2 by default; Caddy wants 1.2 or newer.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# Names of the processes that listen on a TCP port.
function Get-PortOwners([int]$port) {
  if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { return @() }
  return @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
      ForEach-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName } |
      Where-Object { $_ } | Sort-Object -Unique)
}

# The certificate Caddy serves for $domain on this machine, or $null (no TLS, no certificate yet).
function Get-ServedCertificate([string]$domain, [int]$port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $client.ReceiveTimeout = 5000
    $client.SendTimeout = 5000
    $client.Connect('127.0.0.1', $port)
    # Accepts any certificate: this only reads which one is served.
    $stream = New-Object System.Net.Security.SslStream($client.GetStream(), $false, { $true })
    $stream.AuthenticateAsClient($domain, $null, [System.Security.Authentication.SslProtocols]::Tls12, $false)
    return New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $stream.RemoteCertificate
  } catch {
    return $null
  } finally {
    $client.Close()
  }
}

# The last certificate error in Caddy's log (the web container), shortened.
function Get-CaddyCertificateError {
  # Windows PowerShell 5.1 turns native stderr into errors, which 'Stop' would throw.
  $ErrorActionPreference = 'Continue'
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $null }
  $logs = @(docker compose logs web --no-log-prefix --since 24h 2>$null)
  $line = $logs | Where-Object { $_ -match '"level":"error"' -and $_ -match 'certificate|acme|challenge' } | Select-Object -Last 1
  if (-not $line) { return $null }
  $text = if ($line -match '"error":"((?:[^"\\]|\\.)*)"') { $Matches[1] } else { $line }
  $text = $text -replace '\\"', '"'
  if ($text.Length -gt 300) { $text = $text.Substring(0, 300) + '...' }
  return $text
}

# The addresses of $name, asked of a public DNS server so the router's cache
# does not hide a recent change; the normal DNS server if that one is blocked.
function Resolve-Address([string]$name, [string]$type) {
  foreach ($server in @('1.1.1.1', $null)) {
    $options = @{ Name = $name; Type = $type; DnsOnly = $true; ErrorAction = 'Stop' }
    if ($server) { $options.Server = $server }
    try {
      return @(Resolve-DnsName @options | Where-Object { "$($_.Type)" -eq $type } | ForEach-Object { $_.IPAddress })
    } catch {
      # No such record answers with an error too; only a timeout is worth a second try.
      if ($_.Exception.Message -notmatch 'timeout|timed out') { return @() }
    }
  }
  return @()
}

# Runs every check for $domain; calls $report with (status, message) for each.
# Status is OK, WARN, FAIL or INFO, as in verify-setup.ps1.
function Test-PublicAccess([string]$domain, [int]$httpPort, [int]$httpsPort, [scriptblock]$report) {
  if (-not $domain) {
    & $report INFO 'PUBLIC_DOMAIN is empty: CineVault is only reachable at home and over Tailscale (step 20)'
    return
  }
  & $report INFO "PUBLIC_DOMAIN = $domain"

  # 1. The public IPv4 address of the connection, and where the domain points.
  $publicIp = $null
  try {
    $publicIp = "$(Invoke-RestMethod -Uri 'https://api.ipify.org' -TimeoutSec 8)".Trim()
    & $report INFO "public IPv4 address of this connection: $publicIp"
  } catch {
    & $report WARN "could not look up the public IP address (api.ipify.org): $($_.Exception.Message)"
  }

  if (Get-Command Resolve-DnsName -ErrorAction SilentlyContinue) {
    $a = @(Resolve-Address $domain 'A')
    $aaaa = @(Resolve-Address $domain 'AAAA')
    if ($a.Count -eq 0) {
      & $report FAIL "$domain has no A record: add one with the public IP address at the domain registrar (step 20)"
    } elseif ($publicIp -and ($a -notcontains $publicIp)) {
      & $report FAIL "$domain points to $($a -join ', '), but this connection is $publicIp`: change the A record (step 20)"
    } else {
      & $report OK "$domain points to $($a -join ', ')"
    }
    if ($aaaa.Count -gt 0) {
      & $report WARN "$domain also has an IPv6 (AAAA) record ($($aaaa -join ', ')): Let's Encrypt and phones try that first; remove it (step 20)"
    }
  }

  # 2. The firewall: CineVault's rules, and no rule that blocks Docker Desktop.
  if (Get-Command Get-NetFirewallRule -ErrorAction SilentlyContinue) {
    foreach ($rule in $script:firewallRules) {
      $found = Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($found -and "$($found.Enabled)" -eq 'True') { & $report OK "firewall allows TCP $($rule.Port) ('$($rule.Name)')" }
      else { & $report FAIL "no firewall rule for TCP $($rule.Port): run scripts\public-access.ps1 -Install as administrator" }
    }
    $blocking = @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
        Where-Object { $_.Program -match 'com\.docker|wslrelay|vpnkit' } |
        Get-NetFirewallRule -ErrorAction SilentlyContinue |
        Where-Object { "$($_.Action)" -eq 'Block' -and "$($_.Enabled)" -eq 'True' -and "$($_.Direction)" -eq 'Inbound' })
    foreach ($rule in $blocking) {
      & $report WARN "firewall rule '$($rule.DisplayName)' blocks Docker Desktop ($($rule.Profile)): disable it in 'Windows Defender Firewall with Advanced Security'"
    }
  }

  # 3. Who listens on 80 and 443: Docker Desktop (for Caddy), nothing else.
  foreach ($port in @($httpPort, $httpsPort)) {
    $owners = Get-PortOwners $port
    $others = @($owners | Where-Object { $_ -notmatch $script:dockerProcess })
    if ($others.Count -gt 0) {
      $hint = if ($others -contains 'System') { ' (a Windows service via HTTP.sys, e.g. IIS: netsh http show servicestate)' } else { '' }
      & $report FAIL "port $port is in use by $($others -join ', ')$hint; Caddy needs it"
    } elseif ($owners.Count -gt 0) {
      & $report OK "port $port is published by Docker Desktop"
    } elseif (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
      & $report FAIL "nothing listens on port ${port}: start CineVault with scripts\up.ps1"
    }
  }

  # 4. The certificate Caddy serves. Getting one from Let's Encrypt proves that
  #    port 80 or 443 is reachable from the internet.
  $cert = Get-ServedCertificate $domain $httpsPort
  if ($cert) {
    $until = $cert.NotAfter.ToString('yyyy-MM-dd')
    $days = [int]($cert.NotAfter - (Get-Date)).TotalDays
    if ($cert.Issuer -match 'STAGING') {
      & $report WARN "only a test certificate (Let's Encrypt staging): Caddy is still retrying, see docker compose logs web"
    } elseif ($cert.Issuer -match "Let's Encrypt|ZeroSSL") {
      if ($days -lt 14) { & $report WARN "certificate expires in $days days ($until); Caddy should have renewed it: docker compose logs web" }
      else { & $report OK "certificate from $(($cert.Issuer -split ',' | Where-Object { $_ -match 'O=' }) -replace '^\s*O=', ''), valid until $until (Caddy renews it)" }
    } else {
      & $report WARN "certificate from $($cert.Issuer), not from Let's Encrypt"
    }
  } else {
    $why = Get-CaddyCertificateError
    $suffix = if ($why) { " Caddy: $why" } else { ' See docker compose logs web.' }
    & $report FAIL "no certificate for $domain yet: Let's Encrypt must reach port 80/443 through the router (step 20).$suffix"
  }

  # 5. The address itself, from here. This goes out to the router and back in,
  #    which not every router does (NAT loopback).
  try {
    $health = Invoke-RestMethod -Uri "https://$domain/api/health" -TimeoutSec 10
    if ($health.status -eq 'ok') { & $report OK "https://$domain/ works from the N100 itself" }
    else { & $report WARN "https://$domain/api/health answers with status $($health.status)" }
  } catch {
    & $report WARN "https://$domain/ does not answer from the N100 itself ($($_.Exception.Message)). Test with a phone on mobile data, Wi-Fi off: if that works, the router just does not loop back (step 20)"
  }
}
