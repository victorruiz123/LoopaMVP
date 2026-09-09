import { useEffect, useRef, useState } from "react";
import { askSalj } from "../api";
import { ArrowUpIcon, CloseIcon } from "./icons";
import { useT } from "../lib/i18n";

/**
 * "Hur fungerar det?" — arket som förklarar Loopa, och svarar på det som stoppar folk.
 *
 * ETT ARK OCH INTE EN SIDA. Den som klickar har inte lämnat startsidan för att läsa om oss; hen står
 * mitt i ett val och har en fråga. Arket glider upp över märkeslistan, svarar, och går bort igen —
 * märkena ligger kvar under hela tiden, dämpade men synliga, och stängningen lämnar en precis där
 * man var. En egen sida hade gjort en fråga till en utflykt.
 *
 * FORMEN ÄR EN VANLIG CHATT, med flit och utan uppfinningar. Svaren står som löpande text utan
 * bubbla; bara det man själv skrivit får en. Det är formen varje människa som skrivit med en
 * AI-assistent de senaste åren känner igen, och igenkänning är hela poängen med en ruta man ska
 * våga skriva en fråga i. En egen chattformgivning hade varit ett andra gränssnitt att lära sig.
 *
 * VARFÖR SVAREN INTE HAR BUBBLA. En bubbla säger "det här är en replik i ett samtal". Assistentens
 * text är inte en replik utan ett SVAR man läser, ofta det längsta stycket på skärmen, och en bubbla
 * runt det gör läsraden smalare och texten till en pratbubbla. Frågan är kort och personlig och hör
 * hemma i en; svaret hör hemma på sidan.
 *
 * FÖRSTA REPLIKEN ÄR SKRIVEN, inte hämtad. Den står där direkt när arket öppnas, utan väntan och
 * utan modellanrop: hela processen på fyra rader. De flesta får sitt svar där och stänger. Modellen
 * finns för de andra — för "vad händer om den inte blir såld", "tar ni min IKEA-soffa", "måste jag
 * bära ut den" — och de frågorna är olika varje gång, vilket är precis vad en chatt är bra på och en
 * FAQ inte.
 *
 * HÄR FANNS BILDER. Fyra ritade visualiseringar som modellen fick välja bland, en under vartannat
 * svar. De är borttagna: man läste två meningar, mötte ett diagram, och tappade tråden i det man
 * frågat om. Det som ska vara bra är svaret, inte illustrationen bredvid.
 */

interface Meddelande {
  role: "user" | "assistant";
  content: string;
  failed?: boolean;
}

/**
 * Öppningsrepliken. Hela tjänsten på fyra rader, ordagrant som den står på sidan.
 *
 * Att den är hårdkodad är inte snålhet. Den ska vara IDENTISK varje gång — det är produktens
 * beskrivning av sig själv, inte ett svar på en fråga — och den ska stå där i samma ögonblick som
 * arket öppnas. En modell som formulerar om den varje gång ger en tjänst som beskriver sig olika för
 * olika människor, och en sekunds väntan på det man kom för att läsa.
 */
const OPPNING =
  "Hej. Välj märke och filma ett varv. Vi identifierar möbeln, granskar skicket och föreslår ett pris — du bekräftar. Sen säljer vi, hämtar hos dig och du får betalt.";

/**
 * Frågorna som står som knappar under öppningen.
 *
 * De fyra vanligaste invändningarna, inte de fyra vanligaste frågorna — skillnaden är att en
 * invändning stoppar ett köp och en fråga bara fördröjer det. Tre av dem handlar om pengar och
 * kontroll, den fjärde om man ens är välkommen.
 *
 * De är dessutom ett svar på tomma-rutan-problemet: en öppen prompt utan förslag får folk att skriva
 * "hej" eller inget alls.
 */
const FORSLAG = ["Vad kostar det?", "Hur får jag betalt?", "Träffar jag köparen?", "Vilka möbler tar ni?"];

/**
 * Arkets yta, som ett tal — för `theme-color`, som bara tar en färg och inte en variabel.
 *
 * Står också som `--hur-yta` i styles.css, och det är en dubblering som inte går att undvika: ett
 * metataggsvärde kan inte läsa en CSS-variabel. Ändras den ena ska den andra med, och därför står
 * det här.
 */
