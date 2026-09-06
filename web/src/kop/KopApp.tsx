import { useEffect } from "react";
import "../butik/butik.css";
import "./kop.css";
import { useKopRoute } from "./router";
import MinaEfterlysningar from "./screens/MinaEfterlysningar";
import DemandWall from "./screens/DemandWall";
import ButikChrome from "../butik/components/Chrome";

/**
 * Efterlysningarnas två sidor, med butikens ram runt sig.
 *
 * KÖPSIDAN SOM LÅG HÄR ÄR BORTTAGEN. `/kop` var en landningssida — hero, animation, länkfältet,
 * märkesbrickorna, säljpunkterna — och den finns inte längre; adressen 301:as till butiken, som är
 * den ingång köparen ska ha. Kvar står de två vyer som aldrig handlade om att beskriva sidan utan om
 * någons faktiska efterlysningar: "Mina efterlysningar" och efterfrågeväggen.
 *
 * De ligger kvar under samma router och samma ram med flit. Ramen är butikens (topprad, sidfot), så
 * en köpare som klickar mellan sina efterlysningar och lagret inte upplever två sajter — och
 * adresserna står i delade länkar och i utskickade notiser.
 */
export default function KopApp() {
  const route = useKopRoute();

  useEffect(() => {
    document.title =
      route.name === "mina" ? "Dina efterlysningar – Loopa" : "Sökes just nu i Stockholm – Loopa";
  }, [route]);

  return (
    <ButikChrome>
      {route.name === "mina" && <MinaEfterlysningar />}
      {route.name === "vagg" && <DemandWall kategori={route.kategori} />}
    </ButikChrome>
  );
}
