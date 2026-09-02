import { useEffect, useRef, useState } from "react";
import { track } from "../../butik/components/Bits";
import { spara, svara, svep, tolka, type FollowUp, type Spec, type Traff } from "../api";
import { useAuth } from "../../auth/AuthProvider";
import AuthScreen from "../../screens/AuthScreen";
import SpecCard from "./SpecCard";
import TraffLista from "./TraffLista";

/**
 * Efterlysningen som en CHATT.
 *
 * Den första versionen var ett formulär med chattens färger: ett fält, en knapp, och svaren staplade
 * under varandra som ett resultat. Den här är ett samtal — bubblor, tur och retur, en komponerare
 * längst ned och en skrivindikator medan modellen tänker. Skillnaden är inte kosmetisk: ett fält ber
 * om en söksträng, ett samtal ber om en beskrivning, och det är beskrivningar vi kan matcha på.
 *
 * SAMTALET ÄR ÄNDÅ BUNDET. Det ser ut som en öppen chatt och är det inte: högst tre följdfrågor,
 * bara om fält som ändrar matchningen, och sedan ett kort man bekräftar. En chatt man måste prata
 * sig ur är sämre än ett formulär — köparen kom hit för att beskriva en soffa, inte för att föra ett
 * resonemang. Formen är ChatGPT:s; logiken under är den bestämda vägen (se parse.ts followUps).
 *
 * ALLT ÄR MEDDELANDEN, även korten. Specen och träffarna ligger i bubblor från oss i stället för i
 * paneler bredvid samtalet — annars blir det två saker att titta på, och den ena slutar läsas.
 */

type Bubble =
  | { id: string; who: "ai"; kind: "text"; text: string }
  | { id: string; who: "ai"; kind: "fragor"; fraga: FollowUp; kvar: number }
  | { id: string; who: "ai"; kind: "spec"; spec: Spec }
  | { id: string; who: "ai"; kind: "traffar"; traffar: Traff[]; lasta: number; prognos: string | null; degraded: boolean }
  | { id: string; who: "ai"; kind: "spara"; spec: Spec }
  | { id: string; who: "user"; kind: "text"; text: string };

const HALSNING =
  "Hej! Vad letar du efter? Beskriv möbeln som du hade sagt det till en kompis — märke, färg, " +
  "mått, budget. Ju mer du säger, desto bättre hittar jag.";

const FORSLAG = [
  "En grön sammetssoffa, 3-sits, max 6 000 kr",
  "String-hylla i valnöt, upp till 4 000",
  "Matbord max 160 cm, budget 3 000",
];

let räknare = 0;
const nyttId = () => `b${++räknare}`;

/** Omit som fördelar sig över en union i stället för att platta den. */
type UtanId<T> = T extends unknown ? Omit<T, "id"> : never;

