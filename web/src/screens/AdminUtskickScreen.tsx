import { useEffect, useMemo, useRef, useState } from "react";
import { startaUtskick, utskickLage, utskickMottagare, utskickSkickade } from "../api";
import type { UtskickLage, UtskickMottagare } from "../types";
import { SearchIcon } from "../components/icons";
import { usePageTitle } from "../lib/pageTitle";

/**
 * Utskicket: ett brev, en lista, ett tryck.
 *
 * ALLA ÄR FÖRVALDA, och det är ett medvetet val åt andra hållet mot hur en kryssruta oftast används.
 * Brevet skrivs för att gå ut till listan; undantagen är få och kända ("hon har redan svarat", "det
 * här är min egen adress"). Att börja med noll ikryssade hade betytt åttio tryck för att göra det man
 * kom hit för, och ett kryss man missar hade tyst utelämnat någon.
 *
 * FÖRHANDSVISNINGEN ÄR ETT RIKTIGT BREV, med första mottagarens namn insatt. Det är enda sättet att
 * se att [namn] faktiskt byttes ut — en platshållare som står kvar i ett utskickat brev går inte att
 * ta tillbaka.
 *
 * TVÅ TRYCK FÖR ATT SKICKA. Det första räknar upp vad som ska hända, det andra gör det. Samma skäl
 * som bekräftelserutan i "Sälj med Loopa" har: ett klick som når åttio riktiga inkorgar ska inte
 * ligga en millimeter från musen som bara skrollade.
 *
 * TILL ANVÄNDARE ELLER TILL NYA, det ena eller det andra. "Till nya" är en inklistrad lista adresser
 * utan konto bakom sig. Namnet skrivs på samma rad som adressen, och [namn] går att använda så länge
 * varje rad har ett — annars stoppas utskicket och de som saknar namn räknas upp.
 */
type Typ = "anvandare" | "nya";

const MAX_MOTTAGARE = 500;
const NAMNPLATSHALLARE = /[[{](namn|förnamn|fornamn|helanamn|fulltnamn)[\]}]/i;
const EPOST = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"'.]{2,}$/;

/** En rad ur den inklistrade listan: adressen, och namnet när det står bredvid. */
interface NyMottagare {
  epost: string;
  namn: string | null;
}

/**
 * Mottagarna ur en inklistrad lista — samma tolkning som servern (utskick.ts, `tolkaAdresser`), så
 * panelen visar det servern godtar.
 *
 * RAD FÖR RAD. En rad med EN adress och text bredvid ger texten som namn, i vilken form man än
 * klistrar in den: "Anna Svensson <anna@exempel.se>" ur ett mejlprogram, "Anna Svensson, anna@exempel.se"
 * ur en CSV, två kolumner ur ett kalkylark (tabb emellan), eller adressen först. Står flera adresser på
 * samma rad ("a@x.se, b@x.se") vet vi inte vems namnet är, och då får ingen av dem något.
 *
 * Ord MED @ som inte är en giltig adress räknas som fel, så att ett stavfel syns i stället för att tyst
 * falla bort. En rad utan @ hoppas över — det är en rubrikrad ("namn,epost") eller tom. Dubbletter
 * räknas en gång, oavsett versaler; har den senare raden ett namn som den första saknade tas det.
 */
