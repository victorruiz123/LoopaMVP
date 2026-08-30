// Utvecklingsvy: de två väntorna bredvid varandra. De ligger sekunder isär i flödet men aldrig på
// samma skärm, så det enda sättet att se om de är TILLRÄCKLIGT olika är att ställa dem sida vid
// sida. Ingår inte i appen.
import { createRoot } from "react-dom/client";
import ModelSearchLoader from "../components/ModelSearchLoader";
import ListingBuildLoader from "../components/ListingBuildLoader";

const el = document.getElementById("root")!;
el.style.cssText = "display:flex;flex-wrap:wrap;gap:56px;justify-content:center;padding:64px 16px";
createRoot(el).render(
  <>
    <div className="center-column" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <ModelSearchLoader />
      <p className="wait-title">Letar upp modellen…</p>
    </div>
    <div className="center-column" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <ListingBuildLoader />
      <p className="wait-title">Bygger annonsen…</p>
    </div>
  </>,
);
