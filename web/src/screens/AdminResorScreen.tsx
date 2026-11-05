import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getResa, getResor, listUsers } from "../api";
import { useT } from "../lib/i18n";
import type { KartSteg, Resa, ResaPunkt, ResaRad, ResorSvar } from "../types";
import { datum, Fraga, Hopfallt, KortSagt, Period, pct } from "./adminRapport";

/**
 * Uppladdningsfliken: hur säljarna rör sig genom flödet, steg för steg och klick för klick.
 *
 * TRE FRÅGOR, i den ordning man ställer dem när ett flöde tappar folk:
 *
 *   1. Hur går de?        flödeskartan — för varje steg: hur många kom hit, vart gick de sedan
 *   2. Var fastnar de?    stegen där flest lämnar, och vad som hände precis innan
 *   3. Vad gjorde de?     en rad per besök, och för ett besök hela tidslinjen
 *
 * Den tredje är den som gör de två första begripliga. Ett tal som säger att 30 % lämnar vid kameran
 * blir en åtgärd först när man ser tre av dem: "öppnade kameran · nekade · tryckte tillbaka".
 *
 * ORDEN ÄR SÄLJARENS. Mätningens namn ("vantar_modell", "kamera_nekad") översätts här till det
 * säljaren såg ("Väntar på modellförslag", "Nekade kameran"), och okända namn visas som de är —
 * hellre fult än fel.
 */
export default function AdminResorScreen({ onOpenUserId }: { onOpenUserId?: (id: string) => void }) {
  const t = useT();
  const [dagar, setDagar] = useState(30);
  const [data, setData] = useState<ResorSvar | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [namn, setNamn] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let aktiv = true;
    setData(null);
    setFel(null);
    getResor(dagar)
      .then((d) => aktiv && setData(d))
      .catch((err: unknown) => aktiv && setFel(err instanceof Error ? err.message : "Kunde inte hämta resorna."));
    return () => {
      aktiv = false;
    };
  }, [dagar]);

  useEffect(() => {
    // Faller tyst: utan kontolistan står id:t kvar, och fliken går ändå att läsa.
    listUsers()
      .then((svar) => setNamn(new Map(svar.users.map((u) => [u.id, u.name || u.email || u.id]))))
      .catch(() => undefined);
  }, []);

  return (
    <>
      <div className="trafik-topp">
        <p className="admin-lede">{t("Hur säljarna rör sig genom uppladdningen")}</p>
        <Period dagar={dagar} setDagar={setDagar} />
      </div>
      {fel ? (
        <p className="public-card-error">{fel}</p>
      ) : !data ? (
        <div className="profile-loading">
          <div className="spinner" />
        </div>
      ) : data.summering.besok === 0 ? (
        <p className="admin-note">
          {data.matningSedan
            ? t("Inga uppladdningar under perioden. Detaljmätningen har varit igång sedan {datum}.", { datum: datum(data.matningSedan) })
            : t("Detaljmätningen är påslagen men har inga besök än. Den fylls från nästa säljare som väljer ett märke.")}
        </p>
      ) : (
        <Innehall data={data} namn={namn} onOpenUserId={onOpenUserId} />
      )}
    </>
  );
}

