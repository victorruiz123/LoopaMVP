import { useEffect, useState, type ReactNode } from "react";
import { datum, Fraga, Hopfallt, KortSagt, Period, pct, sidNamn, TopLista, Tratt } from "./adminRapport";
import { getTrafik } from "../api";
import { useT } from "../lib/i18n";
import type { TrafikKanalRad, TrafikSvar } from "../types";

/**
 * Trafikfliken: varifrån folk kommer, och vad de gör när de är här.
 *
 * LÄSES UPPIFRÅN OCH NED SOM TRE FRÅGOR, inte som en tavla med tal. Den första versionen visade allt
 * på en gång — sex nyckeltal, fem tabeller, fackord som "studs" och "intygade" — och den som öppnade
 * fliken fick själv lista ut vad som var svaret. Nu står svaret först, i en mening, och siffrorna
 * under det är underlaget till meningen. Allt som bara behövs ibland ligger hopfällt.
 *
 * ORDEN ÄR PRODUKTENS, INTE MÄTNINGENS. "Intygat kort" heter "lade upp en annons" här, "påbörjad"
 * heter "började sälja", "studs" heter "lämnade direkt". Datafliken får tala modellens språk; den här
 * läses av den som ska bestämma var nästa krona i marknadsföringen ska läggas.
 *
 * KONVERTERINGEN RÄKNAS PÅ BESÖKEN: ett besök från Google som gick hela vägen till en upplagd annons
 * är det mått som säger om kanalen ger säljare, inte bara klick.
 */
export default function AdminTrafikScreen({ onOpenUserId }: { onOpenUserId?: (id: string) => void }) {
  const t = useT();
  const [dagar, setDagar] = useState(30);
  const [data, setData] = useState<TrafikSvar | null>(null);
  const [fel, setFel] = useState<string | null>(null);

  useEffect(() => {
    let aktiv = true;
    setData(null);
    setFel(null);
    getTrafik(dagar)
      .then((d) => aktiv && setData(d))
      .catch((err: unknown) => aktiv && setFel(err instanceof Error ? err.message : "Kunde inte hämta trafiken."));
    return () => {
      aktiv = false;
    };
  }, [dagar]);

  return (
    <>
      <div className="trafik-topp">
        <p className="admin-lede">{t("Varifrån folk kommer, och vad de gör när de är här")}</p>
        <Period dagar={dagar} setDagar={setDagar} />
      </div>

      {fel ? (
        <p className="public-card-error">{fel}</p>
      ) : !data ? (
        <div className="profile-loading">
          <div className="spinner" />
        </div>
      ) : data.summering.besok === 0 && data.nyaKonton.length === 0 ? (
        <p className="admin-note">
          {data.matningSedan
            ? t("Inga besök under perioden. Mätningen har varit igång sedan {datum}.", { datum: datum(data.matningSedan) })
            : t("Mätningen är påslagen men har inga besök än. Den fylls från nästa besökare.")}
        </p>
      ) : (
        <Innehall data={data} onOpenUserId={onOpenUserId} />
      )}
    </>
  );
}

