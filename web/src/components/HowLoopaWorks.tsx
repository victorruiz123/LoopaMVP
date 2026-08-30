import { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useT } from "../lib/i18n";
import { LOOPA_PERCENT, SELLER_PERCENT, loopaFee, sellerPayout } from "../lib/fees";
import { formatSek } from "../lib/price";
import { CheckIcon, ShieldIcon, SofaIcon, SparkIcon, TruckIcon } from "./icons";

/**
 * Prototypen på låsskärmen: fem scener som spelas upp efter varandra.
 *
 * Det här är den enda plats i appen där hela affären syns på en gång — från varvet runt möbeln till
 * de utbetalda kronorna. Den som står utanför grinden har aldrig sett produkten, och en punktlista
 * hade beskrivit den utan att visa den.
 *
 * Scenerna är RITADE, inte inspelade: samma tokens, samma typsnitt och samma former som appen, men
 * byggda av divar. En filmad skärminspelning hade blivit inaktuell vid första omdesignen och väger
 * dessutom megabyte; det här väger ingenting och åldras i takt med designsystemet.
 *
 * Talen är hämtade ur koden där det går. Andelarna räknas av lib/fees — samma funktioner som
 * skickar säljaren sin utbetalning — så låsskärmen kan aldrig lova en annan procent än appen tar.
 */

/** Möbeln i exemplet. Priset är påhittat; allt som räknas ur det är det inte. */
const DEMO_PRICE = 2400;

/** Hur länge en scen står kvar. Lång nog att läsa bildtexten under den, kort nog att sitta av alla fem. */
const SCENE_MS = 5200;

/**
 * Fördröjningen som CSS-variabel.
 *
 * Varje sak i en scen kommer in med samma gest men vid sin egen tid, och tiden hör till innehållet
 * — vilken ordning saker händer i — inte till formen. Därför står den i JSX bredvid det som ska
 * synas, och animationen står en gång i CSS.
 */
const at = (seconds: number, extra?: CSSProperties): CSSProperties =>
  ({ ...extra, "--d": `${seconds}s` }) as CSSProperties;

/* ---- scen 1: annonsen görs ---------------------------------------------------------------- */

function CaptureStage(): ReactElement {
  const t = useT();
  return (
    <div className="proto-scene">
      {/* Sökaren. Ringen fylls ett varv — samma mätare som kameravyn ritar runt möbeln. */}
      <div className="proto-lens">
        <svg className="proto-ring" viewBox="0 0 132 132" aria-hidden="true">
          <circle className="proto-ring-track" cx="66" cy="66" r="58" />
          <circle className="proto-ring-fill" cx="66" cy="66" r="58" />
        </svg>
        <span className="proto-lens-piece">
          <SofaIcon size={46} />
        </span>
        <span className="proto-lens-tag">{t("Ett varv, 20 sekunder")}</span>
      </div>

      {/* Och ur varvet skriver sig annonsen. Raderna växer fram i den ordning texten blir till. */}
      <div className="proto-sheet">
        <span className="proto-sheet-head">
          <SparkIcon size={14} />
          {t("Annonsen skriver sig själv")}
        </span>
        <span className="proto-write proto-write-lg" style={at(0.55)} />
        <span className="proto-write" style={at(0.8)} />
        <span className="proto-write proto-write-sm" style={at(1)} />
        <div className="proto-chiprow">
          <span className="proto-chip" style={at(1.35)}>{t("Ek")}</span>
          <span className="proto-chip" style={at(1.5)}>140 × 80 cm</span>
          <span className="proto-chip" style={at(1.65)}>{t("1970-tal")}</span>
        </div>
        <div className="proto-pricerow" style={at(1.95)}>
          <span>{t("Prisförslag")}</span>
          <strong>{formatSek(DEMO_PRICE)}</strong>
        </div>
      </div>
    </div>
  );
}

/* ---- scen 2: skicket granskas -------------------------------------------------------------- */

/** Fynden i exemplet: var på möbeln de sitter, vad de heter, och när de dyker upp. */
const FINDINGS = [
  { x: 18, y: 30, label: "Repa 4 cm", d: 0.65 },
  { x: 54, y: 22, label: "Slitage", d: 0.95 },
  { x: 33, y: 64, label: "Fläck", d: 1.25 },
];