function Innehall({ data, namn, onOpenUserId }: { data: ResorSvar; namn: Map<string, string>; onOpenUserId?: (id: string) => void }) {
  const t = useT();
  return (
    <>
      {data.matningSedan && data.matningSedan > data.fran && (
        <p className="admin-note">
          {t("Detaljmätningen startade {datum}. Besök före det mättes bara skärm för skärm och syns i Data-fliken.", {
            datum: datum(data.matningSedan),
          })}
        </p>
      )}

      <ResorKortSagt data={data} />

      <Fraga nr={1} titel={t("Hur går de genom flödet?")} ingress={t("Varje steg i ordning. Stapeln är hur många som kom hit. Under: vart de gick sedan — vidare, tillbaka, eller ut — och hur lång tid steget tog.")}>
        <Kartan karta={data.karta} />
      </Fraga>

      <Fraga nr={2} titel={t("Var fastnar de?")} ingress={t("Stegen där flest gav upp, och vad som hände precis innan. Ett fel och sedan tystnad betyder att något gick sönder; inget fel betyder att steget var för svårt eller för långt.")}>
        <Fastnar karta={data.karta} />
        <Hopfallt titel={t("Alla fel ({antal})", { antal: data.fel.reduce((n, f) => n + f.antal, 0) })}>
          <FelTabell fel={data.fel} />
        </Hopfallt>
      </Fraga>

      <Fraga nr={3} titel={t("Vad gjorde de, en och en?")} ingress={t("Varje besök som började ladda upp, nyast först. Tryck på ett besök för att se hela resan, klick för klick.")}>
        <Resorna resor={data.resor} namn={namn} onOpenUserId={onOpenUserId} />
      </Fraga>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sammanfattningen
// ---------------------------------------------------------------------------

function ResorKortSagt({ data }: { data: ResorSvar }) {
  const t = useT();
  const s = data.summering;
  const avslutade = s.besok - s.pagar;
  const meningar: ReactNode[] = [
    <>
      <b>{s.besok}</b> {t("besök började ladda upp")} — <b>{s.iMal}</b> {t("kom fram till en färdig annons")} ({pct(s.iMal, avslutade)}
      {s.pagar > 0 ? `, ${t("{antal} pågår", { antal: s.pagar })}` : ""}).
      {s.medianMsTillMal !== null && (
        <>
          {" "}
          {t("Det tar")} <b>{kortTid(s.medianMsTillMal)}</b> {t("i mitten.")}
        </>
      )}
    </>,
  ];
  const varst = [...data.karta].filter((k) => k.lamnade > 0).sort((a, b) => b.lamnade - a.lamnade)[0];
  if (varst) {
    const fore = varst.felForeAvhopp[0];
    meningar.push(
      <>
        {t("Flest ger upp vid")} <b>{mikroNamn(varst.namn)}</b> ({varst.lamnade} {t("st")})
        {fore && fore.namn !== "inget_fel" ? (
          <>
            {" "}— {t("oftast direkt efter felet")} <b>{felNamn(fore.namn)}</b>.
          </>
        ) : (
          <>, {t("oftast utan något fel — de bara slutade.")}</>
        )}
      </>,
    );
  }
  const vanligast = data.fel[0];
  if (vanligast) {
    meningar.push(
      <>
        {t("Vanligaste felet:")} <b>{felNamn(vanligast.namn)}</b> — {vanligast.antal} {t("gånger i")} {vanligast.besok} {t("besök")}
        {vanligast.ledTillAvhopp > 0 && (
          <>
            , {vanligast.ledTillAvhopp} {t("av dem gav upp efteråt")}
          </>
        )}
        .
      </>,
    );
  }
  if (s.medFel > 0) {
    meningar.push(
      <>
        <b>{pct(s.medFel, s.besok)}</b> {t("av besöken stötte på minst ett fel.")}
      </>,
    );
  }
  return <KortSagt meningar={meningar} />;
}

// ---------------------------------------------------------------------------
// 1. Kartan
// ---------------------------------------------------------------------------

/**
 * Flödeskartan, ett steg per rad.
 *
 * INTE ETT SANKEY-DIAGRAM, med flit. Ett flöde med tjugo steg och pilar bakåt blir ett nystan som
 * ser imponerande ut och inte går att läsa. En lista i flödets ordning, där varje rad säger vart folk
 * gick härnäst i ord, går att läsa uppifrån och ned som flödet självt.
 */
function Kartan({ karta }: { karta: KartSteg[] }) {
  const t = useT();
  const forsta = Math.max(1, ...karta.map((k) => k.nadde));
  return (
    <ol className="resor-karta">
      {karta.map((k) => {
        const fram = k.vidare.filter((v) => v.riktning === "fram");
        const bak = k.vidare.filter((v) => v.riktning === "bak");
        return (
          <li key={k.namn} className="resor-kart-steg">
            <div className="resor-kart-topp">
              <strong className="resor-kart-namn">{mikroNamn(k.namn)}</strong>
              <span className="data-tratt-stapel resor-kart-stapel" aria-hidden>
                <span className="data-tratt-fyllning" style={{ width: `${(k.nadde / forsta) * 100}%` }} />
              </span>
              <span className="resor-kart-tal">
                <b>{k.nadde}</b>
              </span>
            </div>
            <div className="resor-kart-vidare">
              {fram.map((v) => (
                <span key={`f-${v.namn}`} className="resor-chip resor-chip-fram">
                  → {mikroNamn(v.namn)} <b>{v.antal}</b>
                </span>
              ))}
              {bak.map((v) => (
                <span key={`b-${v.namn}`} className="resor-chip resor-chip-bak">
                  ↩ {t("tillbaka till")} {mikroNamn(v.namn)} <b>{v.antal}</b>
                </span>
              ))}
              {k.lamnade > 0 && (
                <span className="resor-chip resor-chip-ut">
                  ✕ {t("gav upp")} <b>{k.lamnade}</b> <span className="resor-dampad">({pct(k.lamnade, k.nadde)})</span>
                </span>
              )}
              {k.medianMs !== null && <span className="resor-dampad resor-kart-tid">{t("tar")} {kortTid(k.medianMs)}</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// 2. Fastnar
// ---------------------------------------------------------------------------

function Fastnar({ karta }: { karta: KartSteg[] }) {
  const t = useT();
  const varst = [...karta].filter((k) => k.lamnade > 0).sort((a, b) => b.lamnade - a.lamnade).slice(0, 5);
  if (!varst.length) return <p className="admin-note">{t("Ingen har gett upp under perioden.")}</p>;
  return (
    <ul className="resor-fastnar">
      {varst.map((k) => (
        <li key={k.namn} className="resor-fastnar-kort">
          <div className="resor-fastnar-rubrik">
            <strong>{mikroNamn(k.namn)}</strong>
            <span>
              <b>{k.lamnade}</b> {t("gav upp")} <span className="resor-dampad">· {pct(k.lamnade, k.nadde)} {t("av dem som kom hit")}</span>
            </span>
          </div>
          <dl className="resor-fastnar-fakta">
            <dt>{t("Mobil / dator")}</dt>
            <dd>
              {pct(k.mobil.lamnade, k.mobil.nadde)} {t("på mobil")} · {pct(k.dator.lamnade, k.dator.nadde)} {t("på dator")}
            </dd>
            <dt>{t("Precis innan")}</dt>
            <dd>
              {k.felForeAvhopp.map((f, i) => (
                <span key={f.namn}>
                  {i > 0 && " · "}
                  {f.namn === "inget_fel" ? t("inget fel") : felNamn(f.namn)} <b>{f.antal}</b>
                </span>
              ))}
            </dd>
            {k.klick.length > 0 && (
              <>
                <dt>{t("De tryckte på")}</dt>
                <dd>
                  {k.klick.map((c, i) => (
                    <span key={c.namn}>
                      {i > 0 && " · "}
                      {klickNamn(c.namn)} <b>{c.antal}</b>
                    </span>
                  ))}
                </dd>
              </>
            )}
            {k.medianMs !== null && (
              <>
                <dt>{t("Tid i steget")}</dt>
                <dd>{kortTid(k.medianMs)} {t("för dem som gick vidare")}</dd>
              </>
            )}
          </dl>
        </li>
      ))}
    </ul>
  );
}

function FelTabell({ fel }: { fel: ResorSvar["fel"] }) {
  const t = useT();
  if (!fel.length) return <p className="trafik-text trafik-dampad">{t("Inga fel under perioden.")}</p>;
  return (
    <div className="data-tabell-rull">
      <table className="data-tabell">
        <thead>
          <tr>
            <th>{t("Fel")}</th>
            <th>{t("Gånger")}</th>
            <th>{t("Besök")}</th>
            <th>{t("Gav upp efteråt")}</th>
          </tr>
        </thead>
        <tbody>
          {fel.map((f) => (
            <tr key={f.namn}>
              <td>{felNamn(f.namn)}</td>
              <td>{f.antal}</td>
              <td>{f.besok}</td>
              <td>
                {f.ledTillAvhopp} <span className="data-tratt-tid">{pct(f.ledTillAvhopp, f.besok)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Resorna
// ---------------------------------------------------------------------------

type Filter = "alla" | "gav_upp" | "i_mal" | "med_fel";

function Resorna({ resor, namn, onOpenUserId }: { resor: ResaRad[]; namn: Map<string, string>; onOpenUserId?: (id: string) => void }) {
  const t = useT();
  const [filter, setFilter] = useState<Filter>("gav_upp");
  const [oppen, setOppen] = useState<string | null>(null);
  const [antal, setAntal] = useState(20);
  const urval = useMemo(
    () =>
      resor.filter((r) =>
        filter === "gav_upp" ? !r.iMal && !r.pagar : filter === "i_mal" ? r.iMal : filter === "med_fel" ? r.antalFel > 0 : true,
      ),
    [resor, filter],
  );
  const filterNamn: Record<Filter, string> = {
    gav_upp: t("Gav upp"),
    med_fel: t("Fick fel"),
    i_mal: t("Kom i mål"),
    alla: t("Alla"),
  };
  return (
    <>
      <div className="admin-flikar resor-filter" role="tablist" aria-label={t("Visa")}>
        {(Object.keys(filterNamn) as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            className={`admin-flik-knapp${filter === f ? " vald" : ""}`}
            onClick={() => {
              setFilter(f);
              setAntal(20);
            }}
          >
            {filterNamn[f]}
          </button>
        ))}
      </div>
      {urval.length === 0 ? (
        <p className="trafik-text trafik-dampad">{t("Inga besök i det urvalet.")}</p>
      ) : (
        <ul className="trafik-konton">
          {urval.slice(0, antal).map((r) => (
            <li key={r.sess}>
              <button
                type="button"
                className={`trafik-konto${oppen === r.sess ? " resor-oppen" : ""}`}
                onClick={() => setOppen(oppen === r.sess ? null : r.sess)}
                aria-expanded={oppen === r.sess}
              >
                <span className="trafik-konto-topp">
                  <strong>{r.uid ? (namn.get(r.uid) ?? t("Säljare {id}", { id: r.uid.slice(0, 6) })) : t("Ej inloggad")}</strong>
                  <span className="trafik-dampad">
                    {datum(r.start)} {klocka(r.start)} · {r.enhet ?? t("okänd enhet")} · {kortTid(r.varaktighetMs)}
                  </span>
                  <span className={`rapport-status ${r.iMal ? "rapport-status-annons" : r.pagar ? "rapport-status-inget" : "rapport-status-borjat"}`}>
                    {r.iMal ? t("Kom i mål") : r.pagar ? t("Pågår") : t("Gav upp")}
                  </span>
                </span>
                <span className="trafik-konto-rad">
                  <span className="trafik-etikett">{r.iMal ? t("Sista steg") : t("Stannade vid")}</span>
                  <span>
                    {r.sistaMikro ? mikroNamn(r.sistaMikro) : "—"}
                    {r.antalFel > 0 && (
                      <span className="resor-fel-text">
                        {" "}· {r.antalFel} {t("fel")}
                        {r.sistaFel ? ` (${felNamn(r.sistaFel)})` : ""}
                      </span>
                    )}
                    <span className="trafik-dampad"> · {r.antalKlick} {t("klick")}</span>
                  </span>
                </span>
              </button>
              {oppen === r.sess && <Tidslinje sess={r.sess} uid={r.uid} onOpenUserId={onOpenUserId} />}
            </li>
          ))}
        </ul>
      )}
      {urval.length > antal && (
        <button type="button" className="btn btn-text" onClick={() => setAntal((n) => n + 40)}>
          {t("Visa fler ({antal} kvar)", { antal: urval.length - antal })}
        </button>
      )}
    </>
  );
}

/**
 * Ett besök, punkt för punkt.
 *
 * Tiden står två gånger: klockslaget, och hur länge det gick sedan punkten innan. Det andra är det
 * som berättar något — fyrtio sekunder mellan "öppnade kameran" och "spela in" är tvekan, fyrtio
 * minuter mellan två steg är en flik som låg öppen.
 */
function Tidslinje({ sess, uid, onOpenUserId }: { sess: string; uid: string | null; onOpenUserId?: (id: string) => void }) {
  const t = useT();
  const [resa, setResa] = useState<Resa | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  useEffect(() => {
    getResa(sess)
      .then(setResa)
      .catch((err: unknown) => setFel(err instanceof Error ? err.message : "Kunde inte hämta resan."));
  }, [sess]);
  if (fel) return <p className="public-card-error">{fel}</p>;
  if (!resa) return <p className="trafik-text trafik-dampad resor-tidslinje">{t("Hämtar resan…")}</p>;
  // Stegrader med tid är "lämnade skärmen" — de står redan som mikrosteg och gör linjen dubbel.
  const punkter = resa.punkter.filter((p) => p.typ !== "steg");
  return (
    <div className="resor-tidslinje">
      <ol>
        {punkter.map((p, i) => {
          const fore = i > 0 ? Date.parse(p.at) - Date.parse(punkter[i - 1].at) : 0;
          return (
            <li key={i} className={`resor-punkt resor-punkt-${p.typ}`}>
              <span className="resor-punkt-tid">
                {klocka(p.at, true)}
                {i > 0 && fore >= 1000 && <span className="resor-dampad"> +{kortTid(fore)}</span>}
              </span>
              <span className="resor-punkt-markor" aria-hidden />
              <span className="resor-punkt-text">{punktText(p, t)}</span>
            </li>
          );
        })}
        {!resa.iMal && !resa.pagar && (
          <li className="resor-punkt resor-punkt-slut">
            <span className="resor-punkt-tid">{klocka(resa.slut, true)}</span>
            <span className="resor-punkt-markor" aria-hidden />
            <span className="resor-punkt-text">{t("Inget mer hände — besöket tog slut här.")}</span>
          </li>
        )}
      </ol>
      <p className="trafik-text trafik-dampad">
        {[resa.enhet, resa.plattform].filter(Boolean).join(" · ")}
        {uid && onOpenUserId && (
          <>
            {" · "}
            <button type="button" className="btn btn-text btn-inline" onClick={() => onOpenUserId(uid)}>
              {t("Öppna kontot")}
            </button>
          </>
        )}
      </p>
    </div>
  );
}

export function punktText(p: ResaPunkt, t: (sv: string, vars?: Record<string, string | number>) => string): ReactNode {
  const varde = p.varde;
  switch (p.typ) {
    case "mikro": {
      const extra =
        p.namn === "varv_klart" && varde !== null
          ? ` (${varde} s)`
          : p.namn === "uppladdat" && varde !== null
            ? ` (${t("tog {s} s", { s: varde })}${p.detalj?.startsWith("kb-") ? `, ${Math.round(Number(p.detalj.slice(3)) / 102.4) / 10} MB` : ""})`
            : (p.namn === "skickar_in" || p.namn === "granskar_bilder") && varde !== null
              ? ` (${t("{antal} bilder", { antal: varde })})`
              : "";
      return <b>{mikroNamn(p.namn) + extra}</b>;
    }
    case "klick":
      return (
        <>
          {t("Tryckte:")} {klickNamn(p.namn)}
          {p.detalj && !p.detalj.startsWith("kb-") ? ` (${p.detalj})` : ""}
          {p.namn === "bilder_fran_galleri" && varde !== null ? ` (${varde})` : ""}
        </>
      );
    case "fel":
      return <span className="resor-fel-text">⚠ {felNamn(p.namn)}</span>;
    case "fraga":
      return <>{t("Ställde en fråga i chatten om")} {p.namn}</>;
    case "avhopp":
      return <span className="resor-dampad">{t("Lämnade fliken")}</span>;
    case "konto":
      return <>{t("Loggade in")}</>;
    case "intygat":
      return <b>{t("Färdig annons ✓")}</b>;
    default:
      return p.namn;
  }
}

// ---------------------------------------------------------------------------
// Namnen
// ---------------------------------------------------------------------------

const MIKRO_NAMN: Record<string, string> = {
  startsida: "Startsidan",
  marke_valt: "Valde märke",
  dator_val: "Valskärmen (dator)",
  kamera_oppnad: "Kameran öppnades",
  fotoguide: "Fotoguiden",
  inspelning_startad: "Började filma",
  varv_klart: "Varvet klart",
  granskar_bilder: "Granskar bilderna",
  konto: "Skapa konto / logga in",
  skickar_in: "Laddar upp",
  uppladdat: "Uppladdat",
  vantar_modell: "Väntar på modellförslag",
  valjer_modell: "Väljer modell",
  modell_vald: "Modell vald",
  fragor: "Frågor (husdjur, lukt)",
  variant: "Väljer variant",
  vantar_annons: "Väntar på annonsen",
  matt: "Mått och detaljer",
  pris: "Pris",
  besiktning: "Besiktningen",
  skickrapport: "Skickrapporten",
  fardig_annons: "Färdig annons",
  publicerad: "Publicerad",
};

const KLICK_NAMN: Record<string, string> = {
  spela_in: "Spela in",
  omslag_tagen: "Tog omslagsbild",
  omslag_ta_om: "Tog om omslagsbilden",
  omslag_godkant: "Använd omslagsbilden",
  omslag_hoppat: "Hoppade över omslaget",
  vinkel_tagen: "Tog bild av vinkel",
  vinkel_fran_fil: "Vinkel från fil",
  vinkel_hoppad: "Hoppade över vinkel",
  bilder_fran_galleri: "Valde bilder från galleriet",
  ta_bort_bild: "Tog bort en bild",
  oppna_fotoguide: "Öppnade fotoguiden",
  dator_video: "Valde videofil",
  dator_omslag: "Valde omslagsbild",
  dator_fortsatt: "Fortsätt (dator)",
  skicka_bilder: "Starta AI-analys",
  tillbaka: "Tillbaka",
  uppladdning_forsok_igen: "Försök igen (uppladdning)",
  uppladdning_tillbaka: "Tillbaka till bilderna",
  valj_kandidat: "Valde en föreslagen modell",
  skriv_modell: "Skrev modellen själv",
  hitta_fler: "Hitta fler modeller",
  fragor_skickade: "Svarade på frågorna",
  variant_vald: "Valde variant",
  matt_nasta: "Nästa (mått)",
  matt_tillbaka: "Tillbaka (mått)",
  annons_fortsatt_anda: "Fortsätt ändå",
  byt_modell: "Byt modell",
  se_skick: "Se skicket",
  besiktning_forsok_igen: "Försök igen (besiktning)",
  besiktning_avbryt: "Avbröt besiktningen",
  skada_stammer: "Skadan stämmer",
  skada_stammer_inte: "Skadan stämmer inte",
  skickrapport_vidare: "Vidare från skickrapporten",
  publicera: "Sälj med Loopa",
  publicera_bekrafta: "Bekräftade försäljningen",
  publicera_avbryt: "Avbröt försäljningen",
};

const FEL_NAMN: Record<string, string> = {
  kamera_nekad: "Nekade kameran",
  kamera_saknas: "Ingen kamera hittades",
  kamera_upptagen: "Kameran upptagen",
  kamera_https: "Kameran blockerad (inte https)",
  kamera_start: "Kameran startade inte",
  kamera_uppspelning: "Kamerabilden stod still",
  kamera_avstangd: "Kameran hade stängts av",
  inspelning_tom: "Inspelningen blev tom",
  video_for_kort: "Filmen för kort",
  bildruta_fel: "Kunde inte läsa filmen",
  for_manga_bilder: "För många bilder",
  fel_filtyp: "Fel sorts fil",
  bild_olaslig: "Bilden gick inte att läsa",
  dator_video_fel: "Videofilen gick inte att läsa",
  uppladdning_misslyckad: "Uppladdningen misslyckades",
  uppladdning_tidsgrans: "Uppladdningen tog för lång tid",
  modell_hittades_inte: "Ingen modell hittades",
  modell_sok_fel: "Sökningen efter fler modeller föll",
  modell_val_misslyckat: "Modellvalet kunde inte sparas",
  fragor_sparfel: "Svaren kunde inte sparas",
  variant_sparfel: "Varianten kunde inte sparas",
  annons_misslyckad: "Annonsen blev inte klar",
  besiktning_fel: "Besiktningen föll",
  publicering_misslyckad: "Publiceringen misslyckades",
};

const mikroNamn = (n: string) => MIKRO_NAMN[n] ?? n;
const klickNamn = (n: string) => KLICK_NAMN[n] ?? n;
export const felNamn = (n: string) => FEL_NAMN[n] ?? n;

function kortTid(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min${s % 60 ? ` ${s % 60} s` : ""}` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function klocka(iso: string, sekunder = false): string {
  return new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", ...(sekunder ? { second: "2-digit" } : {}) });
}
