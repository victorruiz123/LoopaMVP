import { useState } from "react";
import { useT } from "../lib/i18n";
import { formatSek } from "../lib/price";
import type { BlocketAnnonsSiffror, BlocketDag, KanalStatistik, TraderaAnnonsSiffror } from "../types";
import blocketMark from "../assets/kanaler/blocket.png";
import traderaMark from "../assets/kanaler/tradera.png";

/**
 * Hur annonsen går på Tradera och Blocket — allt marknadsplatserna själva visar säljaren
 * (server/src/kanalStatistik.ts).
 *
 * EN SEKTION PER KANAL, med det kanalen faktiskt lämnar ut och inget annat. Tradera har visningar,
 * bevakare och bud; Blocket har klick, besökare, kontakter, favoriter, bevakningsmejl och en egen
 * historik dag för dag. Att ställa dem i samma kolumner hade krävt nollor som inte är sanna.
 *
 * HUVUDTALEN FÖRST, stora. Det som förklarar dem — hur många som fått ett bevakningsmejl, hur ofta
 * besökarna kommer tillbaka — står under, mindre. Diagrammet visar riktningen: en annons vars klick
 * dör ut efter första veckan behöver något annat än en som får jämnt med klick.
 *
 * Siffrorna är robotarnas senaste avläsning, och tidpunkten står därför alltid utskriven.
 */
