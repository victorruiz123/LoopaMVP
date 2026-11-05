import { useState, type ReactNode } from "react";
import { useT } from "../lib/i18n";

/**
 * Byggstenarna för adminpanelens rapportflikar — Data och Trafik.
 *
 * SAMMA FORM I BÅDA, med flit. Flikarna läses av samma person i samma ärende — hur går det? — och
 * en sammanfattning, en numrerad fråga eller en tratt ska se likadan ut var den än står. Två flikar
 * med var sina varianter av samma sak är hur panelen blev oläslig från början.
 */

/** Svaret i klartext, överst. Meningarna räknas fram av den som anropar. */
export function KortSagt({ meningar }: { meningar: ReactNode[] }) {
  const t = useT();
  if (!meningar.length) return null;
  return (
    <section className="trafik-kortsagt" aria-label={t("Kort sagt")}>
      <h3 className="trafik-kortsagt-rubrik">{t("Kort sagt")}</h3>
      <ul>
        {meningar.map((m, i) => (
          <li key={i}>{m}</li>
        ))}
      </ul>
    </section>
  );
}

export function Fraga({ nr, titel, ingress, children }: { nr: number; titel: string; ingress: string; children: ReactNode }) {
  return (
    <section className="trafik-fraga">
      <h3 className="trafik-fraga-rubrik">
        <span className="trafik-fraga-nr" aria-hidden>
          {nr}
        </span>
        {titel}
      </h3>
      <p className="trafik-text trafik-dampad">{ingress}</p>
      {children}
    </section>
  );
}

export function Hopfallt({ titel, children }: { titel: string; children: ReactNode }) {
  return (
    <details className="trafik-hopfallt">
      <summary>{titel}</summary>
      <div className="trafik-hopfallt-inne">{children}</div>
    </details>
  );
}

/** Periodväljaren. Samma fyra perioder i båda flikarna. */
export function Period({ dagar, setDagar }: { dagar: number; setDagar: (d: number) => void }) {
  const t = useT();
  return (
    <div className="admin-flikar trafik-period" role="tablist" aria-label={t("Period")}>
      {[7, 30, 90, 365].map((d) => (
        <button
          key={d}
          type="button"
          role="tab"
          aria-selected={dagar === d}
          className={`admin-flik-knapp${dagar === d ? " vald" : ""}`}
          onClick={() => setDagar(d)}
        >
          {d === 365 ? t("12 mån") : t("{antal} dagar", { antal: d })}
        </button>
      ))}
    </div>
  );
}

/**
 * Ett nyckeltal med sin förklaring och, när den finns, jämförelsen med perioden innan.
 *
 * Förklaringen är inte valfri. Ett tal utan en rad om vad det betyder är exakt det som gjorde den
 * gamla datafliken oläslig.
 */
export function Nyckeltal({
  varde,
  etikett,
  forklaring,
  info,
  nu,
  forra,
  mot,
}: {
  varde: ReactNode;
  etikett: string;
  forklaring?: string;
  /** Vad talet betyder och hur det räknas. Visas bakom ⓘ. */
  info?: string;
  nu?: number;
  forra?: number | null;
  /** Vad jämförelsen görs mot, i ord. Standard: "förra perioden". */
  mot?: string;
}) {
  return (
    <div className="rapport-tal">
      <div className="rapport-tal-varde">{varde}</div>
      <div className="rapport-tal-etikett">
        {etikett}
        {info && <Info text={info} />}
      </div>
      {nu !== undefined && forra !== undefined && <Trend nu={nu} forra={forra} mot={mot} />}
      {forklaring && <div className="rapport-tal-forklaring">{forklaring}</div>}
    </div>
  );
}

/**
 * Upp eller ned mot förra perioden, i ord och pil — aldrig bara i färg.
 *
 * Från noll finns ingen procent att räkna; då står ökningen som ett antal. Saknas förra perioden
 * helt (den mättes inte) står ingenting, i stället för en jämförelse mot en nolla som inte är sann.
 */
export function Trend({ nu, forra, mot }: { nu: number; forra: number | null; mot?: string }) {
  const t = useT();
  if (forra === null) return null;
  const vad = mot ?? t("förra perioden");
  if (nu === forra) return <div className="rapport-trend">→ {t("samma som")} {vad}</div>;
  const upp = nu > forra;
  const text =
    forra === 0 ? `${t("{antal} fler än", { antal: nu })} ${vad}` : `${Math.round(Math.abs((nu - forra) / forra) * 100)} % ${upp ? t("fler") : t("färre")} ${t("än")} ${vad}`;
  return <div className={`rapport-trend ${upp ? "upp" : "ned"}`}>{upp ? "↑" : "↓"} {text}</div>;
}