export default function EfterlysningChat() {
  const { user } = useAuth();
  const [bubblor, setBubblor] = useState<Bubble[]>([
    { id: nyttId(), who: "ai", kind: "text", text: HALSNING },
  ]);
  const [utkast, setUtkast] = useState("");
  const [skriver, setSkriver] = useState(false);
  const [spec, setSpec] = useState<Spec | null>(null);
  const [kvarFragor, setKvarFragor] = useState<FollowUp[]>([]);
  const [visaInlogg, setVisaInlogg] = useState(false);
  const [sparad, setSparad] = useState(false);
  const [omrade, setOmrade] = useState("");

  const traden = useRef<HTMLDivElement>(null);
  const faltet = useRef<HTMLTextAreaElement>(null);

  /**
   * Rullar tråden till botten när något nytt kommit. Ett samtal läses nedifrån.
   *
   * Rullar TRÅDEN och inte sidan: `scrollIntoView` hade dragit hela fönstret nedåt vid varje replik
   * och tagit med sig resten av köpsidan ur bild.
   */
  useEffect(() => {
    const el = traden.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [bubblor, skriver]);

  /**
   * Lägger till en bubbla.
   *
   * `DistributiveOmit` och inte `Omit`: `Bubble` är en union, och `Omit` över en union plattar den
   * till skärningen av fälten — vilket lämnar bara `who` och `kind` kvar och gör varje anrop till
   * ett typfel. Distributionen behåller varianterna var för sig.
   */
  const säg = (b: UtanId<Bubble>) => setBubblor((v) => [...v, { ...b, id: nyttId() } as Bubble]);

  /** Textrutan växer med texten, som i varje chatt. Fyra rader är taket. */
  const väx = () => {
    const el = faltet.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  };

  const skickaFörsta = async (text: string) => {
    const t = text.trim();
    if (!t || skriver) return;
    säg({ who: "user", kind: "text", text: t });
    setUtkast("");
    requestAnimationFrame(väx);
    setSkriver(true);
    track("efterlysning_started", { parse_method: "chat" });
    try {
      const r = await tolka(t);
      setSpec(r.spec);
      setKvarFragor(r.fragor);
      if (r.fragor.length) {
        säg({ who: "ai", kind: "text", text: "Bra. Två snabba frågor så jag letar rätt." });
        säg({ who: "ai", kind: "fragor", fraga: r.fragor[0], kvar: r.fragor.length });
      } else {
        visaSpec(r.spec);
      }
    } catch (e) {
      säg({ who: "ai", kind: "text", text: e instanceof Error ? e.message : "Jag kunde inte läsa det där. Prova att skriva om det." });
    } finally {
      setSkriver(false);
    }
  };

  const visaSpec = (s: Spec) => {
    säg({ who: "ai", kind: "text", text: "Så här förstod jag dig. Ändra om något blev fel." });
    säg({ who: "ai", kind: "spec", spec: s });
  };

  const besvara = async (field: string, svarText: string, etikett?: string) => {
    if (!spec || skriver) return;
    säg({ who: "user", kind: "text", text: etikett ?? svarText ?? "Hoppar över" });
    setSkriver(true);
    try {
      const r = await svara(spec, field, svarText);
      setSpec(r.spec);
      const kvar = r.fragor.filter((q) => q.field !== field);
      setKvarFragor(kvar);
      if (kvar.length) säg({ who: "ai", kind: "fragor", fraga: kvar[0], kvar: kvar.length });
      else visaSpec(r.spec);
    } catch {
      // En följdfråga som inte gick att väva in ska inte fälla samtalet.
      setKvarFragor([]);
      visaSpec(spec);
    } finally {
      setSkriver(false);
    }
  };

  const sök = async (s: Spec) => {
    if (skriver) return;
    säg({ who: "user", kind: "text", text: "Ja, det stämmer" });
    setSkriver(true);
    try {
      const r = await svep(s);
      const inledning = r.traffar.length === 0
        ? "Jag hittade inget som håller måttet just nu. Spara efterlysningen så letar jag vidare."
        : r.traffar.some((t) => t.typ === "exact")
          ? "Det här hittade jag direkt."
          : "Inget stämmer helt, men de här är närmast — jag säger vad som skiljer.";
      säg({ who: "ai", kind: "text", text: inledning });
      säg({ who: "ai", kind: "traffar", traffar: r.traffar, lasta: r.lasta, prognos: r.prognos, degraded: r.traderaDegraded });
      säg({ who: "ai", kind: "spara", spec: s });
      for (const t of r.traffar) track("instant_match_shown", { source: t.kalla, kind: t.typ });
    } catch (e) {
      säg({ who: "ai", kind: "text", text: e instanceof Error ? e.message : "Sökningen gick inte igenom." });
    } finally {
      setSkriver(false);
    }
  };

  const sparaNu = async (s: Spec) => {
    if (!user) { setVisaInlogg(true); return; }
    setSkriver(true);
    try {
      await spara(s, omrade.trim() || null, "chat");
      track("efterlysning_saved", { parse_method: "chat" });
      setSparad(true);
      säg({ who: "ai", kind: "text", text: "Sparad. Jag hör av mig så fort något dyker upp — och en gång i veckan även om det inte gör det." });
    } catch (e) {
      säg({ who: "ai", kind: "text", text: e instanceof Error ? e.message : "Kunde inte spara." });
    } finally {
      setSkriver(false);
    }
  };

  if (visaInlogg && !user) {
    return (
      <AuthScreen
        intent="account"
        initialTab="signup"
        onDone={() => { setVisaInlogg(false); if (spec) void sparaNu(spec); }}
        onBack={() => setVisaInlogg(false)}
      />
    );
  }

  const tomt = bubblor.length === 1;

  return (
    <section className="chat">
      <div className="chat-trad" ref={traden}>
        {bubblor.map((b) => (
          <Rad key={b.id} b={b}>
            {b.kind === "fragor" && (
              <FragaBubbla fraga={b.fraga} kvar={b.kvar} last={kvarFragor[0]?.field !== b.fraga.field} onSvar={besvara} />
            )}
            {b.kind === "spec" && (
              <SpecCard
                spec={spec ?? b.spec}
                busy={skriver}
                onChange={setSpec}
                onConfirm={() => void sök(spec ?? b.spec)}
                onRestart={() => window.location.reload()}
              />
            )}
            {b.kind === "traffar" && (
              <TraffLista traffar={b.traffar} lasta={b.lasta} prognos={b.prognos} degraded={b.degraded} />
            )}
            {b.kind === "spara" && !sparad && (
              <SparaBubbla
                inloggad={!!user}
                omrade={omrade}
                busy={skriver}
                onOmrade={setOmrade}
                onSpara={() => void sparaNu(spec ?? b.spec)}
              />
            )}
          </Rad>
        ))}

        {skriver && (
          <div className="chat-rad chat-rad-ai">
            <Avatar />
            <div className="chat-bubbla chat-skriver" aria-label="Skriver">
              <span /><span /><span />
            </div>
          </div>
        )}
      </div>

      {/* Startförslagen ligger ovanför komponeraren och försvinner när samtalet börjat. */}
      {tomt && (
        <div className="chat-forslag">
          {FORSLAG.map((f) => (
            <button key={f} type="button" onClick={() => void skickaFörsta(f)}>{f}</button>
          ))}
        </div>
      )}

      <form
        className="chat-komponerare"
        onSubmit={(e) => { e.preventDefault(); void skickaFörsta(utkast); }}
      >
        <textarea
          ref={faltet}
          rows={1}
          value={utkast}
          onChange={(e) => { setUtkast(e.target.value); väx(); }}
          onKeyDown={(e) => {
            // Enter skickar, skift+enter radbryter — som i varje chatt.
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void skickaFörsta(utkast); }
          }}
          placeholder={spec ? "Skriv om något ska ändras…" : "Beskriv möbeln du letar efter…"}
          aria-label="Skriv till Loopa"
          disabled={skriver}
        />
        <button type="submit" aria-label="Skicka" disabled={skriver || !utkast.trim()}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </form>
      <p className="chat-fot">
        Loopa läser vad du skriver för att hitta möbeln. Inget konto behövs förrän du vill att vi bevakar.
      </p>
    </section>
  );
}

