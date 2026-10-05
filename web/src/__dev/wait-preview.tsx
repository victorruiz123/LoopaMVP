// Utvecklingsvy: modelletningens hela väntskärm (ModelSearchWait) och annonsbyggets laddare under.
// I appen ligger väntan bakom inloggning och uppladdning; här ritas den direkt, med exakt samma
// komponent som säljaren ser. Ingår inte i appen.
import { createRoot } from "react-dom/client";
import ModelSearchWait from "../components/ModelSearchWait";
import ListingBuildWait from "../components/ListingBuildWait";
import { initViewMode } from "../lib/viewMode";

// Samma dator/telefon-växling som appen (data-view på <html>), så att ett brett fönster får
// datorvyn och telefonramen i mobil.html får telefonvyn — annars ritas alltid telefonens stilar.
initViewMode();

createRoot(document.getElementById("root")!).render(
  <>
    <ModelSearchWait brand="IKEA" again={false} />
    {/* Ankaret gör att mobil.html kan öppna rakt på den andra väntan. */}
    <div id="bygger">
      <ListingBuildWait identity={{ brand: "IKEA", model: "Söderhamn" }} />
    </div>
  </>,
);
