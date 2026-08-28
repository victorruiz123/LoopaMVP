import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

const BACKEND_PORT = process.env.CONDITION_GRADING_API_PORT ?? "8799";

export default defineConfig({
  // HTTPS med självsignerat certifikat. getUserMedia — kameran i webbläsaren — är blockerad utanför en
  // säker kontext, så över vanlig http på en LAN-adress kan inspelningsflödet aldrig fungera. Telefonen
  // varnar om certifikatet en gång; att godkänna det gör sidan till en säker kontext.
  //
  // `HTTPS=0` stänger av det. Finns för Safari på samma dator: Safari är betydligt strängare än Chrome
  // mot självsignerade certifikat och gör det ibland omöjligt att klicka sig förbi varningen på
  // localhost. Och det behövs inte där — `http://localhost` räknas ENLIGT SPECIFIKATIONEN som en säker
  // kontext, så kameran fungerar ändå. Bara telefonen, som når appen på en LAN-adress, kräver HTTPS.
  plugins: [react(), ...(process.env.HTTPS === "0" ? [] : [basicSsl()])],
  server: {
    // Any host: this dev server is reached by LAN IP from a phone and by a Tailscale name from
    // elsewhere, and vite rejects Host headers that are not listed. It binds to a local network only.
    allowedHosts: true,
    host: true,
    port: 5190,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://localhost:${BACKEND_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
