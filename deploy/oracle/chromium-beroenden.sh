#!/bin/bash
#
# Systembiblioteken Chromium behöver på Oracle Linux. KÖRS EN GÅNG PER MASKIN, med sudo:
#
#   sudo ./deploy/oracle/chromium-beroenden.sh
#
# VARFÖR SKRIPTET FINNS. Blocket-roboten (server/src/integrations/blocket/) kör Playwrights Chromium,
# och `npm ci` hämtar bara npm-paketet — inte webbläsaren och inte de delade bibliotek den länkar
# mot. Playwright har ett eget `npx playwright install --with-deps` för det, men det stöder bara
# Ubuntu och Debian: på RHEL-familjen (dit Oracle Linux hör) faller det med
# "apt-get: command not found" efter att ha gissat Ubuntu 24.04. Listan nedan är vad Chromium
# faktiskt saknar på en ren Oracle Linux-installation, uttryckt i dnf:s paketnamn.
#
# Själva webbläsaren hämtas sedan av deploy/rulla-ut.sh (steget "Blockets webbläsare"), som också
# provstartar den och vägrar rulla ut om den inte går igång.
set -euo pipefail

if ! command -v dnf >/dev/null 2>&1; then
  echo "✗ dnf saknas — det här är inte en RHEL-baserad maskin. På Ubuntu/Debian: (cd server && npx playwright install --with-deps chromium)" >&2
  exit 1
fi

dnf install -y \
  nss nspr atk at-spi2-atk at-spi2-core cups-libs libdrm libxkbcommon \
  libXcomposite libXdamage libXfixes libXrandr mesa-libgbm pango cairo alsa-lib \
  libxshmfence dbus-libs libX11 libXext liberation-fonts

echo
echo "✓ Biblioteken finns. Kör nu ./deploy/rulla-ut.sh (som opc) så hämtas och provstartas Chromium."