export default function AnnonsStatistik({ statistik }: { statistik: KanalStatistik }) {
  const t = useT();
  const { tradera, blocket } = statistik;
  if (!tradera && !blocket) return null;

  return (
    <div className="annons-statistik">
      <span className="ladder-row-label">{t("Så går annonsen")}</span>
      {tradera && tradera.annonser.length > 0 && <TraderaSektion s={tradera} />}
      {blocket && blocket.annonser.length > 0 && <BlocketSektion s={blocket} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tradera
// ---------------------------------------------------------------------------

const TRADERA_STATUS: Record<string, string> = {
  Active: "Ligger ute",
  Unsold: "Gick ut osåld",
  Sold: "Såld",
};

function TraderaSektion({ s }: { s: NonNullable<KanalStatistik["tradera"]> }) {
  const t = useT();
  const sum = s.annonser.reduce(
    (a, x) => ({ visningar: a.visningar + x.visningar, bevakare: a.bevakare + x.bevakare, bud: a.bud + x.bud }),
    { visningar: 0, bevakare: 0, bud: 0 },
  );
  const konv = s.annonser.some((a) => a.konversationer !== null)
    ? s.annonser.reduce((n, a) => n + (a.konversationer ?? 0), 0)
    : null;
  // Visningar per dag ur våra egna dagspunkter: Tradera sparar ingen historik vi kan läsa. Saknas en
  // dag (servern låg nere) hamnar flera dagars visningar på samma stapel — det står då vid stapeln.
  const perDag = s.historik.slice(1).map((p, i) => {
    const fore = s.historik[i];
    const dagar = Math.round((dagStart(p.at) - dagStart(fore.at)) / 86_400_000);
    return {
      datum: svenskDag(p.at),
      varde: Math.max(0, p.visningar - fore.visningar),
      extra: dagar > 1 ? t("sammanlagt för {n} dagar", { n: dagar }) : undefined,
    };
  });

  return (
    <div className="annons-statistik-kanal">
      <span className="annons-statistik-namn">
        <img src={traderaMark} alt="" /> Tradera
      </span>
      <div className="annons-statistik-tal">
        <Tal varde={sum.visningar} okning={s.igar ? sum.visningar - s.igar.visningar : null} etikett={t("visningar")} />
        <Tal varde={sum.bevakare} okning={s.igar ? sum.bevakare - s.igar.bevakare : null} etikett={t("bevakar")} />
        <Tal varde={sum.bud} okning={s.igar ? sum.bud - s.igar.bud : null} etikett={t("bud")} />
        {konv !== null && <Tal varde={konv} okning={null} etikett={t("köpare har skrivit")} />}
      </div>
      {s.igar && <p className="muted small annons-statistik-not">{t("Gröna tal är ökningen sedan i går.")}</p>}
      {perDag.length >= 3 && <Stapeldiagram rubrik={t("Visningar per dag")} enhet={t("visningar")} dagar={perDag} />}
      <ul className="annons-statistik-annonser">
        {s.annonser.map((a) => (
          <TraderaRad key={a.itemId} a={a} flera={s.annonser.length > 1} />
        ))}
      </ul>
      <p className="muted small">{t("Från Traderas säljarsidor {tid}.", { tid: datum(s.at) })}</p>
    </div>
  );
}

function TraderaRad({ a, flera }: { a: TraderaAnnonsSiffror; flera: boolean }) {
  const t = useT();
  const delar = [
    t(TRADERA_STATUS[a.status] ?? a.status),
    a.prisSek !== null ? (a.typ === "PureBin" ? t("Köp nu {pris}", { pris: formatSek(a.prisSek) }) : t("Ledande bud {pris}", { pris: formatSek(a.prisSek) })) : null,
    a.aktiv && a.slutar ? t("slutar {datum}", { datum: datum(a.slutar) }) : null,
    flera ? t("{v} visningar · {b} bevakar", { v: a.visningar, b: a.bevakare }) : null,
  ].filter(Boolean);
  return (
    <li>
      {flera && <strong>{a.aktuell ? t("Aktuell annons") : t("Äldre annons som ligger kvar")}: </strong>}
      {delar.join(" · ")}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Blocket
// ---------------------------------------------------------------------------

/** Annonsernas dagar ihop, per datum. En möbel med en kvarlämnad annons har två historiker. */
function summeraDagar(annonser: BlocketAnnonsSiffror[]): Array<{ datum: string; dag: BlocketDag }> {
  const per = new Map<string, BlocketDag>();
  for (const a of annonser) {
    for (const d of a.perDag) {
      const f = per.get(d.datum);
      per.set(
        d.datum,
        f
          ? {
              datum: d.datum,
              klick: f.klick + d.klick,
              chattsvar: f.chattsvar + d.chattsvar,
              mejlsvar: f.mejlsvar + d.mejlsvar,
              favoriter: f.favoriter + d.favoriter,
              nyaFavoriter: f.nyaFavoriter + d.nyaFavoriter,
              klickStartsidan: f.klickStartsidan + d.klickStartsidan,
              klickMarknadsforing: f.klickMarknadsforing + d.klickMarknadsforing,
              klickTopplacering: f.klickTopplacering + d.klickTopplacering,
              klickRekommendation: f.klickRekommendation + d.klickRekommendation,
            }
          : d,
      );
    }
  }
  return [...per.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([datum, dag]) => ({ datum, dag }));
}

function summaAv(annonser: BlocketAnnonsSiffror[], falt: "mejlnotiser" | "pushnotiser" | "besokare" | "klickOkadSynlighet"): number | null {
  const varden = annonser.map((a) => a[falt]).filter((v): v is number => v !== null);
  return varden.length ? varden.reduce((n, v) => n + v, 0) : null;
}

function BlocketSektion({ s }: { s: NonNullable<KanalStatistik["blocket"]> }) {
  const t = useT();
  const a = s.annonser;
  const sum = (f: "klick" | "kontakter" | "favoriter") => a.reduce((n, x) => n + x[f], 0);
  const dagar = summeraDagar(a);
  // "I dag" är Blockets egen dag — den sista i historiken, om den är i dag.
  const idag = dagar.length && dagar[dagar.length - 1].datum === new Date().toLocaleDateString("sv-SE") ? dagar[dagar.length - 1].dag : null;
  const besokare = summaAv(a, "besokare");
  const mejl = summaAv(a, "mejlnotiser");
  const push = summaAv(a, "pushnotiser");
  const synlighet = summaAv(a, "klickOkadSynlighet");
  const fordelning = a.length === 1 ? a[0].besokFordelning : null;
  const fran = dagar.reduce(
    (f, { dag }) => ({
      startsidan: f.startsidan + dag.klickStartsidan,
      rekommendation: f.rekommendation + dag.klickRekommendation,
      topplacering: f.topplacering + dag.klickTopplacering,
      marknadsforing: f.marknadsforing + dag.klickMarknadsforing,
    }),
    { startsidan: 0, rekommendation: 0, topplacering: 0, marknadsforing: 0 },
  );
  const aktuell = a.find((x) => x.aktuell) ?? a[0];

  return (
    <div className="annons-statistik-kanal">
      <span className="annons-statistik-namn">
        <img src={blocketMark} alt="" /> Blocket
      </span>
      <div className="annons-statistik-tal">
        <Tal varde={sum("klick")} okning={idag?.klick ?? null} okningEtikett={t("i dag")} etikett={t("klick")} />
        {besokare !== null && <Tal varde={besokare} okning={null} etikett={t("besökare")} />}
        <Tal varde={sum("favoriter")} okning={idag?.nyaFavoriter ?? null} okningEtikett={t("i dag")} etikett={t("sparat som favorit")} />
        <Tal varde={sum("kontakter")} okning={null} etikett={sum("kontakter") === 1 ? t("kontakt") : t("kontakter")} />
      </div>

      {dagar.length >= 3 && (
        <Stapeldiagram
          rubrik={t("Klick per dag")}
          enhet={t("klick")}
          dagar={dagar.map(({ datum, dag }) => ({
            datum,
            varde: dag.klick,
            extra: [
              dag.nyaFavoriter > 0 ? t("{n} nya favoriter", { n: dag.nyaFavoriter }) : null,
              dag.chattsvar + dag.mejlsvar > 0 ? t("{n} meddelanden", { n: dag.chattsvar + dag.mejlsvar }) : null,
            ]
              .filter(Boolean)
              .join(" · "),
          }))}
        />
      )}

      <ul className="annons-statistik-detaljer">
        {fordelning && (
          <li>
            {t("Besökarna: {en} kom en gång, {fa} två till fem gånger, {fler} fler än fem gånger.", {
              en: fordelning.enGang,
              fa: fordelning.tvaTillFem,
              fler: fordelning.flerAnFem,
            })}
          </li>
        )}
        {(mejl !== null || push !== null) && (
          <li>
            {t("Blocket har tipsat om annonsen i {mejl} bevakningsmejl och {push} pushnotiser.", { mejl: mejl ?? 0, push: push ?? 0 })}
          </li>
        )}
        {(fran.startsidan > 0 || fran.rekommendation > 0 || fran.topplacering > 0 || fran.marknadsforing > 0 || (synlighet ?? 0) > 0) && (
          <li>
            {[
              fran.startsidan > 0 ? t("{n} klick från startsidan", { n: fran.startsidan }) : null,
              fran.rekommendation > 0 ? t("{n} från rekommendationer", { n: fran.rekommendation }) : null,
              fran.topplacering + fran.marknadsforing > 0 ? t("{n} från ökad synlighet", { n: fran.topplacering + fran.marknadsforing }) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </li>
        )}
        {a.length > 1 && <li>{t("Räknat över {n} annonser — en äldre annons ligger kvar för att en köpare skrivit till den.", { n: a.length })}</li>}
        {aktuell.dagarKvar !== null && <li>{t("{n} dagar kvar på Blocket.", { n: aktuell.dagarKvar })}</li>}
      </ul>
      <p className="muted small">{t("Från Blockets statistiksida {tid}.", { tid: datum(s.at) })}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delar
// ---------------------------------------------------------------------------

/** Ett huvudtal med sin ökning. Ingen ökning visas när den är noll eller okänd. */
function Tal({ varde, okning, etikett, okningEtikett }: { varde: number; okning: number | null; etikett: string; okningEtikett?: string }) {
  return (
    <span className="annons-statistik-tal-post">
      <strong>{varde.toLocaleString("sv-SE")}</strong> <small>{etikett}</small>
      {okning !== null && okning > 0 && (
        <span className="annons-statistik-okning">
          +{okning.toLocaleString("sv-SE")}
          {okningEtikett ? ` ${okningEtikett}` : ""}
        </span>
      )}
    </span>
  );
}

/**
 * Ett stapeldiagram, en serie: en stapel per dag. Ingen förklaringsruta — rubriken säger vad det är.
 *
 * Tunna staplar med rundade toppar mot en svag baslinje, 2 px luft mellan dem. Talet för en dag syns
 * när man pekar eller trycker på stapeln (raden under diagrammet), och samma tal finns som tabell för
 * den som inte ser diagrammet. Högst de senaste 60 dagarna — längre än så blir staplarna trådar.
 */
function Stapeldiagram({ rubrik, enhet, dagar }: { rubrik: string; enhet: string; dagar: Array<{ datum: string; varde: number; extra?: string }> }) {
  const t = useT();
  const [vald, setVald] = useState<number | null>(null);
  const visa = dagar.slice(-60);
  const max = Math.max(1, ...visa.map((d) => d.varde));
  const aktiv = vald !== null ? visa[vald] : null;

  return (
    <figure className="stapel">
      <figcaption className="stapel-rubrik">
        <span>{rubrik}</span>
        <span className="stapel-max">
          {t("högst {n}", { n: max })}
        </span>
      </figcaption>
      {/* Hela ytan är träffytan: på en telefon är en stapel några pixlar bred, så fingret drar längs
          diagrammet och dagen under det väljs. */}
      <div
        className="stapel-yta"
        role="img"
        aria-label={`${rubrik}, ${visa.length} ${t("dagar")}`}
        onMouseLeave={() => setVald(null)}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setVald(Math.min(visa.length - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * visa.length))));
        }}
      >
        {visa.map((d, i) => (
          <button
            key={d.datum}
            type="button"
            className={`stapel-kolumn${vald === i ? " vald" : ""}`}
            onMouseEnter={() => setVald(i)}
            onFocus={() => setVald(i)}
            onClick={() => setVald(i)}
            aria-label={`${kortDatum(d.datum)}: ${d.varde} ${enhet}`}
          >
            {d.varde > 0 && <span className="stapel-stapel" style={{ height: `${(d.varde / max) * 100}%` }} />}
          </button>
        ))}
      </div>
      <div className="stapel-axel">
        <span>{kortDatum(visa[0].datum)}</span>
        <span>{kortDatum(visa[visa.length - 1].datum)}</span>
      </div>
      <p className="stapel-avlasning muted small" aria-live="polite">
        {aktiv
          ? `${kortDatum(aktiv.datum)}: ${aktiv.varde.toLocaleString("sv-SE")} ${enhet}${aktiv.extra ? ` · ${aktiv.extra}` : ""}`
          : t("Peka eller dra över diagrammet för dagens siffror.")}
      </p>
      <details className="stapel-tabell">
        <summary className="muted small">{t("Visa som tabell")}</summary>
        <table>
          <tbody>
            {[...visa].reverse().map((d) => (
              <tr key={d.datum}>
                <th scope="row">{kortDatum(d.datum)}</th>
                <td>{d.varde.toLocaleString("sv-SE")}</td>
                {d.extra !== undefined && <td>{d.extra}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** Datumet i svensk tid som "ÅÅÅÅ-MM-DD" — en avläsning 00:30 hör till den dagen, inte till UTC:s. */
function svenskDag(iso: string): string {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
}

function dagStart(iso: string): number {
  return Date.parse(`${svenskDag(iso)}T00:00:00Z`);
}

function kortDatum(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
}

function datum(iso: string): string {
  return new Date(iso).toLocaleString("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
