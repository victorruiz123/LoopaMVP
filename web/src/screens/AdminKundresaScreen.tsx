import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { datum, Fraga, Hopfallt, Info, KortSagt, Nyckeltal, Period, pct, sidNamn, STEG_NAMN, Trend } from "./adminRapport";
import { felNamn, punktText } from "./AdminResorScreen";
import { getKampanjer, getKundresa, getKundresaLive, getKundresaTidslinje, listUsers, skapaKampanj, taBortKampanj } from "../api";
import { useT } from "../lib/i18n";
import type { Kampanj, Kampanjer, Kundresa, KundresaKanal, KundresaLive, KundresaFlodesSteg, KundresaIngang, KundresaPunkt, KundresaSession, KundresaSida, KundresaSteg, KundresaTidslinje } from "../types";

/**
 * Kundresan: från första besöket till en såld möbel, och hur folk rör sig på vägen.
 *
 * EN TRATT HELA VÄGEN, i två delar som säger vad de räknar. Trafiken slutade vid "lade upp en
 * annons" och annonslistan började när möbeln låg ute; här står hela vägen under varandra, så att
 * det läcker mest syns med ett ögonkast — och så att varje kanal kan följas till SÅLDA möbler, inte
 * bara till klick. Första delen räknas i besök, andra i annonser: en säljare kan lägga upp flera.
 *
 * SEDAN BETEENDET: vilka vägar som leder till målet och vilka som inte gör det, hur långt ned folk
 * läser, vad de trycker på, och till sist ett besök i taget för den som vill se det med egna ögon.
 *
 * Läses uppifrån och ned som frågor, som Trafik och Data. Svaret står först, i en mening.
 */
export type KundresaVy = "laget" | "oversikt" | "saljflode" | "ingangar" | "varifran" | "lankar" | "saljare";
type Vy = KundresaVy;

/**
 * FYRA UNDERFLIKAR, EN FRÅGA I VARJE. Fliken var en lång sida med fem frågor, köparnas och
 * säljarnas om vartannat, och den som öppnade den fick själv leta reda på svaret. Nu handlar den om
 * säljarna, och varje underflik svarar på en sak: hur går det, var fastnar de, varifrån kommer de,
 * och vilka är de.
 */
const VYER: Array<{ id: Vy; namn: string; fraga: string }> = [
  { id: "laget", namn: "Läget just nu", fraga: "Hur går det — och vad borde vi ändra?" },
  { id: "oversikt", namn: "Översikt", fraga: "Hur många blir säljare — och hur många säljer?" },
  { id: "saljflode", namn: "Säljflödet", fraga: "Var i flödet fastnar de?" },
  { id: "ingangar", namn: "Ingångar", fraga: "Var kommer de in — och hur långt kommer de?" },
  { id: "varifran", namn: "Varifrån", fraga: "Var hittar vi fler säljare?" },
  { id: "lankar", namn: "Kampanjlänkar", fraga: "Hur gör vi varje kanal mätbar?" },
  { id: "saljare", namn: "Säljarna", fraga: "Vilka är de, och var stannade de?" },
];

