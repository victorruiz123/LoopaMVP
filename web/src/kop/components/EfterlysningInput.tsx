import { useState } from "react";
import { track } from "../../butik/components/Bits";
import { spara, svara, svep, tolka, type FollowUp, type Spec, type Traff } from "../api";
import { useAuth } from "../../auth/AuthProvider";
import AuthScreen from "../../screens/AuthScreen";
import SpecCard from "./SpecCard";
import TraffLista from "./TraffLista";

/**
 * Köpsidans hjärta: beskriv möbeln, få den hittad.
 *
 * FYRA LÄGEN, INTE EN CHATT. En öppen chatbot blir något man måste prata sig ur; köparen kom hit för
 * att beskriva en soffa. Vägen är därför bestämd i förväg:
 *
 *   skriv      en mening, ett fält, ingen inloggning
 *   fragor     högst tre följdfrågor, och bara om fält som ändrar matchningen
 *   spec       ett redigerbart kort man bekräftar — det köparen godkänner är det vi bevakar
 *   traffar    direktsvepet, och först här kommer erbjudandet att spara
 *
 * SPARANDET LIGGER SIST MED FLIT. Att kräva konto för att få se om tjänsten fungerar är att be om
 * betalning före leverans. Först när köparen sett att vi hittar saker är det rimligt att fråga vem
 * de är — och då är frågan värd att svara på.
 */

type Steg = "skriv" | "fragor" | "spec" | "traffar";

const EXEMPEL = [
  "Grön sammetssoffa, 3-sits, max 6 000 kr",
  "String-hylla i valnöt, upp till 4 000",
  "Matbord max 160 cm, budget 3 000",
];