function Innehall({ data, onOpenUserId }: { data: TrafikSvar; onOpenUserId?: (id: string) => void }) {
  const t = useT();
  const s = data.summering;
  const startadeSent = data.matningSedan && data.matningSedan > data.fran;

  return (
    <>
      {/* Mätningen började en viss dag. Allt före den är OKÄNT, inte noll. */}
      {startadeSent && (
        <p className="admin-note">
          {t("Mätningen startade {datum}, så perioden är kortare än den ser ut. Allt före det är okänt, inte noll.", {
            datum: datum(data.matningSedan!),
          })}
        </p>
      )}

      <TrafikKortSagt data={data} />

      {/* ── 1 ─────────────────────────────────────────────────────────────── */}
      <Fraga nr={1} titel={t("Varifrån kommer folk?")} ingress={t("Varje besök sorteras efter var det kom ifrån. Stapeln är andelen av alla besök; till höger står hur många av dem som lade upp en annons.")}>
        <Kanaler rader={data.kanaler} totalt={s.besok} />
        <Hopfallt titel={t("Visa exakta källor och kampanjer")}>
          <Kallor data={data} />
        </Hopfallt>
        <Hopfallt titel={t("Så får en delad länk en egen rad här")}>
          <p className="trafik-text">
            {t(
              "Instagram, Messenger och många appar tar bort uppgiften om var besökaren kom ifrån, så de besöken hamnar under Direkt. Skapa en kampanjlänk under Kundresan → Kampanjlänkar och dela den i stället — då får länken en egen rad här.",
            )}
          </p>
          <p className="trafik-text trafik-dampad">
            {t("Märk inte länkar till säljsidan för hand med ?utm_…: roten går inte att nå med en query, och märkningen försvinner på vägen.")}
          </p>
        </Hopfallt>
      </Fraga>

      {/* ── 2 ─────────────────────────────────────────────────────────────── */}
      <Fraga nr={2} titel={t("Vad gör de på plattformen?")} ingress={t("Hur långt besöken kommer, var de börjar, var de lämnar, och vilka vägar som är vanligast.")}>
        <Tratt
          steg={[
            { namn: t("Besökte Loopa"), antal: s.besok, hjalp: t("Alla besök under perioden") },
            { namn: t("Klickade vidare"), antal: s.flerSidor, hjalp: t("Såg mer än en sida") },
            { namn: t("Började sälja"), antal: s.paborjade, hjalp: t("Gick in i säljflödet och började filma") },
            { namn: t("Lade upp en annons"), antal: s.intygade, hjalp: t("Kom hela vägen till ett färdigt kort") },
          ]}
        />
        <div className="trafik-tvaspalt">
          <TopLista
            titel={t("Här landar de")}
            hjalp={t("Första sidan i besöket")}
            rader={[...data.sidor].sort((a, b) => b.ingang - a.ingang).filter((r) => r.ingang > 0).slice(0, 5).map((r) => ({ namn: sidNamn(r.sida), antal: r.ingang, notis: null }))}
          />
          <TopLista
            titel={t("Här lämnar de")}
            hjalp={t("Sista sidan innan de gick — och hur stor del av sidans besökare det är")}
            rader={[...data.sidor].sort((a, b) => b.utgang - a.utgang).filter((r) => r.utgang > 0).slice(0, 5).map((r) => ({ namn: sidNamn(r.sida), antal: r.utgang, notis: pct(r.utgang, r.besok) }))}
          />
        </div>
        {data.vagar.length > 0 && (
          <TopLista
            titel={t("Vanligaste vägarna")}
            hjalp={t("De första sidorna i besök som klickade vidare")}
            rader={data.vagar.slice(0, 5).map((v) => ({ namn: v.vag.map(sidNamn).join("  →  "), antal: v.antal, notis: null }))}
          />
        )}
        <PerDag data={data} />
        <Hopfallt titel={t("Visa alla sidor")}>
          <AllaSidor data={data} />
        </Hopfallt>
      </Fraga>

      {/* ── 3 ─────────────────────────────────────────────────────────────── */}
      <Fraga nr={3} titel={t("Vilka blev användare?")} ingress={t("Nya konton under perioden, med var de kom ifrån och vad de tittade på först. Tryck för att öppna kontot.")}>
        <NyaKonton data={data} onOpenUserId={onOpenUserId} />
      </Fraga>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sammanfattningen
// ---------------------------------------------------------------------------

/** Kanaler med färre besök än så får inte kallas "bäst" — två av två är tur, inte en kanal. */
const MINSTA_UNDERLAG = 5;

/**
 * Svaret i klartext, överst.
 *
 * Meningarna räknas fram ur samma tal som listorna under, och säger bara det talen bär: en kanal
 * med för litet underlag nämns inte som bäst, och en mening utan underlag skrivs inte alls.
 */
function TrafikKortSagt({ data }: { data: TrafikSvar }) {
  const t = useT();
  const s = data.summering;
  const storst = data.kanaler[0];
  const bast = [...data.kanaler]
    .filter((k) => k.besok >= MINSTA_UNDERLAG && k.intygade > 0)
    .sort((a, b) => b.intygade / b.besok - a.intygade / a.besok)[0];
  const lamnar = [...data.sidor].filter((r) => r.besok >= MINSTA_UNDERLAG).sort((a, b) => b.utgang / b.besok - a.utgang / a.besok)[0];
  const meningar: ReactNode[] = [
    <>
      <b>{s.besok}</b> {t("besök gav")} <b>{s.nyaKonton}</b> {t("nya konton och")} <b>{s.intygade}</b> {t("upplagda annonser.")}
    </>,
  ];
  if (storst && s.besok) {
    meningar.push(
      <>
        {t("Flest kom via")} <b>{storst.kanal}</b> ({pct(storst.besok, s.besok)} {t("av besöken")}).
      </>,
    );
  }
  if (bast && bast.kanal !== storst?.kanal) {
    meningar.push(
      <>
        {t("Bäst på att ge säljare är")} <b>{bast.kanal}</b>: {pct(bast.intygade, bast.besok)} {t("av besöken därifrån lade upp en annons.")}
      </>,
    );
  } else if (bast) {
    meningar.push(
      <>
        {t("Den kanalen är också bäst på att ge säljare:")} {pct(bast.intygade, bast.besok)} {t("lade upp en annons.")}
      </>,
    );
  }
  if (s.besok) {
    meningar.push(
      <>
        <b>{pct(s.besok - s.flerSidor, s.besok)}</b> {t("lämnade efter första sidan.")}
        {lamnar && (
          <>
            {" "}
            {t("Flest lämnar på")} <b>{sidNamn(lamnar.sida)}</b> ({pct(lamnar.utgang, lamnar.besok)} {t("av dem som ser den")}).
          </>
        )}
      </>,
    );
  }
  return <KortSagt meningar={meningar} />;
}

// ---------------------------------------------------------------------------
// Delarna
// ---------------------------------------------------------------------------

/** Vad varje kanal betyder. Utan raden är "Direkt" och "Övrigt" två ord som inte säger något. */
const KANAL_BETYDER: Record<string, string> = {
  Direkt: "Skrev in adressen, bokmärke, eller en app som döljer källan",
  Sök: "Google, Bing och andra sökmotorer",
  "Sociala medier": "Facebook, Instagram, TikTok, LinkedIn …",
  Marknadsplatser: "Blocket, Tradera och liknande",
  Marknadssajten: "Från loopa.nu, vår egen startsida",
  Inbjudan: "Klickade på en väns inbjudningslänk",
  Affiliate: "Kom via en partners länk",
  "E-post": "Klickade i ett mejl",
  Kampanj: "En märkt länk (utm) som inte passar ovan",
  Övrigt: "En annan webbplats som länkat till oss",
};

function Kanaler({ rader, totalt }: { rader: TrafikKanalRad[]; totalt: number }) {
  const t = useT();
  if (!rader.length) return <p className="admin-note">{t("Inga besök under perioden.")}</p>;
  const max = Math.max(1, ...rader.map((r) => r.besok));
  return (
    <ul className="trafik-kanaler">
      {rader.map((r) => (
        <li key={r.kanal} className="trafik-kanal">
          <div className="trafik-kanal-namn">
            <strong>{r.kanal}</strong>
            <span className="trafik-dampad">{t(KANAL_BETYDER[r.kanal] ?? "")}</span>
          </div>
          <div className="trafik-kanal-stapel">
            <span className="data-tratt-stapel" aria-hidden>
              <span className="data-tratt-fyllning" style={{ width: `${(r.besok / max) * 100}%` }} />
            </span>
            <span className="trafik-kanal-tal">
              {r.besok} <span className="trafik-dampad">· {pct(r.besok, totalt)}</span>
            </span>
          </div>
          <div className="trafik-kanal-utfall">
            <span>
              <b>{r.intygade}</b> {r.intygade === 1 ? t("annons") : t("annonser")}
              <span className="trafik-dampad"> ({pct(r.intygade, r.besok)})</span>
            </span>
            <span className="trafik-dampad">
              {r.nyaKonton} {t("nya konton")} · {Math.round(r.studs * 100)} % {t("lämnade direkt")}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}



function Kallor({ data }: { data: TrafikSvar }) {
  const t = useT();
  return (
    <>
      <div className="data-tabell-rull">
        <table className="data-tabell">
          <thead>
            <tr>
              <th>{t("Källa")}</th>
              <th>{t("Besök")}</th>
              <th>{t("Nya konton")}</th>
              <th>{t("Började sälja")}</th>
              <th>{t("Lade upp annons")}</th>
            </tr>
          </thead>
          <tbody>
            {data.kallor.map((r) => (
              <tr key={`${r.kanal}-${r.kalla}`}>
                <td>
                  {r.kalla}
                  <span className="trafik-underrad">{r.kanal}</span>
                </td>
                <td>{r.besok}</td>
                <td>{r.nyaKonton}</td>
                <td>{r.paborjade}</td>
                <td>
                  {r.intygade} <span className="data-tratt-tid">{pct(r.intygade, r.besok)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h4 className="trafik-underrubrik">{t("Kampanjer")}</h4>
      {data.kampanjer.length ? (
        <div className="data-tabell-rull">
          <table className="data-tabell">
            <thead>
              <tr>
                <th>{t("Kampanj")}</th>
                <th>{t("Besök")}</th>
                <th>{t("Nya konton")}</th>
                <th>{t("Lade upp annons")}</th>
              </tr>
            </thead>
            <tbody>
              {data.kampanjer.map((k) => (
                <tr key={k.kampanj}>
                  <td>{k.kampanj}</td>
                  <td>{k.besok}</td>
                  <td>{k.nyaKonton}</td>
                  <td>{k.intygade}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="trafik-text trafik-dampad">{t("Inga märkta kampanjlänkar under perioden.")}</p>
      )}
    </>
  );
}

function AllaSidor({ data }: { data: TrafikSvar }) {
  const t = useT();
  if (!data.sidor.length) return <p className="trafik-text trafik-dampad">{t("Inga sidvisningar under perioden.")}</p>;
  return (
    <div className="data-tabell-rull">
      <table className="data-tabell">
        <thead>
          <tr>
            <th>{t("Sida")}</th>
            <th>{t("Visningar")}</th>
            <th>{t("Började här")}</th>
            <th>{t("Lämnade här")}</th>
            <th>{t("Tid på sidan")}</th>
          </tr>
        </thead>
        <tbody>
          {data.sidor.map((r) => (
            <tr key={r.sida}>
              <td title={r.sida}>{sidNamn(r.sida)}</td>
              <td>{r.visningar}</td>
              <td>{r.ingang}</td>
              <td>
                {r.utgang} <span className="data-tratt-tid">{pct(r.utgang, r.besok)}</span>
              </td>
              <td>{r.tidMedianMs !== null ? kortTid(r.tidMedianMs) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NyaKonton({ data, onOpenUserId }: { data: TrafikSvar; onOpenUserId?: (id: string) => void }) {
  const t = useT();
  if (!data.nyaKonton.length) return <p className="admin-note">{t("Inga nya konton under perioden.")}</p>;
  const utan = data.summering.nyaKontonUtanKalla;
  return (
    <>
      {utan > 0 && (
        <p className="trafik-text trafik-dampad">
          {t("{antal} av {alla} saknar källa: de registrerade sig innan mätningen startade, eller på en annan enhet.", {
            antal: utan,
            alla: data.nyaKonton.length,
          })}
        </p>
      )}
      <ul className="trafik-konton">
        {data.nyaKonton.map((k) => (
          <li key={k.id}>
            <button type="button" className="trafik-konto" onClick={() => onOpenUserId?.(k.id)} disabled={!onOpenUserId}>
              <span className="trafik-konto-topp">
                <strong>{k.namn ?? k.id}</strong>
                <span className="trafik-dampad">{k.ungefarligt ? t("första jobbet {datum}", { datum: datum(k.registrerad) }) : datum(k.registrerad)}</span>
                {k.intygat && <span className="admin-tag">{t("Har lagt upp annons")}</span>}
              </span>
              <span className="trafik-konto-rad">
                <span className="trafik-etikett">{t("Kom från")}</span>
                {k.kanal ? (
                  <span>
                    {k.kanal}
                    {k.kalla && k.kalla !== k.kanal.toLowerCase() && k.kalla !== "direkt" ? ` (${k.kalla})` : ""}
                    {k.kampanj ? ` · ${t("kampanj")} ${k.kampanj}` : ""}
                  </span>
                ) : (
                  <span className="trafik-dampad">{t("Okänt")}</span>
                )}
              </span>
              {k.vag.length > 0 && (
                <span className="trafik-konto-rad">
                  <span className="trafik-etikett">{t("Tittade på")}</span>
                  <span className="trafik-vag">
                    {k.vag.map((sida, i) => (
                      <span key={i} className="trafik-vag-steg">
                        {sidNamn(sida)}
                      </span>
                    ))}
                  </span>
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Besöken per dag, som staplar.
 *
 * En serie och därför ingen teckenförklaring — rubriken säger vad staplarna är. Nya konton och
 * upplagda annonser står i raden ovanför när man pekar, inte som egna staplar: de är en bråkdel av
 * besöken, och på samma axel hade de blivit streck ingen kan läsa.
 */
function PerDag({ data }: { data: TrafikSvar }) {
  const t = useT();
  const [aktiv, setAktiv] = useState<number | null>(null);
  const dagar = data.perDag;
  if (dagar.length < 2) return null;
  const max = Math.max(1, ...dagar.map((d) => d.besok));
  const vald = aktiv !== null ? dagar[aktiv] : null;
  return (
    <div className="trafik-toplista">
      <h4>{t("Besök per dag")}</h4>
      <p className="trafik-text trafik-dampad" aria-live="polite">
        {vald
          ? t("{datum}: {besok} besök · {konton} nya konton · {annonser} annonser", {
              datum: datum(vald.dag),
              besok: vald.besok,
              konton: vald.nyaKonton,
              annonser: vald.intygade,
            })
          : t("Som mest {max} besök på en dag. Peka på en stapel för att se dagen.", { max })}
      </p>
      <div className="trafik-dagar" role="img" aria-label={t("Besök per dag")} onMouseLeave={() => setAktiv(null)}>
        {dagar.map((d, i) => (
          <span key={d.dag} className={`trafik-dag${aktiv === i ? " aktiv" : ""}`} onMouseEnter={() => setAktiv(i)} onClick={() => setAktiv(i)}>
            <span className="trafik-dag-stapel" style={{ height: d.besok ? `${Math.max(4, (d.besok / max) * 100)}%` : 0 }} />
          </span>
        ))}
      </div>
      <div className="trafik-dag-axel">
        <span>{datum(dagar[0].dag)}</span>
        <span>{datum(dagar[dagar.length - 1].dag)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function kortTid(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