export function Tratt({ steg }: { steg: Array<{ namn: string; antal: number; hjalp?: string }> }) {
  const forsta = Math.max(1, steg[0]?.antal ?? 1);
  return (
    <ol className="trafik-tratt">
      {steg.map((s, i) => (
        <li key={s.namn} className="trafik-tratt-steg">
          <div className="trafik-tratt-text">
            <strong>{s.namn}</strong>
            {s.hjalp && <span className="trafik-dampad">{s.hjalp}</span>}
          </div>
          <span className="data-tratt-stapel trafik-tratt-stapel" aria-hidden>
            <span className="data-tratt-fyllning" style={{ width: `${(s.antal / forsta) * 100}%` }} />
          </span>
          <span className="trafik-tratt-tal">
            <b>{s.antal}</b>
            {i > 0 && <span className="trafik-dampad"> {pct(s.antal, forsta)}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function TopLista({
  titel,
  hjalp,
  rader,
}: {
  titel: string;
  hjalp?: string;
  rader: Array<{ namn: string; antal: number; notis?: string | null }>;
}) {
  const t = useT();
  const max = Math.max(1, ...rader.map((r) => r.antal));
  return (
    <div className="trafik-toplista">
      <h4>{titel}</h4>
      {hjalp && <p className="trafik-text trafik-dampad">{hjalp}</p>}
      {rader.length === 0 ? (
        <p className="trafik-text trafik-dampad">{t("Inget underlag än.")}</p>
      ) : (
        rader.map((r) => (
          <div className="data-tratt-rad trafik-stapel-rad" key={r.namn}>
            <span className="trafik-stapel-namn" title={r.namn}>
              {r.namn}
            </span>
            <span className="data-tratt-stapel" aria-hidden>
              <span className="data-tratt-fyllning" style={{ width: `${(r.antal / max) * 100}%` }} />
            </span>
            <span className="data-tratt-tal">
              {r.antal}
              {r.notis && <span className="data-tratt-tid">{r.notis}</span>}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

export function pct(del: number, hel: number): string {
  if (!hel) return "—";
  const p = (del / hel) * 100;
  return `${p > 0 && p < 1 ? p.toFixed(1) : Math.round(p)} %`;
}

export function datum(iso: string): string {
  return new Date(iso).toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
}

export const STEG_NAMN: Record<string, string> = {
  capture: "filmning",
  signup: "skapa konto",
  login: "logga in",
  publishSignup: "skapa konto",
  starting: "uppladdning",
  identify: "välj modell",
  specs: "detaljer",
  price: "pris",
  analysis: "besiktning",
  result: "skickrapport",
  listing: "färdigt kort",
  profile: "profilen",
};

/**
 * Adressen som en människa läser den.
 *
 * Panelen visar aldrig en rå adress när det finns ett namn: "/ · capture" säger ingenting, "Sälj:
 * filmning" säger allt. Okända sidor visas som de är — hellre fult än fel.
 */
export function sidNamn(sida: string): string {
  if (sida === "/") return "Startsidan";
  const vy = /^\/ · (.+)$/.exec(sida)?.[1];
  if (vy) return vy === "profile" ? "Profilen" : `Sälj: ${STEG_NAMN[vy] ?? vy}`;
  const exakt: Record<string, string> = {
    "/kop": "Köpsidan",
    "/kop/analysera": "Trygg affär: analysera",
    "/kop/mina-efterlysningar": "Mina efterlysningar",
    "/efterlyses": "Efterlysningar",
    "/butik": "Butiken",
    "/butik/profil": "Profilen",
    "/c/:id": "Publikt kort",
    "/i/:kod": "Inbjudningslänk",
    "/p/:kod": "Affiliatelänk",
    "/a/:kod": "Trygg affär: inbjudan",
    "/affar/:id": "Trygg affär: affären",
    "/integritetspolicy": "Integritetspolicy",
    "/cookies": "Cookiepolicy",
    "/villkor": "Villkor",
  };
  if (exakt[sida]) return exakt[sida];
  if (sida.startsWith("/efterlyses/")) return `Efterlysningar: ${sida.slice("/efterlyses/".length)}`;
  if (sida.startsWith("/butik/mobel/")) return `Butik: ${sida.slice("/butik/mobel/".length)}`;
  if (sida.startsWith("/butik/annons/")) return "Butik: säljarens annons";
  if (sida.startsWith("/butik/info/")) return "Butik: annonsinfo";
  if (sida.startsWith("/butik/")) return "Butik: produkt";
  return sida;
}

/**
 * ⓘ: vad ett tal betyder och hur det räknas.
 *
 * VID TALET, INTE I EN ORDLISTA. Den som undrar vad "annonser per 100 besök" är ska få svaret där
 * frågan uppstår. Visas när muspekaren eller fokus hamnar på tecknet, och fästs med ett tryck — en
 * telefon har ingen muspekare.
 */
export function Info({ text }: { text: string }) {
  const t = useT();
  const [oppen, setOppen] = useState(false);
  return (
    <span className={`rapport-info${oppen ? " oppen" : ""}`}>
      <button
        type="button"
        className="rapport-info-knapp"
        aria-label={t("Vad betyder det här?")}
        aria-expanded={oppen}
        onClick={(e) => {
          e.stopPropagation();
          setOppen((o) => !o);
        }}
        onBlur={() => setOppen(false)}
      >
        i
      </button>
      <span className="rapport-info-text" role="tooltip">
        {text}
      </span>
    </span>
  );
}
