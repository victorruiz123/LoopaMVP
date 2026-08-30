import type { CardCover, ConditionResult } from "../types";
import { damageStands } from "../lib/damages";
import { ArrowLeftIcon } from "../components/icons";
import LoopaIdBlock from "../components/LoopaIdBlock";
import ListingView from "../components/ListingView";
import SellWithLoopa from "../components/SellWithLoopa";
import { usePageTitle } from "../lib/pageTitle";
import { useT } from "../lib/i18n";
import { coverUrl, imageUrl } from "../api";

/**
 * Säljarens vy av sin annons.
 *
 * Själva kortet ritas av ListingView, som är samma vy det publika kortet använder — det säljaren
 * granskar här är exakt det en köpare ser på Loopa-ID:t. Runt kortet ligger det som bara är
 * säljarens: ID:t med vad det innebär, och vägen ut — "Sälj med Loopa", som lägger ut möbeln till
 * salu och lämnar över försäljningen till oss.
 *
 * En väg ut, inte två: "Se Blocket-annons" låg här som ett andra sätt att sälja, men det var inte
 * att sälja med Loopa — det var att få tillbaka annonsen som text att bära någon annanstans för
 * hand. Ett erbjudande att göra jobbet själv, mitt i det som är hela löftet att slippa.
 *
 * Skärmen slutar därför i "Sälj med Loopa" och inte i ett "Klar". "Klar" satt längst ner som sista
 * knapp på en möbel som ännu inte var såld — ett ord som säger att arbetet är gjort, precis där
 * beslutet ska tas. Kvar av den blir bara dörren ut ur ett kort som INTE går att sälja: där finns
 * det ingenting annat att trycka på.
 */
export default function ListingScreen({
  result,
  loopaId,
  onBack,
  onHome,
  onMyListings,
}: {
  result: ConditionResult;
  /** Kortets publika ID. Saknas bara om jobbsvaret hämtades innan servern började skicka med det. */
  loopaId?: string;
  onBack: () => void;
  onHome: () => void;
  /**
   * Till profilen, där möbeln står under "Till salu" så fort den lagts ut.
   *
   * Valfri: adminpanelen öppnar samma skärm för någon annans kort, och där leder "dina annonser"
   * fel. Saknas den ritas ingen sådan väg.
   */
  onMyListings?: () => void;
}) {
  const t = useT();
  const listing = result.listing;
  usePageTitle("Annons");
  const card = listing?.result ?? null;
  /** Annonsen är framme och går att sälja — då är säljknappen skärmens sista handling. */
  const ready = listing?.status === "ok" && !!card;

  return (
    <div className="screen screen-light card-screen">
      <button className="btn btn-text btn-back" onClick={onBack}>
        <ArrowLeftIcon /> {t("Tillbaka till skicket")}
      </button>

      {!listing || listing.status === "unavailable" ? (
        <section className="card-panel">
          <div className="card-kicker">{t("Annons")}</div>
          <h2 className="card-title">{t("Annonsen kunde inte skapas")}</h2>
          <p className="muted small">
            {listing?.unavailableReason ?? t("Inget märke angavs, så det fanns inget att söka på.")}
          </p>
        </section>
      ) : listing.status === "pending" || !card ? (
        <section className="card-panel">
          <div className="card-kicker">{t("Annons")}</div>
          <div className="price-skeleton" />
          <p className="muted small">{t("Letar upp modell och specifikationer…")}</p>
        </section>
      ) : (
        <>
          <ListingView
            card={card}
            identity={result.identity}
            grade={result.grade}
            price={result.price}
            damages={result.damages.filter(damageStands)}
            imageCount={result.images.length}
            reviewed={result.reviewed}
            productImage={result.productImage}
            cover={sellerCover(result)}
            loopaId={loopaId}
          />
          {/* ID:t före säljknappen: det står i annonstexten som skickas, och säljaren ska ha
              sett vad de delar innan de trycker. */}
          {loopaId && <LoopaIdBlock loopaId={loopaId} />}
          {/* Sist på kortet, efter allt som ska granskas: vägen ut. Det är det enda på den här
              skärmen som lämnar appen, så den ska komma efter att säljaren läst vad som skickas. */}
          <SellWithLoopa jobId={result.jobId} onMyListings={onMyListings} />
        </>
      )}

      {/* Bara för kort som inte går att sälja: annonsen föll, eller den byggs fortfarande. Den
          färdiga annonsens sista knapp är säljknappen ovanför, och två knappar under varandra där
          hade gjort försäljningen till ett av två likvärdiga val. */}
      {!ready && (
        <button className="btn btn-primary card-done" onClick={onHome}>
          {t("Till startsidan")}
        </button>
      )}
    </div>
  );
}

/**
 * Omslaget på SÄLJARENS kort.
 *
 * Två steg, i fallande ordning: urklippet mot vitt när det blev till, annars bildrutan det skulle ha
 * gjorts av — som den togs, med rummet kvar. Det andra steget finns bara här. På det publika kortet
 * lämnas ingen rå bildruta ut (se server/src/publicCard.ts); där är urklippet enda vägen till en bild
 * av möbeln, och saknas det står katalogbilden kvar som kortets sista utväg.
 */
function sellerCover(result: ConditionResult): CardCover | null {
  if (result.coverCutout) return { url: coverUrl(result.jobId), kind: "cutout" };
  if (result.coverImageId) return { url: imageUrl(result.jobId, result.coverImageId), kind: "photo" };
  return null;
}
