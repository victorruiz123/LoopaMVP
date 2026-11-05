import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fragaData, getMal, getOversikt, listData, listSamtal, listUsers, sparaMal } from "../api";
import { CardIcon, SendIcon, SparkIcon } from "../components/icons";
import { formatSek } from "../lib/price";
import { useT } from "../lib/i18n";
import type { DataFalt, DataFynd, DataObjekt, DataSaljare, DataSvar, GruppNyckel, Mal, Oversikt, Samtal, UtskickForval } from "../types";
import { datum, Fraga, Hopfallt, KortSagt, Nyckeltal, Period, pct, TopLista, Tratt } from "./adminRapport";

/**
 * Datafliken: hur det går för Loopa, med användarna först.
 *
 * NORDSTJÄRNAN STÅR ÖVERST: en siffra per vecka mot ett mål teamet satt, så att den som öppnar
 * panelen ser på en sekund om veckan går bra.
 *
 * SEDAN SJU FRÅGOR, i den ordning de spelar roll för ett bolag i vårt läge: får vi in folk, stannar
 * de, vilka ska vi höra av oss till, hur hittar de oss, kommer de hela vägen till en annons, säljs
 * det något, och fungerar AI:n. Den första versionen började i den sista frågan — sex tal om "fynd" och "intygat"
 * överst — och den som inte byggt modellen förstod ingenting av den. Nu står svaret först, i
 * meningar, och varje tal har en rad om vad det betyder.
 *
 * INGENTING ÄR BORTTAGET, bara flyttat. Möbellistan, säljartabellen, avhoppen, samtalen, chatten och
 * luckorna ligger kvar längst ned, hopfällda: de behövs när man gräver, inte när man vill veta läget.
 *
 * MÖBELVYN har fortfarande sin enda regel — det modellen sa och det en människa gjorde av det
 * blandas aldrig. Se ObjektVy nedan.
 */
