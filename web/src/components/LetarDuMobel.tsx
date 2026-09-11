import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { track } from "../butik/components/Bits";
import { ArrowUpIcon, CloseIcon } from "./icons";
import "./letar.css";

/**
 * "Letar du möbel?" — en fotnot, inte en andra tjänst.
 *
 * SÄLJSIDAN ÄR HUVUDPERSONEN. Den här raden är det sista som står innan sidfoten — i datorvyn på
 * startsidan i stället en knapp i topplisten, se `variant` nedan — och den ska läsas
 * som en vänlig sista mening: samma typsnitt och samma färger som resten, men mindre text, ingen
 * egen bakgrundsyta och ingen illustration. Varje gång den fått en egen ram eller en egen bild har
 * den slutat vara en fotnot och börjat konkurrera med det sidan faktiskt handlar om.
 *
 * DEN VISAR ALDRIG NÅGOT UTBUD. Ingen träfflista, inget direktsvep, ingen "3 möbler matchar redan".
 * Det är inte en teknisk begränsning: att svara med en tom hylla på "jag letar efter X" är det värsta
 * svar den här personen kan få, och att svara med en full hylla gör dem till en besökare i rutnätet
 * i stället för någon vi har adressen till. Vi tar emot beskrivningen och hör av oss. Det är allt.
 *
 * TRE STEG, OCH INGET ÄR OBLIGATORISKT UTOM ADRESSEN. Beskriv → högst tre frågor → e-post. Frågorna
 * bestäms i kod på servern (efterlysning/parse.ts) och kan alla hoppas över; är beskrivningen redan
 * tydlig ställs inga. Sista steget är en e-postadress och inget konto — se DECISIONS.md #9.
 */

/**
 * VYN ÄR EN CHATT, och samma chatt som "Hur fungerar det?".
 *
 * De två är de enda ställen på sajten där man SKRIVER till oss i stället för att trycka på något, och
 * de såg tills nyligen ut som två olika produkter: den ena ett mörkt ark med repliker, den andra en
 * ljus dialogruta med ett formulär i. Formen är nu gemensam — mörkt ark, andande prick i toppen,
 * loopas repliker som löpande text utan bubbla, det man själv skrivit i en bubbla till höger, chips
 * under och en rundad skrivrad med orange skickaknapp. Reglerna bor i `letar.css`, och den mörka
 * paletten delas med arket via `--chatt-*` i styles.css, så att de två inte kan glida isär i färg.
 *
 * STEGEN FINNS KVAR, de är bara inte längre ett formulär. Beskriv → högst tre frågor → e-post är
 * exakt samma väg och exakt samma anrop som förut; det som ändrats är att varje steg ställs som en
 * replik och besvaras i skrivraden, i stället för att byta ut rutans innehåll. En fråga i taget är
 * dessutom vad en chatt gör naturligt — räknaren "Fråga 2 av 3" behövs inte när det man redan svarat
 * står kvar ovanför.
 */
const OPPNING =
  "Hej. Berätta vad du letar efter — möbel, märke, färg, mått eller prisidé. Jag ställer högst tre korta frågor och behöver sedan bara en e-postadress. Vi hör av oss när något som stämmer kommer in.";

const PLACEHOLDER = "Beskriv möbeln du letar efter…";

/**
 * Exemplen under öppningen.
 *
 * DE FYLLER FÄLTET, de skickar inte. Skillnaden mot arkets chips är avsiktlig: där är chipset en
 * färdig FRÅGA, här är det början på en BESKRIVNING — och en beskrivning på tre ord är precis det
 * som gör att vi måste ställa frågorna vi hellre hade sluppit. Texten hamnar i rutan med markören
 * efter, och nästan alla skriver vidare på den.
 *
 * De är också svaret på tomma-rutan-problemet: "beskriv vad du letar efter" är en öppen fråga, och
 * en öppen fråga utan exempel får folk att skriva "soffa" eller ingenting alls.
 */
const EXEMPEL = [
  "3-sits soffa i ljust tyg",
  "Matbord i ek, 180 cm",
  "Skrivbord som får plats i ett sovrum",
  "Fåtölj till läshörnan",
];

const EPOST_FRAGA = "Var når vi dig? Skriv din e-postadress — inget konto behövs.";