function ConditionStage(): ReactElement {
  const t = useT();
  return (
    <div className="proto-scene">
      <div className="proto-photo">
        <span className="proto-photo-piece">
          <SofaIcon size={66} />
        </span>
        {/* Svepet över bilden: granskningen som pågår, inte en dekoration som snurrar. */}
        <span className="proto-sweep" aria-hidden="true" />
        {FINDINGS.map((f) => (
          <span key={f.label} className="proto-mark" style={at(f.d, { left: `${f.x}%`, top: `${f.y}%` })}>
            <i className="proto-mark-ring" />
            <em className="proto-mark-label">{t(f.label)}</em>
          </span>
        ))}
      </div>

      <div className="proto-verdict" style={at(1.85)}>
        <span className="proto-grade">B</span>
        <span className="proto-verdict-text">
          <strong>{t("Bra skick")}</strong>
          <em>{t("Tre fynd, vart och ett med sin bild")}</em>
        </span>
      </div>
      {/* Loopa-ID:t är det som gör påståendet kontrollerbart: köparen slår upp det och ser samma kort. */}
      <span className="proto-id" style={at(2.25)}>LP-7K2M-4XQ1</span>
    </div>
  );
}

/* ---- scen 3: annonsen läggs ut ------------------------------------------------------------- */

const MARKETS = ["Tradera", "Blocket", "loopa.se"];

function ListedStage(): ReactElement {
  const t = useT();
  return (
    <div className="proto-scene proto-scene-listed">
      <div className="proto-mini" style={at(0.15)}>
        <span className="proto-mini-thumb">
          <SofaIcon size={24} />
        </span>
        <span className="proto-mini-text">
          <strong>{t("Teakbord, 1970-tal")}</strong>
          <em>
            {formatSek(DEMO_PRICE)} · {t("Skick B")}
          </em>
        </span>
      </div>

      {/* Tre streck ut ur samma annons: en möbel, flera marknadsplatser, ingen extra insats. */}
      <svg className="proto-fan" viewBox="0 0 300 44" preserveAspectRatio="none" aria-hidden="true">
        <path d="M150 0 C150 26 52 16 52 44" style={at(0.35)} />
        <path d="M150 0 L150 44" style={at(0.5)} />
        <path d="M150 0 C150 26 248 16 248 44" style={at(0.65)} />
      </svg>

      <div className="proto-markets">
        {MARKETS.map((m, n) => (
          <span key={m} className="proto-market" style={at(0.9 + n * 0.16)}>
            {m}
          </span>
        ))}
      </div>

      <p className="proto-stat" style={at(1.7)}>
        <strong>184</strong> {t("visningar")}
        <span className="proto-stat-dot" />
        <strong>6</strong> {t("bevakar")}
        <span className="proto-stat-dot" />
        <strong>2</strong> {t("frågor")}
      </p>
    </div>
  );
}

/* ---- scen 4: frakten ----------------------------------------------------------------------- */

function ShippingStage(): ReactElement {
  const t = useT();
  return (
    <div className="proto-scene">
      <div className="proto-route">
        <span className="proto-stop">
          <i className="proto-stop-dot" />
          {t("Hemma hos dig")}
        </span>
        <span className="proto-track" aria-hidden="true">
          <i className="proto-track-done" />
          <i className="proto-van">
            <TruckIcon size={15} />
          </i>
        </span>
        <span className="proto-stop">
          <i className="proto-stop-dot proto-stop-dot-end" />
          {t("Hos köparen")}
        </span>
      </div>

      {/* Trygghet och smidighet är två olika löften, och de står som var sin rad av samma skäl. */}
      <ul className="proto-assure">
        <li style={at(0.8)}>
          <ShieldIcon size={15} />
          {t("Betald och försäkrad frakt")}
        </li>
        <li style={at(1.05)}>
          <CheckIcon size={15} />
          {t("Upphämtning vid din dörr")}
        </li>
        <li style={at(1.3)}>
          <CheckIcon size={15} />
          {t("Spårning hela vägen fram")}
        </li>
      </ul>
    </div>
  );
}

/* ---- scen 5: transaktionen och provisionen ------------------------------------------------- */

function PayoutStage(): ReactElement {
  const t = useT();
  return (
    <div className="proto-scene">
      <div className="proto-sold" style={at(0.25)}>
        <span>{t("Såld för")}</span>
        <strong>{formatSek(DEMO_PRICE)}</strong>
      </div>

      {/* Delningen visas som en enda stapel, inte som två tal bredvid varandra: andelen ska synas
          som andel av något innan den läses som siffra. */}
      <div className="proto-bar" aria-hidden="true">
        <span className="proto-bar-seller" style={at(0.55, { width: `${SELLER_PERCENT}%` })} />
        <span className="proto-bar-loopa" style={at(0.55, { width: `${LOOPA_PERCENT}%` })} />
      </div>

      <dl className="proto-ledger">
        <div style={at(1)}>
          <dt>
            <i className="proto-key proto-key-seller" />
            {t("Du får")}
          </dt>
          <dd>
            <strong>{formatSek(sellerPayout(DEMO_PRICE))}</strong>
            <em>{SELLER_PERCENT} %</em>
          </dd>
        </div>
        <div style={at(1.2)}>
          <dt>
            <i className="proto-key proto-key-loopa" />
            {t("Loopa")}
          </dt>
          <dd>
            <strong>{formatSek(loopaFee(DEMO_PRICE))}</strong>
            <em>{LOOPA_PERCENT} %</em>
          </dd>
        </div>
      </dl>

      <p className="proto-note" style={at(1.6)}>{t("Pengarna betalas ut när köparen har fått möbeln.")}</p>
    </div>
  );
}