export default function AdminDataScreen({
  onOpenUserId,
  onVisaTrafik,
  onVisaUppladdning,
  onSkickaTill,
}: {
  onOpenUserId?: (id: string) => void;
  onVisaTrafik?: () => void;
  onVisaUppladdning?: () => void;
  /** Öppnar Utskick med en grupp förvald. Se Grupperna. */
  onSkickaTill?: (forval: UtskickForval) => void;
}) {
  const t = useT();
  const [dagar, setDagar] = useState(30);
  const [ov, setOv] = useState<Oversikt | null>(null);
  const [data, setData] = useState<DataSvar | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [oppen, setOppen] = useState<DataObjekt | null>(null);
  /**
   * Namnen bakom konto-id:na.
   *
   * Mätningen bär bara id:t — den ska inte vara ett personregister, se server/src/data/flode.ts —
   * och en panel full av slumpmässig hexadecimal är oläsbar för en människa. Namnet hämtas därför där
   * det redan finns, ur kontolistan, och bara för den admin som ändå får se den.
   */
  const [namn, setNamn] = useState<Map<string, string>>(new Map());

  const ladda = useCallback(() => {
    listData()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Kunde inte hämta datan."));
  }, []);
  useEffect(ladda, [ladda]);

  useEffect(() => {
    let aktiv = true;
    setOv(null);
    getOversikt(dagar)
      .then((o) => aktiv && setOv(o))
      .catch((err: unknown) => aktiv && setError(err instanceof Error ? err.message : "Kunde inte hämta översikten."));
    return () => {
      aktiv = false;
    };
  }, [dagar]);

  useEffect(() => {
    // Faller tyst: datafliken ska gå att läsa även om kontotjänsten inte svarar. Då står id:t kvar.
    listUsers()
      .then((svar) => setNamn(new Map(svar.users.map((u) => [u.id, u.name || u.email || u.id]))))
      .catch(() => undefined);
  }, []);

  const namnFor = useCallback(
    (uid: string | null) => (uid ? (namn.get(uid) ?? `${uid.slice(0, 8)}…`) : null),
    [namn],
  );

  if (oppen) return <ObjektVy objekt={oppen} onStang={() => setOppen(null)} />;

  return (
    <div className="admin-flik">
      <div className="trafik-topp">
        <p className="admin-lede">{t("Hur det går för Loopa — användarna först")}</p>
        <Period dagar={dagar} setDagar={setDagar} />
      </div>

      {error && <p className="public-card-error">{error}</p>}

      {!ov || !data ? (
        !error && (
          <div className="profile-loading">
            <div className="spinner" />
          </div>
        )
      ) : (
        <>
          <Nordstjarna ov={ov} />

          <DataKortSagt ov={ov} data={data} />

          <Fraga nr={1} titel={t("Får vi in nya användare?")} ingress={t("Nya konton, hur många som är aktiva, och hur många av de nya som faktiskt blir säljare.")}>
            <Anvandarna ov={ov} onOpenUserId={onOpenUserId} />
          </Fraga>

          <Fraga nr={2} titel={t("Stannar de?")} ingress={t("Kontona grupperade efter veckan de registrerade sig. Hur stor del av varje vecka som lade upp en annons — och hur snabbt. En vecka som blir sämre än veckorna före säljer något om vad som ändrats.")}>
            <Kohorterna ov={ov} />
          </Fraga>

          <Fraga nr={3} titel={t("Vilka ska vi höra av oss till?")} ingress={t("Alla konton i fem grupper efter var de står. Välj en grupp för att se vilka det är, och skicka ett utskick till just dem.")}>
            <Grupperna ov={ov} onSkickaTill={onSkickaTill} onOpenUserId={onOpenUserId} />
          </Fraga>

          <Fraga nr={4} titel={t("Hur hittar de oss?")} ingress={t("Var de nya kontona kom ifrån, och hur mycket inbjudningarna ger.")}>
            <Kanalerna ov={ov} onVisaTrafik={onVisaTrafik} />
          </Fraga>

          <Fraga nr={5} titel={t("Kommer de hela vägen till en annons?")} ingress={t("Säljflödet steg för steg: hur många som når varje steg, och vilka som gav upp på vägen. Räknat sedan mätningen startade.")}>
            <Flodet data={data} namnFor={namnFor} onOpenUserId={onOpenUserId} />
            {onVisaUppladdning && (
              <button type="button" className="btn btn-text rapport-lank" onClick={onVisaUppladdning}>
                {t("Se klick, fel och varje säljares resa i Uppladdning →")}
              </button>
            )}
          </Fraga>

          <Fraga nr={6} titel={t("Säljs det något?")} ingress={t("Annonser, köp och vad möblerna går för.")}>
            <Affaren ov={ov} data={data} />
          </Fraga>

          <Fraga nr={7} titel={t("Fungerar AI:n?")} ingress={t("Hur ofta säljarna håller med AI:n om skador, modell och pris. Räknat på alla möbler.")}>
            <AiKvalitet data={data} />
          </Fraga>

          <section className="trafik-fraga">
            <h3 className="trafik-fraga-rubrik">{t("Gräv djupare")}</h3>
            <Hopfallt titel={t("Vad undrar folk i chattarna?")}>
              <Samtalen namnFor={namnFor} />
            </Hopfallt>
            <Hopfallt titel={t("Alla möbler, en och en")}>
              <Mobellistan data={data} onOppna={setOppen} onLadda={ladda} />
            </Hopfallt>
            <Hopfallt titel={t("Fråga datan")}>
              <DataChatt id={null} />
            </Hopfallt>
            <Hopfallt titel={t("Vad vi inte mäter än ({antal})", { antal: data.luckor.length })}>
              <ul className="data-luckor-lista">
                {data.luckor.map((l) => (
                  <li key={l.falt}>
                    <strong>{l.falt}</strong>
                    <span>{l.skal}</span>
                  </li>
                ))}
              </ul>
            </Hopfallt>
          </section>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sammanfattningen
// ---------------------------------------------------------------------------

/**
 * Svaret i klartext, överst — användarna först.
 *
 * Varje mening bär sitt underlag ("12 av 34"). En procent på tre konton och en på trehundra är två
 * olika besked, och den som läser ska kunna se vilket det är utan att leta.
 */
function DataKortSagt({ ov, data }: { ov: Oversikt; data: DataSvar }) {
  const t = useT();
  const k = ov.konton;
  const meningar: ReactNode[] = [];

  meningar.push(
    <>
      <b>{k.nya.nu}</b> {t("nya konton")}
      {k.nya.forra !== null && (
        <>
          {" "}({t("mot")} {k.nya.forra} {t("perioden innan")})
        </>
      )}
      {k.nya.nu > 0 && (
        <>
          {" "}— <b>{k.nyaMedAnnons}</b> {t("av dem har lagt upp en annons")} ({pct(k.nyaMedAnnons, k.nya.nu)}).
        </>
      )}
      {k.nya.nu === 0 && "."}
    </>,
  );

  const kand = ov.kanaler.filter((c) => c.kanal !== "Okänd");
  if (kand.length) {
    meningar.push(
      <>
        {t("Flest nya kom via")} <b>{kand[0].kanal}</b> ({kand[0].nyaKonton} {t("konton")}).
      </>,
    );
  }

  const vagg = [...data.tratt].filter((s) => s.stannade > 0).sort((a, b) => b.stannade - a.stannade)[0];
  if (vagg) {
    meningar.push(
      <>
        {t("Flest ger upp vid")} <b>{stegPlats(vagg.steg)}</b> ({vagg.stannade} {t("st")}).
      </>,
    );
  }

  meningar.push(
    <>
      <b>{ov.affar.nyaAnnonser.nu}</b> {t("nya annonser och")} <b>{ov.affar.kop.nu}</b> {t("köp i butiken")}
      {ov.affar.varde.nu > 0 && (
        <>
          {" "}{t("för")} <b>{formatSek(ov.affar.varde.nu)}</b>
        </>
      )}
      .
    </>,
  );

  return <KortSagt meningar={meningar} />;
}

// ---------------------------------------------------------------------------
// 1. Användarna
// ---------------------------------------------------------------------------

const STATUS_TEXT: Record<Oversikt["nyaKontonLista"][number]["status"], string> = {
  annons: "Har lagt upp annons",
  borjat: "Har börjat, ingen annons än",
  inget: "Inte börjat än",
};

function Anvandarna({ ov, onOpenUserId }: { ov: Oversikt; onOpenUserId?: (id: string) => void }) {
  const t = useT();
  const k = ov.konton;
  return (
    <>
      <div className="rapport-tal-rad">
        <Nyckeltal
          varde={k.nya.nu}
          etikett={t("Nya konton")}
          nu={k.nya.nu}
          forra={k.nya.forra}
          forklaring={t("{antal} konton totalt", { antal: k.totalt })}
        />
        <Nyckeltal
          varde={k.aktiva.nu}
          etikett={t("Aktiva konton")}
          nu={k.aktiva.nu}
          forra={k.aktiva.forra}
          forklaring={t("Har filmat något eller varit inloggade under perioden")}
        />
        <Nyckeltal
          varde={pct(k.nyaMedAnnons, k.nya.nu)}
          etikett={t("Nya som blev säljare")}
          forklaring={t("{med} av {alla} nya har lagt upp en annons, {borjat} har börjat", {
            med: k.nyaMedAnnons,
            alla: k.nya.nu,
            borjat: k.nyaBorjade,
          })}
        />
        <Nyckeltal
          varde={k.medianDygnTillForstaAnnons === null ? "—" : dygnText(k.medianDygnTillForstaAnnons)}
          etikett={t("Från konto till första annons")}
          forklaring={t("Mediantid. {flera} av {saljare} säljare har lagt upp mer än en annons", {
            flera: k.saljareFlera,
            saljare: k.saljare,
          })}
        />
      </div>

      <PerVecka ov={ov} />

      <div className="trafik-toplista">
        <h4>{t("De senaste nya kontona")}</h4>
        <p className="trafik-text trafik-dampad">
          {t("Den som registrerat sig men inte börjat är den lättaste att hjälpa vidare. Tryck för att öppna kontot.")}
        </p>
        {ov.nyaKontonLista.length === 0 ? (
          <p className="trafik-text trafik-dampad">{t("Inga nya konton under perioden.")}</p>
        ) : (
          <ul className="trafik-konton">
            {ov.nyaKontonLista.map((r) => (
              <li key={r.id}>
                <button type="button" className="trafik-konto" onClick={() => onOpenUserId?.(r.id)} disabled={!onOpenUserId}>
                  <span className="trafik-konto-topp">
                    <strong>{r.namn}</strong>
                    <span className="trafik-dampad">{datum(r.registrerad)}</span>
                    <span className={`rapport-status rapport-status-${r.status}`}>{t(STATUS_TEXT[r.status])}</span>
                  </span>
                  <span className="trafik-konto-rad">
                    <span className="trafik-etikett">{t("Kom från")}</span>
                    <span className={r.kanal ? undefined : "trafik-dampad"}>{r.kanal ?? t("Okänt")}</span>
                    {r.telefon && <span className="trafik-dampad">· {r.telefon}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/**
 * Nya konton per vecka, tolv veckor bakåt.
 *
 * En serie och därför ingen teckenförklaring — rubriken säger vad staplarna är. Nya annonser står i
 * raden ovanför när man pekar, inte som en andra serie: de två talen har olika skala och hade blivit
 * oläsliga på samma axel.
 */
function PerVecka({ ov }: { ov: Oversikt }) {
  const t = useT();
  const [aktiv, setAktiv] = useState<number | null>(null);
  const veckor = ov.perVecka;
  const max = Math.max(1, ...veckor.map((v) => v.nyaKonton));
  const vald = aktiv !== null ? veckor[aktiv] : null;
  return (
    <div className="trafik-toplista">
      <h4>{t("Nya konton per vecka")}</h4>
      <p className="trafik-text trafik-dampad" aria-live="polite">
        {vald
          ? t("Veckan från {datum}: {konton} nya konton · {annonser} nya annonser", {
              datum: datum(vald.vecka),
              konton: vald.nyaKonton,
              annonser: vald.nyaAnnonser,
            })
          : t("De senaste tolv veckorna. Peka på en stapel för att se veckan.")}
      </p>
      <div className="trafik-dagar" role="img" aria-label={t("Nya konton per vecka")} onMouseLeave={() => setAktiv(null)}>
        {veckor.map((v, i) => (
          <span key={v.vecka} className={`trafik-dag${aktiv === i ? " aktiv" : ""}`} onMouseEnter={() => setAktiv(i)} onClick={() => setAktiv(i)}>
            {v.nyaKonton > 0 && <span className="rapport-stapel-tal">{v.nyaKonton}</span>}
            <span className="trafik-dag-stapel" style={{ height: v.nyaKonton ? `${Math.max(4, (v.nyaKonton / max) * 100)}%` : 0 }} />
          </span>
        ))}
      </div>
      <div className="trafik-dag-axel">
        <span>{datum(veckor[0].vecka)}</span>
        <span>{t("denna vecka")}</span>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Nordstjärnan
// ---------------------------------------------------------------------------

const MATT_NAMN: Record<Mal["matt"], string> = {
  nyaAnnonser: "Färdiga annonser per vecka",
  nyaSaljare: "Nya säljare per vecka",
  salda: "Sålda möbler per vecka",
};

const MATT_FORKLARING: Record<Mal["matt"], string> = {
  nyaAnnonser: "Möbler som blev en färdig annons. Måttet på att säljflödet fungerar och används.",
  nyaSaljare: "Konton vars första färdiga annons kom den veckan. Måttet på att vi växer.",
  salda: "Betalda köp i Loopas butik. Måttet på att det som läggs upp också säljs.",
};

/**
 * Nordstjärnan: EN siffra per vecka, mot ett mål.
 *
 * Alla andra tal på sidan är underlag. Den här är den som säger om veckan var bra, och den står
 * därför före allt annat och utan periodväljare — en vecka är en vecka, vad periodvalet än säger.
 *
 * MÅLLINJEN RITAS IN I STAPLARNA, inte som en andra serie: målet är ett tröskelvärde, och en linje
 * tvärs över staplarna visar på en gång vilka veckor som nådde den.
 */
function Nordstjarna({ ov }: { ov: Oversikt }) {
  const t = useT();
  const [mal, setMal] = useState<Mal | null>(null);
  const [andrar, setAndrar] = useState(false);
  const [utkast, setUtkast] = useState<{ matt: Mal["matt"]; perVecka: string }>({ matt: "nyaAnnonser", perVecka: "" });
  const [sparar, setSparar] = useState(false);
  const [fel, setFel] = useState<string | null>(null);
  const [aktiv, setAktiv] = useState<number | null>(null);

  useEffect(() => {
    getMal()
      .then(setMal)
      .catch(() => setMal({ matt: "nyaAnnonser", perVecka: null, andradAv: null, andradAt: null }));
  }, []);

  if (!mal) return null;
  const veckor = ov.perVecka.map((v) => ({ vecka: v.vecka, tal: v[mal.matt] }));
  const nu = veckor[veckor.length - 1];
  const forra = veckor[veckor.length - 2];
  const fyraHela = veckor.slice(-5, -1);
  const snitt = fyraHela.length ? fyraHela.reduce((n, v) => n + v.tal, 0) / fyraHela.length : 0;
  const max = Math.max(1, mal.perVecka ?? 0, ...veckor.map((v) => v.tal));
  const nadde = mal.perVecka ? veckor.slice(0, -1).filter((v) => v.tal >= mal.perVecka!).length : 0;
  const vald = aktiv !== null ? veckor[aktiv] : null;

  async function spara() {
    setSparar(true);
    setFel(null);
    try {
      const ny = await sparaMal({ matt: utkast.matt, perVecka: utkast.perVecka.trim() ? Number(utkast.perVecka) : null });
      setMal(ny);
      setAndrar(false);
    } catch (err) {
      setFel(err instanceof Error ? err.message : t("Målet kunde inte sparas."));
    } finally {
      setSparar(false);
    }
  }

  return (
    <section className="rapport-nordstjarna" aria-label={t("Nordstjärna")}>
      <div className="rapport-ns-topp">
        <div>
          <div className="rapport-ns-etikett">★ {t("Nordstjärna")}</div>
          <h3 className="rapport-ns-rubrik">{t(MATT_NAMN[mal.matt])}</h3>
          <p className="rapport-ns-forklaring">{t(MATT_FORKLARING[mal.matt])}</p>
        </div>
        {!andrar && (
          <button
            type="button"
            className="btn btn-small btn-outline"
            onClick={() => {
              setUtkast({ matt: mal.matt, perVecka: mal.perVecka ? String(mal.perVecka) : "" });
              setAndrar(true);
            }}
          >
            {mal.perVecka ? t("Ändra mål") : t("Sätt ett mål")}
          </button>
        )}
      </div>

      {andrar && (
        <div className="rapport-ns-form">
          <label>
            {t("Mått")}
            <select value={utkast.matt} onChange={(e) => setUtkast({ ...utkast, matt: e.target.value as Mal["matt"] })}>
              {(Object.keys(MATT_NAMN) as Mal["matt"][]).map((m) => (
                <option key={m} value={m}>
                  {t(MATT_NAMN[m])}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("Mål per vecka")}
            <input
              type="number"
              min={1}
              inputMode="numeric"
              value={utkast.perVecka}
              onChange={(e) => setUtkast({ ...utkast, perVecka: e.target.value })}
              placeholder={t("t.ex. {antal}", { antal: Math.max(1, Math.ceil(snitt * 1.2)) })}
            />
          </label>
          <div className="rapport-ns-knappar">
            <button type="button" className="btn btn-small btn-primary" onClick={() => void spara()} disabled={sparar}>
              {sparar ? t("Sparar…") : t("Spara")}
            </button>
            <button type="button" className="btn btn-small btn-text" onClick={() => setAndrar(false)}>
              {t("Avbryt")}
            </button>
          </div>
          {fel && <p className="error-text">{fel}</p>}
          <p className="rapport-tal-forklaring">{t("Målet gäller för alla som öppnar panelen. Lämna tomt för att bara visa trenden.")}</p>
        </div>
      )}

      <div className="rapport-ns-tal">
        <div>
          <div className="rapport-ns-varde">{nu.tal}</div>
          <div className="rapport-tal-forklaring">
            {t("hittills denna vecka")}
            {mal.perVecka ? ` · ${t("mål")} ${mal.perVecka}` : ""}
          </div>
          {mal.perVecka && (
            <div className="rapport-ns-progress" aria-hidden>
              <span style={{ width: `${Math.min(100, (nu.tal / mal.perVecka) * 100)}%` }} />
            </div>
          )}
        </div>
        <Nyckeltal varde={forra?.tal ?? "—"} etikett={t("Förra veckan")} nu={forra?.tal ?? 0} forra={veckor[veckor.length - 3]?.tal ?? null} mot={t("veckan innan")} />
        <Nyckeltal
          varde={Math.round(snitt * 10) / 10}
          etikett={t("Snitt, fyra hela veckor")}
          forklaring={mal.perVecka ? t("Målet nåddes {antal} av de senaste 11 veckorna", { antal: nadde }) : undefined}
        />
      </div>

      <p className="trafik-text trafik-dampad" aria-live="polite">
        {vald
          ? t("Veckan från {datum}: {antal}", { datum: datum(vald.vecka), antal: vald.tal })
          : t("De senaste tolv veckorna. Peka på en stapel för att se veckan.")}
      </p>
      <div className="trafik-dagar rapport-ns-staplar" role="img" aria-label={t(MATT_NAMN[mal.matt])} onMouseLeave={() => setAktiv(null)}>
        {mal.perVecka && (
          <span className="rapport-ns-mallinje" style={{ bottom: `${(mal.perVecka / max) * 100}%` }}>
            <span>{t("mål")} {mal.perVecka}</span>
          </span>
        )}
        {veckor.map((v, i) => (
          <span key={v.vecka} className={`trafik-dag${aktiv === i ? " aktiv" : ""}${i === veckor.length - 1 ? " rapport-ns-pagaende" : ""}`} onMouseEnter={() => setAktiv(i)} onClick={() => setAktiv(i)}>
            {v.tal > 0 && <span className="rapport-stapel-tal">{v.tal}</span>}
            <span className="trafik-dag-stapel" style={{ height: v.tal ? `${Math.max(4, (v.tal / max) * 100)}%` : 0 }} />
          </span>
        ))}
      </div>
      <div className="trafik-dag-axel">
        <span>{datum(veckor[0].vecka)}</span>
        <span>{t("denna vecka (pågår)")}</span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 2. Kohorterna
// ---------------------------------------------------------------------------

/**
 * Kohorttabellen: en rad per registreringsvecka.
 *
 * CELLERNA TONAS EFTER ANDELEN, i en enda färg från ljus till mörk — det är en storlek, inte en
 * kategori. Talet står alltid i cellen, så tonen är en genväg för ögat och aldrig det enda som bär
 * beskedet.
 *
 * "PÅGÅR" i stället för en låg siffra när veckan inte haft tiden på sig. En kohort från förra veckan
 * kan inte ha nått "inom 30 dagar", och en tom ruta som ser ut som noll vore fel svar.
 */
function Kohorterna({ ov }: { ov: Oversikt }) {
  const t = useT();
  const rader = [...ov.kohorter].reverse();
  const cell = (antal: number, av: number, klar: boolean) => {
    if (!av) return <td className="rapport-kohort-tom">—</td>;
    if (!klar) return <td className="rapport-kohort-tom">{t("pågår")}</td>;
    const andel = antal / av;
    return (
      <td className="rapport-kohort-cell" style={{ background: `color-mix(in srgb, var(--accent) ${Math.round(andel * 70)}%, transparent)` }}>
        <b>{pct(antal, av)}</b>
        <span>
          {antal} {t("av")} {av}
        </span>
      </td>
    );
  };
  return (
    <>
      <div className="data-tabell-rull">
        <table className="data-tabell rapport-kohort">
          <thead>
            <tr>
              <th>{t("Registrerade veckan")}</th>
              <th>{t("Konton")}</th>
              <th>{t("Annons inom 1 dag")}</th>
              <th>{t("Inom 7 dagar")}</th>
              <th>{t("Inom 30 dagar")}</th>
              <th>{t("Fler än en annons")}</th>
            </tr>
          </thead>
          <tbody>
            {rader.map((r) => (
              <tr key={r.vecka}>
                <td>{datum(r.vecka)}</td>
                <td>{r.konton}</td>
                {cell(r.inom1, r.konton, true)}
                {cell(r.inom7, r.konton, r.klar7)}
                {cell(r.inom30, r.konton, r.klar30)}
                {cell(r.flera, r.konton, true)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="trafik-text trafik-dampad">
        {t("Läs nedåt i en kolumn: blir andelen större vecka för vecka blir Loopa bättre på att göra nya konton till säljare.")}
        {ov.kohorterUtanDatum > 0 &&
          ` ${t("{antal} konton saknar exakt registreringsdatum och ingår inte.", { antal: ov.kohorterUtanDatum })}`}
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// 3. Grupperna
// ---------------------------------------------------------------------------

/**
 * Ordningen är ordningen man jobbar i: de som är lättast att hjälpa vidare först. Den som filmat men
 * aldrig fick en annons har redan visat att de vill — något i flödet stoppade dem.
 */
const GRUPP_INFO: Array<{ nyckel: GruppNyckel; namn: string; text: string }> = [
  { nyckel: "fastnade", namn: "Började men lade aldrig upp", text: "Har filmat men aldrig fått en färdig annons. Lättast att hjälpa vidare." },
  { nyckel: "nya", namn: "Nya, inte börjat än", text: "Registrerade de senaste 14 dagarna men har inte filmat något." },
  { nyckel: "sovande", namn: "Sovande säljare", text: "Har lagt upp annonser men inte gjort något på 30 dagar." },
  { nyckel: "aktiva", namn: "Aktiva säljare", text: "Har lagt upp annons och varit aktiva de senaste 30 dagarna." },
  { nyckel: "aldrig", namn: "Aldrig börjat", text: "Registrerade för mer än 14 dagar sedan och har aldrig filmat." },
];

function Grupperna({
  ov,
  onSkickaTill,
  onOpenUserId,
}: {
  ov: Oversikt;
  onSkickaTill?: (forval: UtskickForval) => void;
  onOpenUserId?: (id: string) => void;
}) {
  const t = useT();
  const [vald, setVald] = useState<GruppNyckel>("fastnade");
  const [antal, setAntal] = useState(15);
  const totalt = Math.max(1, ov.grupper.reduce((n, g) => n + g.antal, 0));
  const grupp = ov.grupper.find((g) => g.nyckel === vald);
  const info = GRUPP_INFO.find((g) => g.nyckel === vald)!;
  const epost = (grupp?.medlemmar ?? []).map((m) => m.epost).filter((e): e is string => !!e);

  return (
    <>
      <div className="rapport-grupper" role="tablist" aria-label={t("Grupper")}>
        {GRUPP_INFO.map((g) => {
          const n = ov.grupper.find((x) => x.nyckel === g.nyckel)?.antal ?? 0;
          return (
            <button
              key={g.nyckel}
              type="button"
              role="tab"
              aria-selected={vald === g.nyckel}
              className={`rapport-grupp${vald === g.nyckel ? " vald" : ""}`}
              onClick={() => {
                setVald(g.nyckel);
                setAntal(15);
              }}
            >
              <span className="rapport-grupp-tal">{n}</span>
              <span className="rapport-grupp-namn">{t(g.namn)}</span>
              <span className="rapport-grupp-andel">{pct(n, totalt)} {t("av kontona")}</span>
            </button>
          );
        })}
      </div>

      <div className="rapport-grupp-lista">
        <div className="rapport-grupp-huvud">
          <div>
            <h4>{t(info.namn)}</h4>
            <p className="trafik-text trafik-dampad">{t(info.text)}</p>
          </div>
          {onSkickaTill && epost.length > 0 && (
            <button
              type="button"
              className="btn btn-small btn-primary"
              onClick={() => onSkickaTill({ namn: t(info.namn), epost })}
            >
              {t("Skicka utskick till {antal}", { antal: epost.length })}
            </button>
          )}
        </div>
        {!grupp || grupp.medlemmar.length === 0 ? (
          <p className="trafik-text trafik-dampad">{t("Ingen i den här gruppen just nu.")}</p>
        ) : (
          <ul className="trafik-konton">
            {grupp.medlemmar.slice(0, antal).map((m) => (
              <li key={m.id}>
                <button type="button" className="trafik-konto" onClick={() => onOpenUserId?.(m.id)} disabled={!onOpenUserId}>
                  <span className="trafik-konto-topp">
                    <strong>{m.namn}</strong>
                    {m.annonser > 0 && <span className="trafik-dampad">{m.annonser} {m.annonser === 1 ? t("annons") : t("annonser")}</span>}
                  </span>
                  <span className="trafik-konto-rad">
                    <span className="trafik-etikett">{t("Kontakt")}</span>
                    <span>{[m.epost, m.telefon].filter(Boolean).join(" · ") || "—"}</span>
                  </span>
                  <span className="trafik-konto-rad">
                    <span className="trafik-etikett">{vald === "fastnade" ? t("Stannade vid") : t("Senast aktiv")}</span>
                    <span>
                      {vald === "fastnade" && m.stannadeVid
                        ? `${stegPlats(m.stannadeVid)}${m.senast ? ` · ${datum(m.senast)}` : ""}`
                        : m.senast
                          ? datum(m.senast)
                          : m.registrerad
                            ? `${t("registrerad")} ${datum(m.registrerad)}`
                            : "—"}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {grupp && grupp.medlemmar.length > antal && (
          <button type="button" className="btn btn-text" onClick={() => setAntal((n) => n + 30)}>
            {t("Visa fler ({antal} kvar)", { antal: grupp.medlemmar.length - antal })}
          </button>
        )}
        {grupp && grupp.antal > grupp.medlemmar.length && (
          <p className="trafik-text trafik-dampad">{t("Visar de {antal} senast aktiva.", { antal: grupp.medlemmar.length })}</p>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 4. Kanalerna
// ---------------------------------------------------------------------------

function Kanalerna({ ov, onVisaTrafik }: { ov: Oversikt; onVisaTrafik?: () => void }) {
  const t = useT();
  const okand = ov.kanaler.find((k) => k.kanal === "Okänd")?.nyaKonton ?? 0;
  const inb = ov.inbjudningar;
  return (
    <>
      <TopLista
        titel={t("Nya konton per kanal")}
        hjalp={t("Kanalen är var personen kom ifrån första gången vi såg dem. Siffran till höger: hur många av dem som lagt upp en annons.")}
        rader={ov.kanaler.map((k) => ({ namn: k.kanal, antal: k.nyaKonton, notis: `${k.medAnnons} ${t("säljare")}` }))}
      />
      {okand > 0 && (
        <p className="trafik-text trafik-dampad">
          {t("Okänd = registrerade sig innan besöksmätningen startade, eller på en annan enhet än den de först besökte oss på.")}
        </p>
      )}

      <div className="trafik-toplista">
        <h4>{t("Inbjudningar")}</h4>
        <div className="rapport-tal-rad">
          <Nyckeltal
            varde={inb.lankarDelade.nu}
            etikett={t("Inbjudningslänkar delade")}
            nu={inb.lankarDelade.nu}
            forra={inb.lankarDelade.forra}
            forklaring={t("Gånger någon kopierade sin länk")}
          />
          <Nyckeltal
            varde={inb.registrerade.nu}
            etikett={t("Registrerade via inbjudan")}
            nu={inb.registrerade.nu}
            forra={inb.registrerade.forra}
          />
          <Nyckeltal varde={inb.gavAnnons} etikett={t("Inbjudna som lade upp annons")} forklaring={t("Det som ger inbjudaren sin belöning")} />
        </div>
      </div>

      {onVisaTrafik && (
        <button type="button" className="btn btn-text rapport-lank" onClick={onVisaTrafik}>
          {t("Se besök, källor och kampanjer i Trafik →")}
        </button>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 5. Flödet
// ---------------------------------------------------------------------------

function Flodet({
  data,
  namnFor,
  onOpenUserId,
}: {
  data: DataSvar;
  namnFor: (uid: string | null) => string | null;
  onOpenUserId?: (id: string) => void;
}) {
  const t = useT();
  const steg = data.tratt.filter((s) => s.naddeHit > 0);
  if (!steg.length) {
    return <p className="admin-note">{t("Flödesmätningen har inga rader än. Den fylls från nästa säljare som öppnar startsidan.")}</p>;
  }
  const vagg = [...steg].filter((s) => s.stannade > 0).sort((a, b) => b.stannade - a.stannade)[0];
  // De som gått att identifiera, nyast först: en rad med ett namn går att höra av sig till.
  const foljUpp = data.avhopp.filter((a) => a.paborjad && a.uid).slice(0, 6);

  return (
    <>
      <Tratt
        steg={steg.map((s) => ({
          namn: stegNamn(s.steg),
          antal: s.naddeHit,
          hjalp: s.stannade > 0 ? t("{antal} gav upp här", { antal: s.stannade }) + (s.medianMs !== null ? ` · ${t("tar")} ${kortTid(s.medianMs)}` : "") : s.medianMs !== null ? `${t("tar")} ${kortTid(s.medianMs)}` : undefined,
        }))}
      />
      {vagg && (
        <p className="trafik-text">
          {t("Flest ger upp vid")} <b>{stegPlats(vagg.steg)}</b>
          {vagg.medianMs !== null && (
            <>
              {" "}— {t("steget tar i mitten")} {kortTid(vagg.medianMs)}
            </>
          )}
          .
        </p>
      )}

      {foljUpp.length > 0 && (
        <div className="trafik-toplista">
          <h4>{t("Följ upp: gav upp mitt i en annons")}</h4>
          <p className="trafik-text trafik-dampad">{t("Inloggade säljare som började men inte kom fram till en färdig annons.")}</p>
          <ul className="trafik-konton">
            {foljUpp.map((a) => (
              <li key={a.sess}>
                <button type="button" className="trafik-konto" onClick={() => a.uid && onOpenUserId?.(a.uid)} disabled={!onOpenUserId}>
                  <span className="trafik-konto-topp">
                    <strong>{namnFor(a.uid)}</strong>
                    <span className="trafik-dampad">{datum(a.slut)}</span>
                  </span>
                  <span className="trafik-konto-rad">
                    <span className="trafik-etikett">{t("Stannade vid")}</span>
                    <span>
                      {a.sistaSteg ? stegPlats(a.sistaSteg) : "—"}
                      {a.enhet ? ` · ${a.enhet}` : ""}
                      {a.antalFragor > 0 ? ` · ${t("ställde {antal} frågor", { antal: a.antalFragor })}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Hopfallt titel={t("Alla avbrutna annonser")}>
        <Avhoppen data={data} namnFor={namnFor} />
      </Hopfallt>
      <Hopfallt titel={t("Per säljare")}>
        <Saljarna saljare={data.saljare} namnFor={namnFor} />
      </Hopfallt>
    </>
  );
}

// ---------------------------------------------------------------------------
// 6. Affären
// ---------------------------------------------------------------------------

function Affaren({ ov, data }: { ov: Oversikt; data: DataSvar }) {
  const t = useT();
  const a = ov.affar;
  const andelar = data.objekt.map((o) => o.pris.andelAvForslag).filter((n): n is number => n !== null).sort((x, y) => x - y);
  const andelMedian = andelar.length ? andelar[Math.floor(andelar.length / 2)] : null;
  return (
    <div className="rapport-tal-rad">
      <Nyckeltal varde={a.nyaAnnonser.nu} etikett={t("Nya annonser")} nu={a.nyaAnnonser.nu} forra={a.nyaAnnonser.forra} forklaring={t("Möbler som blev färdiga annonser")} />
      <Nyckeltal varde={a.uteNu} etikett={t("Ute till salu nu")} forklaring={t("Ligger i butiken just nu, inklusive reserverade")} />
      <Nyckeltal varde={a.kop.nu} etikett={t("Köp i butiken")} nu={a.kop.nu} forra={a.kop.forra} forklaring={t("Betalda köp. Försäljningar på Tradera räknas inte här")} />
      <Nyckeltal varde={formatSek(a.varde.nu)} etikett={t("Försäljningsvärde")} nu={a.varde.nu} forra={a.varde.forra} forklaring={t("Summan av köpen, utan frakt")} />
      <Nyckeltal
        varde={data.summering.medianDagarTillSald === null ? "—" : dygnText(data.summering.medianDagarTillSald)}
        etikett={t("Från annons till såld")}
        forklaring={t("Mediantid, {antal} sålda möbler totalt", { antal: data.summering.salda })}
      />
      <Nyckeltal
        varde={andelMedian === null ? "—" : `${andelMedian} %`}
        etikett={t("Sålt pris av AI:ns förslag")}
        forklaring={andelMedian === null ? t("Ingen möbel med både förslag och slutpris än") : t("Median över {antal} sålda möbler", { antal: andelar.length })}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 7. AI:n
// ---------------------------------------------------------------------------

/**
 * AI:ns träffsäkerhet, i meningar och inte i sex lösa tal.
 *
 * NÄMNAREN STÅR UTSKRIVEN. "0 %" på ett enda besvarat fynd och "0 %" på tvåhundra är två helt olika
 * besked. Nämnaren är BESVARADE skador — en skada ingen tittat på säger ingenting om modellen.
 */
function AiKvalitet({ data }: { data: DataSvar }) {
  const t = useT();
  const s = data.summering;
  const besvarade = s.bekraftadeFynd + s.avvisadeFynd;
  const rader: Array<{ rubrik: string; varde: string; text: string }> = [
    {
      rubrik: t("Skador"),
      varde: s.traffsakerhet !== null ? `${s.traffsakerhet} %` : "—",
      text: besvarade
        ? t("Säljarna höll med om {stammer} av {besvarade} skador AI:n hittade.", { stammer: s.bekraftadeFynd, besvarade })
        : t("Ingen säljare har svarat på en skada än."),
    },
    {
      rubrik: t("Missade"),
      varde: String(s.egnaFynd),
      text: t("Skador säljarna själva fick lägga till för att AI:n inte såg dem."),
    },
    {
      rubrik: t("Modell"),
      varde: pct(s.antal - s.identitetRattade, s.antal),
      text: t("Rätt märke och modell direkt. Fel på {fel} av {antal} möbler.", { fel: s.identitetRattade, antal: s.antal }),
    },
    {
      rubrik: t("Skick"),
      varde: pct(s.antal - s.betygRattade, s.antal),
      text: t("Säljaren behöll AI:ns skicksbetyg. Ändrat på {antal}.", { antal: s.betygRattade }),
    },
    {
      rubrik: t("Pris"),
      varde: pct(s.antal - s.prisRattade, s.antal),
      text: t("Säljaren behöll AI:ns prisförslag. Ändrat på {antal}.", { antal: s.prisRattade }),
    },
  ];
  return (
    <ul className="rapport-ai">
      {rader.map((r) => (
        <li key={r.rubrik}>
          <span className="rapport-ai-rubrik">{r.rubrik}</span>
          <span className="rapport-ai-varde">{r.varde}</span>
          <span className="rapport-ai-text">{r.text}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Möbellistan
// ---------------------------------------------------------------------------

/**
 * Varje möbel som en rad i klartext.
 *
 * Förkortningarna är borta: "3✓ 1✗ 2+" hette "fynd bekräftade, avvisade, egna" och gick bara att läsa
 * för den som skrivit den. Raden säger nu med ord vad som hände.
 */
function Mobellistan({ data, onOppna, onLadda }: { data: DataSvar; onOppna: (o: DataObjekt) => void; onLadda: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [baraRattade, setBaraRattade] = useState(false);
  const rader = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.objekt
      .filter((o) => !baraRattade || o.rattelser.length > 0)
      .filter((o) => !q || [o.titel, o.loopaId, o.lage, o.skick.betyg].some((f) => f?.toLowerCase().includes(q)));
  }, [data, query, baraRattade]);

  return (
    <>
      <div className="admin-verktyg">
        <input
          className="admin-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("Sök på titel, Loopa-ID eller läge")}
          aria-label={t("Sök i möblerna")}
        />
        <label className="admin-sok">
          <input type="checkbox" checked={baraRattade} onChange={(e) => setBaraRattade(e.target.checked)} />{" "}
          {t("Bara där säljaren rättade AI:n")}
        </label>
        <a className="btn btn-small btn-outline" href="/api/admin/data?format=csv">
          {t("Ladda ned CSV")}
        </a>
        <button className="btn btn-small btn-outline" onClick={onLadda}>
          {t("Uppdatera")}
        </button>
      </div>
      {rader.length === 0 ? (
        <div className="profile-empty">
          <span className="profile-empty-mark">
            <CardIcon size={22} />
          </span>
          <p className="profile-empty-title">{query || baraRattade ? t("Ingen träff") : t("Ingen data än")}</p>
          <p className="profile-empty-hint">
            {baraRattade ? t("Ingen möbel har rättats än.") : t("Datan fylls i takt med att möbler filmas.")}
          </p>
        </div>
      ) : (
        <ul className="card-list">
          {rader.map((o) => {
            const besvarade = o.skick.bekraftade + o.skick.avvisade;
            return (
              <li key={o.id}>
                <button className="card-row" onClick={() => onOppna(o)}>
                  {o.bildUrl && <img className="admin-thumb" src={o.bildUrl} alt="" />}
                  <span className="card-row-body">
                    <span className="card-row-title">
                      {o.titel}
                      <span className="admin-tag">{o.lage}</span>
                    </span>
                    <span className="card-row-meta">
                      {[
                        o.identitet.identitetRattad ? t("fel modell, rättad") : t("rätt modell"),
                        besvarade
                          ? t("{stammer} av {besvarade} skador stämde", { stammer: o.skick.bekraftade, besvarade })
                          : t("{antal} skador, obesvarade", { antal: o.skick.antalFynd }),
                        o.skick.saljarensEgna ? t("{antal} missade", { antal: o.skick.saljarensEgna }) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <span className="card-row-meta admin-row-sub">
                      {o.pris.slutSek !== null
                        ? `${t("såld för")} ${formatSek(o.pris.slutSek)}`
                        : o.pris.saljarensStartSek !== null
                          ? `${t("ute för")} ${formatSek(o.pris.saljarensStartSek)}`
                          : o.pris.forslagSek !== null
                            ? `${t("AI:ns förslag")} ${formatSek(o.pris.forslagSek)}`
                            : t("inget pris")}
                      {o.flode.tidTillIntygatMs !== null ? ` · ${kortTid(o.flode.tidTillIntygatMs)} ${t("att lägga upp")}` : ""}
                      {o.flode.enhet ? ` · ${o.flode.enhet}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function dygnText(dygn: number): string {
  if (dygn < 1) {
    const timmar = Math.round(dygn * 24);
    return timmar <= 1 ? "< 1 h" : `${timmar} h`;
  }
  return `${Math.round(dygn)} d`;
}

/**
 * Säljarna, en rad var.
 *
 * TRATTEN OVANFÖR OCH DEN HÄR LISTAN SVARAR PÅ OLIKA FRÅGOR. Tratten säger att en tredjedel
 * försvinner på modellvalet — ett tal om en genomsnittssäljare som inte finns. Listan säger att det
 * är fyra personer, att tre av dem gjorde om försöket samma kväll och att en av dem har fem
 * påbörjade annonser och noll publicerade. Det första är en statistik. Det andra går att ringa upp.
 *
 * VANLIGASTE VÄGGEN är kolumnen fliken finns för: samma säljare som fastnar på samma steg tre gånger
 * är inte en slump, och det syns inte i något medelvärde.
 *
 * "PÅSTÅTT" står utskrivet när inget av kontots flöden gick att styrka mot ett jobb. Flödesraderna
 * bär ett konto som webbläsaren påstått (se server/src/data/flode.ts), och en rad som ser ut som ett
 * faktum men är ett påstående är värre än ingen rad alls.
 */
function Saljarna({
  saljare,
  namnFor,
}: {
  saljare: DataSaljare[];
  namnFor: (uid: string | null) => string | null;
}) {
  const t = useT();
  const [alla, setAlla] = useState(false);
  if (!saljare.length) {
    return (
      <section className="data-tratt">
        <h3 className="data-rubrik">{t("Säljarna")}</h3>
        <p className="admin-note">
          {t("Ingen säljare är mätt än. Raden skapas när någon loggar in och börjar lägga upp en möbel.")}
        </p>
      </section>
    );
  }
  const visade = alla ? saljare : saljare.slice(0, 12);
  return (
    <section className="data-tratt">
      <h3 className="data-rubrik">{t("Säljarna")}</h3>
      <div className="data-tabell-rull">
        <table className="data-tabell">
          <thead>
            <tr>
              <th>{t("Säljare")}</th>
              <th>{t("Påbörjade")}</th>
              <th>{t("Intygade")}</th>
              <th>{t("Avbrutna")}</th>
              <th>{t("Vanligaste väggen")}</th>
              <th>{t("Annonser")}</th>
              <th>{t("Sålda")}</th>
              <th>{t("Samtal")}</th>
              <th>{t("Senast")}</th>
            </tr>
          </thead>
          <tbody>
            {visade.map((s) => {
              const vagg = Object.entries(s.perSistaSteg).sort((a, b) => b[1] - a[1])[0];
              return (
                <tr key={s.uid}>
                  <td>
                    {namnFor(s.uid)}
                    {s.floden > 0 && s.styrkta === 0 && (
                      <span className="admin-tag data-tag-svag" title={t("Kontot är påstått av webbläsaren, inte styrkt mot en annons.")}>
                        {t("påstått")}
                      </span>
                    )}
                  </td>
                  <td>{s.paborjade}</td>
                  <td>{s.intygade}</td>
                  <td className={s.avbrutna > 0 ? "data-tal-avhopp" : undefined}>{s.avbrutna}</td>
                  <td>{vagg ? `${stegNamn(vagg[0])} (${vagg[1]})` : "—"}</td>
                  <td>{s.annonser}</td>
                  <td>{s.salda}</td>
                  <td>{s.samtal}</td>
                  <td>{s.senaste ? new Date(s.senaste).toLocaleDateString("sv-SE", { day: "numeric", month: "short" }) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {saljare.length > 12 && (
        <button className="btn btn-text btn-small" onClick={() => setAlla((v) => !v)}>
          {alla ? t("Visa färre") : t("Visa alla {antal}", { antal: saljare.length })}
        </button>
      )}
    </section>
  );
}

/**
 * De avbrutna annonserna, en rad var — vem, när, och i vilket steg de tryckte bort.
 *
 * DET HÄR ÄR DEN ENDA VYN I PRODUKTEN som visar något som inte blev av. Allt annat — annonslistan,
 * ordrarna, butiken — förutsätter att det finns en möbel att visa, och en säljare som släppte taget
 * på filmningen lämnade ingen. Utan listan är de osynliga, och det som är osynligt går inte att
 * åtgärda.
 *
 * BESÖKEN LIGGER UNDER EN KNAPP. Den som öppnade startsidan och stängde den igen har inte avbrutit
 * någonting, och att blanda in dem hade gjort listan till en besöksstatistik där de fyra raderna som
 * betyder något drunknar.
 */
function Avhoppen({ data, namnFor }: { data: DataSvar; namnFor: (uid: string | null) => string | null }) {
  const t = useT();
  const [medBesok, setMedBesok] = useState(false);
  const [alla, setAlla] = useState(false);
  const rader = useMemo(
    () => data.avhopp.filter((a) => medBesok || a.paborjad),
    [data.avhopp, medBesok],
  );
  const visade = alla ? rader : rader.slice(0, 25);
  const paborjade = data.avhopp.filter((a) => a.paborjad).length;

  return (
    <section className="data-tratt">
      <h3 className="data-rubrik">{t("Avbrutna annonser")}</h3>
      <p className="admin-note">
        {t("{antal} påbörjade annonser tog slut utan ett intygat kort. Steget är det de stod i när de försvann.", {
          antal: paborjade,
        })}
      </p>
      {!rader.length ? (
        <p className="admin-note">{t("Inget avhopp är mätt än.")}</p>
      ) : (
        <ul className="data-avhopp">
          {visade.map((a) => (
            <li key={`${a.sess}-${a.slut}`} className={a.paborjad ? "data-avhopp-rad" : "data-avhopp-rad data-avhopp-besok"}>
              <span className="admin-tag data-avhopp-steg">{a.sistaSteg ? stegNamn(a.sistaSteg) : t("okänt steg")}</span>
              <span className="data-avhopp-vem">{namnFor(a.uid) ?? t("utloggad")}</span>
              <span className="data-avhopp-om">
                {new Date(a.slut).toLocaleDateString("sv-SE", { day: "numeric", month: "short" })}
                {" · "}
                {t("{tid} i steget", { tid: a.sistaStegMs !== null ? kortTid(a.sistaStegMs) : "—" })}
                {" · "}
                {t("{tid} totalt", { tid: kortTid(a.totaltMs) })}
                {a.enhet ? ` · ${a.enhet}` : ""}
                {a.antalFragor > 0 ? ` · ${t("{antal} frågor", { antal: a.antalFragor })}` : ""}
                {a.jobId ? ` · ${t("hann bli ett jobb")}` : ""}
              </span>
              {/* Vägen dit står under: samma sista steg kan nås på två vägar, och den ena är en omväg. */}
              <span className="data-avhopp-vag">{a.besokta.map(stegNamn).join(" → ")}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="admin-verktyg">
        <label className="admin-sok">
          <input type="checkbox" checked={medBesok} onChange={(e) => setMedBesok(e.target.checked)} />{" "}
          {t("Visa även besök som aldrig påbörjade en annons")}
        </label>
        {rader.length > 25 && (
          <button className="btn btn-text btn-small" onClick={() => setAlla((v) => !v)}>
            {alla ? t("Visa färre") : t("Visa alla {antal}", { antal: rader.length })}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * Samtalen i "Hur fungerar det?", ord för ord.
 *
 * VARFÖR DE STÅR I KLARTEXT och inte som kategorier. "Process" säger att någon undrade över hur det
 * går till. Meningen säger att hen undrade om hon måste vara hemma när vi hämtar — vilket är en
 * invändning med ett svar, och svaret hör hemma på startsidan och inte i en chatt. Det är också den
 * enda vägen att se när boten svarat fel: den står först i säljflödet och läses annars av ingen.
 *
 * HÄMTAS FÖR SIG. Samtalen har sällan en möbel och hör inte hemma i datasetets tyngsta anrop; de
 * laddas när fliken öppnas och står hopfällda tills någon vill läsa ett.
 */
function Samtalen({ namnFor }: { namnFor: (uid: string | null) => string | null }) {
  const t = useT();
  const [samtal, setSamtal] = useState<Samtal[] | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [alla, setAlla] = useState(false);

  useEffect(() => {
    listSamtal()
      .then((svar) => setSamtal(svar.samtal))
      .catch((err: unknown) => setFel(err instanceof Error ? err.message : "Kunde inte hämta samtalen."));
  }, []);

  if (fel) return <p className="public-card-error">{fel}</p>;
  if (!samtal) return <p className="admin-note">{t("Hämtar samtalen…")}</p>;

  const visade = alla ? samtal : samtal.slice(0, 15);
  const turer = samtal.reduce((n, s) => n + s.turer.length, 0);

  return (
    <section className="data-tratt">
      <h3 className="data-rubrik">{t("Samtalen i \"Hur fungerar det?\"")}</h3>
      {!samtal.length ? (
        <p className="admin-note">
          {t("Inget samtal är sparat än. De fylls på från nästa fråga någon ställer på startsidan.")}
        </p>
      ) : (
        <>
          <p className="admin-note">
            {t("{samtal} samtal, {turer} frågor.", { samtal: samtal.length, turer })}
          </p>
          <ul className="data-samtal">
            {visade.map((s) => (
              <li key={s.id}>
                <details>
                  <summary>
                    <span className="data-samtal-vem">{namnFor(s.uid) ?? t("utloggad")}</span>
                    <span className="data-samtal-om">
                      {new Date(s.start).toLocaleDateString("sv-SE", { day: "numeric", month: "short" })}
                      {" · "}
                      {t("{antal} frågor", { antal: s.turer.length })}
                      {s.turer.some((tu) => tu.fel) ? ` · ${t("boten föll")}` : ""}
                    </span>
                    {/* Första frågan står i sammanfattningen: det är den som säger vad samtalet handlade om. */}
                    <span className="data-samtal-forsta">{s.turer[0]?.fraga}</span>
                  </summary>
                  <div className="data-samtal-turer">
                    {s.turer.map((tu, i) => (
                      <div key={i} className="data-samtal-tur">
                        <p className="data-samtal-fraga">{tu.fraga}</p>
                        <p className={tu.fel ? "data-samtal-svar data-samtal-fel" : "data-samtal-svar"}>
                          {tu.fel ? t("Boten kunde inte svara.") : tu.svar}
                        </p>
                      </div>
                    ))}
                  </div>
                </details>
              </li>
            ))}
          </ul>
          {samtal.length > 15 && (
            <button className="btn btn-text btn-small" onClick={() => setAlla((v) => !v)}>
              {alla ? t("Visa färre") : t("Visa alla {antal}", { antal: samtal.length })}
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** En möbel, hela vägen: identitet, skick, flöde, pris, distribution, affär och leverans. */
function ObjektVy({ objekt: o, onStang }: { objekt: DataObjekt; onStang: () => void }) {
  const t = useT();
  return (
    <div className="admin-flik data-objekt">
      <button className="btn btn-text" onClick={onStang}>
        ← {t("Tillbaka till listan")}
      </button>

      <header className="data-objekt-head">
        {o.bildUrl && <img className="data-objekt-bild" src={o.bildUrl} alt="" />}
        <div>
          <h2>{o.titel}</h2>
          <p className="card-row-meta">
            {o.loopaId} · {o.lage} · {new Date(o.createdAt).toLocaleDateString("sv-SE")}
            {o.flode.enhet ? ` · ${o.flode.enhet}` : ""}
          </p>
        </div>
      </header>

      <Sektion titel={t("Identitet")}>
        <FaltTabell falt={o.identitet.falt} />
        <dl className="data-fakta">
          <Fakta etikett={t("Modellens konfidens")} varde={o.identitet.konfidens} />
          <Fakta etikett={t("Nypris")} varde={o.identitet.nyprisSek !== null ? formatSek(o.identitet.nyprisSek) : null} />
          <Fakta etikett={t("Nyprisets källa")} varde={o.identitet.nyprisKalla} />
          <Fakta etikett={t("AI:ns förstahandsförslag")} varde={o.identitet.aiForstaForslag} />
          <Fakta etikett={t("Säljaren valde")} varde={o.identitet.saljarensVal} />
          <Fakta etikett={t("Omgångar med förslag")} varde={String(o.identitet.kandidatRundor)} />
        </dl>
        {o.identitet.konfidensNotis && <p className="admin-note">{o.identitet.konfidensNotis}</p>}
      </Sektion>

      <Sektion titel={t("Skick")}>
        <dl className="data-fakta">
          <Fakta etikett={t("Slutgiltigt betyg")} varde={o.skick.betyg ? `${o.skick.betyg} — ${o.skick.betygEtikett ?? ""}` : null} />
          <Fakta
            etikett={t("Modellen föreslog")}
            varde={o.skick.modellensBetyg}
            avvikande={o.skick.betygRattat}
          />
          <Fakta etikett={t("Bilder")} varde={String(o.skick.antalBilder)} />
          <Fakta etikett={t("Vinklar som täcktes")} varde={o.skick.taeckta.join(", ") || null} />
          <Fakta etikett={t("Vinklar som saknades")} varde={o.skick.saknade.join(", ") || null} avvikande={o.skick.saknade.length > 0} />
          <Fakta etikett={t("Besiktningens täckning")} varde={o.skick.taeckning} />
          <Fakta etikett={t("Delar modellen inte såg")} varde={o.skick.ejSynligaDelar.join(", ") || null} />
        </dl>
        {o.skick.taeckningNotis && <p className="admin-note">{o.skick.taeckningNotis}</p>}
        {/*
          Vinklarna går bara att räkna när fotoguiden användes: ett filmat varv märker inte sina
          bildrutor med väderstreck (web/src/lib/videoFrames.ts), så för ett varv är täckningen ovan
          svaret i stället.
        */}
        {o.skick.taeckta.length === 0 && (
          <p className="admin-note">
            {t("Möbeln filmades som ett varv. Bildrutor ur film saknar vinkeletikett med flit — täckningen ovan är vad besiktningen själv säger att den såg.")}
          </p>
        )}

        <ul className="data-fynd-lista">
          {o.skick.fynd.map((f) => (
            <FyndRad key={f.id} fynd={f} />
          ))}
          {o.skick.fynd.length === 0 && <li className="admin-note">{t("Inga fynd rapporterades.")}</li>}
        </ul>

        <h4 className="data-underrubrik">{t("Frågorna")}</h4>
        <FaltTabell falt={o.skick.fragor} />
      </Sektion>

      <Sektion titel={t("Flödet")}>
        <dl className="data-fakta">
          <Fakta
            etikett={t("Start till intygat")}
            varde={o.flode.tidTillIntygatMs !== null ? kortTid(o.flode.tidTillIntygatMs) : null}
          />
          <Fakta etikett={t("Sista steget")} varde={o.flode.sistaSteg ? stegNamn(o.flode.sistaSteg) : null} />
          <Fakta etikett={t("Intygat")} varde={o.flode.intygat ? t("ja") : t("nej")} />
          <Fakta etikett={t("Enhet")} varde={[o.flode.enhet, o.flode.plattform, o.flode.vy].filter(Boolean).join(" · ") || null} />
          <Fakta etikett={t('"Berätta" påslaget')} varde={o.flode.berattaPa ? t("ja") : null} />
        </dl>
        {Object.keys(o.flode.perStegMs).length > 0 && (
          <div className="data-steg-tider">
            {Object.entries(o.flode.perStegMs).map(([steg, ms]) => (
              <span key={steg} className="data-steg-chip">
                {stegNamn(steg)} <strong>{kortTid(ms)}</strong>
              </span>
            ))}
          </div>
        )}
        {o.flode.fragor.length > 0 && (
          <>
            <h4 className="data-underrubrik">{t("Frågor till guiden")}</h4>
            <ul className="data-lista">
              {o.flode.fragor.map((f, i) => (
                <li key={i}>
                  {f.kategori} · {f.chatt === "start" ? t("startsidans chatt") : t("annonsens chatt")} ·{" "}
                  {f.steg ? stegNamn(f.steg) : "—"}
                </li>
              ))}
            </ul>
          </>
        )}
        {o.flode.chip.length > 0 && (
          <>
            <h4 className="data-underrubrik">{t("Förslagschip som trycktes")}</h4>
            <div className="data-steg-tider">
              {o.flode.chip.map((c, i) => (
                <span key={i} className="data-steg-chip">
                  {c.text}
                </span>
              ))}
            </div>
          </>
        )}
        {!o.flode.sess && (
          <p className="admin-note">
            {t("Möbeln filmades innan flödesmätningen fanns, så stegen och tiderna saknas för just den här.")}
          </p>
        )}
      </Sektion>

      <Sektion titel={t("Pris")}>
        <dl className="data-fakta">
          <Fakta etikett={t("Modellens förslag")} varde={kr(o.pris.forslagSek)} />
          <Fakta
            etikett={t("Spann")}
            varde={o.pris.lagSek !== null && o.pris.hogSek !== null ? `${kr(o.pris.lagSek)} – ${kr(o.pris.hogSek)}` : null}
          />
          <Fakta etikett={t("Modellens konfidens")} varde={o.pris.konfidens} />
          <Fakta etikett={t("Säljaren valde")} varde={kr(o.pris.saljarensStartSek)} avvikande={o.pris.prisRattat} />
          <Fakta etikett={t("Golv")} varde={kr(o.pris.golvSek)} />
          <Fakta etikett={t("Veckosänkning")} varde={o.pris.veckoSankningPct !== null ? `${o.pris.veckoSankningPct} %` : null} />
          <Fakta etikett={t("Pris nu")} varde={kr(o.pris.nuSek)} />
          <Fakta etikett={t("Slutpris")} varde={kr(o.pris.slutSek)} />
          <Fakta etikett={t("Andel av nypris")} varde={o.pris.andelAvNypris !== null ? `${o.pris.andelAvNypris} %` : null} />
          <Fakta etikett={t("Andel av förslag")} varde={o.pris.andelAvForslag !== null ? `${o.pris.andelAvForslag} %` : null} />
        </dl>
        {o.pris.sankningar.length > 0 && (
          <ul className="data-lista">
            {o.pris.sankningar.map((d, i) => (
              <li key={i}>
                {new Date(d.at).toLocaleDateString("sv-SE")}: {kr(d.fran)} → {kr(d.till)}
              </li>
            ))}
          </ul>
        )}
        {o.pris.motorNotis && <p className="admin-note">{o.pris.motorNotis}</p>}
      </Sektion>

      <Sektion titel={t("Distribution")}>
        <ul className="data-lista">
          {o.distribution.kanaler.map((k) => (
            <li key={k.kanal}>
              <strong>{k.kanal}</strong>
              {k.publiceradAt ? ` · ${new Date(k.publiceradAt).toLocaleDateString("sv-SE")}` : ` · ${t("ej publicerad")}`}
              {k.visningar !== null ? ` · ${k.visningar} ${t("visningar")}` : ""}
              {` · ${k.klick} ${t("klick")}`}
              {k.forfragningar ? ` · ${k.forfragningar} ${t("kassor")}` : ""}
              {k.notis && <span className="data-notis"> {k.notis}</span>}
            </li>
          ))}
          {o.distribution.kanaler.length === 0 && <li className="admin-note">{t("Möbeln publicerades aldrig.")}</li>}
        </ul>
        <dl className="data-fakta">
          <Fakta etikett={t("Sidvisningar")} varde={String(o.distribution.sidvisningar)} />
          <Fakta etikett={t("Unika")} varde={String(o.distribution.unikaVisningar)} />
          <Fakta etikett={t("Visad i listor")} varde={String(o.distribution.listvisningar)} />
          <Fakta etikett={t("Påbörjade köp")} varde={String(o.distribution.kassor)} />
          <Fakta etikett={t("Köp")} varde={String(o.distribution.kop)} />
          <Fakta etikett={t("Klick vidare till Tradera")} varde={String(o.distribution.utgaendeTradera)} />
          <Fakta etikett={t("Bevakningar skapade härifrån")} varde={String(o.distribution.bevakningar)} />
        </dl>
        {Object.keys(o.distribution.perHandelse).length > 0 && (
          <div className="data-steg-tider">
            {Object.entries(o.distribution.perHandelse).map(([namn, antal]) => (
              <span key={namn} className="data-steg-chip">
                {namn} <strong>{antal}</strong>
              </span>
            ))}
          </div>
        )}
      </Sektion>

      <Sektion titel={t("Transaktion")}>
        <dl className="data-fakta">
          <Fakta etikett={t("Dygn till första förfrågan")} varde={tal(o.transaktion.dagarTillForstaForfragan)} />
          <Fakta etikett={t("Dygn till såld")} varde={tal(o.transaktion.dagarTillSald)} />
          <Fakta etikett={t("Kanal")} varde={o.transaktion.kanal} />
          <Fakta etikett={t("Betalsätt")} varde={o.transaktion.betalsatt} />
          <Fakta etikett={t("Meddelanden")} varde={String(o.transaktion.antalMeddelanden)} />
          <Fakta
            etikett={t("Affären föll")}
            varde={o.transaktion.follIgenom ? (o.transaktion.orsak ?? t("ja, orsak saknas")) : null}
            avvikande={o.transaktion.follIgenom}
          />
        </dl>
        {o.transaktion.meddelanden.length > 0 && (
          <ul className="data-lista">
            {o.transaktion.meddelanden.map((m, i) => (
              <li key={i}>
                <span className="admin-tag">{m.kategori}</span> {new Date(m.at).toLocaleDateString("sv-SE")} ·{" "}
                {m.kanal} · {m.utdrag}
              </li>
            ))}
          </ul>
        )}
      </Sektion>

      <Sektion titel={t("Leverans och facit")}>
        <dl className="data-fakta">
          <Fakta etikett={t("Hämtning/leverans bokad")} varde={o.leverans.hamtningsdatum} />
          <Fakta etikett={t("Levererad")} varde={o.leverans.leveransdatum ? new Date(o.leverans.leveransdatum).toLocaleString("sv-SE") : null} />
          <Fakta etikett={t("Zon")} varde={o.leverans.zon} />
          <Fakta etikett={t("Leveranskostnad")} varde={kr(o.leverans.leveranskostnadSek)} />
          <Fakta etikett={t("Retur eller tvist")} varde={o.leverans.tvist === null ? null : o.leverans.tvist ? t("ja") : t("nej")} />
        </dl>
        {/*
          FACIT SAKNAS, och det är den enda raden i vyn som gör resten mindre värd. Ingen kontroll
          utförs vid överlämningen, så det finns ingen oberoende mätning av om besiktningen hade rätt
          — bara säljarens egen bedömning av sin egen möbel. Se LUCKOR i dataset.ts.
        */}
        <h4 className="data-underrubrik">{t("Leveranskontrollen")}</h4>
        <FaltTabell falt={o.leverans.kontroll} />
      </Sektion>

      {o.rattelser.length > 0 && (
        <Sektion titel={t("Alla rättelser")}>
          <ul className="data-lista">
            {o.rattelser.map((r, i) => (
              <li key={i}>
                <span className="admin-tag">{r.omrade}</span> <strong>{r.falt}</strong>{" "}
                <span className="data-ai">{r.aiSa ?? t("(inget)")}</span> →{" "}
                <span className="data-manniska">{r.manniskanSa ?? t("(borttaget)")}</span>
                <span className="data-notis">
                  {" "}
                  {new Date(r.at).toLocaleString("sv-SE")} · {r.kalla}
                  {r.notis ? ` · ${r.notis}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Sektion>
      )}

      <DataChatt id={o.id} />
    </div>
  );
}

function Sektion({ titel, children }: { titel: string; children: React.ReactNode }) {
  return (
    <section className="data-sektion">
      <h3 className="data-rubrik">{titel}</h3>
      {children}
    </section>
  );
}

/**
 * Fältparen, som en tabell med två kolumner.
 *
 * TVÅ KOLUMNER OCH INTE EN. Det är hela vyns regel: AI:ns påstående står kvar även när det är
 * överskrivet, för det är det som gör raden till en etikett. En tom högerkolumn betyder att ingen
 * rört fältet — inte att någon höll med.
 */
function FaltTabell({ falt }: { falt: DataFalt[] }) {
  const t = useT();
  if (!falt.length) return <p className="admin-note">{t("Inga fält.")}</p>;
  return (
    <table className="data-tabell">
      <thead>
        <tr>
          <th>{t("Fält")}</th>
          <th>{t("AI sa")}</th>
          <th>{t("Människan sa")}</th>
          <th>{t("Stöd")}</th>
        </tr>
      </thead>
      <tbody>
        {falt.map((f, i) => (
          <tr key={`${f.falt}-${i}`} className={f.manniskanSa ? "data-rad-rattad" : undefined}>
            <td>{f.falt}</td>
            <td className="data-ai">{f.aiSa ?? "—"}</td>
            <td className="data-manniska">{f.manniskanSa ?? "—"}</td>
            <td className="data-notis">
              {f.konfidens ?? "—"}
              {f.kalla && <div className="data-kalla">{kortKalla(f.kalla)}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FyndRad({ fynd: f }: { fynd: DataFynd }) {
  const t = useT();
  return (
    <li className={`data-fynd${f.saljarenLaTill ? " data-fynd-egen" : ""}`}>
      <div className="data-fynd-topp">
        <strong>
          {f.typ} · {f.del}
          {f.position ? ` / ${f.position}` : ""}
        </strong>
        <span className="admin-tag">{f.allvarlighet}</span>
        <span className="admin-tag">{f.konfidens} %</span>
        <span className="admin-tag">{f.granskning}</span>
        {f.saljarenLaTill ? (
          <span className="admin-tag data-tag-egen">{t("säljarens eget")}</span>
        ) : (
          <span className={`admin-tag ${f.saljarenSa === "stämmer inte" ? "data-tag-rattad" : ""}`}>
            {f.saljarenSa ?? t("obesvarat")}
          </span>
        )}
      </div>
      <p className="data-fynd-text">{f.beskrivning}</p>
      <p className="data-notis">
        {f.bilder.length
          ? `${t("syns i")} ${f.bilder.map((b) => b.viewLabel ?? b.imageId.slice(0, 6)).join(", ")}`
          : t("ingen bild kopplad")}
        {f.granskningSkal ? ` · ${f.granskningSkal}` : ""}
      </p>
      {f.rattelser.map((r, i) => (
        <p key={i} className="data-fynd-rattelse">
          <strong>{r.falt}:</strong> <span className="data-ai">{r.aiSa ?? "—"}</span> →{" "}
          <span className="data-manniska">{r.manniskanSa ?? "—"}</span>
        </p>
      ))}
    </li>
  );
}

/**
 * Chatten över datan.
 *
 * `id` satt = frågan gäller den möbel som står öppen; null = hela lagret. Servern bygger underlaget
 * ur samma data vyn visar, och svaret märks när det inte går att belägga i den — se
 * server/src/data/chat.ts.
 */
function DataChatt({ id }: { id: string | null }) {
  const t = useT();
  const [meddelanden, setMeddelanden] = useState<Array<{ role: "user" | "assistant"; content: string; belagt?: boolean }>>([]);
  const [fraga, setFraga] = useState("");
  const [vantar, setVantar] = useState(false);
  const flodeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    flodeRef.current?.scrollTo({ top: flodeRef.current.scrollHeight, behavior: "smooth" });
  }, [meddelanden, vantar]);

  const forslag = id
    ? ["Vad hade modellen fel om här?", "Varför blev priset som det blev?", "Vad saknas för att kunna säga om betyget stämde?"]
    : ["Hur ofta rättar säljare betyget?", "Vilket steg tappar vi flest i?", "Sålde de vi sänkte priset på snabbare?", "Vilka fynd missar modellen oftast?"];

  async function skicka(text: string) {
    const q = text.trim();
    if (!q || vantar) return;
    setFraga("");
    setVantar(true);
    const historik = meddelanden.map((m) => ({ role: m.role, content: m.content }));
    setMeddelanden((m) => [...m, { role: "user", content: q }]);
    try {
      const svar = await fragaData(q, id, historik);
      setMeddelanden((m) => [...m, { role: "assistant", content: svar.answer, belagt: svar.belagt }]);
    } catch (err) {
      setMeddelanden((m) => [
        ...m,
        { role: "assistant", content: err instanceof Error ? err.message : t("Kunde inte svara just nu."), belagt: false },
      ]);
    } finally {
      setVantar(false);
    }
  }

  return (
    <section className="data-chatt">
      <h3 className="data-rubrik">
        <SparkIcon size={16} /> {id ? t("Fråga om den här möbeln") : t("Fråga om datan")}
      </h3>
      {meddelanden.length === 0 ? (
        <p className="card-chat-intro">
          {t("Svaren räknas ur samma data som står ovanför. Boten säger till när något inte går att läsa ur den.")}
        </p>
      ) : (
        <div className="card-chat-stream" ref={flodeRef} role="log" aria-live="polite">
          {meddelanden.map((m, i) => (
            <div key={i} className={`card-chat-turn card-chat-turn-${m.role}`}>
              <div className="card-chat-bubble">{m.content}</div>
              {m.role === "assistant" && m.belagt === false && (
                <p className="card-chat-note">{t("Inte belagt i datan — läs svaret som ett resonemang.")}</p>
              )}
            </div>
          ))}
          {vantar && (
            <div className="card-chat-turn card-chat-turn-assistant">
              <div className="card-chat-bubble card-chat-typing" aria-label={t("Skriver svar")}>
                <span />
                <span />
                <span />
              </div>
            </div>
          )}
        </div>
      )}

      {meddelanden.length === 0 && (
        <div className="card-chat-suggestions">
          {forslag.map((f) => (
            <button key={f} type="button" className="card-chat-suggestion" disabled={vantar} onClick={() => void skicka(f)}>
              {f}
            </button>
          ))}
        </div>
      )}

      <form
        className="card-chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          void skicka(fraga);
        }}
      >
        <input
          value={fraga}
          onChange={(e) => setFraga(e.target.value)}
          placeholder={t("Ställ en fråga om datan")}
          aria-label={t("Fråga om datan")}
        />
        <button type="submit" disabled={vantar || !fraga.trim()} aria-label={t("Skicka")}>
          <SendIcon size={16} />
        </button>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Småting
// ---------------------------------------------------------------------------

function Fakta({ etikett, varde, avvikande }: { etikett: string; varde: string | null; avvikande?: boolean }) {
  return (
    <div className={`data-fakta-par${avvikande ? " data-fakta-avvikande" : ""}`}>
      <dt>{etikett}</dt>
      <dd>{varde ?? "—"}</dd>
    </div>
  );
}

const kr = (n: number | null) => (n === null ? null : formatSek(n));
const tal = (n: number | null) => (n === null ? null : String(n));

/** Millisekunder som något en människa läser: "42 s", "3 min", "1 h 12 min". */
function kortTid(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Stegens namn i appen är engelska (de kommer ur `Screen`). Panelen läses på svenska. */
const STEG_NAMN: Record<string, string> = {
  home: "Öppnade startsidan",
  capture: "Började filma",
  signup: "Skapade konto",
  starting: "Laddade upp filmen",
  identify: "Valde modell",
  specs: "Fyllde i detaljer",
  price: "Satte pris",
  analysis: "Besiktningen",
  result: "Såg skickrapporten",
  listing: "Färdig annons",
};

/**
 * Steget som en PLATS, för meningar som "flest ger upp vid modellvalet". Stegnamnen ovan är vad
 * säljaren gjorde ("Valde modell") och läses fel mitt i en mening.
 */
const STEG_PLATS: Record<string, string> = {
  home: "startsidan",
  capture: "filmningen",
  signup: "kontoskapandet",
  starting: "uppladdningen",
  identify: "modellvalet",
  specs: "detaljerna",
  price: "prissättningen",
  analysis: "besiktningen",
  result: "skickrapporten",
  listing: "den färdiga annonsen",
};

function stegPlats(steg: string): string {
  return STEG_PLATS[steg] ?? steg;
}

function stegNamn(steg: string): string {
  return STEG_NAMN[steg] ?? steg;
}

/** En adress som värdnamn. Hela URL:er sprängde kolumnen. */
function kortKalla(kalla: string): string {
  if (!/^https?:\/\//.test(kalla)) return kalla;
  try {
    return new URL(kalla).hostname.replace(/^www\./, "");
  } catch {
    return kalla;
  }
}
