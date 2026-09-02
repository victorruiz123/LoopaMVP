import { useEffect } from "react";
import "../butik/butik.css";
import "./kop.css";
import { useKopRoute } from "./router";
import BuyLanding from "./screens/BuyLanding";
import MinaEfterlysningar from "./screens/MinaEfterlysningar";
import ButikChrome from "../butik/components/Chrome";

/**
 * Köpsidan, med butikens ram runt sig.
 *
 * SAMMA TOPPRAD OCH SIDFOT som butiken, med flit: /kop och /butik är två vyer av samma köpsida — den
 * ena beskriver vad man vill ha, den andra bläddrar i det vi har — och en egen ram hade gjort dem
 * till två sajter för den som klickar mellan dem.
 */
export default function KopApp() {
  const route = useKopRoute();

  useEffect(() => {
    document.title = route.name === "mina"
      ? "Dina efterlysningar – Loopa"
      : "Beskriv möbeln du letar efter – Loopa";
  }, [route]);

  return (
    <ButikChrome>
      {route.name === "landing" && <BuyLanding />}
      {route.name === "mina" && <MinaEfterlysningar />}
    </ButikChrome>
  );
}
