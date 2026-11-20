# shellcheck shell=bash
# Checks for the public HTTPS address (PUBLIC_DOMAIN), shared by
# scripts/public-access.sh and scripts/verify-setup.sh (sourced after
# lib/common.sh). Changes nothing. The Linux version of lib/public-access.ps1,
# without the Windows Firewall: Docker opens published ports itself (also
# past ufw), so there is no rule to make.

# The addresses of $1 (record type $2), asked of 1.1.1.1 so the router's cache
# does not hide a recent change; the normal resolver without dig.
resolve_address() {
  local name="$1" type="$2"
  if command -v dig >/dev/null 2>&1; then
    dig +short +time=3 +tries=1 "$type" "$name" @1.1.1.1 2>/dev/null | grep -E '^[0-9a-fA-F:.]+$' ||
      dig +short +time=3 +tries=1 "$type" "$name" 2>/dev/null | grep -E '^[0-9a-fA-F:.]+$' || true
  elif [[ "$type" == A ]]; then
    { getent ahostsv4 "$name" 2>/dev/null || true; } | awk '{ print $1 }' | sort -u
  else
    { getent ahostsv6 "$name" 2>/dev/null || true; } | awk '$1 !~ /^::ffff:/ { print $1 }' | sort -u
  fi
}

# The last certificate error in Caddy's log (the web container) for domain
# $1, else the last one of any site (Caddy also serves the Voqa sites), shortened.
caddy_certificate_error() {
  local errors line
  errors="$({ docker compose logs web --no-log-prefix --since 24h 2>/dev/null || true; } |
    { grep '"level":"error"' || true; } | { grep -E 'certificate|acme|challenge' || true; })"
  line="$({ grep -F "[$1]" <<<"$errors" || true; } | tail -n 1)"
  [[ -n "$line" ]] || line="$(tail -n 1 <<<"$errors")"
  [[ -n "$line" ]] || return 0
  sed -E 's/.*"error":"(([^"\\]|\\.)*)".*/\1/; s/\\"/"/g' <<<"$line" | cut -c1-300
}

# Runs every check for $1 (the domain) with ports $2 (HTTP) and $3 (HTTPS);
# calls $4 with (status, message) for each. Status is OK, WARN, FAIL or INFO.
test_public_access() {
  local domain="$1" http_port="$2" https_port="$3" report="$4"
  local public_ip='' a aaaa port published cert issuer until days why connect https_setting
  if [[ -z "$domain" ]]; then
    "$report" INFO 'PUBLIC_DOMAIN is empty: CineVault is only reachable at home and over Tailscale (step 20)'
    return 0
  fi
  "$report" INFO "PUBLIC_DOMAIN = $domain"

  # 1. The public IPv4 address of the connection, and where the domain points.
  if public_ip="$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null)" && [[ -n "$public_ip" ]]; then
    "$report" INFO "public IPv4 address of this connection: $public_ip"
  else
    public_ip=''
    "$report" WARN 'could not look up the public IP address (api.ipify.org)'
  fi
  a="$(resolve_address "$domain" A | paste -sd' ' -)"
  aaaa="$(resolve_address "$domain" AAAA | paste -sd' ' -)"
  if [[ -z "$a" ]]; then
    "$report" FAIL "$domain has no A record: add one with the public IP address at the domain registrar (step 20)"
  elif [[ -n "$public_ip" && " $a " != *" $public_ip "* ]]; then
    "$report" FAIL "$domain points to $a, but this connection is $public_ip: change the A record (step 20)"
  else
    "$report" OK "$domain points to $a"
  fi
  if [[ -n "$aaaa" ]]; then
    "$report" WARN "$domain also has an IPv6 (AAAA) record ($aaaa): Let's Encrypt and phones try that first; remove it (step 20)"
  fi

  # 2. 80 and 443: published by the web container (Caddy), not taken by another program.
  for port in "$http_port" "$https_port"; do
    published="$(docker compose port web "$([[ "$port" == "$http_port" ]] && echo 80 || echo 443)" 2>/dev/null || true)"
    if [[ -n "$published" ]]; then
      "$report" OK "port $port is published by the web container (Caddy)"
    elif ss -ltnH "sport = :$port" 2>/dev/null | grep -q .; then
      "$report" FAIL "port $port is in use by another program (sudo ss -ltnp 'sport = :$port'); Caddy needs it"
    else
      "$report" FAIL "nothing listens on port $port: start CineVault with scripts/up.sh"
    fi
  done

  # 3. The certificate Caddy serves. Getting one from Let's Encrypt proves that
  #    port 80 or 443 is reachable from the internet.
  #    HTTPS_PORT may hold an address too (e.g. 192.168.0.110:443, when Tailscale Funnel
  #    holds 443 on the Tailscale address); Caddy then does not listen on 127.0.0.1.
  connect="127.0.0.1:$https_port"
  https_setting="$(env_get HTTPS_PORT)"
  [[ "$https_setting" =~ ^[0-9a-fA-F.:]+:[0-9]+$ ]] && connect="$https_setting"
  cert="$(openssl s_client -connect "$connect" -servername "$domain" </dev/null 2>/dev/null |
    openssl x509 -noout -issuer -enddate 2>/dev/null || true)"
  if [[ -n "$cert" ]]; then
    issuer="$(sed -n 's/^issuer=//p' <<<"$cert")"
    until="$(date -d "$(sed -n 's/^notAfter=//p' <<<"$cert")" +%F)"
    days=$((($(date -d "$until" +%s) - $(date +%s)) / 86400))
    if [[ "$issuer" == *STAGING* ]]; then
      "$report" WARN "only a test certificate (Let's Encrypt staging): Caddy is still retrying, see docker compose logs web"
    elif [[ "$issuer" =~ "Let's Encrypt"|ZeroSSL ]]; then
      if ((days < 14)); then
        "$report" WARN "certificate expires in $days days ($until); Caddy should have renewed it: docker compose logs web"
      else
        "$report" OK "certificate from $(sed -E 's/.*O ?= ?([^,]+).*/\1/' <<<"$issuer"), valid until $until (Caddy renews it)"
      fi
    else
      "$report" WARN "certificate from $issuer, not from Let's Encrypt"
    fi
  else
    why="$(caddy_certificate_error "$domain")"
    if [[ -n "$why" ]]; then why=" Caddy: $why"; else why=' See docker compose logs web.'; fi
    "$report" FAIL "no certificate for $domain yet: Let's Encrypt must reach port 80/443 through the router (step 20).$why"
  fi

  # 4. The address itself, from here. This goes out to the router and back in,
  #    which not every router does (NAT loopback).
  if curl -fsS --max-time 10 "https://$domain/api/health" 2>/dev/null | grep -q '"status":"ok"'; then
    "$report" OK "https://$domain/ works from the N100 itself"
  else
    "$report" WARN "https://$domain/ does not answer from the N100 itself. Test with a phone on mobile data, Wi-Fi off: if that works, the router just does not loop back (step 20)"
  fi
}
