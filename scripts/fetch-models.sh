#!/usr/bin/env bash
# Hämtar segmenteringsmodellen som omslagsurklippet använder.
#
# Ligger utanför git: u2net.onnx är 168 MB, alltså över GitHubs gräns på 100 MB per fil. Körs en
# gång per maskin, och vid varje deploy till en ny burk.
#
#   ./scripts/fetch-models.sh          # bara u2netp (4,4 MB) — den som driftar
#   ./scripts/fetch-models.sh --full   # även u2net (168 MB), för jämförelser
#
# Vikterna är U^2-Net (Qin m.fl., Apache 2.0), distribuerade som ONNX av rembg (MIT).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../server" && pwd)/models"
BASE="https://github.com/danielgatis/rembg/releases/download/v0.0.0"
mkdir -p "$DIR"

# sha256 kontrollerade 2026-09-01. En modell som byts under fötterna på oss ska märkas här och inte
# som ett urklipp som plötsligt ser annorlunda ut.
U2NETP_SHA="309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8"

fetch() {
  local name="$1"
  if [ -f "$DIR/$name.onnx" ]; then
    echo "$name.onnx finns redan ($(du -h "$DIR/$name.onnx" | cut -f1))"
    return
  fi
  echo "hämtar $name.onnx…"
  curl -fL --progress-bar -o "$DIR/$name.onnx" "$BASE/$name.onnx"
  local got
  got=$(shasum -a 256 "$DIR/$name.onnx" | cut -d" " -f1)
  # Bara u2netp har en känd summa — det är den som driftar. u2net laddas för jämförelser och
  # kontrolleras inte; en oväntad fil där ger en sämre bild, inte en otrygg server.
  if [ "$name" = "u2netp" ] && [ "$got" != "$U2NETP_SHA" ]; then
    echo "  FEL: fel kontrollsumma." >&2
    echo "  väntade $U2NETP_SHA" >&2
    echo "  fick    $got" >&2
    rm -f "$DIR/$name.onnx"
    exit 1
  fi
  echo "  $(du -h "$DIR/$name.onnx" | cut -f1)  sha256 OK"
}

fetch u2netp
if [ "${1:-}" = "--full" ]; then fetch u2net; fi

echo
echo "Klart. SEGMENT_MODEL styr vilken som körs (förval: u2netp)."