/** INGET LÖFTE OM NÄR. "Inom 48 timmar" beror på vad som kommer in, inte på oss. */
const TACK = "Tack. Vi hör av oss om något liknande kommer in.";

/**
 * Arkets yta som ett tal, för `theme-color` — som bara tar en färg och inte en variabel.
 *
 * Samma värde som `--chatt-yta` i styles.css, och samma oundvikliga dubblering som i
 * HurFungerarDet.tsx: en metatagg kan inte läsa en CSS-variabel. Ändras den ena ska båda med.
 */
const MORK_YTA = "#1e1d1b";

interface Fraga {
  field: string;
  question: string;
  options?: string[];
}

interface Spec {
  filter: Record<string, unknown>;
  styleTags: string[];
  deadline: string | null;
  urgency: string;
  note: string | null;
  summary: string;
  aiUsed: boolean;
}

type Steg = "beskriv" | "fragor" | "epost" | "klar";

export default function LetarDuMobel({
  /**
   * Var på sajten raden står: "/", "/butik/objekt/LP-1234-5678".
   *
   * Följer med in i efterlysningen. Frågan "kom de här från en såld möbel eller från startsidan?" är
   * den enda som säger något om vad personen letade efter innan de skrev något — och den går inte
   * att svara på i efterhand.
   */
  varifran,
  /**
   * Ersätter köpblocket i stället för att stå under det.
   *
   * Sant på en såld möbel: där finns inget köp att göra, och raden är då sidans enda kvarvarande
   * handling. Den får en aning mer luft, men fortfarande ingen egen bakgrundsyta.
   */
  istallet = false,
  /**
   * Var raden står: som fotnot i flödet ("rad") eller som knapp i topplisten ("bar").
   *
   * BARA DATORVYN FÅR "bar". Toppraden på en telefon rymmer ordmärket och profilbrickan och
   * ingenting mer — ett tredje element där hade trängt undan det ena eller det andra. På en
   * datorskärm står raden tom mellan dem, och där kostar knappen ingenting av det sidan handlar om
   * samtidigt som den slutar vara det sista man ser före sidfoten. Valet görs av den som monterar
   * raden, inte här: komponenten vet inget om skärmen.
   *
   * FORTFARANDE SAMMA FOTNOT. Knappen är avskalad och orange först vid hover, precis som raden —
   * en fylld platta bredvid profilbrickan hade gjort letandet till sidans andra tjänst i stället
   * för dess andra väg.
   */
  variant = "rad",
}: {
  varifran: string;
  istallet?: boolean;
  variant?: "rad" | "bar";
}) {
  const [oppen, setOppen] = useState(false);

  const oppna = () => {
    track("letar_oppnad", { varifran, plats: variant });
    setOppen(true);
  };

  return (
    <>
      {variant === "bar" ? (
        <button type="button" className="letar-bar-knapp" onClick={oppna}>
          Letar du möbel?
        </button>
      ) : (
        <section className={`letar${istallet ? " letar-istallet" : ""}`}>
          <p className="letar-text">
            Letar du efter något? Berätta, så hör vi av oss när det kommer in.
          </p>
          <button type="button" className="letar-knapp" onClick={oppna}>
            Letar du möbel?
          </button>
        </section>
      )}

      {oppen && <LetarVy varifran={varifran} onStang={() => setOppen(false)} />}
    </>
  );
}

/** En replik i samtalet. `fel` = det gick inte; `svag` = ett överhoppande, inte ett svar. */
interface Meddelande {
  roll: "loopa" | "du";
  text: string;
  fel?: boolean;
  svag?: boolean;
}

/**
 * Vyn bakom knappen.
 *
 * EGEN KOMPONENT, monterad först när den öppnas. Raden ligger på varje produktsida och på startsidan;
 * hade tillståndet — texten, frågorna, adressen — bott i raden hade varje sida burit en halv
 * formulärmaskin den aldrig visar. Att den monteras vid öppning betyder också att en stängd och
 * återöppnad vy börjar om ren, vilket är vad "jag ångrade mig" betyder.
 *
 * SAMTALET ÄR TILLSTÅNDET SOM SYNS, `steg` det som styr. Loggen är bara det som sagts — den läses
 * aldrig för att avgöra vad som ska hända härnäst. Det är `steg`, `fragor` och `index` som gör det,
 * precis som förut, och en replik som inte gick fram kan därför inte flytta flödet framåt.
 */