const MORK_YTA = "#1e1d1b";

export default function HurFungerarDet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [meddelanden, setMeddelanden] = useState<Meddelande[]>([]);
  const [fraga, setFraga] = useState("");
  const [vantar, setVantar] = useState(false);
  const arkRef = useRef<HTMLDivElement>(null);
  const flodeRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Escape stänger, och fokus flyttas in i arket när det öppnas.
   *
   * Arket lägger sig över sidan och tar över skärmen; utan de två är det en fälla för den som inte
   * använder mus. Fokus går till STÄNGKNAPPEN och inte till skrivrutan: den som öppnar vill oftast
   * läsa öppningsrepliken, och ett tangentbord som far upp över den på en telefon är att svara på en
   * fråga genom att dölja svaret.
   */
  useEffect(() => {
    if (!open) return;
    const vidTangent = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", vidTangent);
    arkRef.current?.querySelector<HTMLButtonElement>(".hur-stang")?.focus();
    return () => window.removeEventListener("keydown", vidTangent);
  }, [open, onClose]);

  /**
   * WEBBLÄSARENS FÄLT följer med in i mörkret.
   *
   * På iOS tonar Safari sitt adressfält efter `theme-color`. Står den kvar i startsidans krämvita
   * medan chatten är mörk får man en ljus list mot en mörk remsa — en skarv som syns tydligare än
   * den gjorde innan. Färgen är arkets egen yta, så fältet, remsan bakom det och chatten blir samma
   * svarta.
   *
   * Det gamla värdet läses av och läggs tillbaka när arket stängs, i stället för att skrivas in som
   * en konstant: en ändrad palett ska inte tyst lämna en gammal färg kvar här.
   */
  useEffect(() => {
    if (!open) return;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) return;
    const foregaende = meta.content;
    meta.content = MORK_YTA;
    return () => {
      meta.content = foregaende;
    };
  }, [open]);

  /**
   * SIDAN BAKOM LÅSES medan arket står uppe.
   *
   * Utan det här rullade startsidan under fingret så fort man svepte i arket, och märkena drog förbi
   * bakom det. På en telefon är det dessutom vad man SER genom Safaris adressfält: dokumentet rullar
   * under fältet, och arket — som är `position: fixed` — kan inte nå dit. Låset gör åtminstone att
   * det som står där står stilla.
   *
   * `position: fixed` på body och inte `overflow: hidden`, som iOS struntar i: sidan rullar vidare
   * ändå. Att lyfta ut body ur flödet är det enda som håller, och priset är att rullpositionen går
   * förlorad — därför sparas den undan i `top` och läggs tillbaka när arket stängs. Utan det steget
   * kastas man upp till sidans topp varje gång man stänger chatten.
   */
  useEffect(() => {
    if (!open) return;
    const y = window.scrollY;
    const body = document.body;
    const fore = { position: body.style.position, top: body.style.top, width: body.style.width };
    body.style.position = "fixed";
    body.style.top = `-${y}px`;
    body.style.width = "100%";
    return () => {
      body.style.position = fore.position;
      body.style.top = fore.top;
      body.style.width = fore.width;
      window.scrollTo(0, y);
    };
  }, [open]);

  /** Nytt svar syns utan att man rullar. Bara flödet rullar — sidan bakom står stilla. */
  useEffect(() => {
    if (meddelanden.length === 0) return;
    flodeRef.current?.scrollTo({ top: flodeRef.current.scrollHeight, behavior: "smooth" });
  }, [meddelanden, vantar]);

  if (!open) return null;

  async function skicka(text: string) {
    const q = text.trim();
    if (!q || vantar) return;
    setFraga("");
    setVantar(true);
    // Frågan syns direkt. Ett svar tar ett par sekunder, och en ruta som töms utan att visa vad man
    // skrev läser som att trycket inte gick fram.
    const historik = meddelanden.filter((m) => !m.failed).map((m) => ({ role: m.role, content: m.content }));
    setMeddelanden((m) => [...m, { role: "user", content: q }]);
    try {
      const svar = await askSalj(q, historik);
      setMeddelanden((m) => [...m, { role: "assistant", content: svar.answer }]);
    } catch {
      /**
       * Felet står i samtalet, som ett svar. Inte som en röd banner ovanför.
       *
       * Det som gick fel är att just den frågan inte fick något svar, och det hör hemma där frågan
       * står — så att den som läser ser vilken fråga som föll och kan ställa om den. `failed` gör
       * dessutom att raden inte följer med som historik: en modell ska inte få se sitt eget
       * felmeddelande som något den sagt.
       */
      setMeddelanden((m) => [
        ...m,
        { role: "assistant", content: t("Jag kunde inte svara just nu. Försök igen om en stund."), failed: true },
      ]);
    } finally {
      setVantar(false);
      inputRef.current?.focus();
    }
  }

  const tomt = meddelanden.length === 0;

  return (
    <div className="hur-overlay" role="presentation" onClick={onClose}>
      <div
        className="hur-ark"
        ref={arkRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("Så fungerar Loopa")}
        /* Klick i arket ska inte stänga det. Bakgrunden stänger; innehållet är inte bakgrunden. */
        onClick={(e) => e.stopPropagation()}
      >
        <header className="hur-topp">
          <h2>
            {/* Den orange pricken andas. Arkets enda ofrivilliga rörelse — den säger att det sitter
                en maskin i andra änden, inte ett hjälpavsnitt. */}
            <span className="hur-prick" aria-hidden="true" />
            {t("Så fungerar Loopa")}
          </h2>
          <button className="hur-stang" onClick={onClose} aria-label={t("Stäng")}>
            <CloseIcon size={15} />
          </button>
        </header>

        <div className="hur-flode" ref={flodeRef}>
          <p className="hur-svar">{t(OPPNING)}</p>

          {meddelanden.map((m, i) =>
            m.role === "user" ? (
              <p key={i} className="hur-fraga">
                {m.content}
              </p>
            ) : (
              <p key={i} className={`hur-svar ${m.failed ? "hur-svar-fel" : ""}`}>
                {m.content}
              </p>
            ),
          )}

          {/* En puls, inte tre studsande prickar. Den säger "det arbetar" utan att härma skrift —
              svaret kommer i ett stycke och inte tecken för tecken, och tre prickar hade lovat det. */}
          {vantar && (
            <p className="hur-vantar" aria-live="polite">
              <span className="hur-puls" aria-hidden="true" />
              <span className="hur-vantar-text">{t("Tänker…")}</span>
            </p>
          )}
        </div>

        {/* Förslagen försvinner när samtalet börjat: de är en startpunkt, och en rad knappar som står
            kvar under ett pågående samtal läser som att svaret inte dög. */}
        {tomt && (
          <div className="hur-forslag">
            {FORSLAG.map((f) => (
              <button key={f} onClick={() => void skicka(t(f))} disabled={vantar}>
                {t(f)}
              </button>
            ))}
          </div>
        )}

        <form
          className="hur-skriv"
          onSubmit={(e) => {
            e.preventDefault();
            void skicka(fraga);
          }}
        >
          {/*
            TEXTAREA OCH INTE INPUT, som varje modern chattruta.

            En fråga kan bli två rader, och ett enradsfält rullar då texten i sidled så att man inte
            ser början av det man skriver. Rutan växer i stället med innehållet, upp till ett tak (se
            CSS:en) varefter den rullar.

            ENTER SKICKAR, skift+enter ger ny rad. Det är vad fingrarna redan gör.
          */}
          <textarea
            ref={inputRef}
            value={fraga}
            onChange={(e) => setFraga(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void skicka(fraga);
              }
            }}
            onInput={(e) => {
              // Höjden räknas ur innehållet. Nollställs först, annars kan fältet bara växa.
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${el.scrollHeight}px`;
            }}
            rows={1}
            placeholder={t("Fråga oss om processen…")}
            aria-label={t("Fråga oss om processen")}
            maxLength={500}
          />
          <button type="submit" disabled={!fraga.trim() || vantar} aria-label={t("Skicka")}>
            <ArrowUpIcon size={18} />
          </button>
        </form>
      </div>
    </div>
  );
}
