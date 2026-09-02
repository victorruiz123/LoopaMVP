import EfterlysningInput from "../components/EfterlysningInput";
import TryggAffarBlock from "../components/TryggAffarBlock";
import ProofStrip from "../components/ProofStrip";
import { ProductStrip } from "../../butik/components/ProductGrid";
import { Link, SellCta } from "../../butik/components/Bits";

/**
 * Köpsidan. Hierarkin ÄR produkten.
 *
 * En köpare har exakt två tillstånd, och sidan svarar på båda i den ordning de är värda för oss:
 *
 *   1. LETAR FORTFARANDE  → efterlysningen. Överst, som sidans hela ärende. Det är den vi vill lära
 *      folk att göra: den fungerar oberoende av hur stort vårt lager är, och varje sparad
 *      efterlysning är ett påstående om efterfrågan vi kan agera på.
 *   2. HAR REDAN HITTAT   → Trygg affär. Direkt under, visuellt lika stark och med fältet inne i
 *      blocket. Den vägen konverterar bäst tidigt — köparen har redan bestämt sig om möbeln och
 *      behöver bara oss — och den behandlas därför som en förstklassig ingång, inte en textlänk.
 *
 * Sedan bevis, sedan lagret, sedan sälj-CTA:n. Bevisremsan ritar ingenting utan riktig data.
 */
export default function BuyLanding() {
  return (
    <>
      <EfterlysningInput />

      <TryggAffarBlock />

      <ProofStrip />

      <section className="butik-section">
        <div className="butik-section-head">
          <h2>Nyinkommet hos oss</h2>
          <Link to={{ name: "search", q: "" }}>Visa allt →</Link>
        </div>
        <p className="kop-feed-lede">
          Granskade möbler som står hos oss just nu — filmade, genomgångna och prissatta efter skick.
        </p>
        <ProductStrip query={{ onlyLoopa: true, sortering: "nyinkommet" }} limit={8} />
      </section>

      <SellCta />
    </>
  );
}
