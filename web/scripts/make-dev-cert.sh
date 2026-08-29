#!/bin/sh
# Självsignerat certifikat för dev-servern, med datorns LAN-adress i SAN.
#
# Varför det inte räcker med @vitejs/plugin-basic-ssl: dess certifikat täcker bara localhost och
# 127.0.0.1. iOS Safari kräver att namnet i certifikatet matchar adressen man surfar till, och när
# det inte gör det vägrar den helt — "kunde inte upprätta en säker förbindelse", utan möjlighet att
# klicka förbi. Telefonen når datorn på LAN-adressen, alltså måste den stå i SAN.
#
# Adressen byts när datorn byter nätverk. Kör om skriptet då.
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)/.certs"
mkdir -p "$DIR"

IP="${DEV_CERT_IP:-$(ipconfig getifaddr "$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')" 2>/dev/null)}"
[ -n "$IP" ] || { echo "Hittade ingen LAN-adress. Sätt DEV_CERT_IP=... och kör igen." >&2; exit 1; }

# 397 dagar: Apple avvisar TLS-certifikat med längre livstid än 398 dagar.
openssl req -x509 -newkey rsa:2048 -sha256 -days 397 -nodes \
  -keyout "$DIR/dev-key.pem" -out "$DIR/dev-cert.pem" \
  -subj "/CN=$IP" \
  -addext "subjectAltName=IP:$IP,IP:127.0.0.1,DNS:localhost" \
  -addext "extendedKeyUsage=serverAuth" \
  -addext "basicConstraints=critical,CA:FALSE" 2>/dev/null

echo "Certifikat för $IP skrivet till $DIR"
echo "Telefonen öppnar:  https://$IP:5190"