export default function EfterlysningInput() {
  const { user } = useAuth();
  const [steg, setSteg] = useState<Steg>("skriv");
  const [text, setText] = useState("");
  const [spec, setSpec] = useState<Spec | null>(null);
  const [fragor, setFragor] = useState<FollowUp[]>([]);
  const [traffar, setTraffar] = useState<Traff[]>([]);
  const [lasta, setLasta] = useState(0);
  const [prognos, setPrognos] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fel, setFel] = useState<string | null>(null);
  const [visaInlogg, setVisaInlogg] = useState(false);
  const [sparad, setSparad] = useState(false);
  const [omrade, setOmrade] = useState("");

  const start = async (mening: string) => {
    const t = mening.trim();
    if (!t) return;
    setBusy(true);
    setFel(null);
    track("efterlysning_started", { parse_method: "chat" });
    try {
      const r = await tolka(t);
      setSpec(r.spec);
      setFragor(r.fragor);
      setSteg(r.fragor.length ? "fragor" : "spec");
    } catch (e) {
      setFel(e instanceof Error ? e.message : "Vi kunde inte läsa det där.");
    } finally {
      setBusy(false);
    }
  };

  const besvara = async (field: string, answer: string) => {
    if (!spec) return;
    setBusy(true);
    try {
      const r = await svara(spec, field, answer);
      setSpec(r.spec);
      const kvar = r.fragor.filter((q) => q.field !== field);
      setFragor(kvar);
      if (!kvar.length) setSteg("spec");
    } catch {
      // En följdfråga som inte gick att väva in ska inte fälla flödet — gå vidare med det vi har.
      setFragor([]);
      setSteg("spec");
    } finally {
      setBusy(false);
    }
  };

  const sok = async (s: Spec) => {
    setBusy(true);
    setFel(null);
    try {
      const r = await svep(s);
      setTraffar(r.traffar);
      setLasta(r.lasta);
      setPrognos(r.prognos);
      setDegraded(r.traderaDegraded);
      setSteg("traffar");
      // Ett event per källa och hårdhet: "vi visade sex saker" är inte samma mått som "vi visade
      // två exakta ur vårt eget lager och fyra nära från Tradera".
      for (const t of r.traffar) track("instant_match_shown", { source: t.kalla, kind: t.typ });
    } catch (e) {
      setFel(e instanceof Error ? e.message : "Sökningen gick inte igenom.");
    } finally {
      setBusy(false);
    }
  };

  const sparaNu = async () => {
    if (!spec) return;
    if (!user) { setVisaInlogg(true); return; }
    setBusy(true);
    try {
      await spara(spec, omrade.trim() || null, "chat");
      track("efterlysning_saved", { parse_method: "chat" });
      setSparad(true);
    } catch (e) {
      setFel(e instanceof Error ? e.message : "Kunde inte spara.");
    } finally {
      setBusy(false);
    }
  };

  if (visaInlogg && !user) {
    return (
      <AuthScreen
        intent="account"
        initialTab="signup"
        onDone={() => { setVisaInlogg(false); void sparaNu(); }}
        onBack={() => setVisaInlogg(false)}
      />
    );
  }

  return (
    <section className="kop-hero">
      <span className="butik-geo">📍 Just nu i Stockholm</span>
      <h1 className="kop-hero-title">
        Beskriv möbeln du letar efter<br />
        <em>– vi hittar den åt dig.</em>
      </h1>
      <p className="kop-hero-lede">
        Granskad, prisad och levererad hem. Berätta bara vad du vill ha.
      </p>

      {steg === "skriv" && (
        <>
          <form
            className="kop-ask"
            onSubmit={(e) => { e.preventDefault(); void start(text); }}
          >
            <textarea
              className="kop-ask-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Enter söker, skift+enter radbryter. En mening är sällan flera rader.
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void start(text); }
              }}
              placeholder="T.ex. en grön sammetssoffa, 3-sits, max 6 000 kr och högst 220 cm bred"
              rows={2}
              aria-label="Beskriv möbeln du letar efter"
            />
            <button type="submit" className="kop-ask-go" disabled={busy}>
              {busy ? "Läser…" : "Hitta åt mig"}
            </button>
          </form>
          <div className="kop-examples">
            {EXEMPEL.map((e) => (
              <button key={e} type="button" className="kop-example" onClick={() => { setText(e); void start(e); }}>
                {e}
              </button>
            ))}
          </div>
        </>
      )}

      {fel && <p className="kop-error">{fel}</p>}

      {steg === "fragor" && fragor[0] && (
        <FragaKort fraga={fragor[0]} kvar={fragor.length} busy={busy} onSvar={besvara} />
      )}

      {steg === "spec" && spec && (
        <SpecCard
          spec={spec}
          busy={busy}
          onChange={setSpec}
          onConfirm={() => void sok(spec)}
          onRestart={() => { setSteg("skriv"); setSpec(null); setText(""); }}
        />
      )}

      {steg === "traffar" && spec && (
        <>
          <SpecCard spec={spec} busy={busy} compact onChange={setSpec} onConfirm={() => void sok(spec)} onRestart={() => setSteg("skriv")} />
          <TraffLista traffar={traffar} lasta={lasta} prognos={prognos} degraded={degraded} />
          {sparad ? (
            <p className="kop-saved">
              Sparad. Vi hör av oss så fort något dyker upp — och en gång i veckan även om det inte gör det.
            </p>
          ) : (
            <div className="kop-save">
              <div className="kop-save-text">
                <h3>Vill du att vi fortsätter leta?</h3>
                <p>
                  Vi bevakar vårt eget lager, det som är på väg in och Tradera — och hör av oss när
                  något stämmer. {user ? "" : "Kräver ett konto, så vi vet vem vi ska höra av oss till."}
                </p>
              </div>
              <div className="kop-save-row">
                <input
                  className="kop-save-area"
                  value={omrade}
                  onChange={(e) => setOmrade(e.target.value)}
                  placeholder="Stadsdel, t.ex. Södermalm"
                  aria-label="Ditt område"
                />
                <button type="button" className="kop-save-go" disabled={busy} onClick={() => void sparaNu()}>
                  {busy ? "Sparar…" : "Bevaka åt mig"}
                </button>
              </div>
              <p className="kop-save-hint">
                Området används bara för att säga ungefär var efterfrågan finns. Vi visar aldrig vem du är.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** En följdfråga i taget. Snabbsvar plus fritext — den som vill skriva något annat ska få. */
function FragaKort({
  fraga, kvar, busy, onSvar,
}: {
  fraga: FollowUp; kvar: number; busy: boolean; onSvar: (field: string, answer: string) => void;
}) {
  const [eget, setEget] = useState("");
  return (
    <div className="kop-fraga">
      <span className="kop-fraga-rakn">{kvar} {kvar === 1 ? "fråga" : "frågor"} kvar</span>
      <h3>{fraga.question}</h3>
      {fraga.options && (
        <div className="kop-fraga-val">
          {fraga.options.map((o) => (
            <button key={o} type="button" className="kop-chip" disabled={busy} onClick={() => onSvar(fraga.field, o)}>
              {o}
            </button>
          ))}
        </div>
      )}
      <form className="kop-fraga-eget" onSubmit={(e) => { e.preventDefault(); onSvar(fraga.field, eget); }}>
        <input
          value={eget}
          onChange={(e) => setEget(e.target.value)}
          placeholder="…eller skriv själv"
          aria-label={fraga.question}
        />
        <button type="submit" disabled={busy || !eget.trim()}>Svara</button>
      </form>
      <button type="button" className="kop-skip" onClick={() => onSvar(fraga.field, "")}>
        Hoppa över
      </button>
    </div>
  );
}
