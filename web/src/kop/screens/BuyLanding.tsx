import { lazy, Suspense } from "react";
import Hero from "../components/Hero";
import Saljpunkter from "../components/Saljpunkter";
import Utbudsrad from "../components/Utbudsrad";
import Prisarlighet from "../components/Prisarlighet";
import Efterlysningsfangare from "../components/Efterlysningsfangare";
import StickyCta from "../components/StickyCta";
import { SellCta } from "../../butik/components/Bits";

/**
 * Köpsidan. Ett jobb: på under tio sekunder få någon att förstå att en möbel de hittat någon
 * annanstans kan köpas riskfritt och köras hem.
 *
 * ORDNINGEN ÄR ETT ARGUMENT som byggs upp i tur och ordning:
 *
 *   hero          vad du kan göra, och fältet att göra det i — sidans LCP
 *   animationen   hur det går till, VISAT och inte beskrivet
 *   säljpunkter   vad du slipper
 *   utbudet       att vi har egna möbler också (döljs om de är för få)
 *   priset        vad det kostar, plus sidans enda brödtext
 *   fångaren      för den som inte hittat något än
 *   sälj-CTA      andra sidan av loopen
 *
 * ANIMATIONEN LAZY-LADDAS. Den ligger under vecket, och heron ska målas utan att vänta på en enda
 * byte av något annat.
 */
const SaFunkarDet = lazy(() => import("../animation/SaFunkarDet"));

export default function BuyLanding() {
  return (
    <>
      <Hero />

      <Suspense fallback={<div className="funkar-plats" aria-hidden="true" />}>
        <SaFunkarDet />
      </Suspense>

      <Saljpunkter />
      <Utbudsrad />
      <Prisarlighet />
      <Efterlysningsfangare />
      <SellCta />

      <StickyCta />
    </>
  );
}