export default function AdminKundresaScreen({
  onOpenUserId,
  onVisaFlik,
  vy: styrdVy,
  onVisaVy,
}: {
  onOpenUserId?: (id: string) => void;
  /** Till en annan flik i panelen — förslagen leder dit man gör något åt dem. */
  onVisaFlik?: (flik: "annonser" | "uppladdning") => void;
  /**
   * Vyn, när panelen styr den. Då är vyerna panelens egna flikar och den egna raden med underflikar
   * ritas inte — samma vy ska inte gå att välja på två ställen. Utan den styr fliken sig själv, som i
   * förhandsvisningen.
   */
  vy?: Vy;
  onVisaVy?: (vy: Vy) => void;
}) {
  const t = useT();
  const [egenVy, setEgenVy] = useState<Vy>("laget");
  const vy = styrdVy ?? egenVy;
  const setVy = onVisaVy ?? setEgenVy;
  const [dagar, setDagar] = useState(30);
  const [kanal, setKanal] = useState<string | null>(null);
  const [enhet, setEnhet] = useState<string | null>(null);
  const [data, setData] = useState<Kundresa | null>(null);
  const [fel, setFel] = useState<string | null>(null);

  const [hamtad, setHamtad] = useState<Date | null>(null);
  const [omgang, setOmgang] = useState(0);

  useEffect(() => {
    let aktiv = true;
    setFel(null);
    getKundresa(dagar, kanal, enhet)
      .then((d) => {
        if (!aktiv) return;
        setData(d);
        setHamtad(new Date());
      })
      .catch((err: unknown) => aktiv && setFel(err instanceof Error ? err.message : "Kunde inte hämta kundresan."));
    return () => {
      aktiv = false;
    };
  }, [dagar, kanal, enhet, omgang]);

  /**
   * Uppdateras av sig själv varje minut medan fliken syns. Panelen står ofta öppen under en kampanj,
   * och då ska talen följa med utan att någon behöver ladda om. En dold flik frågar inte.
   */
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") setOmgang((n) => n + 1);
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);

  const aktuell = VYER.find((v) => v.id === vy)!;
  return (
    <>
      {!styrdVy && (
      <nav className="resa-vyer" role="tablist" aria-label={t("Kundresan")}>
        {VYER.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={vy === v.id}
            className={`resa-vy${vy === v.id ? " vald" : ""}`}
            onClick={() => setVy(v.id)}
          >
            {t(v.namn)}
          </button>
        ))}
      </nav>
      )}

      {/* Frågan underfliken svarar på, och filtren som styr svaret — på en rad. */}
      <div className="resa-huvud">
        <h3 className="resa-huvud-fraga">{t(aktuell.fraga)}</h3>
        <div className="resa-huvud-filter">
          <label className="resa-val">
            <span>{t("Kanal")}</span>
            <select value={kanal ?? ""} onChange={(e) => setKanal(e.target.value || null)}>
              <option value="">{t("Alla kanaler")}</option>
              {(data?.kanaler ?? []).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label className="resa-val">
            <span>{t("Enhet")}</span>
            <select value={enhet ?? ""} onChange={(e) => setEnhet(e.target.value || null)}>
              <option value="">{t("Mobil och dator")}</option>
              <option value="mobil">{t("Mobil")}</option>
              <option value="dator">{t("Dator")}</option>
            </select>
          </label>
          <Period dagar={dagar} setDagar={setDagar} />
        </div>
      </div>
      {hamtad && (
        <p className="resa-uppdaterad">
          {t("Uppdaterad {tid} · uppdateras varje minut", { tid: hamtad.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" }) })}
          <button type="button" className="btn btn-text btn-inline" onClick={() => setOmgang((n) => n + 1)}>
            {t("Uppdatera nu")}
          </button>
        </p>
      )}

      {fel ? (
        <p className="public-card-error">{fel}</p>
      ) : !data ? (
        <div className="profile-loading">
          <div className="spinner" />
        </div>
      ) : (
        // Gammalt svar står kvar, nedtonat, medan ett nytt filter hämtas: sidan hoppar inte.
        <div className={data.dagar !== dagar || data.kanal !== kanal || data.enhet !== enhet ? "resa-laddar" : undefined}>
          {data.matningSedan && data.matningSedan > data.fran && (
            <p className="admin-note">
              {t("Besöksmätningen startade {datum}, så perioden är kortare än den ser ut. Allt före det är okänt, inte noll.", {
                datum: datum(data.matningSedan),
              })}
            </p>
          )}
          {vy === "laget" ? (
            <Laget data={data} onVisa={setVy} onVisaFlik={onVisaFlik} />
          ) : vy === "oversikt" ? (
            <Oversikten data={data} onVisa={setVy} />
          ) : vy === "saljflode" ? (
            <Saljflodesvyn data={data} />
          ) : vy === "ingangar" ? (
            <Ingangsvyn data={data} />
          ) : vy === "varifran" ? (
            <Varifran data={data} onValjKanal={setKanal} />
          ) : vy === "lankar" ? (
            <Kampanjlankar data={data} />
          ) : (
            <Anvandarna sessioner={data.beteende.sessioner} onOpenUserId={onOpenUserId} />
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Läget just nu
// ---------------------------------------------------------------------------

type Status = "bra" | "varning" | "dalig" | "neutral" | "litet";

const STATUS: Record<Status, { ikon: string; ord: string }> = {
  bra: { ikon: "✓", ord: "Bra" },
  varning: { ikon: "⚠", ord: "Håll koll" },
  dalig: { ikon: "✗", ord: "Behöver åtgärdas" },
  neutral: { ikon: "–", ord: "Ingen jämförelse" },
  litet: { ikon: "–", ord: "För lite underlag" },
};

/** Mot förra perioden: som förra eller bättre är bra, upp till en femtedel sämre är värt att hålla koll på. */
function motForra(nu: number, forra: number | null): Status {
  if (forra === null || forra === 0) return "neutral";
  const kvot = nu / forra;
  return kvot >= 0.95 ? "bra" : kvot >= 0.8 ? "varning" : "dalig";
}

/** Gränser för tal utan förra period. Står i talets ⓘ, så att ingen behöver gissa varför det är rött. */
function motGrans(varde: number, bra: number, varning: number, lagreArBattre = false): Status {
  if (lagreArBattre) return varde <= bra ? "bra" : varde <= varning ? "varning" : "dalig";
  return varde >= bra ? "bra" : varde >= varning ? "varning" : "dalig";
}

interface LagesTal {
  id: string;
  etikett: string;
  varde: ReactNode;
  status: Status;
  jamforelse: string;
  info: string;
  vy: Vy;
}

function svarasteSkarm(steg: KundresaFlodesSteg[]): KundresaFlodesSteg | undefined {
  return steg
    .slice(1, -1)
    .filter((s) => s.nadde >= MINSTA_UNDERLAG && s.lamnade > 0)
    .sort((a, b) => b.lamnade / b.nadde - a.lamnade / a.nadde)[0];
}

/**
 * Läget just nu: sex tal med en status, och det vi borde ändra.
 *
 * FÖRSTA VYN, MED FLIT. Den som öppnar panelen vill veta om det går bra eller dåligt, inte läsa
 * diagram. Varje tal har en status i ord och ikon — aldrig bara en färg — och leder vidare till
 * underfliken där svaret står i detalj. Under talen står förslagen: vad i datan som pekar på ett
 * problem, varför, och vad vi borde ändra — sorterade efter hur många säljare det berör.
 */
function Laget({ data, onVisa, onVisaFlik }: { data: Kundresa; onVisa: (vy: Vy) => void; onVisaFlik?: (flik: "annonser" | "uppladdning") => void }) {
  const t = useT();
  const [besok, borjade, , fardig] = data.besoksdel;
  const flode = data.beteende.saljflode;
  const varst = svarasteSkarm(flode);
  const filmade = flode.find((s) => s.steg === "capture")?.nadde ?? 0;
  const lamnade = flode.find((s) => s.steg === "lamnad")?.nadde ?? 0;
  const rateNu = besok.antal ? fardig.antal / besok.antal : 0;
  const rateForra = besok.forra && fardig.forra !== null ? fardig.forra / besok.forra : null;
  const vantarTimmar = data.ko.aldstaSedan ? (Date.now() - Date.parse(data.ko.aldstaSedan)) / 3_600_000 : 0;
  const okand = data.matning.besok ? data.matning.utanKalla / data.matning.besok : 0;
  const forandring = (nu: number, forra: number | null) =>
    forra === null ? t("Ingen jämförelse — förra perioden mättes inte") : forra === 0 ? t("{n} fler än förra perioden", { n: nu }) : `${nu >= forra ? "↑" : "↓"} ${Math.round(Math.abs((nu - forra) / forra) * 100)} % ${t("mot förra perioden")}`;

  const tal: LagesTal[] = [
    {
      id: "borjade",
      etikett: t("Började sälja"),
      varde: borjade.antal,
      status: besok.antal < MINSTA_UNDERLAG ? "litet" : motForra(borjade.antal, borjade.forra),
      jamforelse: forandring(borjade.antal, borjade.forra),
      info: t("Besök som valde märke och gick in i filmningen. Grönt när det är minst lika många som förra perioden, gult upp till 20 % färre, rött därunder."),
      vy: "oversikt",
    },
    {
      id: "rate",
      etikett: t("Blev en annons"),
      varde: pct(fardig.antal, besok.antal),
      status: besok.antal < MINSTA_UNDERLAG ? "litet" : rateForra === null ? "neutral" : motForra(rateNu, rateForra),
      jamforelse: rateForra === null ? t("Ingen jämförelse — förra perioden mättes inte") : t("{forra} förra perioden", { forra: `${(rateForra * 100).toLocaleString("sv-SE", { maximumFractionDigits: 1 })} %` }),
      info: t("Andelen av periodens besök som slutade i en färdig annons. Jämförs med samma andel förra perioden, med samma gränser som ovan."),
      vy: "oversikt",
    },
    {
      id: "lamnade",
      etikett: t("Lämnade till Loopa"),
      varde: pct(lamnade, filmade),
      // Två av två eller noll av två är tur, inte ett läge — under fem räknas ingen status.
      status: filmade < MINSTA_UNDERLAG ? "litet" : motGrans(lamnade / filmade, 0.4, 0.25),
      jamforelse: t("{a} av {b} som började filma", { a: lamnade, b: filmade }),
      info: t("Av dem som började filma: hur många som tryckte ”Sälj med Loopa” och fick fram sin annons. Grönt från 40 %, gult från 25 %, rött därunder."),
      vy: "saljflode",
    },
    {
      id: "varst",
      etikett: t("Svåraste skärmen"),
      varde: varst ? stegNamn(varst.steg) : "—",
      status: varst ? motGrans(varst.lamnade / varst.nadde, 0.15, 0.25, true) : "neutral",
      jamforelse: varst ? t("{andel} slutar där", { andel: pct(varst.lamnade, varst.nadde) }) : t("För lite underlag"),
      info: t("Skärmen i säljflödet där störst andel slutar. Grönt om under 15 % slutar där, gult upp till 25 %, rött däröver."),
      vy: "saljflode",
    },
    {
      id: "ko",
      etikett: t("Väntar på godkännande"),
      varde: data.ko.vantar,
      status: data.ko.vantar === 0 ? "bra" : motGrans(vantarTimmar, 24, 72, true),
      jamforelse: data.ko.aldstaSedan ? t("Den äldsta har väntat {tid}", { tid: varaktighet(Date.now() - Date.parse(data.ko.aldstaSedan)) }) : t("Kön är tom"),
      info: t("Annonser som säljaren lämnat till oss men som ingen godkänt än. Grönt när den äldsta väntat under ett dygn, gult upp till tre, rött därefter."),
      vy: "oversikt",
    },
    {
      id: "okand",
      etikett: t("Okänd källa"),
      varde: pct(data.matning.utanKalla, data.matning.besok),
      status: data.matning.besok < MINSTA_UNDERLAG ? "litet" : motGrans(okand, 0.3, 0.5, true),
      jamforelse: t("av besöken vet vi inte varifrån de kom"),
      info: t("Besök utan känd källa — de syns som Direkt. Grönt upp till 30 %, gult upp till 50 %, rött däröver. Kampanjlänkar sänker talet."),
      vy: "varifran",
    },
  ];

  return (
    <>
      <JustNuRad onVisa={onVisa} />
      <section className="resa-lage" aria-label={t("Läget just nu")}>
        {tal.map((l) => (
          <button key={l.id} type="button" className={`resa-lage-tal resa-lage-${l.status}`} onClick={() => onVisa(l.vy)}>
            <span className="resa-lage-topp">
              <span className="resa-lage-etikett">
                {l.etikett}
                <Info text={l.info} />
              </span>
              <span className={`resa-lage-status resa-lage-status-${l.status}`}>
                {STATUS[l.status].ikon} {t(STATUS[l.status].ord)}
              </span>
            </span>
            <span className="resa-lage-varde">{l.varde}</span>
            <span className="resa-lage-jamfor">{l.jamforelse}</span>
            <span className="resa-lage-mer">{t("Se mer →")}</span>
          </button>
        ))}
      </section>

      <Fraga
        nr={1}
        titel={t("Det här borde vi ändra")}
        ingress={t("Förslag räknade ur datan för perioden. Brådskande först, sedan de som berör flest — den som redan börjat sälja väger tyngre än en besökare. Varje förslag säger vad som händer, varför, och vad vi kan göra åt det.")}
      >
        <Forslagen data={data} onVisa={onVisa} onVisaFlik={onVisaFlik} />
      </Fraga>
    </>
  );
}

/**
 * Just nu: vilka som är inne, och var. Frågar var tjugonde sekund medan fliken syns.
 *
 * Det enda i panelen som är live på riktigt — allt annat är en period. Den finns för stunderna när
 * något händer: ett inlägg som går ut, en kampanj som startar. Då ska man se folk komma in, och se
 * om de börjar filma.
 */
function JustNuRad({ onVisa }: { onVisa: (vy: Vy) => void }) {
  const t = useT();
  const [live, setLive] = useState<KundresaLive | null>(null);
  const [fel, setFel] = useState(false);
  useEffect(() => {
    let aktiv = true;
    const hamta = () => {
      if (document.visibilityState !== "visible") return;
      getKundresaLive()
        .then((l) => {
          if (!aktiv) return;
          setLive(l);
          setFel(false);
        })
        .catch(() => aktiv && setFel(true));
    };
    hamta();
    const id = window.setInterval(hamta, 20_000);
    return () => {
      aktiv = false;
      window.clearInterval(id);
    };
  }, []);
  if (fel && !live) return <p className="resa-live resa-live-av">{t("Just nu: kunde inte hämtas.")}</p>;
  if (!live) return null;
  return (
    <section className={`resa-live${live.besokare ? "" : " resa-live-tom"}`} aria-label={t("Just nu")} aria-live="polite">
      <span className="resa-live-prick" aria-hidden />
      <span className="resa-live-text">
        <b>{t("Just nu:")}</b>{" "}
        {live.besokare === 0
          ? t("ingen är inne på sajten")
          : live.besokare === 1
            ? t("1 besökare")
            : t("{n} besökare", { n: live.besokare })}
        {live.iSaljflodet > 0 && (
          <>
            {" · "}
            <button type="button" className="btn btn-text btn-inline" onClick={() => onVisa("saljflode")}>
              {t("{n} i säljflödet", { n: live.iSaljflodet })}
            </button>
          </>
        )}
      </span>
      {live.perPlats.length > 0 && (
        <span className="resa-live-platser">
          {live.perPlats.slice(0, 5).map((p) => (
            <span key={p.plats} className="resa-live-plats">
              {sidNamn(p.plats)} <b>{p.antal}</b>
            </span>
          ))}
        </span>
      )}
      <span className="resa-live-tid">
        {t("senaste {m} min", { m: live.minuter })}
        <Info text={t("Besök som gjort något de senaste fem minuterna — bytt sida, filmat, tryckt. Uppdateras var tjugonde sekund medan fliken är öppen. Adminernas egna besök räknas inte.")} />
      </span>
    </section>
  );
}

/** Vad vi kan göra åt ett avhopp, efter orsaken. Konkret nog att börja på i morgon. */
const ATGARD_ORSAK: Record<string, string> = {
  kamera_nekad: "Förklara varför kameran behövs innan webbläsaren frågar, och erbjud uppladdning från galleriet i samma vy.",
  kamera_saknas: "Erbjud uppladdning från galleriet direkt när ingen kamera hittas.",
  kamera_upptagen: "Säg att en annan app använder kameran, och erbjud galleriet som väg runt.",
  kamera_start: "Erbjud uppladdning från galleriet när kameran inte startar.",
  video_for_kort: "Visa en tydlig mätare under inspelningen som säger när varvet är långt nog.",
  uppladdning_tidsgrans: "Komprimera bilderna innan de skickas, och låt uppladdningen fortsätta i stället för att börja om.",
  uppladdning_misslyckad: "Låt uppladdningen återupptas automatiskt, och spara bilderna så att säljaren inte behöver filma igen.",
  modell_hittades_inte: "Gör ”skriv in modellen själv” synligare, och låt säljaren gå vidare utan exakt modell.",
  besiktning_fel: "Gå igenom besiktningsfelen och visa ett tydligt ”försök igen” i stället för att avbryta.",
  publicering_misslyckad: "Gå igenom publiceringsfelen — säljaren var klar och ville sälja.",
  konto_vid_publicering: "Låt säljaren lämna in med bara e-post och sätta lösenord senare — kontot är det sista hindret.",
  granskning_avbruten: "Förenkla granskningen: visa vad säljaren får, när möbeln läggs ut, och en enda knapp.",
};

/** När ingen orsak sticker ut: vad skärmen själv brukar behöva. */
const ATGARD_STEG: Record<string, string> = {
  capture: "Gör filmningen kortare och tydligare — visa ett exempelvarv innan kameran startar.",
  starting: "Visa tydligt hur långt uppladdningen kommit, och att säljaren kan lämna sidan medan den pågår.",
  identify: "Visa färre men säkrare modellförslag, och gör det lätt att skriva in modellen själv.",
  specs: "Ställ färre frågor och fyll i mått från modellen, så att säljaren bara behöver bekräfta.",
  price: "Förvälj ett rekommenderat pris och en sänkning, så att säljaren bara behöver godkänna.",
  analysis: "Visa vad som händer under besiktningen, så att väntan känns kort och begriplig.",
  result: "Låt säljaren godkänna alla skador på en gång, och förklara varför de spelar roll för priset.",
  listing: "Gör ”Sälj med Loopa” synligare direkt på kortet, och påminn via mejl dagen efter den som inte tryckte.",
  salj: "Förenkla sista steget — så få fält och val som möjligt mellan kortet och inlämnad annons.",
};

interface Forslag {
  id: string;
  /** Hur många förslaget berör, och vilka — står på kortet. */
  beror: number;
  vilka: "säljare" | "besök" | "annonser";
  /** Brådskande förslag står först oavsett storlek: något väntar på oss just nu. */
  bradskande?: boolean;
  rubrik: ReactNode;
  varfor: ReactNode;
  forslag: string;
  knappar: Array<{ etikett: string; gor: () => void }>;
}

/**
 * Från insikt till handling: vad datan pekar på, och vad vi borde ändra.
 *
 * REGLER, INTE MAGI. Varje förslag kommer ur en tydlig regel — svåraste skärmen, en kö som växer, en
 * kanal som ger mindre än sin del — och säger i klartext vilket tal det bygger på. Ett förslag vi inte
 * kan förklara är ett förslag ingen ska följa.
 */
function Forslagen({ data, onVisa, onVisaFlik }: { data: Kundresa; onVisa: (vy: Vy) => void; onVisaFlik?: (flik: "annonser" | "uppladdning") => void }) {
  const t = useT();
  const lista: Forslag[] = [];
  const flode = data.beteende.saljflode;

  // De två svåraste skärmarna, om de tappar mer än var tionde.
  flode
    .slice(1, -1)
    .filter((s) => s.nadde >= MINSTA_UNDERLAG && s.lamnade / s.nadde > 0.1)
    .sort((a, b) => b.lamnade / b.nadde - a.lamnade / a.nadde)
    .slice(0, 2)
    .forEach((s) => {
      const orsak = s.fel[0];
      lista.push({
        id: `skarm-${s.steg}`,
        beror: s.lamnade,
        vilka: "säljare",
        rubrik: (
          <>
            {pct(s.lamnade, s.nadde)} {t("slutar på")} <b>{stegNamn(s.steg).toLowerCase()}</b>
          </>
        ),
        varfor: (
          <>
            {t("{a} av {b} som kom dit gick inte vidare.", { a: s.lamnade, b: s.nadde })}
            {orsak && <> {t("Vanligast innan: {orsak} ({n}).", { orsak: orsakNamn(orsak.namn).toLowerCase(), n: orsak.antal })}</>}
          </>
        ),
        forslag: t((orsak && ATGARD_ORSAK[orsak.namn]) || ATGARD_STEG[s.steg] || "Titta på försöken i Uppladdning och se var de fastnar."),
        knappar: [
          ...(onVisaFlik ? [{ etikett: t("Se försöken i Uppladdning"), gor: () => onVisaFlik("uppladdning") }] : []),
          { etikett: t("Se vilka som fastnade"), gor: () => onVisa("saljare") },
        ],
      });
    });

  // Godkännandekön.
  if (data.ko.vantar > 0 && data.ko.aldstaSedan && Date.now() - Date.parse(data.ko.aldstaSedan) > 24 * 3_600_000) {
    lista.push({
      id: "ko",
      beror: data.ko.vantar,
      vilka: "annonser",
      bradskande: Date.now() - Date.parse(data.ko.aldstaSedan) > 72 * 3_600_000,
      rubrik: (
        <>
          <b>{data.ko.vantar}</b> {t("annonser väntar på godkännande")}
        </>
      ),
      varfor: t("Den äldsta har väntat {tid}. Varje dygn i kön är ett dygn möbeln inte kan säljas.", { tid: varaktighet(Date.now() - Date.parse(data.ko.aldstaSedan)) }),
      forslag: t("Godkänn dem som väntar, och sätt ett mål: alla inom ett dygn."),
      knappar: onVisaFlik ? [{ etikett: t("Öppna annonserna"), gor: () => onVisaFlik("annonser") }] : [],
    });
  }

  // De som fastnade och går att nå.
  const fastnade = data.beteende.sessioner.filter((s) => s.borjade && !s.intygat && s.uid);
  if (fastnade.length) {
    lista.push({
      id: "kontakta",
      beror: fastnade.length,
      vilka: "säljare",
      rubrik: (
        <>
          <b>{fastnade.length}</b> {t("fastnade och har ett konto")}
        </>
      ),
      varfor: t("De började sälja men fick aldrig en färdig annons — och vi vet vilka de är."),
      forslag: t("Hör av er och hjälp dem i mål. Ett samtal till den som stannade vid en skärm säger också varför."),
      knappar: [{ etikett: t("Se vilka de är"), gor: () => onVisa("saljare") }],
    });
  }

  // Okänd källa.
  const m = data.matning;
  if (m.besok && m.utanKalla / m.besok > 0.3) {
    lista.push({
      id: "kalla",
      beror: m.utanKalla,
      vilka: "besök",
      rubrik: (
        <>
          {pct(m.utanKalla, m.besok)} {t("av besöken har okänd källa")}
        </>
      ),
      varfor: t("Vi vet inte varifrån {n} besök kom, så vi vet inte vilka kanaler som är värda att satsa på.", { n: m.utanKalla }),
      forslag: t("Använd en kampanjlänk i varje inlägg, annons och tryck — då får Instagram, TikTok och affischer en egen rad."),
      knappar: [{ etikett: t("Skapa en kampanjlänk"), gor: () => onVisa("lankar") }],
    });
  }

  // Ingången som borde få mer trafik: bättre än snittet men liten.
  const { alla, ingangar } = data.beteende;
  const snitt = alla.besok ? (alla.utfall.salja + alla.utfall.annons) / alla.besok : 0;
  const snittBesok = ingangar.length ? ingangar.reduce((n, i) => n + i.besok, 0) / ingangar.length : 0;
  const lovande = ingangar
    .filter((i) => i.besok >= MINSTA_UNDERLAG && i.besok < snittBesok && (i.utfall.salja + i.utfall.annons) / i.besok > snitt * 1.2)
    .sort((a, b) => (b.utfall.salja + b.utfall.annons) / b.besok - (a.utfall.salja + a.utfall.annons) / a.besok)[0];
  if (lovande) {
    const inbjudan = lovande.sida.startsWith("/i/");
    lista.push({
      id: "ingang",
      beror: lovande.besok,
      vilka: "besök",
      rubrik: (
        <>
          <b>{sidNamn(lovande.sida)}</b> {t("ger många säljare men få besök")}
        </>
      ),
      varfor: t("{andel} av besöken därifrån börjar sälja, mot {snitt} i snitt — men bara {n} besök landade där.", {
        andel: pct(lovande.utfall.salja + lovande.utfall.annons, lovande.besok),
        snitt: `${Math.round(snitt * 100)} %`,
        n: lovande.besok,
      }),
      forslag: inbjudan
        ? t("Påminn säljare om sin inbjudningslänk — till exempel i mejlet när annonsen godkänts eller sålts.")
        : t("Låt fler kampanjlänkar och inlägg leda hit."),
      knappar: [{ etikett: t("Se ingångarna"), gor: () => onVisa("ingangar") }],
    });
  }

  // Den stora kanalen som ger mindre än sin del, och den lilla som ger mer.
  const matta = data.perKanal.filter((k) => k.besok >= MINSTA_UNDERLAG && k.kanal !== "Okänd" && k.kanal !== "Direkt");
  const totB = data.perKanal.reduce((n, k) => n + k.besok, 0);
  const totF = data.perKanal.reduce((n, k) => n + k.fardigaBesok, 0);
  const snittKanal = totB ? totF / totB : 0;
  const svag = matta.filter((k) => k.besok / totB >= 0.15 && k.fardigaBesok / k.besok < snittKanal * 0.8).sort((a, b) => b.besok - a.besok)[0];
  if (svag) {
    lista.push({
      id: "kanal-svag",
      beror: svag.besok,
      vilka: "besök",
      rubrik: (
        <>
          <b>{svag.kanal}</b> {t("ger färre säljare än sin trafik")}
        </>
      ),
      varfor: t("{andel} av besöken kommer därifrån, men bara {n} av 100 blir en annons, mot {snitt} i snitt.", {
        andel: pct(svag.besok, totB),
        n: decimal(per100(svag.fardigaBesok, svag.besok)),
        snitt: decimal(snittKanal * 100),
      }),
      forslag: t("Se över vart trafiken därifrån landar — låt länkarna leda till startsidan eller en annan ingång som fungerar."),
      knappar: [{ etikett: t("Se kanalerna"), gor: () => onVisa("varifran") }],
    });
  }
  const stark = matta.filter((k) => k.fardigaBesok / k.besok > snittKanal * 1.3).sort((a, b) => b.fardigaBesok / b.besok - a.fardigaBesok / a.besok)[0];
  if (stark) {
    lista.push({
      id: "kanal-stark",
      beror: stark.fardigaBesok,
      vilka: "säljare",
      rubrik: (
        <>
          <b>{stark.kanal}</b> {t("ger flest säljare per besök")}
        </>
      ),
      varfor: t("{n} av 100 besök därifrån blir en annons, {x}× snittet.", {
        n: decimal(per100(stark.fardigaBesok, stark.besok)),
        x: decimal(stark.fardigaBesok / stark.besok / snittKanal),
      }),
      forslag: t("Lägg mer tid och pengar här. Skapa en kampanjlänk per inlägg, så ser ni vilka som fungerar bäst."),
      knappar: [{ etikett: t("Skapa en kampanjlänk"), gor: () => onVisa("lankar") }],
    });
  }

  // Säljsidan: märkesvalet och "Hur fungerar det?".
  const start = data.beteende.sidor.find((s) => s.sida === "/");
  const marken = start?.sektioner.find((x) => x.namn === "salj_marken");
  if (start && marken && start.besok >= MINSTA_UNDERLAG && marken.sedd / start.besok < 0.8) {
    lista.push({
      id: "marken",
      beror: start.besok - marken.sedd,
      vilka: "besök",
      rubrik: (
        <>
          {pct(start.besok - marken.sedd, start.besok)} {t("ser aldrig märkesvalet")}
        </>
      ),
      varfor: t("Märkesvalet är första steget i säljflödet. Den som inte scrollar dit kan inte börja."),
      forslag: t("Flytta upp märkesvalet, eller lägg en knapp i toppen som tar säljaren dit."),
      knappar: [{ etikett: t("Se säljsidan"), gor: () => onVisa("saljflode") }],
    });
  }
  const hur = start?.sektioner.find((x) => x.namn === "salj_hur");
  if (start && hur && start.besok >= MINSTA_UNDERLAG && hur.klick / start.besok > 0.1) {
    lista.push({
      id: "hur",
      beror: hur.klick,
      vilka: "besök",
      rubrik: (
        <>
          {pct(hur.klick, start.besok)} {t("trycker på ”Hur fungerar det?”")}
        </>
      ),
      varfor: t("Många vill förstå innan de börjar — sidan förklarar inte nog själv."),
      forslag: t("Svara på det direkt på sidan: tre korta steg och vad det kostar, synligt utan att trycka."),
      knappar: [{ etikett: t("Se säljsidan"), gor: () => onVisa("saljflode") }],
    });
  }

  // Brådskande först. Sedan efter hur många det berör — och den som redan börjat sälja väger dubbelt
  // mot en besökare som bara tittade: hen har visat att hen vill, och det är där vi tappar mest.
  const vikt = (f: Forslag) => (f.vilka === "besök" ? f.beror : f.beror * 2);
  const sorterade = lista.sort((a, b) => Number(!!b.bradskande) - Number(!!a.bradskande) || vikt(b) - vikt(a)).slice(0, 6);
  if (!sorterade.length) {
    return <p className="admin-note">{t("Inget sticker ut just nu. Förslagen dyker upp här när datan pekar på något — en svår skärm, en kö som växer, en kanal som ger mindre än sin del.")}</p>;
  }
  return (
    <ol className="resa-forslag">
      {sorterade.map((f, i) => (
        <li key={f.id} className="resa-forslag-kort">
          <span className="resa-forslag-nr" aria-hidden>
            {i + 1}
          </span>
          <div className="resa-forslag-inne">
            <div className="resa-forslag-huvud">
              <h4 className="resa-forslag-rubrik">{f.rubrik}</h4>
              <span className="resa-forslag-beror">
                {f.bradskande && <span className="resa-lacka-etikett">⚠ {t("Brådskande")}</span>}
                {t("Berör {n} {vilka}", { n: f.beror, vilka: t(f.vilka) })}
              </span>
            </div>
            <p className="resa-forslag-varfor">{f.varfor}</p>
            <p className="resa-forslag-gor">
              <span className="resa-forslag-etikett">{t("Förslag")}</span>
              {f.forslag}
            </p>
            {f.knappar.length > 0 && (
              <div className="resa-forslag-knappar">
                {f.knappar.map((k) => (
                  <button key={k.etikett} type="button" className="btn btn-outline btn-small" onClick={k.gor}>
                    {k.etikett} →
                  </button>
                ))}
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Oversikten({ data, onVisa }: { data: Kundresa; onVisa: (vy: Vy) => void }) {
  const t = useT();
  return (
    <>
      {/* Kort sagt och nyckeltalen står i Läget just nu. Här står resan själv, och vad den blev. */}
      <Fraga
        nr={1}
        titel={t("Hela resan, från besök till såld möbel")}
        ingress={t("Läs från vänster till höger. Den orange strömmen är alla som följde med till nästa steg. Vid varje steg rinner en grå ström av nedåt — de som lämnade, lika tjock som antalet. Den röda är där vi tappar störst andel.")}
      >
        <Resan data={data} />
        <SummeringResan data={data} />
      </Fraga>
      <div className="resa-vidare">
        <button type="button" className="btn btn-outline btn-small" onClick={() => onVisa("saljflode")}>
          {t("Se var i säljflödet de fastnar →")}
        </button>
        <button type="button" className="btn btn-outline btn-small" onClick={() => onVisa("saljare")}>
          {t("Se vilka som fastnade →")}
        </button>
      </div>
    </>
  );
}

function Saljflodesvyn({ data }: { data: Kundresa }) {
  const t = useT();
  return (
    <>
      <Fraga
        nr={1}
        titel={t("Skärm för skärm: var slutar de?")}
        ingress={t("En rad per skärm, i flödets ordning. Stapeln är andelen av dem som kom till skärmen som slutade just där — längst stapel är den svåraste skärmen. Till höger står den vanligaste orsaken — ett fel i appen, eller att de stannade vid kontot.")}
      >
        <Saljflodet steg={data.beteende.saljflode} />
        <SummeringFlodet steg={data.beteende.saljflode} />
      </Fraga>
      <Fraga
        nr={2}
        titel={t("Vad ser de på säljsidan?")}
        ingress={t("Hur långt ned besökarna scrollar på startsidan, vilka delar de faktiskt ser, och hur många som trycker där.")}
      >
        <Sidorna sidor={data.beteende.sidor.filter((s) => s.sida === "/")} />
        <SummeringSaljsidan sida={data.beteende.sidor.find((s) => s.sida === "/")} />
      </Fraga>
    </>
  );
}

/**
 * Ingångarna: sidan besöken börjar på, och hur långt de kommer därifrån. Egen underflik — frågan är
 * en annan än säljflödets. Den handlar om vart trafiken ska skickas, inte om var flödet är svårt.
 */
function Ingangsvyn({ data }: { data: Kundresa }) {
  const t = useT();
  return (
    <Fraga
      nr={1}
      titel={t("Vilka ingångar är värda trafik?")}
      ingress={t("En bubbla per sida besökarna börjar på. Längre till höger: fler besök. Högre upp: större andel som börjar sälja. Större bubbla: fler färdiga annonser. De streckade linjerna är snittet, och rutan bubblan hamnar i säger vad som är värt att göra.")}
    >
      <Bubbeldiagram data={data} />
      <p className="trafik-text trafik-dampad">
        {t("Butiken, köpsidan, efterlysningarna och delade annonser står inte med — den som landar där kom för att köpa, inte för att sälja.")}
      </p>
      <Hopfallt titel={t("Visa varje ingång steg för steg — och vart de gick härnäst")}>
        <Ingangarna data={data} />
      </Hopfallt>
      <SummeringIngangar data={data} />
    </Fraga>
  );
}

function Varifran({ data, onValjKanal }: { data: Kundresa; onValjKanal: (k: string | null) => void }) {
  const t = useT();
  return (
    <>
      <Fraga nr={1} titel={t("Hur mycket vet vi om var de kommer ifrån?")} ingress={t("Ett besök utan känd källa går inte att räkna till någon kanal. Ju lägre andel, desto mer går kanalerna nedan att lita på.")}>
        <Matkvalitet data={data} />
        <SummeringMatning data={data} />
      </Fraga>
      <Fraga nr={2} titel={t("Vilken kanal ger flest säljare?")} ingress={t("Överst: varje kanals andel av besöken mot dess andel av annonserna. Ligger annons-punkten till höger om besöks-punkten ger kanalen fler säljare än sin andel av trafiken. Under: alla kanaler i en tabell med samma skala i varje kolumn, så att de går att jämföra uppifrån och ned. Tryck på en rubrik för att sortera, och på en kanal för att se källorna i den.")}>
        <Andelsdiagram data={data} />
        <Kanalerna data={data} onValjKanal={onValjKanal} />
        <SummeringKanaler data={data} />
      </Fraga>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sammanfattat — sist i varje sektion
// ---------------------------------------------------------------------------

interface SumRad {
  varde: ReactNode;
  etikett: string;
  forklaring?: string;
  /** Vad talet betyder och hur det räknas. Visas bakom ⓘ. */
  info?: string;
}

/**
 * Sektionens svar i siffror, sist.
 *
 * Diagrammet ovanför visar HUR det ser ut; den här raden säger vad det blev. Den som bara läser
 * slutet av varje sektion ska ändå veta hur stor andel som konverterar, var det läcker mest och hur
 * lång tid det tar — samma tal varje gång, på samma plats.
 */
function Sammanfattat({ rader }: { rader: Array<SumRad | null> }) {
  const t = useT();
  const synliga = rader.filter((r): r is SumRad => r !== null);
  if (!synliga.length) return null;
  return (
    <section className="resa-summering" aria-label={t("Sammanfattat")}>
      <h4 className="resa-summering-rubrik">{t("Sammanfattat")}</h4>
      <dl className="resa-summering-rad">
        {synliga.map((r) => (
          <div key={r.etikett} className="resa-summering-tal">
            <dd>{r.varde}</dd>
            <dt>
              {r.etikett}
              {r.info && <Info text={r.info} />}
            </dt>
            {r.forklaring && <span>{r.forklaring}</span>}
          </div>
        ))}
      </dl>
    </section>
  );
}

function SummeringResan({ data }: { data: Kundresa }) {
  const t = useT();
  const [besok, , , fardig] = data.besoksdel;
  const [fardiga, , , salda] = data.annonsdel;
  const lacka = storstaLackan(data);
  const per1000 = besok.antal && fardiga.antal ? Math.round((fardig.antal / besok.antal) * (salda.antal / fardiga.antal) * 1000) : null;
  return (
    <Sammanfattat
      rader={[
        { varde: pct(fardig.antal, besok.antal), etikett: t("Blev en annons"), info: t("Andelen av periodens besök som slutade i en färdig annons under samma besök."), forklaring: t("{a} av {b} besök", { a: fardig.antal, b: besok.antal }) },
        { varde: pct(salda.antal, fardiga.antal), etikett: t("Färdig annons → såld"), info: t("Andelen av periodens färdiga annonser som sålts. Räknas på annonser, inte besök — en säljare kan ha flera."), forklaring: t("{a} av {b} annonser", { a: salda.antal, b: fardiga.antal }) },
        per1000 !== null ? { varde: per1000, etikett: t("Sålda möbler per 1 000 besök"), info: t("Hela vägen i ett tal: av tusen besök, hur många som blev en såld möbel. Andelen besök som blev annons gånger andelen annonser som sålts."), forklaring: t("Hela vägen, från första besöket") } : null,
        fardig.medianMs !== null ? { varde: varaktighet(fardig.medianMs), etikett: t("Tid till färdig annons"), info: t("Median från besökets början till den färdiga annonsen, bland dem som kom dit."), forklaring: t("Median, från besökets början") } : null,
        data.ko.medianMs !== null
          ? {
              varde: varaktighet(data.ko.medianMs),
              etikett: t("Tid till godkännande"),
              info: t("Median från att säljaren tryckte ”Sälj med Loopa” till att en admin godkände annonsen, bland annonser godkända i perioden."),
              forklaring: t("vårt eget steg"),
            }
          : null,
        lacka ? { varde: `${Math.round(lacka.andel * 100)} %`, etikett: t("Största läckan"), info: t("Steget i resan där störst andel försvinner. Talet är hur många som gick vidare därifrån."), forklaring: t("gick vidare till {steg}", { steg: t(STEG[lacka.till].namn).toLowerCase() }) } : null,
      ]}
    />
  );
}

function SummeringFlodet({ steg }: { steg: KundresaFlodesSteg[] }) {
  const t = useT();
  if (!steg[0]?.nadde) return null;
  const startade = steg[1]?.nadde ?? 0;
  const klara = steg[steg.length - 1]?.nadde ?? 0;
  const varst = steg
    .slice(1, -1)
    .filter((s) => s.nadde >= MINSTA_UNDERLAG && s.lamnade > 0)
    .sort((a, b) => b.lamnade / b.nadde - a.lamnade / a.nadde)[0];
  const tid = steg.slice(1).reduce((n, s) => n + (s.medianMs ?? 0), 0);
  // Bara riktiga fel — att stanna vid kontot eller ångra sig i granskningen är ett val, inget fel.
  const lamnadeMedFel = steg
    .slice(1)
    .reduce((n, s) => n + Math.min(s.lamnade, s.fel.filter((f) => !(f.namn in ORSAK_NAMN)).reduce((m, f) => m + f.antal, 0)), 0);
  const lamnadeTotalt = steg.slice(1, -1).reduce((n, s) => n + s.lamnade, 0);
  return (
    <Sammanfattat
      rader={[
        { varde: pct(startade, steg[0].nadde), etikett: t("Började sälja"), info: t("Andelen besök på startsidan som valde ett märke och gick in i filmningen."), forklaring: t("av besöken på startsidan") },
        { varde: pct(klara, startade), etikett: t("Började → lämnad till Loopa"), info: t("Av dem som började filma: hur många som till slut tryckte ”Sälj med Loopa” och fick fram sin annons till oss — också om det skedde i ett senare besök."), forklaring: t("{a} av {b}", { a: klara, b: startade }) },
        (() => {
          const kort = steg.find((s) => s.steg === "listing");
          return kort && kort.nadde ? { varde: pct(klara, kort.nadde), etikett: t("Färdigt kort → lämnad"), info: t("Av dem som såg sin färdiga annons: hur många som också lämnade den till Loopa. Visar om sista knappen fungerar."), forklaring: t("av dem som såg sin färdiga annons") } : null;
        })(),
        varst ? { varde: stegNamn(varst.steg), etikett: t("Svåraste skärmen"), info: t("Skärmen i säljflödet där störst andel av dem som kom dit slutade. Skärmar med färre än fem besök räknas inte."), forklaring: t("{andel} slutade där", { andel: pct(varst.lamnade, varst.nadde) }) } : null,
        tid > 0 ? { varde: varaktighet(tid), etikett: t("Tid genom flödet"), info: t("Ungefärlig tid från filmning till färdigt kort: summan av mediantiden på varje skärm. Inte en uppmätt totaltid."), forklaring: t("Summan av mediantiden per skärm") } : null,
        lamnadeTotalt > 0 ? { varde: pct(lamnadeMedFel, lamnadeTotalt), etikett: t("Avhopp efter ett fel"), info: t("Ungefärlig andel av avhoppen i säljflödet där säljaren fick ett fel i appen (kameran, uppladdningen, modellen …) innan de lämnade. Att stanna vid kontot räknas inte som fel."), forklaring: t("Ungefär — resten lämnade utan att något gick fel") } : null,
      ]}
    />
  );
}

function SummeringIngangar({ data }: { data: Kundresa }) {
  const t = useT();
  const { alla, ingangar } = data.beteende;
  if (!alla.besok) return null;
  const salj = (i: KundresaIngang) => (i.utfall.salja + i.utfall.annons) / Math.max(1, i.besok);
  const ordnade = [...ingangar].sort((a, b) => salj(b) - salj(a));
  const bast = ordnade[0];
  const samst = ordnade[ordnade.length - 1];
  return (
    <Sammanfattat
      rader={[
        { varde: pct(alla.besok - alla.utfall.lamnade, alla.besok), etikett: t("Klickade vidare"), info: t("Andelen av besöken på säljsidorna som gick vidare från första sidan i stället för att lämna direkt."), forklaring: t("av alla som landade") },
        { varde: pct(alla.utfall.salja + alla.utfall.annons, alla.besok), etikett: t("Landade → började sälja"), info: t("Av alla som landade på en säljsida: andelen som valde märke och gick in i filmningen.") },
        { varde: pct(alla.utfall.annons, alla.besok), etikett: t("Landade → färdig annons"), info: t("Av alla som landade på en säljsida: andelen som kom hela vägen till en färdig annons.") },
        bast ? { varde: sidNamn(bast.sida), etikett: t("Bästa ingången"), info: t("Sidan besökarna landade på som ger störst andel som börjar sälja. Sidor med färre än fem besök räknas inte."), forklaring: t("{andel} började sälja", { andel: pct(bast.utfall.salja + bast.utfall.annons, bast.besok) }) } : null,
        samst && samst !== bast ? { varde: sidNamn(samst.sida), etikett: t("Sämsta ingången"), info: t("Sidan besökarna landade på som ger minst andel som börjar sälja, bland säljsidorna."), forklaring: t("{andel} började sälja", { andel: pct(samst.utfall.salja + samst.utfall.annons, samst.besok) }) } : null,
      ]}
    />
  );
}

function SummeringSaljsidan({ sida }: { sida: KundresaSida | undefined }) {
  const t = useT();
  if (!sida || (!sida.medDjup && !sida.sektioner.length)) return null;
  const sektion = (namn: string) => sida.sektioner.find((s) => s.namn === namn);
  const marken = sektion("salj_marken");
  const hur = sektion("salj_hur");
  return (
    <Sammanfattat
      rader={[
        sida.medDjup ? { varde: pct(sida.djup[100], sida.medDjup), etikett: t("Läser hela sidan"), info: t("Andelen av startsidans besökare som scrollade ända till slutet av sidan."), forklaring: t("scrollar ända ned") } : null,
        marken ? { varde: pct(marken.sedd, sida.besok), etikett: t("Ser märkesvalet"), info: t("Andelen av startsidans besökare där märkesvalet faktiskt syntes på skärmen. De som inte ser det kan inte börja.") } : null,
        marken ? { varde: pct(marken.klick, sida.besok), etikett: t("Väljer ett märke"), info: t("Andelen av startsidans besökare som tryckte i märkesvalet — det första steget i säljflödet."), forklaring: t("av alla som kom till sidan") } : null,
        hur ? { varde: pct(hur.klick, sida.besok), etikett: t("Frågar hur det fungerar"), info: t("Andelen av startsidans besökare som tryckte på ”Hur fungerar det?”. Högt tal betyder att sidan inte förklarar nog själv."), forklaring: t("trycker på ”Hur fungerar det?”") } : null,
      ]}
    />
  );
}

function SummeringMatning({ data }: { data: Kundresa }) {
  const t = useT();
  const m = data.matning;
  if (!m.besok) return null;
  return (
    <Sammanfattat
      rader={[
        { varde: pct(m.besok - m.utanKalla, m.besok), etikett: t("Besök med känd källa"), info: t("Andelen besök där vi vet varifrån besökaren kom: via en länk, en sökmotor, en annan sajt eller en kampanjlänk. Resten räknas som Direkt — okänd källa."), forklaring: t("Målet är minst 70 %") },
        { varde: pct(m.viaLank, m.besok), etikett: t("Kom via kampanjlänk"), info: t("Andelen besök som kom in genom en av panelens kampanjlänkar. Ju högre, desto bättre vet vi vad varje kanal ger.") },
        m.annonser ? { varde: pct(m.annonser - m.annonserOkand, m.annonser), etikett: t("Annonser med känd kanal"), info: t("Andelen av periodens färdiga annonser där vi vet vilken kanal säljaren kom ifrån — från besöket där möbeln filmades, eller säljarens första besök.") } : null,
      ]}
    />
  );
}

function SummeringKanaler({ data }: { data: Kundresa }) {
  const t = useT();
  const matta = data.perKanal.filter((k) => k.besok > 0);
  const besok = matta.reduce((n, k) => n + k.besok, 0);
  if (!besok) return null;
  const fardiga = matta.reduce((n, k) => n + k.fardigaBesok, 0);
  const annonser = data.perKanal.reduce((n, k) => n + k.annonser, 0);
  const salda = data.perKanal.reduce((n, k) => n + k.salda, 0);
  const sakra = matta.filter((k) => k.besok >= MINSTA_UNDERLAG && k.kanal !== "Okänd");
  const bast = [...sakra].sort((a, b) => b.fardigaBesok / b.besok - a.fardigaBesok / a.besok)[0];
  const storst = [...matta].sort((a, b) => b.besok - a.besok)[0];
  return (
    <Sammanfattat
      rader={[
        { varde: decimal(per100(fardiga, besok)), etikett: t("Annonser per 100 besök"), info: t("Hur många av hundra besök som slutade i en färdig annons. Räknas på besöken, så att stora och små kanaler kan jämföras rättvist."), forklaring: t("snittet över alla kanaler") },
        annonser ? { varde: pct(salda, annonser), etikett: t("Annonser som sålts"), info: t("Andelen av periodens färdiga annonser som sålts — i butiken eller på Tradera. Nya annonser har inte hunnit säljas, så talet är lägre för korta perioder.") } : null,
        bast ? { varde: bast.kanal, etikett: t("Bästa kanalen"), info: t("Kanalen med flest färdiga annonser per 100 besök. Kanaler med färre än fem besök räknas inte — två av två är tur."), forklaring: t("{n} annonser per 100 besök", { n: decimal(per100(bast.fardigaBesok, bast.besok)) }) } : null,
        storst ? { varde: storst.kanal, etikett: t("Största kanalen"), info: t("Kanalen med flest besök under perioden, och dess andel av alla besök."), forklaring: t("{andel} av besöken", { andel: pct(storst.besok, besok) }) } : null,
      ]}
    />
  );
}

function SummeringLankar({ data }: { data: Kundresa }) {
  const t = useT();
  const l = data.perKampanj;
  if (!l.length) return null;
  const besok = l.reduce((n, k) => n + k.besok, 0);
  const fardiga = l.reduce((n, k) => n + k.fardigaBesok, 0);
  const alla = data.matning.besok;
  const allaFardiga = data.perKanal.reduce((n, k) => n + k.fardigaBesok, 0);
  const anvanda = l.filter((k) => k.besok > 0).length;
  return (
    <Sammanfattat
      rader={[
        { varde: `${anvanda} / ${l.length}`, etikett: t("Länkar som använts"), info: t("Hur många av kampanjlänkarna som gav minst ett besök under perioden, av alla länkar som finns."), forklaring: t("under perioden") },
        { varde: besok, etikett: t("Besök via länkar"), info: t("Besök som kom in genom en av panelens kampanjlänkar (loopa.nu/k/…) under perioden."), forklaring: alla ? t("{andel} av alla besök", { andel: pct(besok, alla) }) : undefined },
        besok ? { varde: decimal(per100(fardiga, besok)), etikett: t("Annonser per 100 besök"), info: t("Hur många av hundra besök som slutade i en färdig annons. Räknas på besöken, så att stora och små kanaler kan jämföras rättvist."), forklaring: t("via länkar, mot {snitt} totalt", { snitt: decimal(per100(allaFardiga, alla)) }) } : null,
      ]}
    />
  );
}

/** Stegen efter kortet har inga skärmar i App.tsx och därför inga namn i STEG_NAMN. */
const SLUTSTEG_NAMN: Record<string, string> = { salj: "Sälj med Loopa", lamnad: "Lämnad till Loopa" };

/** Skärmens namn som en säljare skulle säga det, med stor bokstav. */
function stegNamn(steg: string): string {
  const namn = steg === "home" ? "startsidan" : (SLUTSTEG_NAMN[steg] ?? STEG_NAMN[steg] ?? steg);
  return namn.charAt(0).toUpperCase() + namn.slice(1);
}

/**
 * Vad säljaren GÖR på varje skärm, som flödet ser ut i dag (web/src/App.tsx, FlowApp). Står på
 * raden så att den som läser panelen inte behöver kunna appen för att förstå varför ett steg är svårt.
 */
const STEG_GORA: Record<string, string> = {
  home: "Väljer märke",
  capture: "Filmar ett varv runt möbeln och tar omslagsbild",
  starting: "Bilderna laddas upp — som gäst, utan konto",
  identify: "Väljer rätt modell bland förslagen",
  specs: "Svarar om husdjur och rök, väljer variant, anger mått",
  price: "Väljer startpris och veckosänkning",
  analysis: "AI:n går igenom skicket",
  result: "Bekräftar eller rättar skadorna",
  listing: "Ser sin färdiga annons",
  salj: "Trycker ”Sälj med Loopa”, granskar och bekräftar — skapar konto om de är gäst",
  lamnad: "Annonsen är hos oss och väntar på godkännande",
};

/** Orsakerna till ett avhopp som inte är fel i appen, utan något säljaren gjorde. */
const ORSAK_NAMN: Record<string, string> = {
  konto_vid_publicering: "Fastnade vid kontot",
  granskning_avbruten: "Avbröt granskningen",
};
const orsakNamn = (n: string) => ORSAK_NAMN[n] ?? felNamn(n);

// ---------------------------------------------------------------------------
// Stegen
// ---------------------------------------------------------------------------

/** Under så många i steget innan får ett steg inte kallas en läcka — två av tre är tur. */
const MINSTA_UNDERLAG = 5;

const STEG: Record<string, { namn: string; hjalp: string }> = {
  besok: { namn: "Besökte Loopa", hjalp: "Alla besök i perioden" },
  borjade: { namn: "Började sälja", hjalp: "Valde märke och gick in i filmningen" },
  laddade: { namn: "Laddade upp", hjalp: "Filmade klart och skickade in bilderna" },
  fardig: { namn: "Fick en färdig annons", hjalp: "Kom hela vägen till ett färdigt kort" },
  fardiga: { namn: "Färdiga annonser", hjalp: "Annonser som blev klara i perioden" },
  overlamnade: { namn: "Lämnade till Loopa", hjalp: "Säljaren tryckte ”Sälj med Loopa”" },
  godkanda: { namn: "Godkänd och ute", hjalp: "En admin godkände, och möbeln gick ut" },
  salda: { namn: "Såld", hjalp: "I butiken eller på Tradera" },
};

/**
 * Övergångarna som får kallas läckor. Bara de där den som inte gick vidare faktiskt LÄMNADE.
 * En godkänd möbel som inte sålts än ligger ute; den har inte tappats, den har inte hunnit.
 */
const KAN_LACKA = new Set(["borjade", "laddade", "fardig", "overlamnade"]);

interface Overgang {
  till: string;
  andel: number;
}

function storstaLackan(data: Kundresa): Overgang | null {
  const kandidater: Overgang[] = [];
  for (const del of [data.besoksdel, data.annonsdel]) {
    for (let i = 1; i < del.length; i += 1) {
      if (!KAN_LACKA.has(del[i].nyckel) || del[i - 1].antal < MINSTA_UNDERLAG) continue;
      kandidater.push({ till: del[i].nyckel, andel: del[i].antal / del[i - 1].antal });
    }
  }
  return kandidater.sort((a, b) => a.andel - b.andel)[0] ?? null;
}

/** Tid som en människa säger den: sekunder och minuter i flödet, timmar och dygn i affären. */
function varaktighet(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} dygn`;
}

// ---------------------------------------------------------------------------
// Sammanfattningen och nyckeltalen
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Resan
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Trattarna
// ---------------------------------------------------------------------------

export interface TrattNiva {
  nyckel: string;
  namn: ReactNode;
  hjalp?: ReactNode;
  antal: number;
  /** Under talet: andelen av första steget, eller en enhet. */
  under?: ReactNode;
  trend?: ReactNode;
}

export interface TrattOvergang {
  /** Andelen som gick vidare från steget innan, färdigformaterad. */
  vidare: string;
  /** Resten av raden: hur många som föll bort, tiden. */
  text?: ReactNode;
  /** Det som står under raden — felen säljarna fick innan de lämnade. */
  extra?: ReactNode;
  /** Sant när det här är steget där störst andel försvinner. */
  lacka?: boolean;
}

/** Ritytan i viewBox-enheter. */
const SK_KOL = 150;
const SK_MINB = 1000;
/** Första stegets höjd. Allt annat skalas mot det — ett avhopp på 96 är tre gånger ett på 32. */
const SK_H = 320;
/** Plats ovanför för stegens namn, och luft mellan huvudströmmen och avhoppen under. */
const SK_TOPP = 84;
const SK_LUFT = 54;
const SK_NOD = 14;
/** Tunnare än så ritas ingen ström — en nolla ska synas som ett streck, inte försvinna. */
const SK_MIN = 2.5;

/** Ett band från en lodrät sträcka till en annan, med mjuka kurvor — sankeyns ström. */
function band(x0: number, y0: number, x1: number, y1: number, tjock: number): string {
  const xm = (x0 + x1) / 2;
  return `M ${x0},${y0} C ${xm},${y0} ${xm},${y1} ${x1},${y1} L ${x1},${y1 + tjock} C ${xm},${y1 + tjock} ${xm},${y0 + tjock} ${x0},${y0 + tjock} Z`;
}

/**
 * Flödet som ett sankeydiagram, åt höger.
 *
 * VARFÖR INTE BARA EN TRATT. En tratt visar hur många som är KVAR; den visar inte vart de andra tog
 * vägen. Här är varje steg en stapel, och från den går två strömmar: den orange till nästa steg och
 * den grå ned till en egen stapel för dem som lämnade. Strömmarna behåller sin tjocklek hela vägen
 * fram — ett avhopp på 96 personer ser ut som 96 personer ända till sin etikett, inte som ett streck.
 *
 * TVÅ BAN. Huvudströmmen löper längs en rak överkant; avhoppen samlas i ett eget band under den.
 * Etiketterna för avhoppen står därför där inga strömmar går, och huvudströmmen läses mot samma linje
 * hela vägen. `overgangar[i]` beskriver övergången FÖRE steg i — alltså strömmen ut från steg i − 1.
 */
function TrattBild({ nivaer, overgangar }: { nivaer: TrattNiva[]; overgangar: Array<TrattOvergang | null> }) {
  const t = useT();
  const n = nivaer.length;
  const forsta = Math.max(1, nivaer[0]?.antal ?? 1);
  const hojd = (antal: number) => (antal > 0 ? Math.max(SK_MIN, (antal / forsta) * SK_H) : SK_MIN);
  const B = Math.max(SK_MINB, n * SK_KOL);
  const kol = B / n;
  // Stegen står till vänster i sina kolumner, så att avhoppets etikett får plats till höger om sin stapel.
  const x = (i: number) => i * kol + kol * 0.18;
  const avhopp = nivaer.slice(0, -1).map((niva, i) => Math.max(0, niva.antal - nivaer[i + 1].antal));
  const storstaAvhopp = Math.max(0, ...avhopp.map((d) => hojd(d)));
  const yAvhopp = SK_TOPP + SK_H + SK_LUFT;
  // Under avhoppen står deras etiketter, och de behöver plats även när avhoppen är tunna.
  const H = yAvhopp + Math.max(storstaAvhopp, 70 + n * 18) + 24;
  const pctX = (v: number) => `${(v / B) * 100}%`;
  const pctY = (v: number) => `${(v / H) * 100}%`;

  return (
    <>
      <p className="resa-strom-svep" aria-hidden>
        {t("Svep i sidled för att se hela flödet →")}
      </p>
      <div className="resa-strom">
        <div className="resa-sankey" style={{ ["--steg" as string]: n }}>
          {/* Ytan som etiketterna placeras mot. Ramen runt har luft ovanför, där namnen får plats även
              när de bryts på två rader. */}
          <div className="resa-sankey-yta">
          <svg className="resa-sankey-bild" viewBox={`0 0 ${B} ${H}`} aria-hidden>
            {nivaer.map((niva, i) => {
              const nasta = nivaer[i + 1];
              if (!nasta) return null;
              const hn = hojd(nasta.antal);
              const d = avhopp[i];
              const o = overgangar[i + 1] ?? null;
              const x0 = x(i) + SK_NOD;
              const x1 = x(i + 1);
              return (
                <g key={niva.nyckel}>
                  <path className="resa-sankey-vidare" d={band(x0, SK_TOPP, x1, SK_TOPP, hn)} />
                  {d > 0 && (
                    <path
                      className={o?.lacka ? "resa-sankey-avhopp resa-sankey-lacka" : "resa-sankey-avhopp"}
                      d={band(x0, SK_TOPP + hn, x1, yAvhopp, hojd(d))}
                    />
                  )}
                </g>
              );
            })}
            {nivaer.map((niva, i) => (
              <rect key={niva.nyckel} className="resa-sankey-nod" x={x(i)} y={SK_TOPP} width={SK_NOD} height={hojd(niva.antal)} rx={2} />
            ))}
            {avhopp.map((d, i) =>
              d > 0 ? (
                <rect
                  key={i}
                  className={overgangar[i + 1]?.lacka ? "resa-sankey-nod-avhopp resa-sankey-nod-lacka" : "resa-sankey-nod-avhopp"}
                  x={x(i + 1)}
                  y={yAvhopp}
                  width={SK_NOD}
                  height={hojd(d)}
                  rx={2}
                />
              ) : null,
            )}
          </svg>

          {/* Stegen: namnet och antalet ovanför sin stapel. */}
          {nivaer.map((niva, i) => (
            <div
              key={niva.nyckel}
              // Första namnet läggs mot kanten i stället för centrerat — annars klipps det.
              className={`resa-sankey-steg${i === 0 ? " resa-sankey-forsta" : ""}`}
              style={{ left: pctX(i === 0 ? x(i) : x(i) + SK_NOD / 2), top: pctY(SK_TOPP - 8), maxWidth: pctX(i === 0 ? kol * 0.62 : kol * 0.76) }}
            >
              <strong>{niva.namn}</strong>
              <span className="resa-strom-tal">
                <b>{niva.antal}</b>
                {niva.under && <span className="trafik-dampad">{niva.under}</span>}
              </span>
            </div>
          ))}

          {/* Avhoppen: etiketten till höger om sin grå stapel, i bandet under huvudströmmen. */}
          {avhopp.map((d, i) => {
            const o = overgangar[i + 1] ?? null;
            if (!o) return null;
            return (
              <div
                key={i}
                className={`resa-sankey-ut${o.lacka ? " resa-strom-lacka" : ""}`}
                style={{ left: pctX(x(i + 1) + SK_NOD + 8), top: pctY(yAvhopp), maxWidth: pctX(kol - SK_NOD - 16) }}
              >
                {o.lacka && <span className="resa-lacka-etikett">⚠ {t("Största läckan")}</span>}
                <span className="resa-strom-avhopp-text">{o.text ?? t("{antal} lämnade", { antal: d })}</span>
                <span className="resa-strom-vidare">
                  {t("{andel} av {antal}", { andel: pct(d, nivaer[i].antal), antal: nivaer[i].antal })}
                </span>
                {o.extra && <span className="resa-tratt-extra">{o.extra}</span>}
              </div>
            );
          })}
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Bubbeldiagrammet (ingångarna) och andelsdiagrammet (kanalerna)
// ---------------------------------------------------------------------------

/** Rutorna i bubbeldiagrammet: [över snittet i andel][över snittet i besök]. */
const RUTOR = {
  uppVanster: "Skicka mer trafik hit",
  uppHoger: "Behåll",
  nedHoger: "Bygg om sidan",
  nedVanster: "Låt vara",
} as const;

/**
 * Ingångarna som bubblor: volym åt höger, andel som börjar sälja uppåt, färdiga annonser som storlek.
 *
 * VARFÖR BUBBLOR. Frågan om en ingång har två delar som en lista inte kan visa samtidigt: hur MÅNGA
 * som kommer dit, och hur BRA den är. En liten sida med hög andel är dit nästa kampanjlänk ska peka;
 * en stor sida med låg andel är den som ska byggas om. Snittlinjerna delar ytan i fyra rutor, och
 * rutan säger vad som är värt att göra — i ord, inte bara i placering.
 */
function Bubbeldiagram({ data }: { data: Kundresa }) {
  const t = useT();
  const { alla } = data.beteende;
  const rader = data.beteende.ingangar.filter((i) => i.besok > 0);
  if (!rader.length) return <p className="trafik-text trafik-dampad">{t("Inget underlag än.")}</p>;
  const andel = (i: KundresaIngang) => (i.utfall.salja + i.utfall.annons) / i.besok;
  const W = 800;
  const H = 440;
  const M = { v: 56, h: 24, o: 20, n: 48 };
  // Jämna steg på besöksaxeln: 1, 2, 2,5 eller 5 gånger en tiopotens.
  const grovMax = Math.max(...rader.map((i) => i.besok)) * 1.12;
  const potens = 10 ** Math.floor(Math.log10(grovMax / 4));
  const stegX = [1, 2, 2.5, 5, 10].map((m) => m * potens).find((v) => v * 4 >= grovMax) ?? potens * 10;
  const maxX = stegX * 4;
  const maxY = Math.min(1, Math.max(0.1, ...rader.map(andel)) * 1.18);
  const x = (v: number) => M.v + (v / maxX) * (W - M.v - M.h);
  const y = (v: number) => H - M.n - (v / maxY) * (H - M.o - M.n);
  const maxAnnons = Math.max(1, ...rader.map((i) => i.utfall.annons));
  const r = (n: number) => 7 + Math.sqrt(n / maxAnnons) * 26;
  const snittX = rader.reduce((n, i) => n + i.besok, 0) / rader.length;
  const snittY = alla.besok ? (alla.utfall.salja + alla.utfall.annons) / alla.besok : 0;
  const yTicks = Array.from({ length: 5 }, (_, k) => (maxY / 4) * k);
  const xTicks = Array.from({ length: 5 }, (_, k) => stegX * k);
  return (
    <div className="resa-strom">
      <div className="resa-bubblor">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t("Bubbeldiagram över ingångarna")}>
          {/* Rutorna, svagt tonade, med sina råd i hörnen. */}
          <rect className="resa-ruta-bra" x={M.v} y={M.o} width={x(snittX) - M.v} height={y(snittY) - M.o} />
          <rect className="resa-ruta-fixa" x={x(snittX)} y={y(snittY)} width={W - M.h - x(snittX)} height={H - M.n - y(snittY)} />
          <text className="resa-ruta-text" x={M.v + 10} y={M.o + 20}>{t(RUTOR.uppVanster)}</text>
          <text className="resa-ruta-text" x={W - M.h - 10} y={M.o + 20} textAnchor="end">{t(RUTOR.uppHoger)}</text>
          {/* De nedre rådens text står strax under snittlinjen — nere vid noll trängs de små sidorna. */}
          <text className="resa-ruta-text" x={W - M.h - 10} y={y(snittY) + 20} textAnchor="end">{t(RUTOR.nedHoger)}</text>
          <text className="resa-ruta-text" x={M.v + 10} y={y(snittY) + 20}>{t(RUTOR.nedVanster)}</text>
          {/* Axlarna och rutnätet. */}
          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line className="resa-axel-linje" x1={M.v} x2={W - M.h} y1={y(v)} y2={y(v)} />
              <text className="resa-axel-text" x={M.v - 8} y={y(v) + 4} textAnchor="end">{Math.round(v * 100)} %</text>
            </g>
          ))}
          {xTicks.map((v) => (
            <text key={`x${v}`} className="resa-axel-text" x={x(v)} y={H - M.n + 18} textAnchor="middle">{Math.round(v)}</text>
          ))}
          <text className="resa-axel-titel" x={(M.v + W - M.h) / 2} y={H - 8} textAnchor="middle">{t("Besök som landade på sidan →")}</text>
          <text className="resa-axel-titel" x={14} y={(M.o + H - M.n) / 2} textAnchor="middle" transform={`rotate(-90 14 ${(M.o + H - M.n) / 2})`}>{t("Andel som började sälja →")}</text>
          {/* Snittlinjerna. */}
          <line className="resa-snittlinje" x1={x(snittX)} x2={x(snittX)} y1={M.o} y2={H - M.n} />
          <line className="resa-snittlinje" x1={M.v} x2={W - M.h} y1={y(snittY)} y2={y(snittY)} />
          <text className="resa-snitt-text" x={W - M.h - 4} y={y(snittY) - 6} textAnchor="end">{t("snitt {andel}", { andel: pct(alla.utfall.salja + alla.utfall.annons, alla.besok) })}</text>
          {/* Bubblorna, största först så att de små ligger ovanpå och går att se. */}
          {[...rader]
            .sort((a, b) => b.utfall.annons - a.utfall.annons)
            .map((i) => (
              <g key={i.sida} className="resa-bubbla">
                <title>
                  {`${sidNamn(i.sida)}: ${i.besok} besök, ${pct(i.utfall.salja + i.utfall.annons, i.besok)} började sälja, ${i.utfall.annons} färdiga annonser`}
                </title>
                <circle cx={x(i.besok)} cy={y(andel(i))} r={r(i.utfall.annons)} />
              </g>
            ))}
          {/* Etiketterna efteråt, flyttade isär när de skulle krocka. En tunn linje leder tillbaka
              till bubblan när etiketten fått flytta. */}
          {etiketter(
            rader.map((i) => ({ i, cx: x(i.besok), cy: y(andel(i)), rad: r(i.utfall.annons) })),
            W,
            H - M.n - 18,
          ).map(({ i, cx, cy, lx, ly, hoger, flyttad }) => (
            <g key={i.sida} className="resa-bubbla-etikett">
              {flyttad && <line className="resa-ledlinje" x1={cx} y1={cy} x2={hoger ? lx - 3 : lx + 3} y2={ly - 6} />}
              <text className="resa-bubbla-namn" x={lx} y={ly - 2} textAnchor={hoger ? "start" : "end"}>
                {sidNamn(i.sida)}
              </text>
              <text className="resa-bubbla-tal" x={lx} y={ly + 13} textAnchor={hoger ? "start" : "end"}>
                {pct(i.utfall.salja + i.utfall.annons, i.besok)} · {i.utfall.annons} {t("annonser")}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}

/**
 * Var etiketterna ska stå. Till höger om bubblan om det får plats, annars till vänster; och står två
 * för nära varandra flyttas den senare nedåt tills den går fri. Enkelt och tillräckligt för de högst
 * sex ingångar diagrammet visar.
 */
function etiketter<T extends { cx: number; cy: number; rad: number }>(
  punkter: T[],
  bredd: number,
  botten: number,
): Array<T & { lx: number; ly: number; hoger: boolean; flyttad: boolean }> {
  const B = 130;
  const H = 32;
  const placerade: Array<{ x0: number; x1: number; y: number }> = [];
  return [...punkter]
    .sort((a, b) => a.cy - b.cy)
    .map((p) => {
      const hoger = p.cx + p.rad + 8 + B < bredd;
      const lx = hoger ? p.cx + p.rad + 6 : p.cx - p.rad - 6;
      const x0 = hoger ? lx : lx - B;
      let ly = Math.min(p.cy, botten);
      const krockar = () => placerade.some((q) => x0 < q.x1 && x0 + B > q.x0 && Math.abs(ly - q.y) < H);
      // Nedåt i första hand; når etiketten botten letar den uppåt i stället.
      while (krockar() && ly + 8 <= botten) ly += 8;
      if (krockar()) {
        ly = Math.min(p.cy, botten);
        while (krockar()) ly -= 8;
      }
      placerade.push({ x0, x1: x0 + B, y: ly });
      return { ...p, lx, ly, hoger, flyttad: Math.abs(ly - p.cy) > 4 };
    });
}

/**
 * Kanalernas andel av besöken mot deras andel av annonserna — två punkter per kanal.
 *
 * DEN ENKLASTE RÄTTVISA JÄMFÖRELSEN. En stor kanal ger alltid flest annonser, och en liten kanal kan
 * ha en hög andel av ett litet tal. Andelen av trafiken mot andelen av resultatet tar bort båda: en
 * kanal som står för 20 % av besöken men 30 % av annonserna ger mer än sin del, och avståndet mellan
 * punkterna är hur mycket mer. Riktningen står i ord, inte bara i färg.
 */
function Andelsdiagram({ data }: { data: Kundresa }) {
  const t = useT();
  const kanaler = data.perKanal.filter((k) => k.besok > 0 && k.kanal !== "Okänd");
  const besok = kanaler.reduce((n, k) => n + k.besok, 0);
  const annonser = kanaler.reduce((n, k) => n + k.fardigaBesok, 0);
  if (!besok || !annonser) return null;
  const rader = kanaler
    .map((k) => ({ kanal: k.kanal, b: k.besok / besok, a: k.fardigaBesok / annonser, litet: k.besok < MINSTA_UNDERLAG }))
    .sort((p, q) => q.b - p.b);
  const max = Math.min(1, Math.ceil((Math.max(...rader.map((r) => Math.max(r.a, r.b))) * 1.1) / 0.1) * 0.1);
  const ticks = Array.from({ length: Math.round(max / 0.1) + 1 }, (_, k) => k * 0.1);
  const pos = (v: number) => `${(v / max) * 100}%`;
  const fmt = (v: number) => `${Math.round(v * 100)} %`;
  return (
    <div className="resa-andel">
      <div className="resa-andel-forklaring" aria-hidden>
        <span><span className="resa-andel-prick resa-andel-besok" /> {t("andel av besöken")}</span>
        <span><span className="resa-andel-prick resa-andel-annons" /> {t("andel av annonserna")}</span>
        <Info text={t("○ är kanalens andel av alla besök, ● dess andel av alla besök som blev en färdig annons. Ligger ● till höger om ○ ger kanalen fler säljare än sin andel av trafiken.")} />
      </div>
      <ul className="resa-andel-lista">
        {rader.map((r) => {
          const mer = r.a > r.b * 1.1;
          const mindre = r.a < r.b * 0.9;
          return (
            <li key={r.kanal} className={`resa-andel-rad${mer ? " resa-andel-mer" : mindre ? " resa-andel-mindre" : ""}`}>
              <span className="resa-andel-namn">{r.kanal}</span>
              <span className="resa-andel-spar" title={`${r.kanal}: ${fmt(r.b)} av besöken, ${fmt(r.a)} av annonserna`}>
                {ticks.slice(1, -1).map((v) => (
                  <span key={v} className="resa-andel-linje" style={{ left: pos(v) }} aria-hidden />
                ))}
                <span className="resa-andel-band" style={{ left: pos(Math.min(r.a, r.b)), width: `${(Math.abs(r.a - r.b) / max) * 100}%` }} />
                <span className="resa-andel-prick resa-andel-besok" style={{ left: pos(r.b) }} />
                <span className="resa-andel-prick resa-andel-annons" style={{ left: pos(r.a) }} />
              </span>
              <span className="resa-andel-utfall">
                <span className="trafik-dampad">{fmt(r.b)} → </span>
                <b>{fmt(r.a)}</b>{" "}
                {r.litet ? (
                  <span className="resa-mot resa-mot-osaker">{t("litet underlag")}</span>
                ) : mer ? (
                  <span className="resa-mot resa-mot-upp">▲ {t("ger mer")}</span>
                ) : mindre ? (
                  <span className="resa-mot resa-mot-ned">▼ {t("ger mindre")}</span>
                ) : (
                  <span className="resa-mot">≈ {t("som sin andel")}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="resa-andel-skala" aria-hidden>
        <span />
        <span className="resa-avhopp-axel">
          {ticks.map((v) => (
            <span key={v} style={{ left: pos(v) }}>
              {fmt(v)}
            </span>
          ))}
        </span>
        <span />
      </div>
    </div>
  );
}

/**
 * Stegen som en kedja: talet för varje steg, och mellan stegen hur stor andel som gick vidare.
 *
 * VARFÖR INTE EN TRATT. De små trattarna krympte till ett streck så fort första steget tappade de
 * flesta — vilket det nästan alltid gör — och då gick varken andra eller tredje steget att läsa. Här
 * står varje steg som ett eget tal med en egen stapel, och övergången mellan två steg står som en
 * procent på pilen: "29 % gick vidare". Stapeln visar storleken mot första steget och har alltid en
 * synlig bredd, så att tio procent ser ut som tio procent och inte som ingenting.
 */
function StegKedja({ steg }: { steg: Array<{ etikett: string; antal: number }> }) {
  const t = useT();
  const forsta = Math.max(1, steg[0]?.antal ?? 1);
  const kolumner = steg.map((_, i) => (i === 0 ? "minmax(0, 1fr)" : "auto minmax(0, 1fr)")).join(" ");
  return (
    <span className="resa-kedja" style={{ gridTemplateColumns: kolumner }}>
      {steg.map((s, i) => (
        <Fragment key={s.etikett}>
          {i > 0 && (
            <span className="resa-kedja-pil" title={t("{a} av {b} gick vidare", { a: s.antal, b: steg[i - 1].antal })}>
              <span aria-hidden>→</span>
              <b>{pct(s.antal, steg[i - 1].antal)}</b>
            </span>
          )}
          <span className={`resa-kedja-steg${s.antal === 0 ? " resa-kedja-noll" : ""}`}>
            <b>{s.antal}</b>
            <span className="resa-kedja-etikett">{s.etikett}</span>
            <span className="resa-kedja-spar" aria-hidden>
              <span style={{ width: `${s.antal > 0 ? Math.max(4, (s.antal / forsta) * 100) : 0}%` }} />
            </span>
          </span>
        </Fragment>
      ))}
    </span>
  );
}

function Resan({ data }: { data: Kundresa }) {
  const t = useT();
  const lacka = storstaLackan(data);
  return (
    <div className="resa">
      <Del
        nr={1}
        titel={t("Från besök till annons")}
        enhet={t("räknas i besök")}
        steg={data.besoksdel}
        lacka={lacka?.till ?? null}
      />
      <div className="resa-bro" aria-hidden>
        <span>{t("Den färdiga annonsen är bron. Härifrån räknas annonser — en säljare kan lägga upp flera.")}</span>
      </div>
      <Del
        nr={2}
        titel={t("Från annons till såld")}
        enhet={t("räknas i annonser")}
        steg={data.annonsdel}
        lacka={lacka?.till ?? null}
        pagar={{ salda: data.ligger }}
      />
    </div>
  );
}

/**
 * En halva av resan: stegen under varandra, och mellan dem hur många som gick vidare.
 *
 * MELLANRUMMET ÄR DET VIKTIGA. Stegens tal säger hur många som kom dit; raden mellan två steg säger
 * hur många som INTE kom vidare, och hur lång tid det tog för dem som gjorde det. Det är där varje
 * beslut om vad som ska byggas härnäst finns.
 */
function Del({
  nr,
  titel,
  enhet,
  steg,
  lacka,
  pagar = {},
}: {
  nr: number;
  titel: string;
  enhet: string;
  steg: KundresaSteg[];
  lacka: string | null;
  /** Steg där de som inte gått vidare ÄNNU inte gjort det, med hur många. */
  pagar?: Record<string, number>;
}) {
  const t = useT();
  const forsta = Math.max(1, steg[0]?.antal ?? 1);
  return (
    <section className="resa-del" aria-label={titel}>
      <h4 className="resa-del-rubrik">
        <span className="resa-del-nr">{t("Del {nr}", { nr })}</span>
        {titel}
        <span className="trafik-dampad"> · {enhet}</span>
      </h4>
      <TrattBild
        nivaer={steg.map((s, i) => ({
          nyckel: s.nyckel,
          namn: t(STEG[s.nyckel]?.namn ?? s.nyckel),
          hjalp: t(STEG[s.nyckel]?.hjalp ?? ""),
          antal: s.antal,
          under: i > 0 ? pct(s.antal, forsta) : undefined,
          trend: s.forra !== null ? <Trend nu={s.antal} forra={s.forra} /> : undefined,
        }))}
        overgangar={steg.map((s, i) => {
          const fore = steg[i - 1];
          if (!fore) return null;
          const tapp = fore.antal - s.antal;
          const ejAn = pagar[s.nyckel] ?? 0;
          const delar = [
            tapp > 0
              ? ejAn > 0
                ? t("{antal} ligger ute och väntar, {rest} föll bort", { antal: ejAn, rest: Math.max(0, tapp - ejAn) })
                : KAN_LACKA.has(s.nyckel)
                  ? t("{antal} föll bort", { antal: tapp })
                  : t("{antal} har inte gått vidare än", { antal: tapp })
              : null,
          ].filter(Boolean);
          return { vidare: pct(s.antal, fore.antal), text: delar.join(" · ") || undefined, lacka: lacka === s.nyckel };
        })}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Säljflödet, skärm för skärm
// ---------------------------------------------------------------------------

/**
 * Säljflödet som en lista att läsa uppifrån och ned.
 *
 * EN SAK PER RAD: hur många kom hit, och hur många slutade här. Uppladdningsfliken har kartan med
 * mikrostegen och varje enskilt försök; den här vyn är frågan före den — VILKEN skärm ska vi titta
 * på? Skärmen där störst andel slutar är markerad, och felen som föregick avhoppen står direkt under,
 * för de är oftast svaret.
 */
function Saljflodet({ steg }: { steg: KundresaFlodesSteg[] }) {
  const t = useT();
  const flode = steg.slice(1);
  if (!steg[0]?.nadde || !flode[0]?.nadde) return <p className="trafik-text trafik-dampad">{t("Inga besök i säljflödet under perioden.")}</p>;
  // Värst: störst andel som slutade, bland skärmar med underlag. Startsidan räknas inte — de flesta
  // besökare lämnar den, och det är ett annat problem än ett avhopp mitt i flödet — och inte heller
  // sista skärmen, som är målet.
  const varst = steg
    .slice(1, -1)
    .filter((s) => s.nadde >= MINSTA_UNDERLAG && s.lamnade > 0)
    .sort((a, b) => b.lamnade / b.nadde - a.lamnade / a.nadde)[0];
  const klara = steg[steg.length - 1]?.nadde ?? 0;
  return (
    <>
      <KortSagt
        meningar={[
          <>
            {t("Av")} <b>{steg[1]?.nadde ?? 0}</b> {t("som började filma lämnade")} <b>{klara}</b> {t("sin möbel till Loopa")} ({pct(klara, steg[1]?.nadde ?? 0)}).
          </>,
          ...(varst
            ? [
                <>
                  {t("Flest slutar på")} <b>{stegNamn(varst.steg).toLowerCase()}</b>: {varst.lamnade} {t("av")} {varst.nadde} ({pct(varst.lamnade, varst.nadde)})
                  {varst.fel[0] && (
                    <>
                      {", "}
                      {t("och den vanligaste orsaken där är")} <b>{orsakNamn(varst.fel[0].namn).toLowerCase()}</b>
                    </>
                  )}
                  .
                </>,
              ]
            : []),
        ]}
      />
      <Avhoppsdiagram flode={flode} varst={varst?.steg ?? null} />
      <p className="trafik-text trafik-dampad">
        {t("Varje mikrosteg, varje knapptryck och varje enskilt försök finns i fliken Uppladdning.")}
      </p>
    </>
  );
}

/**
 * Avhoppen skärm för skärm, som liggande staplar.
 *
 * VARFÖR INTE ETT FLÖDE HÄR. Ett flöde visar hur MÅNGA som lämnade, och i ett flöde dominerar alltid
 * början — där är folk flest. Frågan här är en annan: vilken skärm är SVÅRAST? Det svaret är andelen
 * av dem som kom till skärmen som slutade där, och den står som en stapel per skärm, i flödets
 * ordning, mot en gemensam skala som börjar på noll. Längst stapel är svårast, och den är röd och
 * säger det i ord. Antalet, hur många som gick vidare och det vanligaste felet står på samma rad.
 */
function Avhoppsdiagram({ flode, varst }: { flode: KundresaFlodesSteg[]; varst: string | null }) {
  const t = useT();
  const skarmar = flode.slice(0, -1);
  const mal = flode[flode.length - 1];
  const andel = (s: KundresaFlodesSteg) => (s.nadde ? s.lamnade / s.nadde : 0);
  // Skalan: närmaste tiotal över den största andelen, så att skillnaderna syns — men alltid från noll.
  const stegLangd = Math.max(...skarmar.map(andel), 0.05) <= 0.2 ? 0.05 : 0.1;
  const max = Math.max(stegLangd * 2, Math.ceil(Math.max(...skarmar.map(andel), 0.01) / stegLangd) * stegLangd);
  const markeringar = Array.from({ length: Math.round(max / stegLangd) + 1 }, (_, k) => k * stegLangd);
  return (
    <div className="resa-avhopp">
      <div className="resa-avhopp-huvud" aria-hidden>
        <span>{t("Skärm")}</span>
        <span>
          {t("Andel som slutade på skärmen")}
          <Info text={t("Av dem som kom till skärmen: hur stor andel som inte gick vidare. Räknas per skärm, så att en skärm sent i flödet kan vara svårast även om färre når dit.")} />
        </span>
        <span>{t("Vanligaste orsaken")}</span>
      </div>
      <ol className="resa-avhopp-lista">
        {skarmar.map((s) => {
          const a = andel(s);
          const arVarst = varst === s.steg;
          const osaker = s.nadde < MINSTA_UNDERLAG;
          return (
            <li key={s.steg} className={`resa-avhopp-rad${arVarst ? " resa-avhopp-varst" : ""}`}>
              <span className="resa-avhopp-skarm">
                <strong>{stegNamn(s.steg)}</strong>
                {STEG_GORA[s.steg] && <span className="resa-avhopp-gora">{t(STEG_GORA[s.steg])}</span>}
                <span className="trafik-dampad">
                  {t("{n} kom hit", { n: s.nadde })}
                  {s.medianMs !== null && ` · ${varaktighet(s.medianMs)}`}
                </span>
              </span>
              <span className="resa-avhopp-matt">
                <span className="resa-avhopp-yta" title={t("{a} av {b} slutade här", { a: s.lamnade, b: s.nadde })}>
                  {markeringar.slice(1, -1).map((m) => (
                    <span key={m} className="resa-avhopp-linje" style={{ left: `${(m / max) * 100}%` }} aria-hidden />
                  ))}
                  <span
                    className={`resa-avhopp-stapel${osaker ? " resa-avhopp-osaker" : ""}`}
                    style={{ width: `${Math.max(a > 0 ? 0.8 : 0, (a / max) * 100)}%` }}
                  />
                </span>
                <span className="resa-avhopp-tal">
                  <b>{pct(s.lamnade, s.nadde)}</b>
                  <span className="trafik-dampad">
                    {t("{a} slutade · {b} vidare", { a: s.lamnade, b: s.nadde - s.lamnade })}
                  </span>
                  {arVarst && <span className="resa-lacka-etikett">⚠ {t("Svårast")}</span>}
                </span>
              </span>
              <span className={`resa-avhopp-fel${s.fel[0] ? "" : " resa-avhopp-fel-tom"}`}>
                {s.fel[0] ? (
                  <span title={s.fel.map((f) => `${orsakNamn(f.namn)} (${f.antal})`).join(", ")}>
                    {orsakNamn(s.fel[0].namn)} <b>{s.fel[0].antal}</b>
                  </span>
                ) : (
                  <span className="trafik-dampad">—</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {/* Skalan under staplarna, så att längderna går att läsa som tal. */}
      <div className="resa-avhopp-skala" aria-hidden>
        <span />
        <span className="resa-avhopp-axel">
          {markeringar.map((m) => (
            <span key={m} style={{ left: `${(m / max) * 100}%` }}>
              {Math.round(m * 100)} %
            </span>
          ))}
        </span>
        <span />
      </div>
      {mal && (
        <p className="resa-avhopp-mal">
          ✓ <b>{mal.nadde}</b> {t("lämnade sin möbel till Loopa")} — {pct(mal.nadde, flode[0].nadde)} {t("av dem som började filma.")}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Konvertering mot snittet — samma rad i kanalerna, landningarna, sidorna och vägarna
// ---------------------------------------------------------------------------

/**
 * Hur många gånger snittet en andel är, i ord och pil — aldrig bara i färg.
 *
 * MULTIPELN OCH INTE PROCENTENHETERNA. "12 % mot 8 %" kräver huvudräkning; "1,5× snittet" gör det
 * inte, och det är samma tal oavsett om målet är vanligt eller sällsynt.
 */
function Mot({ andel, snitt, underlag }: { andel: number; snitt: number; underlag: number }) {
  const t = useT();
  if (underlag < MINSTA_UNDERLAG) return <span className="resa-mot resa-mot-osaker">{t("litet underlag")}</span>;
  if (!snitt) return null;
  const x = andel / snitt;
  if (x >= 0.9 && x <= 1.1) return <span className="resa-mot">≈ {t("snittet")}</span>;
  const upp = x > 1;
  return (
    <span className={`resa-mot ${upp ? "resa-mot-upp" : "resa-mot-ned"}`}>
      {upp ? "▲" : "▼"} {x.toLocaleString("sv-SE", { maximumFractionDigits: 1 })}× {t("snittet")}
    </span>
  );
}

/**
 * En rad: vad det är, hur ofta det ledde till målet, och mot snittet.
 *
 * Stapeln är andelen; det lodräta strecket är snittet. Ett litet underlag ritas grått och rangordnas
 * inte — två av tre är tur, inte en kanal.
 */
function KonvRad({ namn, besok, lyckade, snitt, max, enhet }: { namn: ReactNode; besok: number; lyckade: number; snitt: number; max: number; enhet: string }) {
  const andel = besok ? lyckade / besok : 0;
  const skala = Math.max(max, snitt, 0.0001);
  const osaker = besok < MINSTA_UNDERLAG;
  return (
    <li className={`resa-konv${osaker ? " resa-konv-osaker" : ""}`}>
      <span className="resa-konv-namn">{namn}</span>
      <span className="resa-konv-stapel" title={`${lyckade} / ${besok}`}>
        <span className="resa-konv-fyllning" style={{ width: `${(andel / skala) * 100}%` }} />
        {snitt > 0 && <span className="resa-konv-snitt" style={{ left: `${(snitt / skala) * 100}%` }} aria-hidden />}
      </span>
      <span className="resa-konv-tal">
        <b>{pct(lyckade, besok)}</b>
        <span className="trafik-dampad">
          {besok} {enhet}
        </span>
        <Mot andel={andel} snitt={snitt} underlag={besok} />
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Kanalerna
// ---------------------------------------------------------------------------

type KanalSort = "besok" | "borjade" | "konv";

/** Annonser per hundra besök. Talet en kanal ska bedömas på: det tar hänsyn till hur stor den är. */
const per100 = (del: number, hel: number) => (hel ? (del / hel) * 100 : 0);
const decimal = (n: number) => n.toLocaleString("sv-SE", { maximumFractionDigits: n < 10 ? 1 : 0 });

/**
 * Kanalerna som kort, inte som kalkylblad.
 *
 * Tabellen svarade på allt och sade ingenting: åtta tal per rad och inget som visade vilken kanal som
 * var bäst. Nu bär varje kanal ETT huvudtal — färdiga annonser per hundra besök — mot snittet, och
 * resten står som en trappa under. Ovanför står slutsatsen i ord, och den som vill veta varför
 * fäller ut kanalen och ser källorna i den.
 */
function Kanalerna({ data, onValjKanal }: { data: Kundresa; onValjKanal: (k: string | null) => void }) {
  const t = useT();
  const [sort, setSort] = useState<KanalSort>("besok");
  const [oppen, setOppen] = useState<string | null>(null);
  const matta = data.perKanal.filter((k) => k.besok > 0);
  const totBesok = matta.reduce((n, k) => n + k.besok, 0);
  const snitt = per100(matta.reduce((n, k) => n + k.fardigaBesok, 0), totBesok);
  // Bara kanaler med besök står i tabellen. "Okänd" är annonser utan ett mätt besök, och den
  // har ingen trafik att jämföra — den står som en mening under tabellen.
  const tabellRader = useMemo(() => {
    const lista = data.perKanal.filter((k) => k.besok > 0);
    // Litet underlag sist när det sorteras på andelar: en kanal med ett besök och en annons är inte "bäst".
    const sakerFirst = (a: KundresaKanal, b: KundresaKanal) => Number(b.besok >= MINSTA_UNDERLAG) - Number(a.besok >= MINSTA_UNDERLAG);
    if (sort === "konv") return lista.sort((a, b) => sakerFirst(a, b) || b.fardigaBesok / b.besok - a.fardigaBesok / a.besok);
    if (sort === "borjade") return lista.sort((a, b) => sakerFirst(a, b) || b.borjade / b.besok - a.borjade / a.besok);
    return lista.sort((a, b) => b.besok - a.besok);
  }, [data.perKanal, sort]);
  const okandaAnnonser = data.perKanal.find((k) => k.kanal === "Okänd")?.annonser ?? 0;
  const maxBesok = Math.max(1, ...tabellRader.map((k) => k.besok));
  const sakraRader = tabellRader.filter((k) => k.besok >= MINSTA_UNDERLAG);
  const maxBorjade = Math.max(0.05, ...sakraRader.map((k) => k.borjade / k.besok)) * 1.1;
  const maxKonv = Math.max(snitt, ...sakraRader.map((k) => per100(k.fardigaBesok, k.besok))) * 1.15;

  if (!data.perKanal.length) return <p className="trafik-text trafik-dampad">{t("Inget underlag än.")}</p>;

  // Slutsatsen: kanalen att satsa på, och den stora kanalen som presterar sämst.
  const sakra = matta.filter((k) => k.besok >= MINSTA_UNDERLAG && k.kanal !== "Okänd");
  const bast = [...sakra].sort((a, b) => per100(b.fardigaBesok, b.besok) - per100(a.fardigaBesok, a.besok))[0];
  const svagStor = [...sakra]
    .filter((k) => k.besok / totBesok >= 0.15 && per100(k.fardigaBesok, k.besok) < snitt * 0.8)
    .sort((a, b) => b.besok - a.besok)[0];

  return (
    <>
      {(bast || svagStor) && (
        <div className="resa-slutsatser">
          {bast && per100(bast.fardigaBesok, bast.besok) > snitt * 1.1 && (
            <p className="resa-slutsats resa-slutsats-upp">
              <span aria-hidden>▲</span>
              <span>
                <b>{bast.kanal}</b> {t("ger")} {decimal(per100(bast.fardigaBesok, bast.besok))} {t("annonser per 100 besök")} —{" "}
                {decimal(per100(bast.fardigaBesok, bast.besok) / snitt)}× {t("snittet. Mer trafik härifrån ger mest per krona.")}
              </span>
            </p>
          )}
          {svagStor && (
            <p className="resa-slutsats resa-slutsats-ned">
              <span aria-hidden>▼</span>
              <span>
                <b>{svagStor.kanal}</b> {t("står för")} {pct(svagStor.besok, totBesok)} {t("av besöken men ger bara")}{" "}
                {decimal(per100(svagStor.fardigaBesok, svagStor.besok))} {t("annonser per 100 besök. Se över vart den trafiken landar — fliken Ingångar visar vilka sidor som fungerar.")}
              </span>
            </p>
          )}
        </div>
      )}

      {/*
        EN TABELL MED GEMENSAMMA SKALOR. Korten visade varje kanal mot sig själv, och då gick de inte att
        jämföra — vilket är hela frågan. Här har varje kolumn en skala för alla kanaler, så att ögat
        jämför nedåt: vilken kanal är störst, vilken får flest att börja, vilken ger flest annonser.
        Varje tal står en gång. Rubrikerna sorterar.
      */}
      <div className="resa-kt" role="table" aria-label={t("Kanalerna jämförda")}>
        <div className="resa-kt-rad resa-kt-huvud" role="row">
          <span role="columnheader">{t("Kanal")}</span>
          {(
            [
              ["besok", t("Besök"), t("Antal besök från kanalen under perioden. Stapeln är mot den största kanalen.")],
              ["borjade", t("Började sälja"), t("Andelen av kanalens besök som valde märke och gick in i filmningen.")],
              ["konv", t("Blev en annons"), t("Hur många av hundra besök från kanalen som slutade i en färdig annons. Strecket är snittet över alla kanaler.")],
            ] as Array<[KanalSort, string, string]>
          ).map(([k, namn, info]) => (
            <span key={k} role="columnheader" aria-sort={sort === k ? "descending" : "none"}>
              <button type="button" className={`resa-kt-sort${sort === k ? " vald" : ""}`} onClick={() => setSort(k)}>
                {namn} {sort === k ? "↓" : ""}
              </button>
              <Info text={info} />
            </span>
          ))}
          <span aria-hidden />
        </div>
        {tabellRader.map((k) => {
          const varde = per100(k.fardigaBesok, k.besok);
          const andelBorjade = k.borjade / k.besok;
          const ar = oppen === k.kanal;
          const vald = data.kanal === k.kanal;
          const osaker = k.besok < MINSTA_UNDERLAG;
          return (
            <div key={k.kanal} className={`resa-kt-post${vald ? " resa-kanal-vald" : ""}${ar ? " oppen" : ""}`} role="rowgroup">
              <button type="button" className="resa-kt-rad" role="row" aria-expanded={ar} onClick={() => setOppen(ar ? null : k.kanal)}>
                <span className="resa-kt-kanal" role="cell">
                  <span className="resa-kanal-pil" aria-hidden>
                    {ar ? "▾" : "▸"}
                  </span>
                  <span>
                    <strong>{k.kanal}</strong>
                    {k.forraBesok !== null && <Trend nu={k.besok} forra={k.forraBesok} />}
                  </span>
                </span>
                <span className="resa-kt-cell" role="cell" data-etikett={t("Besök")}>
                  <b>{k.besok}</b>
                  <span className="resa-kt-spar">
                    <span style={{ width: `${Math.min(100, (k.besok / maxBesok) * 100)}%` }} />
                  </span>
                </span>
                <span className="resa-kt-cell" role="cell" data-etikett={t("Började sälja")}>
                  <b>{pct(k.borjade, k.besok)}</b>
                  {/* Ett litet underlag får ingen stapel: tre besök säger inget att jämföra, och en
                      andel som 67 % av tre hade sprängt skalan för alla andra. */}
                  {osaker ? (
                    <span className="resa-kt-spar resa-kt-tom" aria-hidden />
                  ) : (
                    <span className="resa-kt-spar">
                      <span style={{ width: `${Math.min(100, (andelBorjade / maxBorjade) * 100)}%` }} />
                    </span>
                  )}
                </span>
                <span className="resa-kt-cell resa-kt-huvudtal" role="cell" data-etikett={t("Blev en annons")}>
                  <span className="resa-kt-varde">
                    <b>{decimal(varde)}</b>
                    <span className="trafik-dampad">{t("per 100")}</span>
                    <Mot andel={varde} snitt={snitt} underlag={k.besok} />
                  </span>
                  {osaker ? (
                    <span className="resa-kt-spar resa-kt-tom" aria-hidden />
                  ) : (
                    <span className="resa-kt-spar">
                      <span style={{ width: `${Math.min(100, (varde / maxKonv) * 100)}%` }} />
                      <span className="resa-kt-snitt" style={{ left: `${(snitt / maxKonv) * 100}%` }} aria-hidden />
                    </span>
                  )}
                </span>
              </button>
              {ar && (
                <div className="resa-kanal-inne">
                  {k.kallor.length > 0 && (
                    <>
                      <h4 className="resa-underrubrik">{t("Källorna i kanalen")}</h4>
                      <ul className="resa-konv-lista">
                        {k.kallor.map((c) => (
                          <KonvRad
                            key={c.kalla}
                            namn={
                              <>
                                {c.kalla}
                                <span className="trafik-dampad"> · {c.annonser} {t("annonser")}, {c.salda} {t("sålda")}</span>
                              </>
                            }
                            besok={c.besok}
                            lyckade={c.fardigaBesok}
                            snitt={snitt / 100}
                            max={Math.max(...k.kallor.map((x) => (x.besok ? x.fardigaBesok / x.besok : 0)), snitt / 100)}
                            enhet={t("besök")}
                          />
                        ))}
                      </ul>
                    </>
                  )}
                  <p className="trafik-text trafik-dampad">
                    {k.annonser > 0
                      ? t("{a} annonser från kanalen i perioden, {s} sålda ({p}).", { a: k.annonser, s: k.salda, p: pct(k.salda, k.annonser) })
                      : t("Inga färdiga annonser från kanalen i perioden.")}
                  </p>
                  <button type="button" className="btn btn-outline btn-small" onClick={() => onValjKanal(vald ? null : k.kanal)}>
                    {vald ? t("Visa alla kanaler igen") : t("Visa hela resan för {kanal}", { kanal: k.kanal })}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="trafik-text trafik-dampad">
        {t("Huvudtalet räknas på besöken: hur många av hundra besök som blev en färdig annons. Tryck på en kanal för källorna i den och vad annonserna sålde.")}
        {okandaAnnonser > 0 && <> {t("{n} annonser kommer från säljare vi inte vet varifrån de kom.", { n: okandaAnnonser })}</>}
      </p>
    </>
  );
}


// ---------------------------------------------------------------------------
// Mätningen av kanalerna
// ---------------------------------------------------------------------------

/** Så mycket okänd trafik tål kanaltabellen innan den slutar säga något. */
const OKAND_MAL = 0.3;

/**
 * Hur mycket kanaltabellen går att lita på.
 *
 * STÅR FÖRE KANALERNA, med flit. Ett besök utan källa hamnar under "Direkt" och ser ut som en kanal,
 * men det är ett besök vi inte vet något om — och ju större den andelen är, desto mindre säger
 * resten av tabellen. Svaret på "vilken kanal är bäst" börjar med "hur mycket vet vi".
 */
function Matkvalitet({ data }: { data: Kundresa }) {
  const t = useT();
  const m = data.matning;
  if (!m.besok) return null;
  const okand = m.utanKalla / m.besok;
  const viaLank = m.viaLank / m.besok;
  const ovrigt = 1 - okand - viaLank;
  const bra = okand <= OKAND_MAL;
  return (
    <section className={`resa-matning${bra ? "" : " resa-matning-svag"}`} aria-label={t("Hur väl mäter vi kanalerna?")}>
      <div className="resa-matning-topp">
        <span className="resa-matning-tal">{pct(m.utanKalla, m.besok)}</span>
        <span>
          <strong>{t("av besöken har okänd källa")}</strong>
          <Info text={t("Besök utan referrer och utan märkning. De räknas som Direkt, men är egentligen besök vi inte vet något om — från appar som Instagram och Messenger, inskrivna adresser och QR-koder utan kampanjlänk.")} />
          <span className="trafik-dampad">
            {" "}
            · {bra ? t("✓ under målet på {mal} %", { mal: OKAND_MAL * 100 }) : t("⚠ målet är under {mal} %", { mal: OKAND_MAL * 100 })}
          </span>
        </span>
      </div>
      <span className="resa-matning-stapel" aria-hidden>
        <span className="resa-matning-lank" style={{ width: `${viaLank * 100}%` }} />
        <span className="resa-matning-kand" style={{ width: `${ovrigt * 100}%` }} />
        <span className="resa-matning-okand" style={{ width: `${okand * 100}%` }} />
      </span>
      <p className="resa-teckenforklaring">
        <span className="resa-tecken resa-matning-lank" aria-hidden /> {t("via våra kampanjlänkar")} ({pct(m.viaLank, m.besok)})
        <span className="resa-tecken resa-matning-kand" aria-hidden /> {t("känd källa ändå")} ({pct(Math.max(0, m.besok - m.utanKalla - m.viaLank), m.besok)})
        <span className="resa-tecken resa-matning-okand" aria-hidden /> {t("okänd — räknas som Direkt")} ({pct(m.utanKalla, m.besok)})
      </p>
      <p className="trafik-text">
        {bra
          ? t("Kanalerna nedan går att lita på. Fortsätt dela Loopa med kampanjlänkar, så håller det i sig.")
          : t("Kanalerna nedan visar bara en del av sanningen. Instagram, Messenger, TikTok och affischer lämnar inga spår — de syns bara om länken är en kampanjlänk. Skapa en under fliken Kampanjlänkar och använd den varje gång ni delar Loopa.")}
        {m.annonserOkand > 0 && (
          <>
            {" "}
            {t("{a} av {b} annonser kommer från säljare vi aldrig såg komma in.", { a: m.annonserOkand, b: m.annonser })}
          </>
        )}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Kampanjlänkarna
// ---------------------------------------------------------------------------

const LANKBAS = "loopa.nu/k/";

/**
 * Kampanjlänkarna: en länk per ställe ni delar Loopa, och vad varje länk gav.
 *
 * VARFÖR I PANELEN OCH INTE "LÄGG TILL UTM". En UTM-märkning till säljsidan överlever inte vägen in
 * (se server/src/data/kampanjer.ts), och en märkning skriven för hand stavas olika varje gång. Här
 * väljer man VAR länken ska ligga, och resten — källan, kanalen, den korta adressen — följer av det.
 */
function Kampanjlankar({ data }: { data: Kundresa }) {
  const t = useT();
  const [lista, setLista] = useState<Kampanjer | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [namn, setNamn] = useState("");
  const [plats, setPlats] = useState("");
  const [mal, setMal] = useState("/");
  const [skapar, setSkapar] = useState(false);
  const [ny, setNy] = useState<string | null>(null);
  const [kopierad, setKopierad] = useState<string | null>(null);

  useEffect(() => {
    getKampanjer()
      .then(setLista)
      .catch((err: unknown) => setFel(err instanceof Error ? err.message : "Kunde inte hämta länkarna."));
  }, []);

  const resultat = new Map(data.perKampanj.map((k) => [k.kod, k]));
  const platsNamn = new Map(lista?.platser.map((p) => [p.id, p.namn]) ?? []);
  const malNamn = new Map(lista?.mal.map((m) => [m.id, m.namn]) ?? []);

  async function skapa() {
    setSkapar(true);
    setFel(null);
    try {
      const k = await skapaKampanj(namn, plats, mal);
      setLista((l) => (l ? { ...l, kampanjer: [k, ...l.kampanjer] } : l));
      setNy(k.kod);
      setNamn("");
    } catch (err) {
      setFel(err instanceof Error ? err.message : "Länken kunde inte skapas.");
    } finally {
      setSkapar(false);
    }
  }

  async function kopiera(kod: string) {
    try {
      await navigator.clipboard.writeText(`https://${LANKBAS}${kod}`);
      setKopierad(kod);
      window.setTimeout(() => setKopierad((k) => (k === kod ? null : k)), 2000);
    } catch {
      // Ingen urklippsbehörighet: länken står ändå i klartext att markera.
    }
  }

  async function taBort(k: Kampanj) {
    if (!window.confirm(t("Ta bort ”{namn}”? Länken fortsätter att fungera, men besöken räknas inte längre som en egen kampanj.", { namn: k.namn }))) return;
    try {
      await taBortKampanj(k.kod);
      setLista((l) => (l ? { ...l, kampanjer: l.kampanjer.filter((x) => x.kod !== k.kod) } : l));
    } catch (err) {
      setFel(err instanceof Error ? err.message : "Länken kunde inte tas bort.");
    }
  }

  return (
    <>
      <Fraga
        nr={1}
        titel={t("Skapa en kampanjlänk")}
        ingress={t("Välj var länken ska ligga, ge kampanjen ett namn och välj vart den leder. Varje besök genom länken räknas sedan till rätt kanal — också från Instagram, TikTok och affischer, som annars hamnar under Direkt.")}
      >
      <div className="resa-lank-ny">
        <label className="resa-falt">
          <span>{t("1. Var ska länken ligga?")}</span>
          <div className="resa-chips">
            {lista?.platser.map((p) => (
              <button key={p.id} type="button" className={`resa-chip${plats === p.id ? " vald" : ""}`} aria-pressed={plats === p.id} onClick={() => setPlats(p.id)}>
                {t(p.namn)}
              </button>
            ))}
          </div>
        </label>
        <label className="resa-falt">
          <span>{t("2. Vad heter kampanjen?")}</span>
          <input
            value={namn}
            maxLength={60}
            placeholder={t("t.ex. Höstrea vecka 43, eller Affisch Södermalm")}
            onChange={(e) => setNamn(e.target.value)}
          />
        </label>
        <div className="resa-falt">
          <span>{t("3. Vart ska den leda?")}</span>
          <div className="resa-chips">
            {lista?.mal.map((m) => (
              <button key={m.id} type="button" className={`resa-chip${mal === m.id ? " vald" : ""}`} aria-pressed={mal === m.id} onClick={() => setMal(m.id)}>
                {t(m.namn)}
              </button>
            ))}
          </div>
        </div>
        <button type="button" className="btn btn-primary btn-small" disabled={!plats || !namn.trim() || skapar} onClick={() => void skapa()}>
          {skapar ? t("Skapar…") : t("Skapa länk")}
        </button>
        {fel && <p className="public-card-error">{fel}</p>}
      </div>

      <Hopfallt titel={t("Så mäter ni varje kanal")}>
        <ul className="resa-guide">
          <li>
            <b>{t("Instagram och TikTok")}</b> — {t("en länk i profilen, en ny för varje kampanj eller story-serie. Appen skickar ingen källa, så utan länken syns besöket som Direkt.")}
          </li>
          <li>
            <b>{t("Facebook-grupper")}</b> — {t("en länk per grupp ni postar i. Då ser ni vilken grupp som ger säljare, inte bara att Facebook gör det.")}
          </li>
          <li>
            <b>{t("Betalda annonser")}</b> — {t("välj ”betald annons”, och en länk per annonsuppsättning. Jämför sedan annonser per 100 besök med vad klicken kostade.")}
          </li>
          <li>
            <b>{t("Affischer, flyers och visitkort")}</b> — {t("en länk per tryck, gärna som QR-kod. Koden är fem tecken och går att skriva av för hand.")}
          </li>
          <li>
            <b>{t("Blocket och Tradera")}</b> — {t("en länk i annonstexten där det är tillåtet.")}
          </li>
          <li>
            <b>{t("Nyhetsbrev och mejl")}</b> — {t("en länk per utskick.")}
          </li>
          <li>
            <b>{t("Mun till mun")}</b> — {t("syns via inbjudningslänkarna säljarna redan har (kanalen Inbjudan).")}
          </li>
        </ul>
      </Hopfallt>
      </Fraga>
      <Fraga
        nr={2}
        titel={t("Länkarna och vad de gav")}
        ingress={t("Varje länk steg för steg: besök, började sälja, annonser, sålda — och hur stor andel som gick vidare mellan stegen. Kopiera länken och dela den där den hör hemma.")}
      >
      {lista && lista.kampanjer.length > 0 && (
        <ul className="resa-lank-lista">
          {lista.kampanjer.map((k) => {
            const r = resultat.get(k.kod);
            return (
              <li key={k.kod} className={`resa-lank${ny === k.kod ? " resa-lank-ny-skapad" : ""}`}>
                <div className="resa-lank-topp">
                  <span className="resa-lank-namn">
                    <strong>{k.namn}</strong>
                    <span className="trafik-dampad">
                      {t(platsNamn.get(k.plats) ?? k.plats)} → {t(malNamn.get(k.mal) ?? k.mal)}
                    </span>
                  </span>
                  <span className="resa-lank-adress">
                    <code>
                      {LANKBAS}
                      {k.kod}
                    </code>
                    <button type="button" className="btn btn-outline btn-small" onClick={() => void kopiera(k.kod)}>
                      {kopierad === k.kod ? t("✓ Kopierad") : t("Kopiera")}
                    </button>
                  </span>
                </div>
                <div className="resa-lank-utfall">
                  {r && r.besok > 0 ? (
                    <>
                      <span className="resa-kanal-trappa">
                        <StegKedja
                          steg={[
                            { etikett: t("besök"), antal: r.besok },
                            { etikett: t("började sälja"), antal: r.borjade },
                            { etikett: t("annonser"), antal: r.fardigaBesok },
                            { etikett: t("sålda"), antal: r.salda },
                          ]}
                        />
                      </span>
                      <span className="trafik-dampad">
                        {t("Senast använd {datum}", { datum: datum(r.senast!) })}
                      </span>
                    </>
                  ) : (
                    <span className="trafik-dampad">{t("Inga besök genom länken under perioden än.")}</span>
                  )}
                  <button type="button" className="btn btn-text btn-inline resa-lank-bort" onClick={() => void taBort(k)}>
                    {t("Ta bort")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

        {lista && lista.kampanjer.length === 0 && (
          <p className="trafik-text trafik-dampad">{t("Inga länkar än. Skapa den första ovanför.")}</p>
        )}
        <SummeringLankar data={data} />
      </Fraga>
    </>
  );
}

// ---------------------------------------------------------------------------
// Ingångarna
// ---------------------------------------------------------------------------


/**
 * Var landar de, och vad gör de sedan?
 *
 * EN STEGKEDJA PER INGÅNG. En rad per sida folk kommer in på, och raden är dess steg: landade,
 * klickade vidare, började sälja, fick en färdig annons. Raden överst är alla besök, så att varje
 * ingång kan jämföras med helheten med ett ögonkast — en tratt som håller ihop bättre än den översta
 * är en bra ingång. Tryck på en rad för att se vart de gick härnäst.
 */
function Ingangarna({ data }: { data: Kundresa }) {
  const t = useT();
  const [oppen, setOppen] = useState<string | null>(null);
  // Säljarnas bild: den som tittade på möbler i butiken har inte börjat sälja, och räknas här som
  // en som tittade runt. Köparnas väg hör inte till den här fliken.
  const somSaljare = (x: KundresaIngang): KundresaIngang => ({ ...x, utfall: { ...x.utfall, tittade: x.utfall.tittade + x.utfall.mobler, mobler: 0 } });
  const alla = somSaljare(data.beteende.alla);
  const ingangar = data.beteende.ingangar.map(somSaljare);
  if (!alla.besok) return <p className="trafik-text trafik-dampad">{t("Inget underlag än.")}</p>;

  const salj = (i: KundresaIngang) => (i.utfall.salja + i.utfall.annons) / Math.max(1, i.besok);
  const bastSalj = [...ingangar].sort((a, b) => salj(b) - salj(a))[0];
  const flestLamnar = [...ingangar].sort((a, b) => b.utfall.lamnade / b.besok - a.utfall.lamnade / a.besok)[0];
  const meningar: ReactNode[] = [];
  if (bastSalj && salj(bastSalj) > salj(alla) * 1.1) {
    meningar.push(
      <>
        {t("Flest börjar sälja när de landar på")} <b>{sidNamn(bastSalj.sida)}</b>: {pct(bastSalj.utfall.salja + bastSalj.utfall.annons, bastSalj.besok)},{" "}
        {t("mot")} {pct(alla.utfall.salja + alla.utfall.annons, alla.besok)} {t("totalt. Låt kampanjlänkar för säljare leda dit.")}
      </>,
    );
  }
  if (flestLamnar && flestLamnar.utfall.lamnade / flestLamnar.besok > alla.utfall.lamnade / alla.besok * 1.1) {
    meningar.push(
      <>
        <b>{sidNamn(flestLamnar.sida)}</b> {t("tappar flest direkt")}: {pct(flestLamnar.utfall.lamnade, flestLamnar.besok)}{" "}
        {t("lämnar utan att klicka vidare. Den sidan behöver en tydligare första knapp.")}
      </>,
    );
  }

  return (
    <>
      <KortSagt meningar={meningar} />
      <ul className="resa-ingangar">
        {[alla, ...ingangar].map((i) => {
          const arAlla = i === alla;
          const ar = oppen === i.sida;
          return (
            <li key={i.sida} className={`resa-ingang${arAlla ? " resa-ingang-alla" : ""}`}>
              <button
                type="button"
                className="resa-ingang-knapp"
                disabled={arAlla}
                aria-expanded={arAlla ? undefined : ar}
                onClick={() => setOppen(ar ? null : i.sida)}
              >
                <span className="resa-ingang-namn">
                  <strong>{arAlla ? t("Alla besök") : sidNamn(i.sida)}</strong>
                  <span className="trafik-dampad">
                    {i.besok} {t("besök")}
                  </span>
                </span>
                <span className="resa-ingang-tratt">
                  <StegKedja
                    steg={[
                      { etikett: t("landade"), antal: i.besok },
                      { etikett: t("klickade vidare"), antal: i.besok - i.utfall.lamnade },
                      { etikett: t("började sälja"), antal: i.utfall.salja + i.utfall.annons },
                      { etikett: t("färdig annons"), antal: i.utfall.annons },
                    ]}
                  />
                </span>
                {!arAlla && (
                  <span className="resa-kanal-pil" aria-hidden>
                    {ar ? "▾" : "▸"}
                  </span>
                )}
              </button>
              {ar && (
                <div className="resa-ingang-inne">
                  <h4 className="resa-underrubrik">{t("Härnäst gick de till")}</h4>
                  <ul className="resa-konv-lista">
                    {i.nasta.map((n) => (
                      <li key={n.sida ?? "lamnade"} className="resa-nasta">
                        <span>{n.sida ? sidNamn(n.sida) : <i>{t("Ingenstans — lämnade")}</i>}</span>
                        <span className="resa-konv-stapel">
                          <span className={`resa-konv-fyllning${n.sida ? "" : " resa-utfall-lamnade"}`} style={{ width: `${(n.antal / i.besok) * 100}%` }} />
                        </span>
                        <b>{pct(n.antal, i.besok)}</b>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="trafik-text trafik-dampad">
        {t("Varje besök räknas en gång, efter hur långt det kom. Sidor med färre än fem besök står inte med.")}
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sidorna
// ---------------------------------------------------------------------------

const SEKTION_NAMN: Record<string, string> = {
  salj_hero: "Rubriken överst",
  salj_hur: "”Hur fungerar det?”",
  salj_marken: "Märkesvalet",
  salj_avgift: "Avgiften",
  salj_fot: "Sidfoten",
  butik_hero: "Länkrutan överst",
  butik_hur: "Så funkar det",
  butik_lagret: "”Eller köp något vi granskat”",
  butik_ai_sok: "AI-sökningen",
  butik_marken: "Märkena",
  butik_kategorier: "Kategorierna",
  butik_nyinkommet: "Nyinkommet",
  butik_billigast: "Billigast just nu",
  butik_hero_liten: "Länkrutan längst ned",
  produkt_bilder: "Bilderna",
  produkt_kop: "Köprutan",
  produkt_skick: "Skickrapporten",
  produkt_om: "Om möbeln",
  produkt_matt: "Måtten",
  produkt_chatt: "Chatten",
  salj_cta: "”Sälj din möbel”",
};

function Sidorna({ sidor }: { sidor: KundresaSida[] }) {
  const t = useT();
  const [vald, setVald] = useState<string | null>(null);
  const sida = sidor.find((s) => s.sida === vald) ?? sidor[0];
  if (!sida) {
    return (
      <p className="admin-note">
        {t("Ingen sida har mätts än. Scrolldjupet och sektionerna mäts från och med nu, och fylls på med nästa besökare.")}
      </p>
    );
  }
  return (
    <>
      {sidor.length > 1 && (
      <div className="admin-flikar resor-filter resa-valj" role="tablist" aria-label={t("Sida")}>
        {sidor.map((s) => (
          <button
            key={s.sida}
            type="button"
            role="tab"
            aria-selected={s.sida === sida.sida}
            className={`admin-flik-knapp${s.sida === sida.sida ? " vald" : ""}`}
            onClick={() => setVald(s.sida)}
          >
            {sidNamn(s.sida)}
          </button>
        ))}
      </div>
      )}

      <div className="resa-sida">
        <div className="resa-sida-djup">
          <h4 className="resa-underrubrik">{t("Hur långt ned de kommer")}</h4>
          {sida.medDjup === 0 ? (
            <p className="trafik-text trafik-dampad">{t("Inte mätt än.")}</p>
          ) : (
            <>
              {/* Sidan uppifrån och ned, som den ser ut: varje band är en fjärdedel av den. */}
              <ol className="resa-djup">
                {([25, 50, 75, 100] as const).map((d) => (
                  <li key={d} className="resa-djup-band" title={`${sida.djup[d]} ${t("av")} ${sida.medDjup}`}>
                    <span className="resa-djup-etikett">{d === 100 ? t("Hela sidan") : t("{d} % ned", { d })}</span>
                    <span className="resa-djup-stapel">
                      <span style={{ width: `${(sida.djup[d] / sida.medDjup) * 100}%` }} />
                    </span>
                    <b className="resa-djup-tal">{pct(sida.djup[d], sida.medDjup)}</b>
                  </li>
                ))}
              </ol>
              <p className="trafik-text trafik-dampad">{t("Av {antal} besök där det mättes.", { antal: sida.medDjup })}</p>
            </>
          )}
        </div>

        <div className="resa-sida-sektioner">
          <h4 className="resa-underrubrik">{t("Vad de ser — och trycker på")}</h4>
          {sida.sektioner.length === 0 ? (
            <p className="trafik-text trafik-dampad">{t("Sidan har inga mätta sektioner.")}</p>
          ) : (
            <ul className="resa-sektioner">
              {sida.sektioner.map((s) => (
                <li key={s.namn} className="resa-sektion">
                  <span className="resa-sektion-namn">{t(SEKTION_NAMN[s.namn] ?? s.namn)}</span>
                  <span className="resa-sektion-stapel" title={`${t("Sågs av")} ${s.sedd} · ${t("tryckte")} ${s.klick}`}>
                    <span className="resa-sektion-sedd" style={{ width: `${Math.min(100, (s.sedd / Math.max(1, sida.besok)) * 100)}%` }}>
                      <span className="resa-sektion-klick" style={{ width: `${s.sedd ? (s.klick / s.sedd) * 100 : 0}%` }} />
                    </span>
                  </span>
                  <span className="resa-sektion-tal">
                    {t("sågs av")} <b>{pct(s.sedd, sida.besok)}</b>
                    <span className="trafik-dampad"> · {t("{andel} av dem tryckte", { andel: pct(s.klick, s.sedd) })}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="resa-teckenforklaring">
            <span className="resa-tecken resa-tecken-sedd" aria-hidden /> {t("såg sektionen")}
            <span className="resa-tecken resa-tecken-klick" aria-hidden /> {t("tryckte i den")}
          </p>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Besöken
// ---------------------------------------------------------------------------

type AnvandarFilter = "fastnade" | "klara" | "saljare" | "alla";

/**
 * Användarna: en rad per besök, med personen i stället för sessionen.
 *
 * FÖRVALT ÄR DE SOM FASTNADE — de som började sälja men aldrig fick en färdig annons. Det är listan
 * att ringa från: namnet, skärmen de stannade på och felet de fick står på raden, och hela besöket
 * går att fälla ut. Den som aldrig loggade in står som besökare; mer än så vet vi inte om dem.
 */
function Anvandarna({ sessioner, onOpenUserId }: { sessioner: KundresaSession[]; onOpenUserId?: (id: string) => void }) {
  const t = useT();
  const [filter, setFilter] = useState<AnvandarFilter>("fastnade");
  const [oppen, setOppen] = useState<string | null>(null);
  const [antal, setAntal] = useState(20);
  const [namn, setNamn] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    listUsers()
      .then((svar) => setNamn(new Map(svar.users.map((u) => [u.id, u.name || u.email || u.id]))))
      .catch(() => undefined);
  }, []);
  const urval = useMemo(
    () =>
      sessioner.filter((s) =>
        filter === "fastnade" ? s.borjade && !s.intygat : filter === "klara" ? s.intygat : filter === "saljare" ? s.borjade : true,
      ),
    [sessioner, filter],
  );
  const raknat: Record<AnvandarFilter, number> = {
    fastnade: sessioner.filter((s) => s.borjade && !s.intygat).length,
    klara: sessioner.filter((s) => s.intygat).length,
    saljare: sessioner.filter((s) => s.borjade).length,
    alla: sessioner.length,
  };
  const filterNamn: Record<AnvandarFilter, string> = {
    fastnade: t("Fastnade"),
    klara: t("Fick en annons"),
    saljare: t("Alla som började sälja"),
    alla: t("Alla besök"),
  };
  return (
    <>
      <div className="admin-flikar resor-filter resa-valj" role="tablist" aria-label={t("Visa")}>
        {(Object.keys(filterNamn) as AnvandarFilter[]).map((f) => (
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
            {filterNamn[f]} <span className="resa-antal">{raknat[f]}</span>
          </button>
        ))}
      </div>
      <p className="trafik-text trafik-dampad">
        {filter === "fastnade"
          ? t("Började sälja men fick aldrig en färdig annons. Tryck på en rad för att se exakt vad som hände.")
          : filter === "klara"
            ? t("Kom hela vägen till ett färdigt kort under besöket.")
            : t("Tryck på en rad för att se hela besöket, steg för steg.")}
      </p>
      {urval.length === 0 ? (
        <p className="trafik-text trafik-dampad">{t("Ingen i det urvalet under perioden.")}</p>
      ) : (
        <ul className="trafik-konton">
          {urval.slice(0, antal).map((s) => {
            const vem = s.uid ? (namn.get(s.uid) ?? t("Konto {id}", { id: s.uid.slice(0, 6) })) : t("Besökare utan konto");
            return (
              <li key={s.sess}>
                <button
                  type="button"
                  className={`trafik-konto resa-person${oppen === s.sess ? " resor-oppen" : ""}`}
                  onClick={() => setOppen(oppen === s.sess ? null : s.sess)}
                  aria-expanded={oppen === s.sess}
                >
                  <span className="trafik-konto-topp">
                    <strong className={s.uid ? undefined : "resa-anonym"}>{vem}</strong>
                    <Status s={s} />
                  </span>
                  <span className="resa-person-fakta">
                    {s.borjade && !s.intygat && s.sistaSteg && (
                      <span>
                        {t("Stannade vid")} <b>{stegNamn(s.sistaSteg).toLowerCase()}</b>
                        {s.fel > 0 && <span className="resor-fel-text"> · {t("{n} fel", { n: s.fel })}</span>}
                      </span>
                    )}
                    <span className="trafik-dampad">
                      {datum(s.start)} {klocka(s.start)} · {s.enhet === "dator" ? t("Dator") : s.enhet === "mobil" ? t("Mobil") : t("okänd enhet")} · {s.kanal}
                      {s.kalla !== "direkt" && ` (${s.kalla})`}
                    </span>
                  </span>
                </button>
                {oppen === s.sess && <Tidslinje sess={s.sess} onOpenUserId={onOpenUserId} />}
              </li>
            );
          })}
        </ul>
      )}
      {urval.length > antal && (
        <button type="button" className="btn btn-text" onClick={() => setAntal((n) => n + 40)}>
          {t("Visa fler ({antal} kvar)", { antal: urval.length - antal })}
        </button>
      )}
      <SummeringAnvandare sessioner={sessioner} />
    </>
  );
}

function SummeringAnvandare({ sessioner }: { sessioner: KundresaSession[] }) {
  const t = useT();
  const borjade = sessioner.filter((s) => s.borjade);
  if (!borjade.length) return null;
  const klara = borjade.filter((s) => s.intygat);
  const fastnade = borjade.filter((s) => !s.intygat);
  const stopp = new Map<string, number>();
  for (const s of fastnade) if (s.sistaSteg) stopp.set(s.sistaSteg, (stopp.get(s.sistaSteg) ?? 0) + 1);
  const vanligast = [...stopp].sort((a, b) => b[1] - a[1])[0];
  const kanNas = fastnade.filter((s) => s.uid).length;
  return (
    <Sammanfattat
      rader={[
        { varde: pct(klara.length, borjade.length), etikett: t("Av dem som började fick en annons"), info: t("Av besöken där säljaren började filma: hur många som kom hela vägen till ett färdigt kort under samma besök."), forklaring: t("{a} av {b} besök", { a: klara.length, b: borjade.length }) },
        { varde: fastnade.length, etikett: t("Fastnade"), info: t("Besök där säljaren började filma men aldrig kom fram till en färdig annons.") },
        vanligast ? { varde: stegNamn(vanligast[0]), etikett: t("Vanligaste stoppet"), info: t("Skärmen där flest av dem som fastnade stannade."), forklaring: t("{n} av dem som fastnade", { n: vanligast[1] }) } : null,
        fastnade.length ? { varde: pct(kanNas, fastnade.length), etikett: t("Går att kontakta"), info: t("Andelen av dem som fastnade som var inloggade — vi har deras kontaktuppgifter och kan höra av oss."), forklaring: t("fastnade med ett konto — {n} personer", { n: kanNas }) } : null,
      ]}
    />
  );
}

/** Hur långt säljaren kom, i ord. Aldrig bara en färg. */
function Status({ s }: { s: KundresaSession }) {
  const t = useT();
  if (s.intygat) return <span className="rapport-status rapport-status-annons">✓ {t("Färdig annons")}</span>;
  if (s.borjade) return <span className="rapport-status rapport-status-borjat">{t("Fastnade")}</span>;
  if (s.sidor <= 1) return <span className="rapport-status rapport-status-inget">{t("Lämnade direkt")}</span>;
  return <span className="rapport-status rapport-status-inget">{t("Tittade runt")}</span>;
}

const HANDLING_NAMN: Record<string, string> = {
  view_item: "Såg en möbel i en lista",
  begin_checkout: "Gick till kassan",
  purchase: "Köpte",
  search: "Sökte",
  ai_search: "Sökte med AI",
  filter_use: "Filtrerade",
  outbound_tradera: "Gick vidare till Tradera",
  sell_cta_click: "Tryckte på ”Sälj”",
  sticky_cta_click: "Tryckte på den fasta säljknappen",
  hero_submit: "Klistrade in en annonslänk",
  hero_paste_start: "Började klistra in en länk",
  bevakning_created: "Bevakade",
  efterlysning_saved: "Sparade en efterlysning",
  wanted_page_visit: "Öppnade efterlysningarna",
  wanted_page_visit_sell_click: "Tryckte ”Sälj” från efterlysningarna",
  leta_bland_produkter: "Bläddrade i produkterna",
  utbudsrad_click: "Tryckte på en möbel i en rad",
  logga_in_fraga: "Ombads logga in",
  notification_clicked: "Öppnade en avisering",
  elsewhere_link_submitted: "Skickade in en annons från annat håll",
};

/**
 * Ett besök, punkt för punkt — samma ritning som uppladdningsfliken, med sidorna och butikens
 * händelser vävda in. Tiden sedan punkten innan står med: den är det som berättar något.
 */
function Tidslinje({ sess, onOpenUserId }: { sess: string; onOpenUserId?: (id: string) => void }) {
  const t = useT();
  const [linje, setLinje] = useState<KundresaTidslinje | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  useEffect(() => {
    getKundresaTidslinje(sess)
      .then(setLinje)
      .catch((err: unknown) => setFel(err instanceof Error ? err.message : "Kunde inte hämta besöket."));
  }, [sess]);
  if (fel) return <p className="public-card-error">{fel}</p>;
  if (!linje) return <p className="trafik-text trafik-dampad resor-tidslinje">{t("Hämtar besöket…")}</p>;
  return (
    <div className="resor-tidslinje">
      <ol>
        {linje.punkter.map((p, i) => {
          const fore = i > 0 ? Date.parse(p.at) - Date.parse(linje.punkter[i - 1].at) : 0;
          return (
            <li key={i} className={`resor-punkt resor-punkt-${p.flode ? p.flode.typ : p.typ}`}>
              <span className="resor-punkt-tid">
                {klocka(p.at, true)}
                {i > 0 && fore >= 1000 && <span className="resor-dampad"> +{varaktighet(fore)}</span>}
              </span>
              <span className="resor-punkt-markor" aria-hidden />
              <span className="resor-punkt-text">{punktTextFor(p, linje, t)}</span>
            </li>
          );
        })}
        <li className="resor-punkt resor-punkt-slut">
          <span className="resor-punkt-tid">{klocka(linje.slut, true)}</span>
          <span className="resor-punkt-markor" aria-hidden />
          <span className="resor-punkt-text">{t("Besöket tog slut här.")}</span>
        </li>
      </ol>
      <p className="trafik-text trafik-dampad">
        {[linje.kanal, linje.kalla !== "direkt" ? linje.kalla : null, linje.kampanj ? `${t("kampanj")} ${linje.kampanj}` : null, linje.enhet]
          .filter(Boolean)
          .join(" · ")}
        {linje.uid && onOpenUserId && (
          <>
            {" · "}
            <button type="button" className="btn btn-text btn-inline" onClick={() => onOpenUserId(linje.uid!)}>
              {t("Öppna kontot")}
            </button>
          </>
        )}
      </p>
    </div>
  );
}

function punktTextFor(p: KundresaPunkt, linje: KundresaTidslinje, t: (sv: string, vars?: Record<string, string | number>) => string): ReactNode {
  switch (p.typ) {
    case "landning":
      return (
        <>
          <b>{t("Kom in")}</b> {t("via")} {linje.kanal}
          {linje.kalla !== "direkt" && <> ({linje.kalla})</>}
          {p.sida && <> {t("på")} {sidNamn(p.sida)}</>}
        </>
      );
    case "sida":
      return (
        <>
          {t("Öppnade")} <b>{sidNamn(p.namn)}</b>
          {(p.ms !== null || p.djup !== null) && (
            <span className="resor-dampad">
              {" "}
              ({[p.ms !== null ? t("stannade {tid}", { tid: varaktighet(p.ms) }) : null, p.djup !== null ? t("läste {d} %", { d: p.djup }) : null]
                .filter(Boolean)
                .join(", ")}
              )
            </span>
          )}
        </>
      );
    case "handling":
      return (
        <>
          <b>{t(HANDLING_NAMN[p.namn] ?? p.namn)}</b>
          {p.objekt && <span className="resor-dampad"> · {p.objekt}</span>}
        </>
      );
    case "klick":
      return (
        <>
          {t("Tryckte i")} {t(SEKTION_NAMN[p.namn] ?? p.namn)}
        </>
      );
    case "flode":
      return p.flode ? punktText(p.flode, t) : p.namn;
  }
}

function klocka(iso: string, sekunder = false): string {
  return new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", ...(sekunder ? { second: "2-digit" } : {}) });
}
