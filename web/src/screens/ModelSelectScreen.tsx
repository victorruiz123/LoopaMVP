import { useEffect, useState } from "react";
import type { ModelCandidate } from "../types";
import { ChevronRight } from "../components/icons";
import FlowSteps from "../components/FlowSteps";
import { usePageTitle } from "../lib/pageTitle";
import { useT } from "../lib/i18n";

/**
 * Vilken modell är det?
 *
 * Tvetydighet mellan VERKLIGA produkter lämnas till säljaren i stället för att slås ut med fler
 * modellanrop — mänsklig särskiljning är billig, modellatens är dyr. Skärmen visas bara när det finns
 * något att välja mellan: kunde identifieringen avgöra saken själv hoppas den över helt.
 *
 * Men alla fyra kan vara fel, och då är "skriv namnet själv" ett dåligt enda svar: säljaren tittar på
 * en möbel utan att veta vad den heter — det är därför de är här. Alltså finns tre utgångar och inte
 * två: välj en, hitta nya, eller skriv manuellt.
 */
export default function ModelSelectScreen({
  brand,
  candidates,
  round,
  searchingImages = false,
  onSelect,
  onManual,
  onFindNew,
}: {
  brand: string | null;
  candidates: ModelCandidate[];
  /** Antal gånger säljaren bett om nya förslag. 0 = den första listan. Styr bara texten. */
  round: number;
  /**
   * Hämtar servern fortfarande bilder till listan?
   *
   * Falskt när pollningen tagit slut — och då finns det ingen som kan fylla i de bilder som saknas.
   * Skimret ska sluta i samma stund: en platshållare som rör sig lovar att något är på väg.
   */
  searchingImages?: boolean;
  onSelect: (candidate: ModelCandidate) => void;
  onManual: (model: string) => void;
  onFindNew: () => void;
}) {
  const t = useT();
  const [manual, setManual] = useState("");
  usePageTitle("Välj modell");
  const [manualOpen, setManualOpen] = useState(false);

  const models = brand ? t("{märke}-modeller", { märke: brand }) : t("modeller");
  const lede =
    candidates.length > 0
      ? round > 0
        ? t("Här är {antal} andra {modeller}. De du redan sagt nej till kommer inte tillbaka.", {
            antal: candidates.length,
            modeller: models,
          })
        : t("Vi hittade {antal} {modeller} som stämmer med bilderna. Välj den som är din.", {
            antal: candidates.length,
            modeller: models,
          })
      : round > 0
        ? t("Vi hittade inga fler modeller att föreslå. Skriv namnet själv om du vet det.")
        : t("Vi kunde inte peka ut någon modell ur bilderna. Skriv namnet själv om du vet det.");

  return (
    <div className="screen screen-light">
      <header className="home-header">
        <FlowSteps current={1} />
        <h1 className="home-title">
          {t("Vilken modell")}
          <br />
          <span className="accent">{t("är det?")}</span>
        </h1>
        <p className="home-lede">{lede}</p>
      </header>

      {candidates.length > 0 && (
        <div className="candidate-list">
          {candidates.map((c, i) => (
            <button key={`${c.model}-${i}`} className="candidate" onClick={() => onSelect(c)}>
              {/* Bild och namn, inget annat. Bilden ÄR jämförelsen — en säljare känner igen sin
                  möbel på en sekund och behöver inte läsa sig till skillnaden. */}
              <CandidatePhoto url={c.imageUrl} searching={searchingImages} />
              <span className="candidate-name">{c.model}</span>
              <span className="candidate-chevron">
                <ChevronRight size={18} />
              </span>
            </button>
          ))}
        </div>
      )}

      {/* De två utvägarna står bredvid varandra, som svar på samma fråga. "Hitta nya" ligger först:
          den kostar säljaren ett tryck och en väntan, medan den andra kräver att de vet namnet. */}
      {!manualOpen ? (
        candidates.length > 0 ? (
          <div className="candidate-none">
            <span className="candidate-none-label">{t("Ingen av dem?")}</span>
            <button className="btn btn-text" onClick={onFindNew}>
              {t("Hitta nya")}
            </button>
            <button className="btn btn-text" onClick={() => setManualOpen(true)}>
              {t("Skriv manuellt")}
            </button>
          </div>
        ) : (
          <button className="btn btn-text manual-model-link" onClick={() => setManualOpen(true)}>
            {t("Skriv modellnamnet")}
          </button>
        )
      ) : (
        <div className="form-group manual-model">
          <div className="form-row">
            <label className="form-row-label" htmlFor="manual-model">
              {t("Modell")}
            </label>
            <input
              id="manual-model"
              className="form-row-input"
              value={manual}
              autoFocus
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && manual.trim() && onManual(manual.trim())}
              placeholder={t("t.ex. Söderhamn")}
            />
          </div>
        </div>
      )}
      {manualOpen && (
        <button className="btn btn-primary" disabled={!manual.trim()} onClick={() => onManual(manual.trim())}>
          {t("Fortsätt")}
        </button>
      )}
    </div>
  );
}

/** Så länge en bildruta får hänga innan vi behandlar den som en tom ruta. */
const PHOTO_TIMEOUT_MS = 12_000;

/**
 * Bildrutan: den skimrar bara så länge någon faktiskt letar.
 *
 * TRE lägen, inte två. `undefined` betyder att servern fortfarande letar upp bilden och ÄR en
 * laddning. `null` är dess besked att ingen hittades — och ett skimmer för ett avslutat letande är
 * precis en bild som står och laddar i evighet. Samma sak när pollningen gett upp: då finns det
 * ingen kvar som kan fylla i rutan, hur mycket den än rör sig.
 *
 * Det tredje läget är hämtningen hos säljaren. En <img> mot en långsam butiks-CDN kan hänga hur
 * länge som helst utan att säga något: `onError` kommer aldrig, för anslutningen är inte bruten utan
 * bara tyst, och webbläsaren har ingen egen tidsgräns att erbjuda. Rutan får därför en egen, och
 * faller tillbaka på den stilla platshållaren när den löper ut.
 */
function CandidatePhoto({ url, searching }: { url?: string | null; searching: boolean }) {
  const [state, setState] = useState<"laddar" | "klar" | "död">("laddar");

  useEffect(() => {
    setState("laddar");
    if (!url) return;
    const id = setTimeout(() => setState((s) => (s === "laddar" ? "död" : s)), PHOTO_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [url]);

  return (
    <span className="candidate-photo">
      {url && state !== "död" ? (
        /* Ingen `loading="lazy"`: fyra miniatyrer, och de ÄR skärmens innehåll — säljaren väljer på
           bilden. En uppskjuten hämtning hade dessutom hunnit slå i tidsgränsen ovan utan att ett
           enda byte begärts, och rutan hade slocknat för en bild som aldrig ens efterfrågats. */
        <img src={url} alt="" onLoad={() => setState("klar")} onError={() => setState("död")} />
      ) : (
        <span
          className={`candidate-photo-empty${url === undefined && searching ? " is-searching" : ""}`}
          aria-hidden="true"
        />
      )}
    </span>
  );
}