function Avatar() {
  return <span className="chat-avatar" aria-hidden="true">loopa<i>.</i></span>;
}

/** En rad i tråden. Text renderas här; allt annat kommer som barn. */
function Rad({ b, children }: { b: Bubble; children?: React.ReactNode }) {
  if (b.who === "user") {
    return (
      <div className="chat-rad chat-rad-user">
        <div className="chat-bubbla chat-bubbla-user">{b.kind === "text" ? b.text : ""}</div>
      </div>
    );
  }
  return (
    <div className="chat-rad chat-rad-ai">
      <Avatar />
      <div className="chat-innehall">
        {b.kind === "text" && <div className="chat-bubbla">{b.text}</div>}
        {children}
      </div>
    </div>
  );
}

/** En följdfråga med snabbsvar. Fritext går alltid också — komponeraren är kvar. */
function FragaBubbla({
  fraga, kvar, last, onSvar,
}: {
  fraga: FollowUp; kvar: number; last: boolean;
  onSvar: (field: string, svar: string, etikett?: string) => void;
}) {
  return (
    <>
      <div className="chat-bubbla">{fraga.question}</div>
      {!last && (
        <div className="chat-snabbsvar">
          {(fraga.options ?? []).map((o) => (
            <button key={o} type="button" onClick={() => onSvar(fraga.field, o)}>{o}</button>
          ))}
          <button type="button" className="chat-hoppa" onClick={() => onSvar(fraga.field, "", "Spelar ingen roll")}>
            Spelar ingen roll
          </button>
        </div>
      )}
      {!last && kvar > 1 && <p className="chat-kvar">{kvar - 1} fråga kvar efter den här.</p>}
    </>
  );
}

function SparaBubbla({
  inloggad, omrade, busy, onOmrade, onSpara,
}: {
  inloggad: boolean; omrade: string; busy: boolean;
  onOmrade: (v: string) => void; onSpara: () => void;
}) {
  return (
    <div className="chat-spara">
      <p>
        Vill du att jag fortsätter leta? Jag bevakar vårt lager, det som är på väg in och Tradera —
        och hör av mig när något stämmer.
      </p>
      <div className="chat-spara-rad">
        <input
          value={omrade}
          onChange={(e) => onOmrade(e.target.value)}
          placeholder="Stadsdel, t.ex. Södermalm"
          aria-label="Ditt område"
        />
        <button type="button" disabled={busy} onClick={onSpara}>
          {inloggad ? "Bevaka åt mig" : "Skapa konto och bevaka"}
        </button>
      </div>
      <p className="chat-spara-hint">
        Området används bara för att säga ungefär var efterfrågan finns. Vi visar aldrig vem du är.
      </p>
    </div>
  );
}
