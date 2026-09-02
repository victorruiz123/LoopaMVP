import { useEffect } from "react";
import "./affar.css";
import { useAffarRoute } from "./router";
import IntakeScreen from "./screens/IntakeScreen";
import DealScreen from "./screens/DealScreen";
import InviteScreen from "./screens/InviteScreen";

/**
 * Trygg affär.
 *
 * Ligger bredvid säljflödet och butiken, inte inuti någon av dem: App.tsx väljer på adressen, precis
 * som den redan gör med det publika kortet, de juridiska sidorna och butiken.
 */
export default function AffarApp() {
  const route = useAffarRoute();

  useEffect(() => {
    document.title =
      route.name === "invite" ? "Någon vill köpa din möbel – Loopa"
      : route.name === "deal" ? "Din affär – Loopa"
      : "Köp tryggt – Loopa";
  }, [route.name]);

  return (
    <div className="affar">
      <header className="affar-bar">
        <a className="affar-logo" href="/">loopa<span>.</span></a>
        {/* Säljvägen står kvar även här: den som läser om att köpa tryggt har ofta något att bli av med. */}
        <a className="affar-bar-link" href="/butik">Butiken</a>
      </header>
      <main>
        {route.name === "intake" && <IntakeScreen />}
        {route.name === "deal" && <DealScreen id={route.id} />}
        {route.name === "invite" && <InviteScreen token={route.token} />}
      </main>
    </div>
  );
}
