#!/bin/bash
#
# Rullar ut på Oracle-maskinen. KÖRS PÅ SERVERN, inte på din dator:
#
#   ssh <oracle>
#   cd /opt/loopa && ./deploy/rulla-ut.sh
#
# VARFÖR SKRIPTET FINNS. Utrullningen var tre steg som gjordes för hand, och den 6 september
# hade två av dem glidit isär: web/dist var byggt från senaste koden medan servern kört ett
# äldre bygge sedan veckor. Symptomen var tysta — sidorna svarade 200 och såg rätt ut i en
# webbläsare — men INGEN av SEO-injektionerna var live, /kop svarade 200 i stället för 301,
# och /sitemap.xml skickade appskalet som text/html. Google rapporterade det som ett fel i
# webbplatskartan, vilket är det sista stället man letar efter en glömd omstart.
#
# Därför gör skriptet alla stegen i ordning OCH kontrollerar efteråt att servern faktiskt kör
# det den just hämtade. En utrullning som inte går att verifiera är en utrullning man tror på.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TJANST=${TJANST:-loopa-server}
PORT=${PORT:-8799}

steg() { printf '\n\033[1m→ %s\033[0m\n' "$1"; }
fel()  { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# ── 1. Hämta koden ──────────────────────────────────────────────────────────
#
# Lokala ändringar stoppar utrullningen i stället för att skrivas över. En redigering gjord
# direkt på servern är nästan alltid en felsökning någon glömt att ta med hem, och att tyst
# kasta den är värre än att stanna.
steg "Hämtar koden"
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  fel "Arbetsträdet på servern är smutsigt. Ta hand om ändringarna ovan först."
fi

FORE=$(git rev-parse HEAD)
git pull --ff-only
EFTER=$(git rev-parse HEAD)

if [ "$FORE" = "$EFTER" ]; then
  echo "Redan på $(git rev-parse --short HEAD) — inget nytt att hämta."
else
  echo "$(git rev-parse --short "$FORE") → $(git rev-parse --short "$EFTER")"
fi

# ── 2. Beroenden, men bara när de ändrats ───────────────────────────────────
#
# npm install på varje utrullning kostar minuter för ingenting. Låsfilerna säger när det
# faktiskt behövs. Vid första körningen (FORE = EFTER) hoppas kontrollen över.
steg "Beroenden"
if [ "$FORE" != "$EFTER" ] && ! git diff --quiet "$FORE" "$EFTER" -- server/package-lock.json server/package.json; then
  echo "server: låsfilen ändrad, installerar"
  npm --prefix server ci
else
  echo "server: oförändrad"
fi
if [ "$FORE" != "$EFTER" ] && ! git diff --quiet "$FORE" "$EFTER" -- web/package-lock.json web/package.json; then
  echo "web: låsfilen ändrad, installerar"
  npm --prefix web ci
else
  echo "web: oförändrad"
fi

# ── 3. Frontend ─────────────────────────────────────────────────────────────
#
# Servern skickar web/dist (static.ts). Utan det här steget serveras gårdagens gränssnitt av
# dagens server, vilket är exakt den halva glidningen som gömde felet i september.
steg "Bygger frontend"
npm --prefix web run build

# ── 4. Servern ──────────────────────────────────────────────────────────────
#
# Ingen byggning: tjänsten kör `tsx src/server.ts` mot källkoden (se loopa-server.service).
# Omstarten är alltså det enda som får den att läsa den nya koden — och det är det steg som
# glömdes bort.
steg "Startar om $TJANST"
sudo systemctl restart "$TJANST"

# ── 5. Kontrollen ───────────────────────────────────────────────────────────
#
# Mot 127.0.0.1 och inte mot app.loopa.nu: här prövas SERVERN, och ett svar via Cloudflare
# kan komma ur deras cache eller från deras egna regler. Den publika kontrollen kommer sist,
# och den prövar en annan sak.
steg "Väntar på att servern svarar"
for i in $(seq 1 30); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/butik"; then break; fi
  [ "$i" = 30 ] && fel "Servern svarar inte på port $PORT. Läs: journalctl -u $TJANST -n 50"
  sleep 1
done
echo "Servern svarar."

steg "Kontrollerar att den kör den nya koden"
BRISTER=0

# Webbplatskartan MÅSTE vara XML. Är den text/html föll förfrågan igenom till appskalet, vilket
# betyder att rutten inte finns i koden som kör — alltså att omstarten inte tog.
# GET och inte HEAD. Rutterna är skrivna `req.method === "GET"` (server.ts), så en HEAD-förfrågan
# faller igenom till 404 i JSON — kontrollen hade underkänt även en helt korrekt utrullning.
# `-o /dev/null` kastar kroppen; `-D -` behåller huvudena.
TYP=$(curl -s -o /dev/null -D - "http://127.0.0.1:$PORT/sitemap.xml" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2}')
case "$TYP" in
  application/xml*) echo "✓ /sitemap.xml svarar $TYP" ;;
  *) echo "✗ /sitemap.xml svarar '$TYP', väntade application/xml"; BRISTER=1 ;;
esac

# Sidhuvudet injiceras på servern (seo.ts). Saknas canonical kör servern gammal kod, oavsett
# vad git säger — det var precis så den gamla utrullningen såg ut.
if curl -s "http://127.0.0.1:$PORT/butik" | grep -q 'rel="canonical"'; then
  echo "✓ /butik bär sitt sidhuvud"
else
  echo "✗ /butik saknar canonical — SEO-injektionen kör inte"; BRISTER=1
fi

if [ "$(curl -so /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/kop")" = "301" ]; then
  echo "✓ /kop omdirigerar"
else
  echo "✗ /kop omdirigerar inte"; BRISTER=1
fi

[ "$BRISTER" = 0 ] || fel "Servern kör inte den kod som just hämtades. Läs: journalctl -u $TJANST -n 50"

# ── 6. Vägen ut, genom Cloudflare ───────────────────────────────────────────
#
# Egen kontroll, för det är en ANNAN fråga: servern kan vara helt rätt medan Cloudflare svarar
# i dess ställe. Deras hanterade robots.txt gör just det — den fångar adressen innan den når
# hit, och vår egen fil syns då aldrig utåt hur rätt den än är.
steg "Kontrollerar den publika vägen"
PUBLIK=${PUBLIK:-https://app.loopa.nu}
# -L följer omdirigeringar. Utan den mätte kontrollen fel sak så fort en domänflytt pågick: den
# gamla domänen svarar 301 och grepet såg en tom kropp, vilket rapporterades som en saknad
# Sitemap-rad — ett larm om ett fel som inte fanns.
if curl -sL --max-time 20 "$PUBLIK/robots.txt" | grep -qi '^sitemap:'; then
  echo "✓ $PUBLIK/robots.txt pekar ut webbplatskartan"
else
  echo "⚠ $PUBLIK/robots.txt saknar Sitemap-rad."
  echo "  Cloudflare serverar troligen sin egen robots.txt. Stäng av den hanterade filen"
  echo "  (Cloudflare → Settings → Content Signals / robots.txt) så tar vår egen över."
fi

printf '\n\033[32m✓ Utrullat: %s\033[0m\n' "$(git rev-parse --short HEAD)"
