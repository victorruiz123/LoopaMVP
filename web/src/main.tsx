import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { initViewMode } from "./lib/viewMode";
import "./styles.css";

// Före render: layoutläget ska ligga på <html> när första bildrutan målas, annars ritas
// telefonkolumnen upp en gång och byter bredd i nästa tick.
initViewMode();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>,
);
