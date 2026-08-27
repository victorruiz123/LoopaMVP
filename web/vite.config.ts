import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

const BACKEND_PORT = process.env.CONDITION_GRADING_API_PORT ?? "8799";

export default defineConfig({
  // HTTPS with a self-signed certificate. getUserMedia — the in-browser camera — is blocked outside a
  // secure context, so over plain http on a LAN address the recording flow can never work. The phone
  // will warn about the certificate once; accepting it makes the page a secure context.
  plugins: [react(), basicSsl()],
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
