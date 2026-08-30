#!/bin/bash
# Kopplar app.loopa.nu till den lokala servern via en Cloudflare-tunnel.
#
# Körs EN gång. Kräver att du loggar in i webbläsaren på det Cloudflare-konto som äger loopa.nu —
# det är därför det här är ett skript och inte något som redan är gjort.
#
#   ./deploy/tunnel-setup.sh
#
# Efteråt startas tunneln med:
#   ./tools/cloudflared tunnel --config deploy/cloudflared/config.yml run
set -euo pipefail
cd "$(dirname "$0")/.."

CF=./tools/cloudflared
NAME=${TUNNEL_NAME:-loopa-app}
HOSTNAME=${TUNNEL_HOSTNAME:-app.loopa.nu}

# 1. Logga in. Öppnar webbläsaren; välj zonen loopa.nu. Skriver ~/.cloudflared/cert.pem.
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  echo "→ Loggar in mot Cloudflare. Välj loopa.nu i webbläsaren."
  $CF tunnel login
fi

# 2. Skapa tunneln om den inte finns. Ger ett id och en credentials-fil.
if ! $CF tunnel list --output json | grep -q "\"name\":\"$NAME\""; then
  echo "→ Skapar tunneln $NAME"
  $CF tunnel create "$NAME"
fi
ID=$($CF tunnel list --output json | python3 -c "
import json,sys
print(next(t['id'] for t in json.load(sys.stdin) if t['name']=='$NAME'))")
echo "→ Tunnel-id: $ID"

# 3. DNS. Skapar CNAME app.loopa.nu -> <id>.cfargotunnel.com i zonen.
echo "→ Pekar $HOSTNAME mot tunneln"
$CF tunnel route dns "$NAME" "$HOSTNAME"

# 4. Fyll i konfigurationen.
sed -e "s|TUNNEL_ID|$ID|g" -e "s|HOME|$HOME|g" -e "s|app.loopa.nu|$HOSTNAME|g" \
  deploy/cloudflared/config.yml > deploy/cloudflared/config.local.yml
echo "→ Skrev deploy/cloudflared/config.local.yml"

echo
echo "Klart. Starta tunneln med:"
echo "  ./tools/cloudflared tunnel --config deploy/cloudflared/config.local.yml run"
