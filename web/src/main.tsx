import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { initViewMode } from "./lib/viewMode";
import { fangaInbjudan } from "./lib/referral";
import { LanguageProvider } from "./lib/i18n";
import "./styles.css";

// Före render: layoutläget ska ligga på <html> när första bildrutan målas, annars ritas
// telefonkolumnen upp en gång och byter bredd i nästa tick.
initViewMode();
// Inbjudningskoden ur ?ref=, sparad i 30 dagar. Före render, så att ingen vy hinner läsa adressen med
// koden kvar i. Se lib/referral.ts.
fangaInbjudan();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LanguageProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </LanguageProvider>
  </React.StrictMode>,
);
