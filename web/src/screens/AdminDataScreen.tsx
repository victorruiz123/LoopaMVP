import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fragaData, listData, listSamtal, listUsers } from "../api";
import { CardIcon, SendIcon, SparkIcon } from "../components/icons";
import { formatSek } from "../lib/price";
import { useT } from "../lib/i18n";
import type { DataFalt, DataFynd, DataObjekt, DataSaljare, DataSvar, Samtal } from "../types";

/**
 * Datafliken: allt vi vet om varje möbel, med AI:ns ord skilda från människans.
 *
 * DEN HÄR VYN HAR EN ENDA REGEL, och den syns i varje rad: det modellen sa står till vänster, det en
 * människa gjorde av det står till höger, och de blandas aldrig. En tabell som visar "värdet" hade
 * varit lättare att läsa och värdelös som underlag — hela poängen är att kunna se VAR modellen hade
 * fel, och en rättelse utan sitt ursprungliga påstående är ingen etikett.
 *
 * TVÅ LÄGEN: listan, och en möbel i taget. Listan svarar på "var är vi svaga" — den går att sortera
 * på rättelser och sålla på det som rättats — och möbelvyn svarar på "vad hände med just den här".
 *
 * CHATTEN ligger under, alltid nåbar. Den ser samma data som vyn och ingenting annat, och säger till
 * när svaret inte går att läsa ur den. Se server/src/data/chat.ts.
 *
 * LUCKORNA STÅR UTSKRIVNA högst upp och det är avsiktligt. Tre av de efterfrågade fälten har ingen
 * källa än, och en tom kolumn som ser ut som en nolla är det värsta en datavy kan innehålla. Se
 * LUCKOR i server/src/data/dataset.ts.
 */
