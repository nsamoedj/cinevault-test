#!/usr/bin/env bash
# Checks that CineVault works on PUBLIC_DOMAIN (HTTPS) from the internet.
#
# Caddy (the web container) serves PUBLIC_DOMAIN from .env, e.g. cine-vault.nl,
# over HTTPS with a Let's Encrypt certificate that it gets and renews itself.
# For that, TCP ports 80 and 443 must be forwarded in the router to the N100
# (docs/server-setup.md, step 20). Checks DNS, the public IP address, the
# ports and the certificate; changes nothing.
#
#   scripts/public-access.sh
#
# On Linux there is no firewall step (public-access.ps1 -Install on Windows):
# Docker opens the ports it publishes itself.
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
# shellcheck source=lib/public-access.sh
source "$CV_ROOT/scripts/lib/public-access.sh"

[[ "${1:-}" =~ ^(-h|--help)$ ]] && usage
need curl
need openssl
failed=0
print() {
  local color
  case "$1" in
    OK) color="$C_GREEN" ;; WARN) color="$C_YELLOW" ;; FAIL) color="$C_RED" failed=$((failed + 1)) ;; *) color="$C_GRAY" ;;
  esac
  printf '  %s[%-4s]%s %s\n' "$color" "$1" "$C_RESET" "$2"
}
step 'Public access'
test_public_access "$(env_get PUBLIC_DOMAIN)" "$(env_number HTTP_PORT 80)" "$(env_number HTTPS_PORT 443)" print
((failed == 0))