function tolkaAdresser(text: string): { giltiga: NyMottagare[]; ogiltiga: string[]; dubbletter: number } {
  const giltiga: NyMottagare[] = [];
  const ogiltiga: string[] = [];
  const index = new Map<string, NyMottagare>();
  let dubbletter = 0;
  for (const rad of text.split(/\r?\n/)) {
    const ord = rad.split(/[\s,;]+/).filter(Boolean);
    const adresser: string[] = [];
    const namnord: string[] = [];
    for (const rå of ord) {
      if (!rå.includes("@")) {
        namnord.push(rå);
        continue;
      }
      const epost = rå.replace(/^[<("'[]+|[>)"'\].:]+$/g, "").toLowerCase();
      if (EPOST.test(epost)) adresser.push(epost);
      else ogiltiga.push(rå);
    }
    const namn =
      adresser.length === 1
        ? namnord.join(" ").replace(/["'<>()[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 100) || null
        : null;
    for (const epost of adresser) {
      const forra = index.get(epost);
      if (forra) {
        dubbletter += 1;
        if (!forra.namn && namn) forra.namn = namn;
        continue;
      }
      const m = { epost, namn };
      index.set(epost, m);
      giltiga.push(m);
    }
  }
  return { giltiga, ogiltiga, dubbletter };
}

export default function AdminUtskickScreen() {
  usePageTitle("Adminpanel");
  const [mottagare, setMottagare] = useState<UtskickMottagare[] | null>(null);
  const [avsandare, setAvsandare] = useState<string>("");
  const [konfigurerat, setKonfigurerat] = useState(true);
  const [fel, setFel] = useState<string | null>(null);

  const [typ, setTyp] = useState<Typ>("anvandare");
  const [adressText, setAdressText] = useState("");
  const [amne, setAmne] = useState("");
  const [brev, setBrev] = useState("");
  const [fraga, setFraga] = useState("");
  /** Adresser som INTE ska med. Undantagen sparas, inte urvalet — se resonemanget ovan. */
  const [bortvalda, setBortvalda] = useState<Set<string>>(new Set());
  const [bekraftar, setBekraftar] = useState(false);
  const [lage, setLage] = useState<UtskickLage | null>(null);
  const [skickar, setSkickar] = useState(false);
  /** Vilka som redan fått brevet med ämnesraden i rutan. Servern hoppar över dem; här syns det i förväg. */
  const [skickade, setSkickade] = useState<Set<string>>(new Set());

  useEffect(() => {
    utskickMottagare()
      .then((d) => {
        setMottagare(d.mottagare);
        setAvsandare(d.avsandare);
        setKonfigurerat(d.konfigurerat);
      })
      .catch((err: unknown) => setFel(err instanceof Error ? err.message : "Mottagarna kunde inte hämtas."));
    // Ett utskick kan pågå sedan tidigare — en omladdning av panelen ska visa det, inte dölja det.
    utskickLage()
      .then((l) => l.startad && setLage(l))
      .catch(() => {});
  }, []);

  // Pollningen lever bara medan något faktiskt pågår.
  const pollning = useRef<number | null>(null);
  useEffect(() => {
    if (!lage?.pagar) {
      if (pollning.current) window.clearInterval(pollning.current);
      pollning.current = null;
      return;
    }
    pollning.current = window.setInterval(() => {
      void utskickLage().then(setLage).catch(() => {});
    }, 2000);
    return () => {
      if (pollning.current) window.clearInterval(pollning.current);
    };
  }, [lage?.pagar]);

  // Hämtas om när ämnesraden ändras (lite fördröjt, inte per tangent) och när ett utskick blir klart.
  useEffect(() => {
    const a = amne.trim();
    if (!a) return setSkickade(new Set());
    const t = window.setTimeout(() => {
      utskickSkickade(a)
        .then((lista) => setSkickade(new Set(lista)))
        .catch(() => setSkickade(new Set()));
    }, 400);
    return () => window.clearTimeout(t);
  }, [amne, lage?.pagar]);

  const valda = useMemo(
    () => (mottagare ?? []).filter((m) => !bortvalda.has(m.epost)),
    [mottagare, bortvalda],
  );
  const synliga = useMemo(() => {
    const q = fraga.trim().toLowerCase();
    if (!q) return mottagare ?? [];
    return (mottagare ?? []).filter((m) => m.epost.includes(q) || (m.namn ?? m.fornamn).toLowerCase().includes(q));
  }, [mottagare, fraga]);

  const tillNya = typ === "nya";
  const nya = useMemo(() => tolkaAdresser(adressText), [adressText]);
  // De nya i samma form som användarna: förnamnet är första ordet, precis som servern räknar.
  const nyaMottagare = useMemo<UtskickMottagare[]>(
    () =>
      nya.giltiga.map((m) => ({ epost: m.epost, fornamn: m.namn?.split(" ")[0] ?? "", namn: m.namn, registrerad: null })),
    [nya],
  );
  const antal = tillNya ? nyaMottagare.length : valda.length;
  const harFatt = (tillNya ? nyaMottagare : valda).filter((m) => skickade.has(m.epost)).length;

  const anvanderNamn = NAMNPLATSHALLARE.test(`${amne}\n${brev}`);
  /** Nya utan namn — stoppar utskicket bara när brevet faktiskt använder [namn]. */
  const utanNamn = tillNya ? nyaMottagare.filter((m) => !m.fornamn) : [];

  // Förhandsvisningen hälsar på den första som HAR ett namn; har ingen det står [namn] kvar och fångas nedan.
  const provmottagare = tillNya ? (nyaMottagare.find((m) => m.fornamn) ?? null) : (valda[0] ?? null);
  const fyll = (text: string) =>
    provmottagare
      ? text
          .replace(/[[{](namn|förnamn|fornamn)[\]}]/gi, provmottagare.fornamn)
          .replace(/[[{](helanamn|fulltnamn)[\]}]/gi, provmottagare.namn ?? provmottagare.fornamn)
      : text;
  const kvarglomda = useMemo(() => {
    const prov = fyll(`${amne}\n${brev}`);
    return [...new Set([...prov.matchAll(/[[{][^\]}\n]{1,30}[\]}]/g)].map((m) => m[0]))];
  }, [amne, brev, provmottagare]);

  const klart =
    !!amne.trim() &&
    !!brev.trim() &&
    antal > 0 &&
    antal <= MAX_MOTTAGARE &&
    (!tillNya || nya.ogiltiga.length === 0) &&
    !(anvanderNamn && utanNamn.length > 0) &&
    konfigurerat &&
    kvarglomda.length === 0;

  function bytTyp(ny: Typ) {
    setTyp(ny);
    setBekraftar(false);
  }

  function vaxla(epost: string) {
    setBekraftar(false);
    setBortvalda((forra) => {
      const ny = new Set(forra);
      if (ny.has(epost)) ny.delete(epost);
      else ny.add(epost);
      return ny;
    });
  }

  async function skicka() {
    if (!bekraftar) return setBekraftar(true);
    setSkickar(true);
    setFel(null);
    try {
      // Till nya går raderna som de står: namnet hör till raden, och servern tolkar dem likadant.
      const lista = tillNya ? adressText.split("\n").filter((rad) => rad.includes("@")) : valda.map((m) => m.epost);
      setLage(await startaUtskick(amne.trim(), brev, lista, typ));
      setBekraftar(false);
    } catch (err) {
      setFel(err instanceof Error ? err.message : "Utskicket kunde inte startas.");
    } finally {
      setSkickar(false);
    }
  }

  return (
    <div className="admin-flik utskick">
      <p className="admin-lede">
        Ett brev till flera. <code>[namn]</code> byts mot mottagarens förnamn, varje gång det står. Till nya
        adresser skriver du namnet på samma rad som adressen.
      </p>

      <div className="admin-flikar admin-underflikar" role="tablist" aria-label="Mottagare">
        {(
          [
            ["anvandare", "Till användare"],
            ["nya", "Till nya"],
          ] as const
        ).map(([v, etikett]) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={typ === v}
            className={`admin-flik-knapp${typ === v ? " vald" : ""}`}
            onClick={() => bytTyp(v)}
          >
            {etikett}
          </button>
        ))}
      </div>

      {!konfigurerat && (
        <p className="admin-note">
          Servern saknar SMTP_USER och SMTP_PASS, så ingenting kan skickas. Lägg in dem i server/.env.
        </p>
      )}
      {fel && <p className="public-card-error">{fel}</p>}

      {lage?.startad && (
        <section className={`utskick-lage${lage.pagar ? " pagar" : ""}`}>
          <strong>
            {!lage.pagar
              ? "Utskicket är klart"
              : lage.vantarTill
                ? `Mejlservern bromsar – fortsätter ${new Date(lage.vantarTill).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}`
                : "Skickar…"}
          </strong>
          <span>
            {lage.skickade} av {lage.totalt} skickade
            {lage.fel > 0 ? ` · ${lage.fel} fel` : ""}
            {lage.amne ? ` · "${lage.amne}"` : ""}
          </span>
          {lage.problem.length > 0 && (
            <ul className="utskick-problem">
              {lage.problem.map((p) => (
                <li key={p.epost}>
                  {p.epost} — {p.orsak}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <label className="utskick-falt">
        <span className="auth-label">Avsändare</span>
        <input value={avsandare} readOnly aria-label="Avsändare" />
      </label>

      <label className="utskick-falt">
        <span className="auth-label">Ämne</span>
        <input
          value={amne}
          onChange={(e) => {
            setAmne(e.target.value);
            setBekraftar(false);
          }}
          placeholder="Det som står i inkorgen"
          maxLength={200}
        />
      </label>

      <label className="utskick-falt">
        <span className="auth-label">Brev</span>
        <textarea
          className="utskick-brev"
          value={brev}
          onChange={(e) => {
            setBrev(e.target.value);
            setBekraftar(false);
          }}
          rows={14}
          placeholder={"Hej [namn],\n\n…\n\nVill du inte höra från oss igen, svara på det här mejlet."}
        />
      </label>

      {/* En platshållare vi inte kan fylla i stoppar utskicket. [stad] i åttio brev är inte ett
          skönhetsfel — det är åttio brev som avslöjar att de skrevs av en maskin. */}
      {kvarglomda.length > 0 && (
        <p className="public-card-error">
          Det här går inte att fylla i: {kvarglomda.join(", ")}.{" "}
          Skriptet kan bara [namn]{tillNya && !provmottagare ? " — och ingen rad i listan har ett namn" : ""}.
        </p>
      )}

      {(provmottagare || tillNya) && (amne.trim() || brev.trim()) && (
        <section className="utskick-forhands">
          <div className="price-panel-head">
            {provmottagare ? `Så här ser det ut för ${provmottagare.fornamn}` : "Så här ser det ut"}
          </div>
          <p className="utskick-forhands-amne">{fyll(amne) || <em>ingen ämnesrad</em>}</p>
          <pre className="utskick-forhands-brev">{fyll(brev)}</pre>
        </section>
      )}

      {tillNya ? (
        <section className="utskick-lista">
          <label className="utskick-falt">
            <span className="auth-label">Adresser</span>
            <textarea
              className="utskick-brev utskick-adresser"
              value={adressText}
              onChange={(e) => {
                setAdressText(e.target.value);
                setBekraftar(false);
              }}
              rows={10}
              spellCheck={false}
              placeholder={"Anna Svensson, anna@exempel.se\nErik Lind <erik@exempel.se>\nsara@exempel.se Sara"}
            />
          </label>
          <p className="form-hint">
            <strong>{nyaMottagare.length}</strong> giltiga adresser
            {nyaMottagare.length > 0 ? `, ${nyaMottagare.length - utanNamn.length} med namn` : ""}
            {nya.dubbletter > 0 ? ` · ${nya.dubbletter} dubbletter borttagna` : ""}. En mottagare per rad, namnet
            bredvid adressen — eller klistra in två kolumner ur ett kalkylark.
          </p>
          {anvanderNamn && utanNamn.length > 0 && (
            <p className="public-card-error">
              Brevet använder [namn], men {utanNamn.length} {utanNamn.length === 1 ? "adress saknar" : "adresser saknar"}{" "}
              namn: {utanNamn.slice(0, 10).map((m) => m.epost).join(", ")}
              {utanNamn.length > 10 ? " …" : ""}. Skriv namnet på samma rad, eller ta bort [namn] ur brevet.
            </p>
          )}
          {nya.ogiltiga.length > 0 && (
            <p className="public-card-error">
              {nya.ogiltiga.length} {nya.ogiltiga.length === 1 ? "adress" : "adresser"} går inte att läsa:{" "}
              {nya.ogiltiga.slice(0, 10).join(", ")}
              {nya.ogiltiga.length > 10 ? " …" : ""}. Rätta eller ta bort {nya.ogiltiga.length === 1 ? "den" : "dem"}.
            </p>
          )}
          {nyaMottagare.length > MAX_MOTTAGARE && (
            <p className="public-card-error">
              Högst {MAX_MOTTAGARE} mottagare per utskick — dela upp listan.
            </p>
          )}
        </section>
      ) : (
        <section className="utskick-lista">
          <div className="utskick-lista-topp">
            <strong>
              {valda.length} av {mottagare?.length ?? 0} mottagare
            </strong>
            <button type="button" className="btn btn-text" onClick={() => setBortvalda(new Set())}>
              Markera alla
            </button>
            <button
              type="button"
              className="btn btn-text"
              onClick={() => setBortvalda(new Set((mottagare ?? []).map((m) => m.epost)))}
            >
              Avmarkera alla
            </button>
          </div>

          <label className="admin-sok">
            <SearchIcon size={15} />
            <input
              value={fraga}
              onChange={(e) => setFraga(e.target.value)}
              placeholder="Sök namn eller adress"
              aria-label="Sök mottagare"
            />
          </label>

          {mottagare === null ? (
            <div className="profile-loading">
              <div className="spinner" />
            </div>
          ) : (
            <ul className="utskick-mottagare">
              {synliga.map((m) => (
                <li key={m.epost}>
                  <label>
                    <input type="checkbox" checked={!bortvalda.has(m.epost)} onChange={() => vaxla(m.epost)} />
                    <span className="utskick-namn">{m.namn ?? m.fornamn}</span>
                    {skickade.has(m.epost) && <span className="utskick-fatt">har fått brevet</span>}
                    <span className="utskick-epost">{m.epost}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {harFatt > 0 && (
        <p className="form-hint">
          <strong>{harFatt}</strong> av de valda har redan fått brevet med den här ämnesraden och hoppas över.{" "}
          {antal - harFatt > 0
            ? `Brevet går till ${antal - harFatt}.`
            : "Ingen återstår."}
        </p>
      )}

      <div className="utskick-knappar">
        <button className="btn btn-primary" disabled={!klart || skickar || !!lage?.pagar} onClick={() => void skicka()}>
          {skickar
            ? "Startar…"
            : lage?.pagar
              ? "Ett utskick pågår"
              : bekraftar
                ? `Tryck igen för att skicka till ${antal - harFatt}`
                : `Skicka till ${antal - harFatt} ${tillNya ? "nya " : ""}mottagare`}
        </button>
        {bekraftar && (
          <button className="btn btn-text" onClick={() => setBekraftar(false)}>
            Avbryt
          </button>
        )}
      </div>
      <p className="form-hint">
        Samma adress får aldrig samma ämnesrad två gånger — servern håller en logg och hoppar över dem.
      </p>
    </div>
  );
}