export default function AdminDataScreen() {
  const t = useT();
  const [data, setData] = useState<DataSvar | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [oppen, setOppen] = useState<DataObjekt | null>(null);
  const [query, setQuery] = useState("");
  const [baraRattade, setBaraRattade] = useState(false);
  const [visaLuckor, setVisaLuckor] = useState(false);
  /**
   * Namnen bakom konto-id:na.
   *
   * Mätningen bär bara id:t — den ska inte vara ett personregister, se server/src/data/flode.ts —
   * och en panel full av 36 tecken slumpmässig hexadecimal är oläsbar för en människa. Namnet hämtas
   * därför där det redan finns, ur kontolistan, och bara för den admin som ändå får se den.
   */
  const [namn, setNamn] = useState<Map<string, string>>(new Map());

  const ladda = useCallback(() => {
    listData()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Kunde inte hämta datan."));
  }, []);

  useEffect(ladda, [ladda]);

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

  const rader = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.objekt ?? [])
      .filter((o) => !baraRattade || o.rattelser.length > 0)
      .filter((o) => !q || [o.titel, o.loopaId, o.lage, o.skick.betyg].some((f) => f?.toLowerCase().includes(q)));
  }, [data, query, baraRattade]);

  const s = data?.summering;

  if (oppen) return <ObjektVy objekt={oppen} onStang={() => setOppen(null)} />;

  return (
    <div className="admin-flik">
      <p className="admin-lede">
        {s
          ? `${s.antal} ${t("möbler")} · ${s.rattelser} ${t("rättelser")} på ${s.medRattelse} ${t("av dem")}`
          : t("Hämtar…")}
      </p>

      {error && <p className="public-card-error">{error}</p>}

      {s && (
        <>
          {/*
            Träffsäkerheten står först och störst, för det är den siffra fliken finns för.
            Nämnaren är BESVARADE fynd — ett fynd ingen tittat på säger ingenting om modellen, och att
            räkna det som en träff hade gjort talet bättre ju färre som orkat svara.
          */}
          <section className="profile-stats admin-stats-wide">
            <div className="profile-stat">
              <div className="profile-stat-value">{s.traffsakerhet !== null ? `${s.traffsakerhet} %` : "—"}</div>
              {/*
                NÄMNAREN STÅR UTSKRIVEN. "0 %" på ett enda besvarat fynd och "0 %" på tvåhundra är två
                helt olika besked, och en procentsats utan sitt underlag läses som det senare. Så
                länge få säljare svarar är talet en indikation, inte ett mått — och etiketten säger
                det i stället för att låta siffran låtsas.
              */}
              <div className="profile-stat-label">
                {t("Fynd säljaren höll med om")}
                <br />
                <span className="data-notis">
                  {s.bekraftadeFynd + s.avvisadeFynd} {t("av {antal} besvarade", { antal: s.fynd })}
                </span>
              </div>
            </div>
            <div className="profile-stat">
              <div className="profile-stat-value">{s.fynd}</div>
              <div className="profile-stat-label">{t("Fynd totalt")}</div>
            </div>
            <div className="profile-stat">
              <div className="profile-stat-value">{s.egnaFynd}</div>
              <div className="profile-stat-label">{t("Missade helt")}</div>
            </div>
            <div className="profile-stat">
              <div className="profile-stat-value">{s.identitetRattade}</div>
              <div className="profile-stat-label">{t("Identitet rättad")}</div>
            </div>
            <div className="profile-stat">
              <div className="profile-stat-value">{s.betygRattade}</div>
              <div className="profile-stat-label">{t("Betyg ändrat")}</div>
            </div>
            <div className="profile-stat">
              <div className="profile-stat-value">
                {s.medianTidTillIntygatMs !== null ? kortTid(s.medianTidTillIntygatMs) : "—"}
              </div>
              <div className="profile-stat-label">{t("Median till intygat")}</div>
            </div>
          </section>

          <Tratten data={data} />

          <Saljarna saljare={data.saljare} namnFor={namnFor} />

          <Avhoppen data={data} namnFor={namnFor} />

          <Samtalen namnFor={namnFor} />

          <div className="admin-verktyg">
            <input
              className="admin-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("Sök på titel, Loopa-ID eller läge")}
              aria-label={t("Sök i datan")}
            />
            <label className="admin-sok">
              <input type="checkbox" checked={baraRattade} onChange={(e) => setBaraRattade(e.target.checked)} />{" "}
              {t("Bara rättade")}
            </label>
            <a className="btn btn-small btn-outline" href="/api/admin/data?format=csv">
              {t("CSV")}
            </a>
            <button className="btn btn-small btn-outline" onClick={ladda}>
              {t("Uppdatera")}
            </button>
          </div>

          {/*
            Luckorna. Hopfällda, men aldrig gömda: den som läser en siffra i den här vyn ska kunna se
            vad som INTE ligger bakom den.
          */}
          <section className="data-luckor">
            <button className="data-luckor-knapp" onClick={() => setVisaLuckor((v) => !v)} aria-expanded={visaLuckor}>
              {t("{antal} fält samlas inte in än", { antal: data.luckor.length })} {visaLuckor ? "▴" : "▾"}
            </button>
            {visaLuckor && (
              <ul className="data-luckor-lista">
                {data.luckor.map((l) => (
                  <li key={l.falt}>
                    <strong>{l.falt}</strong>
                    <span>{l.skal}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {data === null && !error ? (
        <div className="profile-loading">
          <div className="spinner" />
        </div>
      ) : rader.length === 0 ? (
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
          {rader.map((o) => (
            <li key={o.id}>
              <button className="card-row" onClick={() => setOppen(o)}>
                {o.bildUrl && <img className="admin-thumb" src={o.bildUrl} alt="" />}
                <span className="card-row-body">
                  <span className="card-row-title">
                    {o.titel}
                    <span className="admin-tag">{o.lage}</span>
                    {o.rattelser.length > 0 && (
                      <span className="admin-tag data-tag-rattad">
                        {o.rattelser.length} {t("rättelser")}
                      </span>
                    )}
                  </span>
                  <span className="card-row-meta">
                    {o.loopaId} · {o.skick.antalFynd} {t("fynd")} ({o.skick.bekraftade}✓ {o.skick.avvisade}✗{" "}
                    {o.skick.saljarensEgna}+) · {t("betyg")} {o.skick.betyg ?? "—"}
                    {o.skick.betygRattat && o.skick.modellensBetyg ? ` (${t("modellen sa")} ${o.skick.modellensBetyg})` : ""}
                  </span>
                  <span className="card-row-meta admin-row-sub">
                    {o.pris.forslagSek !== null ? `${t("förslag")} ${formatSek(o.pris.forslagSek)}` : t("inget pris")}
                    {o.pris.saljarensStartSek !== null ? ` → ${t("valde")} ${formatSek(o.pris.saljarensStartSek)}` : ""}
                    {o.pris.slutSek !== null ? ` → ${t("såld")} ${formatSek(o.pris.slutSek)}` : ""}
                    {o.flode.tidTillIntygatMs !== null ? ` · ${kortTid(o.flode.tidTillIntygatMs)} ${t("i flödet")}` : ""}
                    {o.flode.enhet ? ` · ${o.flode.enhet}` : ""}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <DataChatt id={null} />
    </div>
  );
}

/**
 * Tratten över ALLA flöden, även de som aldrig blev ett jobb.
 *
 * De sista är hela poängen: en session som tog slut på filmningen finns ingen annanstans i produkten
 * — inget jobb skapades, ingen rad någonstans — och det är just de som svarar på om processen är för
 * lång och var.
 */
function Tratten({ data }: { data: DataSvar }) {
  const t = useT();
  const max = Math.max(1, ...data.tratt.map((s) => s.naddeHit));
  const nagot = data.tratt.some((s) => s.naddeHit > 0);
  if (!nagot) {
    return (
      <p className="admin-note">
        {t("Flödesmätningen är påslagen men har inga rader än. Den fylls från nästa säljare som öppnar startsidan.")}
      </p>
    );
  }
  return (
    <section className="data-tratt">
      <h3 className="data-rubrik">{t("Flödet")}</h3>
      {data.tratt
        .filter((s) => s.naddeHit > 0)
        .map((s) => (
          <div className="data-tratt-rad" key={s.steg}>
            <span className="data-tratt-namn">{stegNamn(s.steg)}</span>
            <span className="data-tratt-stapel">
              <span className="data-tratt-fyllning" style={{ width: `${(s.naddeHit / max) * 100}%` }} />
            </span>
            <span className="data-tratt-tal">
              {s.naddeHit}
              {s.stannade > 0 && <em className="data-tratt-avhopp"> −{s.stannade}</em>}
              {s.medianMs !== null && <span className="data-tratt-tid">{kortTid(s.medianMs)}</span>}
            </span>
          </div>
        ))}
      <p className="admin-note">
        {t("{antal} flöden nådde aldrig en uppladdning och finns ingen annanstans i produkten.", {
          antal: data.avhoppUtanJobb,
        })}
      </p>
    </section>
  );
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
  home: "Startsidan",
  capture: "Filmningen",
  signup: "Kontot",
  starting: "Uppladdningen",
  identify: "Modellvalet",
  specs: "Specifikationerna",
  price: "Priset",
  analysis: "Besiktningen",
  result: "Skickrapporten",
  listing: "Kortet",
};

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
