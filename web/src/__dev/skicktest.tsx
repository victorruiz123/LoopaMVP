// Utvecklingsvy: skicktestet — bildguiden och skickbedömningen, och ingenting annat (ingen identifiering,
// inga mått, inget pris). Nås på /skicktest.html när `npm run web:dev` körs; ingår inte i produktionsbygget,
// samma sorts fil som annons-preview.tsx och dim-preview.tsx.
//
// Inga AuthProvider och inget konto: jobbet skapas som gäst (api.ts, ensureGuest), precis som säljarflödet gör
// innan någon loggat in. Servern måste köra (`npm run server:dev`, port 8799 — vite proxar /api dit).
import { createRoot } from "react-dom/client";
import SkickTestScreen from "../screens/SkickTestScreen";
import { LanguageProvider } from "../lib/i18n";
import { initViewMode } from "../lib/viewMode";

// Samma dator/telefon-växling som appen (data-view på <html>).
initViewMode();

createRoot(document.getElementById("root")!).render(
  <LanguageProvider>
    <SkickTestScreen />
  </LanguageProvider>,
);
