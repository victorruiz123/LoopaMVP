#!/usr/bin/env bash
# Kontrollerar samarbetslänken loopa.nu/salj/massproduction (och /k/-formen) mot den RIKTIGA sajten, efter utrullning.
# Kör: bash scripts/verifiera-kampanjlank.sh   — allt ska vara OK, annars är något inte utrullat.
#
# Vad varje rad betyder om den faller:
#   appskalet saknas  → Cloudflare-rutten loopa.nu/k/* är inte deployad (deploy/cloudflare, wrangler deploy)
#   fel omdirigering  → servern på Oracle kör gammal kod (rulla ut servern)
#   www ger 404       → rutten www.loopa.nu/* är inte deployad

set -u
FEL=0
ok() { printf "  OK    %s\n" "$1"; }
fel() { printf "  FEL   %s\n        %s\n" "$1" "$2"; FEL=1; }

# Svarets status och location, utan att följa omdirigeringar.
huvud() { curl -s -o /dev/null -D - --max-time 15 "$@" | tr -d '\r'; }
status() { huvud "$@" | grep -E "^HTTP" | grep -v " 103" | tail -1 | awk '{print $2}'; }
plats() { huvud "$@" | grep -i "^location:" | tail -1 | cut -d' ' -f2-; }

echo "Länken som delas (fungerar utan ny Cloudflare-utrullning)"
for u in "https://loopa.nu/salj/massproduction" "https://loopa.nu/salj/massproduction?fbclid=test123" "http://loopa.nu/salj/massproduction"; do
  s=$(curl -s -L -o /dev/null -w "%{http_code} %{url_effective}" --max-time 15 "$u")
  if [[ "$s" == "200 https://loopa.nu/salj/massproduction"* ]]; then ok "$u → säljsidan, räknas"
  elif [[ "$s" == "200 https://loopa.nu/" ]]; then fel "$u" "landar på säljsidan men RÄKNAS INTE — servern på Oracle kör gammal kod"
  else fel "$u" "slutade på '$s'"; fi
done

echo "/k/-formen (kräver Cloudflare-utrullningen)"
for u in "https://loopa.nu/k/massproduction" "https://loopa.nu/k/massproduction?fbclid=test123" "http://loopa.nu/k/massproduction"; do
  # -L: http:// får gärna gå via en 301 till https — det som räknas är var den landar.
  s=$(curl -s -L -o /dev/null -w "%{http_code}" --max-time 15 "$u"); body=$(curl -s -L --max-time 15 "$u")
  if [ "$s" = "200" ] && grep -q "Sälj din möbel" <<<"$body" && grep -q "app-assets" <<<"$body"; then ok "$u → säljsidan"
  else fel "$u" "status $s — appskalet saknas (marknadssajten svarade?)"; fi
done

echo "Andra stavningar → den exakta"
for v in "k/massproduction/" "k/MassProduction" "K/massproduction" "k/mass-production" "k/Mass_Production"; do
  u="https://loopa.nu/$v"; s=$(status "$u"); l=$(plats "$u")
  if [ "$s" = "302" ] && [[ "$l" == */k/massproduction ]]; then ok "$u → $l"
  else fel "$u" "status $s, location '${l:-}' — väntade 302 till /k/massproduction"; fi
done

echo "www"
u="https://www.loopa.nu/k/massproduction"; s=$(status "$u"); l=$(plats "$u")
if [ "$s" = "301" ] && [ "$l" = "https://loopa.nu/k/massproduction" ]; then ok "$u → $l"
else fel "$u" "status $s, location '${l:-}' — väntade 301 till https://loopa.nu/k/massproduction"; fi

echo "HEAD (länkförhandsvisningar i appar)"
s=$(status -I "https://loopa.nu/k/massproduction")
if [ "$s" = "200" ]; then ok "HEAD → 200"; else fel "HEAD https://loopa.nu/k/massproduction" "status $s"; fi

echo "Hela vägen i en vanlig webbläsarförfrågan"
slut=$(curl -s -L -o /dev/null -w "%{http_code} %{url_effective}" --max-time 20 "https://www.loopa.nu/K/MassProduction")
if [[ "$slut" == "200 https://loopa.nu/k/massproduction" ]]; then ok "www.loopa.nu/K/MassProduction → $slut"
else fel "www.loopa.nu/K/MassProduction" "slutade på '$slut'"; fi

echo
if [ $FEL = 0 ]; then echo "Allt OK — länken är redo att delas: https://loopa.nu/k/massproduction"
else echo "Något är inte utrullat. Se kommentaren överst för vad varje fel betyder."; exit 1; fi