/* ---- uppspelningen ------------------------------------------------------------------------- */

interface Scene {
  id: string;
  /** Namnet i stegraden. Syns bara för skärmläsare — raden är fem streck, inte fem etiketter. */
  tab: string;
  title: string;
  body: string;
  Stage: () => ReactElement;
}

const SCENES: Scene[] = [
  {
    id: "annons",
    tab: "Annonsen",
    title: "Du filmar ett varv. Vi skriver annonsen.",
    body: "Märke, modell, mått, material och pris läses ur bilderna. Du behöver inte skriva en rad.",
    Stage: CaptureStage,
  },
  {
    id: "skick",
    tab: "Skicket",
    title: "Skicket granskas ruta för ruta.",
    body: "Varje repa och fläck får en egen bild och ett eget avdrag — och ett Loopa-ID som köparen kan slå upp.",
    Stage: ConditionStage,
  },
  {
    id: "utlagd",
    tab: "Annonseringen",
    title: "Möbeln läggs ut där köparna finns.",
    body: "En annons, flera marknadsplatser. Vi svarar på frågorna och bevakar buden åt dig.",
    Stage: ListedStage,
  },
  {
    id: "frakt",
    tab: "Frakten",
    title: "Frakten är bokad, betald och spårad.",
    body: "Budbilen hämtar hemma hos dig. Du bär ingenting, och möbeln är försäkrad hela vägen.",
    Stage: ShippingStage,
  },
  {
    id: "betalning",
    tab: "Betalningen",
    title: "Pengarna delas när möbeln är framme.",
    body: "Köparens betalning hålls tills leveransen är kvitterad. Sedan går din del ut — vår andel är provisionen.",
    Stage: PayoutStage,
  },
];

/**
 * Rörelse av- eller påslaget i systemet.
 *
 * Med den avstängd spelas ingenting upp av sig självt: scenerna står still i sitt färdiga läge, och
 * den som vill se dem byter själv i stegraden. Att bara sakta ner uppspelningen hade missat poängen
 * — inställningen betyder "flytta inte saker framför mig", inte "flytta dem långsammare".
 */
function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export default function HowLoopaWorks() {
  const t = useT();
  const [index, setIndex] = useState(0);
  /**
   * Ett tryck i stegraden stoppar uppspelningen för gott.
   *
   * Den som väljer en scen vill titta på den, och att rycka undan den fem sekunder senare gör
   * raden obrukbar — man hinner aldrig fram till det man pekade på.
   */
  const [taken, setTaken] = useState(false);
  const reduced = usePrefersReducedMotion();
  const playing = !reduced && !taken;

  useEffect(() => {
    if (!playing) return;
    const id = window.setTimeout(() => setIndex((n) => (n + 1) % SCENES.length), SCENE_MS);
    return () => window.clearTimeout(id);
  }, [index, playing]);

  const scene = SCENES[index];

  return (
    <section className="proto" aria-labelledby="proto-heading">
      <h2 id="proto-heading" className="proto-heading">
        {t("Hur funkar")} <span className="app-wordmark proto-heading-mark">Loopa</span>?
      </h2>

      {/* Nyckeln byter scen OCH startar om animationerna: varje scen ritas från noll varje gång den
          visas, i stället för att stå färdig när man kommer tillbaka till den. */}
      <div className="proto-frame">
        <div className="proto-screen" key={scene.id}>
          <scene.Stage />
        </div>
      </div>

      {/* Bildtexten säger vad scenen visar. Ingen aria-live: en uppläsning var femte sekund gör
          sidan obrukbar med skärmläsare, och rubriken plus stegraden bär redan innehållet. */}
      <p className="proto-caption">
        <strong>{t(scene.title)}</strong>
        <span>{t(scene.body)}</span>
      </p>

      <ol className="proto-rail">
        {SCENES.map((s, n) => (
          <li key={s.id}>
            <button
              type="button"
              className={`proto-rail-step ${n === index ? "proto-rail-step-on" : ""}`}
              aria-current={n === index ? "step" : undefined}
              onClick={() => {
                setIndex(n);
                setTaken(true);
              }}
            >
              <span
                className="proto-rail-fill"
                style={playing && n === index ? { animationDuration: `${SCENE_MS}ms` } : undefined}
              />
              <span className="visually-hidden">{t(s.tab)}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
