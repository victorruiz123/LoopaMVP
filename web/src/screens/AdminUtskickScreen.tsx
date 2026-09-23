import { useEffect, useMemo, useRef, useState } from "react";
import { startaUtskick, utskickLage, utskickMottagare } from "../api";
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
 */
export default function AdminUtskickScreen() {
  usePageTitle("Adminpanel");
  const [mottagare, setMottagare] = useState<UtskickMottagare[] | null>(null);
  const [avsandare, setAvsandare] = useState<string>("");
  const [konfigurerat, setKonfigurerat] = useState(true);
  const [fel, setFel] = useState<string | null>(null);

  const [amne, setAmne] = useState("");
  const [brev, setBrev] = useState("");
  const [fraga, setFraga] = useState("");
  /** Adresser som INTE ska med. Undantagen sparas, inte urvalet — se resonemanget ovan. */
  const [bortvalda, setBortvalda] = useState<Set<string>>(new Set());
  const [bekraftar, setBekraftar] = useState(false);
  const [lage, setLage] = useState<UtskickLage | null>(null);
  const [skickar, setSkickar] = useState(false);

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

  const valda = useMemo(
    () => (mottagare ?? []).filter((m) => !bortvalda.has(m.epost)),
    [mottagare, bortvalda],
  );
  const synliga = useMemo(() => {
    const q = fraga.trim().toLowerCase();
    if (!q) return mottagare ?? [];
    return (mottagare ?? []).filter((m) => m.epost.includes(q) || (m.namn ?? m.fornamn).toLowerCase().includes(q));
  }, [mottagare, fraga]);

  const provmottagare = valda[0] ?? null;
  const fyll = (text: string) =>
    provmottagare ? text.replace(/[[{](namn|förnamn|fornamn)[\]}]/gi, provmottagare.fornamn) : text;
  const kvarglomda = useMemo(() => {
    const prov = fyll(`${amne}\n${brev}`);
    return [...new Set([...prov.matchAll(/\[[^\]\n]{1,30}\]/g)].map((m) => m[0]))];
  }, [amne, brev, provmottagare]);

  const klart = !!amne.trim() && !!brev.trim() && valda.length > 0 && konfigurerat && kvarglomda.length === 0;

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
      setLage(await startaUtskick(amne.trim(), brev, valda.map((m) => m.epost)));
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
        Ett brev till flera. <code>[namn]</code> byts mot mottagarens förnamn, varje gång det står.
      </p>

      {!konfigurerat && (
        <p className="admin-note">
          Servern saknar SMTP_USER och SMTP_PASS, så ingenting kan skickas. Lägg in dem i server/.env.
        </p>
      )}
      {fel && <p className="public-card-error">{fel}</p>}

      {lage?.startad && (
        <section className={`utskick-lage${lage.pagar ? " pagar" : ""}`}>
          <strong>{lage.pagar ? "Skickar…" : "Utskicket är klart"}</strong>
          <span>
            {lage.skickade} av {lage.totalt} skickade
            {lage.fel > 0 ? ` · ${lage.fel} fel` : ""}
            {lage.amne ? ` · "${lage.amne}"` : ""}
          </span>
          {lage.problem.length > 0 && (
            <ul className="utskick-problem">
              {lage.problem.slice(0, 10).map((p) => (
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
          Det här går inte att fylla i: {kvarglomda.join(", ")}. Skriptet kan bara [namn].
        </p>
      )}

      {provmottagare && (amne.trim() || brev.trim()) && (
        <section className="utskick-forhands">
          <div className="price-panel-head">Så här ser det ut för {provmottagare.fornamn}</div>
          <p className="utskick-forhands-amne">{fyll(amne) || <em>ingen ämnesrad</em>}</p>
          <pre className="utskick-forhands-brev">{fyll(brev)}</pre>
        </section>
      )}

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
                  <span className="utskick-epost">{m.epost}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="utskick-knappar">
        <button className="btn btn-primary" disabled={!klart || skickar || !!lage?.pagar} onClick={() => void skicka()}>
          {skickar
            ? "Startar…"
            : lage?.pagar
              ? "Ett utskick pågår"
              : bekraftar
                ? `Tryck igen för att skicka till ${valda.length}`
                : `Skicka till ${valda.length} mottagare`}
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
