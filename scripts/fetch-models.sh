#!/usr/bin/env bash
# Hämtar segmenteringsmodellerna som produktbildssystemet använder.
#
# Ligger utanför git: filerna är 5–973 MB, alltså långt över GitHubs gräns på 100 MB. Körs en gång
# per maskin, och vid varje deploy till en ny burk.
#
#   ./scripts/fetch-models.sh          # drift: u2netp (urval) + birefnet-general (omslag)
#   ./scripts/fetch-models.sh --latt   # bara u2netp + isnet-general-use, för en burk med lite RAM
#   ./scripts/fetch-models.sh --alla   # även u2net, för modelljämförelsen
#
# VILKA OCH VARFÖR står i server/src/pipeline/bild/modeller.ts, som är registret koden läser. Kort:
# u2netp är liten och räcker för att VÄLJA bildruta; birefnet-general är den enda som ger en kant
# man inte ser att någon klippt. isnet-general-use är mellanläget för en burk som inte har en
# gigabyte att avvara — sätt då PRODUKTBILD_MODELL=isnet-general-use.
#
# LICENSER, kontrollerade 2026-09-06: U^2-Net och IS-Net är Apache-2.0 (Qin m.fl.), BiRefNet är MIT
# (ZhengPeng7). BRIA:s RMBG-1.4 hämtas INTE och står inte i registret: den är mätbart bra och
# licensen är BRIA:s egen, icke-kommersiell utan avtal. Loopa säljer möbler.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../server" && pwd)/models"
REMBG="https://github.com/danielgatis/rembg/releases/download/v0.0.0"
HF="https://huggingface.co/onnx-community/BiRefNet-ONNX/resolve/main/onnx"
mkdir -p "$DIR"

# sha256 kontrollerade 2026-09-01. En modell som byts under fötterna på oss ska märkas här och inte
# som ett urklipp som plötsligt ser annorlunda ut.
U2NETP_SHA="309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8"

fetch() {
  local name="$1"
  local url="$2"
  if [ -f "$DIR/$name.onnx" ]; then
    echo "$name.onnx finns redan ($(du -h "$DIR/$name.onnx" | cut -f1))"
    return
  fi
  echo "hämtar $name.onnx…"
  curl -fL --progress-bar -o "$DIR/$name.onnx" "$url"
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

# u2netp alltid: den poängsätter bildrutorna och är billig nog att ingen ska behöva välja bort den.
fetch u2netp "$REMBG/u2netp.onnx"

case "${1:-}" in
  --latt)
    fetch isnet-general-use "$REMBG/isnet-general-use.onnx"
    ;;
  --alla)
    fetch isnet-general-use "$REMBG/isnet-general-use.onnx"
    fetch u2net "$REMBG/u2net.onnx"
    # 973 MB. Sist med flit: en avbruten hämtning ska inte kosta de tre små också.
    fetch birefnet-general "$HF/model.onnx"
    ;;
  *)
    fetch birefnet-general "$HF/model.onnx"
    ;;
esac

echo
echo "Klart. PRODUKTBILD_MODELL styr vilken som bygger omslaget (förval: birefnet-general),"
echo "PRODUKTBILD_URVALSMODELL vilken som väljer bildruta (förval: u2netp). Saknas den valda"
echo "faller koden nedåt genom RESERVKEDJA i modeller.ts — sämre bild, aldrig ett kraschat jobb."