function LetarVy({ varifran, onStang }: { varifran: string; onStang: () => void }) {
  const [steg, setSteg] = useState<Steg>("beskriv");
  const [logg, setLogg] = useState<Meddelande[]>([{ roll: "loopa", text: OPPNING }]);
  const [utkast, setUtkast] = useState("");
  const [beskrivning, setBeskrivning] = useState("");
  const [spec, setSpec] = useState<Spec | null>(null);
  const [fragor, setFragor] = useState<Fraga[]>([]);
  const [index, setIndex] = useState(0);
  /** Frågeloggen, i den ordning frågorna ställdes. `answer: null` = överhoppad. */
  const [svar, setSvar] = useState<{ field: string; question: string; answer: string | null }[]>([]);
  const [arbetar, setArbetar] = useState(false);

  const arkRef = useRef<HTMLDivElement>(null);
  const flodeRef = useRef<HTMLDivElement>(null);
  const faltRef = useRef<HTMLTextAreaElement>(null);
  const epostRef = useRef<HTMLInputElement>(null);

  /**
   * Escape stänger, och fokus flyttas in i arket när det öppnas.
   *
   * Fokus går till STÄNGKNAPPEN och inte till skrivraden — samma val som i "Hur fungerar det?" och
   * av samma skäl: den som öppnar ska först få läsa öppningsrepliken, och ett tangentbord som far
   * upp över den på en telefon döljer precis det man kom för. Raden fokuseras i stället så fort en
   * replik är besvarad, se nedan.
   */
  useEffect(() => {
    const vidTangent = (e: KeyboardEvent) => { if (e.key === "Escape") onStang(); };
    window.addEventListener("keydown", vidTangent);
    arkRef.current?.querySelector<HTMLButtonElement>(".letar-stang")?.focus();
    return () => window.removeEventListener("keydown", vidTangent);
  }, [onStang]);

  /** Webbläsarens fält följer med in i mörkret. Se samma effekt i HurFungerarDet.tsx. */
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) return;
    const foregaende = meta.content;
    meta.content = MORK_YTA;
    return () => { meta.content = foregaende; };
  }, []);

  /**
   * SIDAN BAKOM LÅSES medan arket står uppe.
   *
   * `position: fixed` på body och inte `overflow: hidden`, som iOS struntar i. Priset är att
   * rullpositionen går förlorad — den sparas därför undan i `top` och läggs tillbaka vid stängning,
   * annars kastas man upp till sidans topp varje gång. Rullistens bredd läggs tillbaka som padding
   * så att sidan bakom inte hoppar i sidled när den försvinner. Hela resonemanget står i
   * HurFungerarDet.tsx; koden är densamma för att de två arken beter sig likadant.
   */
  useEffect(() => {
    const y = window.scrollY;
    const body = document.body;
    const fore = {
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      paddingRight: body.style.paddingRight,
    };
    const rullist = window.innerWidth - document.documentElement.clientWidth;
    body.style.position = "fixed";
    body.style.top = `-${y}px`;
    body.style.width = "100%";
    if (rullist > 0) body.style.paddingRight = `${rullist}px`;
    return () => {
      body.style.position = fore.position;
      body.style.top = fore.top;
      body.style.width = fore.width;
      body.style.paddingRight = fore.paddingRight;
      window.scrollTo(0, y);
    };
  }, []);

  /** Ny replik syns utan att man rullar. Bara flödet rullar — sidan bakom står stilla. */
  useEffect(() => {
    flodeRef.current?.scrollTo({ top: flodeRef.current.scrollHeight, behavior: "smooth" });
  }, [logg, arbetar]);

  /** Är ordet vårt och vi inte arbetar står markören i raden, så nästa svar bara går att skriva. */
  useEffect(() => {
    if (arbetar || steg === "klar") return;
    (steg === "epost" ? epostRef.current : faltRef.current)?.focus();
  }, [arbetar, steg, index]);

  const saga = (...nya: Meddelande[]) => setLogg((l) => [...l, ...nya]);

  /**
   * Beskrivningen in, frågorna ut.
   *
   * FALLER TOLKNINGEN GÅR FLÖDET VIDARE ÄNDÅ. Utan spec och utan frågor hoppar vi rakt till
   * adressen, och det som sparas är personens egna ord. En efterlysning med bara meningen är fullt
   * användbar — den läses av en människa (efterlysning/admin.ts) — medan ett felmeddelande här hade
   * kostat oss hela avsikten. Det syns inte heller i samtalet att något gick fel: nästa replik är
   * frågan om adressen, precis som när tolkningen inte hade något att fråga om.
   */
  const tolka = async (skrivet: string) => {
    setBeskrivning(skrivet);
    setArbetar(true);
    try {
      const res = await fetch("/api/efterlysning/tolka", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: skrivet }),
      });
      const kropp = (await res.json()) as { spec?: Spec; fragor?: Fraga[] };
      if (!res.ok) throw new Error("tolkningen svarade inte");
      setSpec(kropp.spec ?? null);
      const q = kropp.fragor ?? [];
      setFragor(q);
      setIndex(0);
      if (q.length) {
        saga({ roll: "loopa", text: q[0].question });
        setSteg("fragor");
      } else {
        saga({ roll: "loopa", text: EPOST_FRAGA });
        setSteg("epost");
      }
    } catch {
      setFragor([]);
      saga({ roll: "loopa", text: EPOST_FRAGA });
      setSteg("epost");
    } finally {
      setArbetar(false);
    }
  };

  /** Ett svar, eller ett överhoppande. Båda för flödet framåt på exakt samma sätt. */
  const besvara = (answer: string | null) => {
    const fraga = fragor[index];
    if (!fraga) return;
    const rent = answer?.trim() || null;
    setSvar((f) => [...f, { field: fraga.field, question: fraga.question, answer: rent }]);
    setUtkast("");
    const sista = index + 1 >= fragor.length;
    saga(
      rent ? { roll: "du", text: rent } : { roll: "du", text: "Hoppar över", svag: true },
      { roll: "loopa", text: sista ? EPOST_FRAGA : fragor[index + 1].question },
    );
    if (sista) setSteg("epost");
    else setIndex(index + 1);
  };

  const spara = async (adress: string) => {
    saga({ roll: "du", text: adress });
    setUtkast("");
    setArbetar(true);
    try {
      const res = await fetch("/api/efterlysning/beskrivning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: beskrivning, spec, fragor: svar, epost: adress, varifran }),
      });
      const kropp = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(kropp.error ?? "Det gick inte just nu. Försök igen.");
      track("letar_sparad", {
        varifran,
        fragor: svar.length,
        besvarade: svar.filter((s) => s.answer).length,
      });
      saga({ roll: "loopa", text: TACK });
      setSteg("klar");
    } catch (e) {
      /*
       * Felet står i samtalet, som en replik — inte som en röd rad i kanten. Det som gick fel är att
       * just den här adressen inte gick att spara, och adressen läggs tillbaka i raden så att ett
       * nytt försök är en tryckning och inte en omskrivning.
       */
      saga({ roll: "loopa", text: e instanceof Error ? e.message : "Det gick inte just nu. Försök igen.", fel: true });
      setUtkast(adress);
    } finally {
      setArbetar(false);
    }
  };

  const skicka = () => {
    const v = utkast.trim();
    if (!v || arbetar) return;
    if (steg === "beskriv") {
      saga({ roll: "du", text: v });
      setUtkast("");
      void tolka(v);
    } else if (steg === "fragor") {
      besvara(v);
    } else if (steg === "epost") {
      // En adress utan @ är inte en adress. Frågan ställs om i samtalet i stället för att skickas
      // iväg och komma tillbaka som ett serverfel — samma svar, en rundtur mindre.
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
        saga({ roll: "du", text: v }, { roll: "loopa", text: "Det där ser inte ut som en e-postadress. Skriv den som du@exempel.se så hör vi av oss dit.", fel: true });
        setUtkast("");
        return;
      }
      void spara(v);
    }
  };

  const fraga = steg === "fragor" ? fragor[index] : undefined;
  /** Exemplen står bara innan man skrivit något: de är en startpunkt, inte en meny. */
  const visaExempel = steg === "beskriv" && logg.length === 1 && !arbetar;

  return createPortal(
    <div className="letar-overlay" role="presentation" onClick={onStang}>
      <div
        className="letar-ark"
        ref={arkRef}
        role="dialog"
        aria-modal="true"
        aria-label="Letar du möbel?"
        /* Klick i arket ska inte stänga det. Bakgrunden stänger; innehållet är inte bakgrunden. */
        onClick={(e) => e.stopPropagation()}
      >
        <header className="letar-topp">
          <h2>
            <span className="letar-prick" aria-hidden="true" />
            Letar du möbel?
          </h2>
          <button type="button" className="letar-stang" onClick={onStang} aria-label="Stäng">
            <CloseIcon size={15} />
          </button>
        </header>

        <div className="letar-flode" ref={flodeRef}>
          {logg.map((m, i) =>
            m.roll === "du" ? (
              <p key={i} className={`letar-du ${m.svag ? "letar-du-svag" : ""}`}>{m.text}</p>
            ) : (
              <p key={i} className={`letar-svar ${m.fel ? "letar-svar-fel" : ""}`}>{m.text}</p>
            ),
          )}

          {/* En puls, inte tre studsande prickar — samma indikator som i arket. */}
          {arbetar && (
            <p className="letar-vantar" aria-live="polite">
              <span className="letar-puls" aria-hidden="true" />
              <span>{steg === "epost" ? "Sparar…" : "Läser…"}</span>
            </p>
          )}
        </div>

        {visaExempel && (
          <div className="letar-forslag">
            {EXEMPEL.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => {
                  // Fyller raden, skickar inte: chipset är början på en beskrivning, inte en färdig
                  // fråga. Se EXEMPEL ovan.
                  setUtkast(e + " ");
                  faltRef.current?.focus();
                }}
              >
                {e}
              </button>
            ))}
          </div>
        )}

        {fraga && !arbetar && (
          <div className="letar-forslag">
            {fraga.options?.map((o) => (
              <button key={o} type="button" onClick={() => besvara(o)}>{o}</button>
            ))}
            {/* Varje fråga går att hoppa över, och knappen står bland svaren och inte i en kant. En
                överhoppningsknapp man måste leta efter är ingen överhoppningsknapp. */}
            <button type="button" className="letar-hoppa" onClick={() => besvara(null)}>
              Hoppa över
            </button>
          </div>
        )}

        {steg === "klar" ? (
          <div className="letar-forslag letar-forslag-slut">
            <button type="button" onClick={onStang}>Stäng</button>
          </div>
        ) : (
          <form
            className="letar-skriv"
            onSubmit={(e) => { e.preventDefault(); skicka(); }}
          >
            {steg === "epost" ? (
              /* Ett riktigt e-postfält: `type="email"` ger telefonen rätt tangentbord och webbläsaren
                 rätt ifyllnadsförslag. Det ligger i samma ram som textrutan och ser likadant ut. */
              <input
                ref={epostRef}
                type="email"
                value={utkast}
                onChange={(e) => setUtkast(e.target.value)}
                placeholder="du@exempel.se"
                aria-label="Din e-postadress"
                autoComplete="email"
                inputMode="email"
                maxLength={160}
              />
            ) : (
              /*
                TEXTAREA OCH INTE INPUT, som varje modern chattruta. En beskrivning blir lätt två
                rader, och ett enradsfält rullar då texten i sidled så att man inte ser början av det
                man skriver. Rutan växer med innehållet upp till ett tak (se CSS:en) och rullar sedan.

                ENTER SKICKAR, skift+enter ger ny rad. Det är vad fingrarna redan gör.
              */
              <textarea
                ref={faltRef}
                value={utkast}
                onChange={(e) => setUtkast(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); skicka(); }
                }}
                onInput={(e) => {
                  // Höjden räknas ur innehållet. Nollställs först, annars kan fältet bara växa.
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = `${el.scrollHeight}px`;
                }}
                rows={1}
                placeholder={steg === "fragor" ? "Skriv ditt svar…" : PLACEHOLDER}
                aria-label={fraga ? fraga.question : "Beskriv vad du letar efter"}
                maxLength={500}
              />
            )}
            <button type="submit" disabled={!utkast.trim() || arbetar} aria-label="Skicka">
              <ArrowUpIcon size={18} />
            </button>
          </form>
        )}

        {/* Vad adressen används till, och inte till. Står kvar hela vägen: den som tvekar inför att
            lämna den gör det innan de skriver den, inte efter. */}
        <p className="letar-fot">
          Vi använder adressen för att höra av oss om just det här. Inget nyhetsbrev, ingen
          vidareförsäljning.
        </p>
      </div>
    </div>,
    document.body,
  );
}
