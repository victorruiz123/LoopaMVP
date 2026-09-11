import { useEffect, useState } from "react";
import type { CardCover, CardDamage, ConditionResult } from "../types";
import { damageStands } from "../lib/damages";
import { ArrowLeftIcon } from "../components/icons";
import ListingView from "../components/ListingView";
import SellWithLoopa from "../components/SellWithLoopa";
import { usePageTitle } from "../lib/pageTitle";
import { useT } from "../lib/i18n";
import { deleteJob, imageUrl, saveListingDetails } from "../api";

/**
 * Säljarens vy av sin annons.
 *
 * Själva kortet ritas av ListingView, som är samma vy det publika kortet använder — det säljaren
 * granskar här är exakt det en köpare ser. Runt kortet ligger bara vägen ut — "Sälj med Loopa",
 * som lägger ut möbeln till salu och lämnar över försäljningen till oss.
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
  result: initialResult,
  loopaId,
  onBack,
  backLabel,
  onHome,
  onMyListings,
  onSellAnother,
  onDeleted,
}: {
  result: ConditionResult;
  /** Kortets publika ID. Saknas bara om jobbsvaret hämtades innan servern började skicka med det. */
  loopaId?: string;
  onBack: () => void;
  /**
   * Vad vägen tillbaka heter.
   *
   * Den står i flödet direkt efter skickbedömningen, och DÄR är "Tillbaka till skicket" sant. Öppnas
   * samma kort ur profilen är det en lögn: skicket ligger inte bakom, mina annonser gör det — och en
   * knapp som säger fel om vart den leder är sämre än ingen knapp. Texten kommer därför utifrån, av
   * den som vet var man kom ifrån.
   */
  backLabel?: string;
  onHome: () => void;
  /**
   * Till profilen, där möbeln står under "Till salu" så fort den lagts ut.
   *
   * Valfri: adminpanelen öppnar samma skärm för någon annans kort, och där leder "dina annonser"
   * fel. Saknas den ritas ingen sådan väg.
   */
  onMyListings?: () => void;
  /** Ett nytt varv, med nästa möbel. Valfri av samma skäl som `onMyListings`. */
  onSellAnother?: () => void;
  /**
   * Annonsen är borta — vart man går då.
   *
   * Att den är VALFRI är själva behörighetsprövningen på skärmen: saknas den ritas ingen
   * borttagningsknapp alls. Adminpanelen öppnar samma skärm för andras kort och skickar inte in
   * den; servern prövar ägarskapet igen på sin sida (DELETE /api/jobs/:id).
   */
  onDeleted?: () => void;
}) {
  const t = useT();

  /**
   * Kortet som det ser ut just nu — inte som det såg ut när skärmen öppnades.
   *
   * Säljaren kan rätta måtten och beskrivningen härifrån, och varje sådan skrivning svarar med hela
   * `ConditionResult`. Utan ett eget tillstånd hade vyn ritat om med propen, alltså med texten som
   * gällde före ändringen — rättelsen hade sparats på servern och försvunnit på skärmen.
   *
   * Propen vinner fortfarande när den byts: App skickar in ett nytt resultat när man går via
   * skickskärmen igen, och det är färskare än vårt.
   */
  const [result, setResult] = useState(initialResult);
  useEffect(() => setResult(initialResult), [initialResult]);

  /**
   * Borttagningen, i två tryck.
   *
   * Ett steg hade varit fel: annonsen är resultatet av en filmning, en skickbedömning och en
   * prissättning, och den går inte att göra ogjord. Frågan ställs därför på skärmen i stället för i
   * en `confirm()` — den senare ser ut som webbläsarens fråga, inte som vår, och texten om vad som
   * faktiskt försvinner får inte plats i den.
   *
   * Felet visas där knappen står. Servern är den som avgör om annonsen får tas bort (möbeln kan
   * ligga ute till salu eller redan vara köpt), och dess besked är formulerat för säljaren.
   */
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function remove() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteJob(result.jobId);
      onDeleted?.();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  const listing = result.listing;
  usePageTitle("Annons");
  const card = listing?.result ?? null;
  /** Annonsen är framme och går att sälja — då är säljknappen skärmens sista handling. */
  const ready = listing?.status === "ok" && !!card;

  return (
    <div className="screen screen-light card-screen">
      <button className="btn btn-text btn-back" onClick={onBack}>
        <ArrowLeftIcon /> {backLabel ?? t("Tillbaka till skicket")}
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
            damages={saljarensSkador(result)}
            imageCount={result.images.length}
            reviewed={result.reviewed}
            /**
             * KATALOGBILDEN SKICKAS INTE IN HÄR, och det är avsiktligt.
             *
             * ListingView tar katalogbilden före en orörd bildruta (se `candidates` där), vilket är
             * rätt ordning för en KÖPARE: en studiobild av en ny möbel ser ut som något man handlar.
             * Säljaren granskar något annat — sin egen möbel, som den blev fotograferad. Att visa
             * en främmande produktbild överst på den sidan är att visa fel möbel till fel person.
             *
             * Uttryckligen null och inte en flagga: det finns ingen katalogbild att välja bort i
             * den här vyn, det finns bara säljarens omslag.
             */
            productImage={null}
            cover={sellerCover(result)}
            loopaId={loopaId}
            /* Fällda sektioner, så att "Sälj med Loopa" ryms på första skärmen. Se `collapsible`
               i ListingView för varför det gäller den här vyn och inte det publika kortet. */
            collapsible
            /* Säljaren har inga frågor att ställa om sin egen möbel — se `hideChat` i ListingView. */
            hideChat
            onSaveListing={async (patch) => setResult(await saveListingDetails(result.jobId, patch))}
          />
          {/* Sist på kortet, efter allt som ska granskas: vägen ut. Det är det enda på den här
              skärmen som lämnar appen, så den ska komma efter att säljaren läst vad som skickas.

              LOOPA-ID:T STOD HÄR, i en egen ruta med kopieringsknapp och tre rader förklaring. Det
              är en intern nyckel — den råkar stå i annonstexten, men säljaren har ingenting att
              göra med den, och en kod med en kopieringsknapp mitt i en annons ser ut som något man
              förväntas ta hand om. Kortet nås fortfarande på sitt ID; det behöver bara inte stå
              framför den som säljer möbeln. */}
          <SellWithLoopa
            jobId={result.jobId}
            coverUrl={sellerCover(result)?.url ?? null}
            onMyListings={onMyListings}
            onSellAnother={onSellAnother}
          />
        </>
      )}

      {/*
        Ta bort annonsen. SIST PÅ SIDAN och som text, inte som knapp: det är den handling man letar
        efter när man bestämt sig, inte en som ska konkurrera med att sälja möbeln.

        Ritas bara när någon tagit emot den — adminpanelen öppnar samma skärm för andras kort, och
        där finns ingenting att ta bort (se `onDeleted` i App.tsx).
      */}
      {onDeleted && (
        <section className="card-delete">
          {deleteError && <p className="sell-error">{deleteError}</p>}
          {confirmDelete ? (
            <>
              <p className="muted small">
                {t("Annonsen, bilderna och skickrapporten tas bort. Det går inte att ångra.")}
              </p>
              <div className="card-delete-row">
                <button className="btn btn-danger" onClick={() => void remove()} disabled={deleting}>
                  {deleting ? t("Tar bort…") : t("Ja, ta bort annonsen")}
                </button>
                <button className="btn btn-text" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                  {t("Avbryt")}
                </button>
              </div>
            </>
          ) : (
            <button className="btn btn-text card-delete-link" onClick={() => setConfirmDelete(true)}>
              {t("Ta bort annonsen")}
            </button>
          )}
        </section>
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
  /**
   * Bildrutan, orörd — samma bild köparen ser, och i samma ordning: ListingView tar katalogbilden
   * först och den här som reserv. Urklippet är avvecklat som omslag, se publicCard.ts.
   */
  if (result.coverImageId) return { url: imageUrl(result.jobId, result.coverImageId), kind: "photo" };
  return null;
}

/**
 * Skadorna med sina foton, för säljarens egen vy.
 *
 * Köparens kort får bilderna av servern (publicCard.ts) på en publik adress. Säljaren tittar på
 * samma vy men är inloggad, och hämtar därför bildrutan på jobbets egen väg. Utan den här
 * mappningen hade säljaren sett en skadelista utan foton medan köparen ser dem — och den som ska
 * godkänna en skickrapport innan den publiceras är just den som mest behöver se vad som märkts ut.
 */
function saljarensSkador(result: ConditionResult): CardDamage[] {
  const bilder = new Map(result.images.map((i) => [i.id, i]));
  return result.damages.filter(damageStands).map((d) => {
    const bevis = d.evidence.find((e) => bilder.has(e.imageId));
    const bild = bevis ? bilder.get(bevis.imageId) : undefined;
    return {
      ...d,
      bild: bevis && bild
        ? { url: imageUrl(result.jobId, bevis.imageId), mark: bevis.mark, width: bild.width, height: bild.height }
        : null,
    };
  });
}
