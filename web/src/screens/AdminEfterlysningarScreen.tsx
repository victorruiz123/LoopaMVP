import { useCallback, useEffect, useState } from "react";
import { efterlysningKandidater, listaEfterlysningar, skickaEfterlysningTips } from "../api";
import { formatSek } from "../lib/price";
import type { AdminEfterlysning, EfterlysningKandidat } from "../types";

/**
 * Efterlysningsfliken: vad folk letar efter, och knappen som hör av sig.
 *
 * MENINGEN STÅR FÖRST, sammanfattningen under. Sammanfattningen är vad TOLKNINGEN förstod och är
 * ofta smalare än vad personen bad om — ett märke vi inte har i lager överlever den inte, och det är
 * ofta just det som avgör. Den som matchar för hand läser meningen och bedömer själv.
 *
 * KANDIDATERNA HÄMTAS FÖRST NÄR EN RAD ÖPPNAS. Varje rad kostar ett anrop mot hela lagret, och en
 * lista med trettio rader hade blivit trettio anrop för att fylla sektioner ingen öppnat.
 *
 * KNAPPEN SKICKAR ETT RIKTIGT BREV. Det finns ingen ångra — därför står mottagarens adress på
 * knappen, och en möbel som redan skickats går inte att skicka igen (regeln sitter på servern, se
 * efterlysning/admin.ts).
 */
export default function AdminEfterlysningarScreen() {
  const [poster, setPoster] = useState<AdminEfterlysning[] | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [oppen, setOppen] = useState<string | null>(null);

  const ladda = useCallback(() => {
    listaEfterlysningar()
      .then((r) => setPoster(r.poster))
      .catch((err: unknown) => setFel(err instanceof Error ? err.message : "Kunde inte hämta efterlysningarna."));
  }, []);

  useEffect(ladda, [ladda]);

  const aktiva = (poster ?? []).filter((p) => p.state === "active").length;

  return (
    <div className="admin-flik">
      <p className="admin-lede">
        {poster
          ? `${aktiva} ${aktiva === 1 ? "aktiv efterlysning" : "aktiva efterlysningar"} · ${poster.length} totalt`
          : "Hämtar…"}
      </p>

      {fel && <p className="public-card-error">{fel}</p>}

      {poster?.length === 0 && <p className="admin-lede">Ingen har efterlyst något än.</p>}

      <div className="letar-admin-lista">
        {(poster ?? []).map((p) => (
          <Rad
            key={p.id}
            post={p}
            oppen={oppen === p.id}
            onVaxla={() => setOppen(oppen === p.id ? null : p.id)}
            onSkickat={ladda}
          />
        ))}
      </div>
    </div>
  );
}

function datum(iso: string): string {
  return new Date(iso).toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" });
}

function Rad({
  post, oppen, onVaxla, onSkickat,
}: {
  post: AdminEfterlysning;
  oppen: boolean;
  onVaxla: () => void;
  onSkickat: () => void;
}) {
  const [kandidater, setKandidater] = useState<EfterlysningKandidat[] | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [skickar, setSkickar] = useState<string | null>(null);
  const [kvitto, setKvitto] = useState<string | null>(null);

  useEffect(() => {
    if (!oppen || kandidater) return;
    efterlysningKandidater(post.id)
      .then((r) => setKandidater(r.poster))
      .catch((err: unknown) => setFel(err instanceof Error ? err.message : "Kunde inte hämta förslagen."));
  }, [oppen, kandidater, post.id]);

  const skicka = async (k: EfterlysningKandidat) => {
    if (!post.epost) return;
    if (!window.confirm(`Skicka "${k.titel}" till ${post.epost}?`)) return;
    setFel(null);
    setSkickar(k.id);
    try {
      const svar = await skickaEfterlysningTips(post.id, k.id);
      setKvitto(svar.skickat ? `Skickat till ${svar.till}.` : `Brevet gick inte iväg. Kontrollera utskicket.`);
      setKandidater((rader) => (rader ?? []).map((r) => (r.id === k.id ? { ...r, tipsad: true } : r)));
      onSkickat();
    } catch (err) {
      setFel(err instanceof Error ? err.message : "Det gick inte att skicka.");
    } finally {
      setSkickar(null);
    }
  };

  return (
    <section className={`letar-admin-rad${oppen ? " oppen" : ""}`}>
      <button type="button" className="letar-admin-huvud" onClick={onVaxla} aria-expanded={oppen}>
        {/* Personens egna ord, inte vår sammanfattning. Se filens topp. */}
        <span className="letar-admin-text">{post.originalText || post.summary}</span>
        <span className="letar-admin-meta">
          {datum(post.skapad)} · {post.epost ?? "konto"}
          {post.state !== "active" && ` · ${post.state}`}
        </span>
      </button>

      {oppen && (
        <div className="letar-admin-kropp">
          <dl className="letar-admin-fakta">
            <div><dt>Tolkat som</dt><dd>{post.summary}</dd></div>
            {post.styleTags.length > 0 && <div><dt>Stil</dt><dd>{post.styleTags.join(", ")}</dd></div>}
            {post.note && <div><dt>Anteckning</dt><dd>{post.note}</dd></div>}
            {post.varifran && <div><dt>Kom från</dt><dd>{post.varifran}</dd></div>}
          </dl>

          {/*
            Frågeloggen med de överhoppade kvar.
            En överhoppad fråga är ett svar: den säger att frågan inte var värd att svara på, och en
            fråga som alla hoppar över ska bort ur intaget. Att bara visa de besvarade hade dolt just
            den signalen.
          */}
          {post.fragor.length > 0 && (
            <ul className="letar-admin-fragor">
              {post.fragor.map((f, i) => (
                <li key={i}>
                  <span className="letar-admin-fraga">{f.question}</span>
                  <span className={f.answer ? "letar-admin-svar" : "letar-admin-svar tom"}>
                    {f.answer ?? "hoppade över"}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <h4 className="letar-admin-rubrik">Förslag ur lagret</h4>
          {fel && <p className="public-card-error">{fel}</p>}
          {kvitto && <p className="letar-admin-kvitto" role="status">{kvitto}</p>}
          {!kandidater && !fel && <p className="admin-lede">Hämtar förslag…</p>}
          {kandidater?.length === 0 && (
            <p className="admin-lede">Inget i lagret som ligger nära. Kolla igen när något kommit in.</p>
          )}

          <div className="letar-admin-kandidater">
            {(kandidater ?? []).map((k) => (
              <article key={k.id} className="letar-admin-kandidat">
                {k.bild
                  ? <img src={k.bild} alt="" loading="lazy" />
                  : <div className="letar-admin-ingenbild" aria-hidden="true" />}
                <div className="letar-admin-kandidat-text">
                  <a href={k.lank} target="_blank" rel="noreferrer">{k.titel}</a>
                  <span>
                    {k.pris !== null ? formatSek(k.pris) : "Pris saknas"}
                    {k.skick ? ` · ${k.skick}` : ""}
                    {k.kalla === "tradera" ? " · Tradera" : ""}
                  </span>
                </div>
                <button
                  type="button"
                  className="letar-admin-skicka"
                  disabled={k.tipsad || !post.epost || skickar === k.id}
                  onClick={() => void skicka(k)}
                  title={post.epost ? `Skickar till ${post.epost}` : "Ingen adress att skriva till"}
                >
                  {k.tipsad ? "Skickad" : skickar === k.id ? "Skickar…" : "Skicka"}
                </button>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
