/**
 * Skickbedömningen: skadorna en och en, sedan helheten.
 *
 * Säljaren får EN skada åt gången — bilden fyller kortet, och frågan och svaren ligger ovanpå på
 * glas: "Ja, det stämmer", "Ingen skada" eller "Redigera". När alla är besvarade visas helheten:
 * betyget i en ring, skickets namn och skadorna som små bilder, och därifrån "Till annonsen".
 *
 * Togs fram i experimentet experiment/skickvy (oktober 2026) och ersatte den tidigare listan, där
 * alla fynd stod som kort med två knappar var och fyra knappar under.
 */
import { useEffect, useRef, useState } from "react";
import { actOnDamage, addDamageFromPhoto, getJob, imageUrl } from "../api";
import type { ConditionResult, Damage } from "../types";
import GradeBadge from "../components/GradeBadge";
import EvidenceViewer from "../components/EvidenceViewer";
import { AlertIcon, ArrowLeftIcon, CameraIcon, ChevronRight } from "../components/icons";
import FlowSteps from "../components/FlowSteps";
import { DAMAGE_TYPE_OPTIONS, SEVERITY_OPTIONS, typeLabel, severityLabel } from "../lib/labels";
import { usePageTitle } from "../lib/pageTitle";
import { t as translate, useT } from "../lib/i18n";

type Lage = { steg: "granska"; index: number } | { steg: "helhet" };

export default function ResultScreen({
  jobId,
  onHome,
  onContinue,
}: {
  jobId: string;
  onHome: () => void;
  onContinue: (result: ConditionResult) => void;
}) {
  const t = useT();
  usePageTitle("Skickbedömning");
  const [result, setResult] = useState<ConditionResult | null>(null);
  const [lage, setLage] = useState<Lage | null>(null);
  const [sparar, setSparar] = useState(false);
  const [redigerar, setRedigerar] = useState(false);
  const [viewer, setViewer] = useState<Damage | null>(null);
  const [besked, setBesked] = useState<string | null>(null);
  const [laggerTill, setLaggerTill] = useState(false);
  const fotoRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const j = await getJob(jobId);
        if (cancelled) return;
        if (j.result) setResult(j.result);
        if (j.result?.reviewPending || j.result?.listing?.status === "pending") setTimeout(poll, 1500);
      } catch {
        if (!cancelled) setTimeout(poll, 2500);
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // Var säljaren börjar: vid första skadan som inte är besvarad, eller direkt i helheten om alla är det.
  useEffect(() => {
    if (!result || lage) return;
    const skador = attGranska(result);
    const forsta = skador.findIndex((d) => !d.sellerAction);
    setLage(forsta === -1 ? { steg: "helhet" } : { steg: "granska", index: forsta });
  }, [result, lage]);

  if (!result || !lage) {
    return (
      <div className="screen screen-light center-column">
        <div className="spinner" />
        <p>{t("Laddar resultat…")}</p>
      </div>
    );
  }

  const skador = attGranska(result);

  /** Sparar svaret och går vidare till nästa skada — eller till helheten efter den sista. */
  async function svara(d: Damage, action: "confirm" | "reject" | "edit", patch?: Parameters<typeof actOnDamage>[3]) {
    if (lage?.steg !== "granska") return;
    setSparar(true);
    try {
      const nytt = await actOnDamage(jobId, d.id, action, patch);
      setResult(nytt);
      setRedigerar(false);
      const nasta = lage.index + 1;
      setLage(nasta < attGranska(nytt).length ? { steg: "granska", index: nasta } : { steg: "helhet" });
    } finally {
      setSparar(false);
    }
  }

  async function fotoValt(e: React.ChangeEvent<HTMLInputElement>) {
    const fil = e.target.files?.[0];
    e.target.value = "";
    if (!fil) return;
    setLaggerTill(true);
    setBesked(null);
    try {
      const r = await addDamageFromPhoto(jobId, await tillDataUrl(fil));
      setResult(r.result);
      setBesked(r.added ? t("Skadan lades till.") : r.reason);
    } catch (err) {
      setBesked(err instanceof Error ? err.message : t("Något gick fel."));
    } finally {
      setLaggerTill(false);
    }
  }

  const rubrik = result.identity ? [result.identity.brand, result.identity.model].filter(Boolean).join(" ") : null;

  // -------------------------------------------------------------------------------------------
  // Steg 1: en skada i taget
  // -------------------------------------------------------------------------------------------
  if (lage.steg === "granska") {
    const d = skador[lage.index];
    const bild = d.evidence[0];
    const bildMeta = bild ? result.images.find((i) => i.id === bild.imageId) : undefined;

    return (
      <div className="screen screen-light v2">
        <button className="btn btn-text btn-back" onClick={onHome}>
          <ArrowLeftIcon /> {t("Startsidan")}
        </button>
        <FlowSteps current={4} />

        {/*
          KORTET. Bilden i sina egna proportioner, så stor som skärmen tillåter, och frågan och svaren
          ovanpå den på en glasyta. Resten av bilden mörknar lätt så att blicken går till skadan —
          markeringen är det enda som är fullt upplyst. `key` gör varje skada till ett nytt kort, som
          glider in när föregående är besvarad.
        */}
        <Kort
          key={d.id}
          liten={redigerar}
          bildMeta={bildMeta}
          mark={bild?.mark ?? null}
          bild={bild ? (
            <button className="v2-kort-bild" onClick={() => setViewer(d)} aria-label={t("Visa bilden större")}>
              <img src={imageUrl(jobId, bild.imageId)} alt="" />
              {bild.mark.kind === "box" ? (
                <span
                  className="v2-strålkastare"
                  style={{
                    left: `${bild.mark.x * 100}%`,
                    top: `${bild.mark.y * 100}%`,
                    width: `${(bild.mark.w ?? 0.1) * 100}%`,
                    height: `${(bild.mark.h ?? 0.1) * 100}%`,
                  }}
                />
              ) : (
                <svg className="v2-linje" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                  <line x1={bild.mark.x * 100} y1={bild.mark.y * 100} x2={(bild.mark.x2 ?? bild.mark.x) * 100} y2={(bild.mark.y2 ?? bild.mark.y) * 100} />
                </svg>
              )}
            </button>
          ) : (
            <div className="v2-kort-bild v2-kort-tom">{t("Ingen bild på den här skadan")}</div>
          )}
        >
          {/* Överst: frågan och var i högen man är. Prickarna leder tillbaka till en tidigare skada. */}
          <div className="v2-glas v2-kort-topp">
            <span className="v2-kort-fraga">{t("Stämmer denna skada?")}</span>
            <span className="v2-prickar" aria-label={t("Skada {nr} av {antal}", { nr: lage.index + 1, antal: skador.length })}>
              {skador.map((s, i) => (
                <button
                  key={s.id}
                  className={`v2-prick${i === lage.index ? " nu" : ""}${s.sellerAction === "rejected" ? " nej" : s.sellerAction ? " ja" : ""}`}
                  onClick={() => {
                    setRedigerar(false);
                    setLage({ steg: "granska", index: i });
                  }}
                  aria-label={t("Skada {nr}", { nr: i + 1 })}
                />
              ))}
            </span>
          </div>

          {!redigerar && (
            <div className="v2-glas v2-kort-botten">
              <h2 className="v2-namn">{typeLabel(d.type)}</h2>
              <div className="v2-knappar">
                <button className="v2-knapp v2-knapp-nej" disabled={sparar} onClick={() => void svara(d, "reject")}>
                  {t("Ingen skada")}
                </button>
                <button className="v2-knapp v2-knapp-ja" disabled={sparar} onClick={() => void svara(d, "confirm")}>
                  {t("Ja, det stämmer")}
                </button>
              </div>
              <button className="v2-redigera-lank" disabled={sparar} onClick={() => setRedigerar(true)}>
                {t("Redigera")}
              </button>
            </div>
          )}
        </Kort>

        {redigerar && (
          <Redigera
            skada={d}
            sparar={sparar}
            onAvbryt={() => setRedigerar(false)}
            onSpara={(patch) => void svara(d, "edit", patch)}
          />
        )}

        {viewer && (
          <EvidenceViewer jobId={jobId} damage={viewer} images={result.images} startIndex={0} onClose={() => setViewer(null)} />
        )}
      </div>
    );
  }

  // -------------------------------------------------------------------------------------------
  // Steg 2: helheten
  // -------------------------------------------------------------------------------------------
  const godkanda = skador.filter((d) => d.sellerAction !== "rejected");

  /*
    HELHETEN, så lite text som möjligt. Betyget och skickets namn — inget mer om det. Skadorna som
    knappar: en rund bild inzoomad på just den skadan och namnet, och ett tryck öppnar den igen. Allt
    man kan göra står samlat nederst, där tummen är.
  */
  return (
    <div className="screen screen-light v2 v2-helhet-skarm v2-h">
      <button className="btn btn-text btn-back" onClick={onHome}>
        <ArrowLeftIcon /> {t("Startsidan")}
      </button>
      <FlowSteps current={4} />

      {/*
        HELHETEN, så stilla som möjligt: betyget i en tunn ring som fylls efter skicket, skickets namn,
        och skadorna som små runda bilder utan text. Ett tryck på en bild öppnar den skadan igen.
      */}
      <section
        className="v2-m"
        style={{
          ["--betygsfarg" as string]: result.grade ? BETYGSFARG[result.grade.grade] : "#c9922e",
          ["--fyllnad" as string]: result.grade ? `${FYLLNAD[result.grade.grade]}%` : "0%",
        }}
      >
        {result.grade && (
          <>
            <div className="v2-m-ring" aria-hidden="true">
              <span>{result.grade.grade}</span>
            </div>
            <h2>{result.grade.label}</h2>
          </>
        )}

        {godkanda.length > 0 ? (
          <>
            <div className="v2-m-skador" role="list" aria-label={t("Skador i annonsen")}>
              {godkanda.map((d) => (
                <button
                  key={d.id}
                  role="listitem"
                  className="v2-m-skada"
                  title={typeLabel(d.type)}
                  aria-label={typeLabel(d.type)}
                  onClick={() => setLage({ steg: "granska", index: skador.indexOf(d) })}
                >
                  <Lins jobId={jobId} skada={d} bilder={result.images} storlek={46} className="v2-m-bild" />
                </button>
              ))}
            </div>
            <p className="v2-m-antal">
              {godkanda.length === 1 ? t("1 skada") : t("{antal} skador", { antal: godkanda.length })}
            </p>
          </>
        ) : (
          <p className="v2-m-antal">{t("Inga skador")}</p>
        )}
      </section>

      {result.coverage === "NOT_SUFFICIENTLY_VISIBLE" && (
        <p className="v2-h-varning">
          <AlertIcon size={15} /> {t("Preliminär bedömning")}
        </p>
      )}
      {besked && <p className="v2-dampad v2-besked">{besked}</p>}

      <div className="v2-h-knappar">
        <button className="btn btn-primary next-step" onClick={() => onContinue(result)}>
          <span>{t("Till annonsen")}</span>
          <ChevronRight size={18} />
        </button>
        <div className="v2-h-par">
          <button className="v2-h-knapp" disabled={laggerTill} onClick={() => fotoRef.current?.click()}>
            <CameraIcon size={18} />
            {laggerTill ? t("Bedömer…") : t("Missad skada")}
          </button>
          {skador.length > 0 && (
            <button className="v2-h-knapp" onClick={() => setLage({ steg: "granska", index: 0 })}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 3-6.7" />
                <path d="M3 4v5h5" />
              </svg>
              {t("Granska igen")}
            </button>
          )}
        </div>
      </div>

      <input ref={fotoRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={fotoValt} />
    </div>
  );
}

/**
 * Kortet fyller skärmen, men bilden har sina egna proportioner — de två stämmer nästan aldrig.
 *
 * Bilden får därför fylla kortet som `object-fit: cover`, men beskärningen räknas här och inte av
 * webbläsaren: lagret med bilden OCH markeringen är exakt bildens proportioner, så markeringen följer
 * med i procent och hamnar alltid rätt. Beskärningen centreras på skadan — den hamnar mitt i bredd
 * och strax ovanför mitten i höjd, ovanför glaset med svaren — och skjuts aldrig så långt att en kant
 * av kortet blir tom.
 */
function Kort({
  liten,
  bildMeta,
  mark,
  bild,
  children,
}: {
  liten: boolean;
  bildMeta: { width: number; height: number } | undefined;
  mark: { kind: "box" | "line"; x: number; y: number; w?: number; h?: number; x2?: number; y2?: number } | null;
  bild: React.ReactNode;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [yta, setYta] = useState<{ b: number; h: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setYta({ b: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  let lager: React.CSSProperties = { inset: 0 };
  if (yta && bildMeta) {
    const kvot = bildMeta.width / bildMeta.height;
    const b = yta.b / yta.h > kvot ? yta.b : yta.h * kvot;
    const h = b / kvot;
    // Skadans mittpunkt, i bråkdelar av bilden.
    const mx = mark ? (mark.kind === "box" ? mark.x + (mark.w ?? 0.1) / 2 : (mark.x + (mark.x2 ?? mark.x)) / 2) : 0.5;
    const my = mark ? (mark.kind === "box" ? mark.y + (mark.h ?? 0.1) / 2 : (mark.y + (mark.y2 ?? mark.y)) / 2) : 0.5;
    const klamp = (v: number, min: number) => Math.min(0, Math.max(min, v));
    lager = {
      width: b,
      height: h,
      left: klamp(yta.b * 0.5 - mx * b, yta.b - b),
      top: klamp(yta.h * (liten ? 0.5 : 0.4) - my * h, yta.h - h),
    };
  }

  return (
    <div
      ref={ref}
      className={`v2-kort${liten ? " v2-kort-liten" : ""}`}
      // Bildens egna proportioner — datorvyn ger kortet dem, så att fotot visas helt och skarpt i
      // stället för att beskäras till skärmens liggande format (se [data-view="desktop"] .v2-kort).
      style={{ ["--ratio" as string]: bildMeta ? bildMeta.width / bildMeta.height : 0.75 }}
    >
      <div className="v2-beskarning" style={lager}>
        {bild}
      </div>
      {children}
    </div>
  );
}

/** Betygets färg — samma som GradeBadge (components/GradeBadge.tsx), som inte exporterar sin tabell. */
const BETYGSFARG: Record<string, string> = { A: "#2F7A50", B: "#62A15C", C: "#C9922E", D: "#E07B2C", E: "#C4442E", F: "#96271C" };
/** Hur långt ringen fylls: A nästan hel, F en bit. */
const FYLLNAD: Record<string, number> = { A: 96, B: 84, C: 70, D: 55, E: 40, F: 24 };

/**
 * En rund bild inzoomad på skadan — skadans eget utsnitt ur bevisfotot, utan ram eller markering.
 * Zoomen räknas så att markeringens största sida fyller ungefär rundeln, och utsnittet centreras på
 * skadans mitt.
 */
function Lins({
  jobId,
  skada,
  bilder,
  storlek = 36,
  className = "v2-lins",
}: {
  jobId: string;
  skada: Damage;
  bilder: ConditionResult["images"];
  storlek?: number;
  className?: string;
}) {
  const ev = skada.evidence[0];
  const STORLEK = storlek;
  if (!ev) return <span className={`${className} v2-lins-tom v2-grad-${skada.severity}`} aria-hidden="true" />;
  const bild = bilder.find((b) => b.id === ev.imageId);
  const kvot = bild ? bild.width / bild.height : 0.75;
  const m = ev.mark;
  const w = m.kind === "box" ? (m.w ?? 0.1) : Math.abs((m.x2 ?? m.x) - m.x) || 0.1;
  const h = m.kind === "box" ? (m.h ?? 0.1) : Math.abs((m.y2 ?? m.y) - m.y) || 0.1;
  const cx = m.kind === "box" ? m.x + w / 2 : (m.x + (m.x2 ?? m.x)) / 2;
  const cy = m.kind === "box" ? m.y + h / 2 : (m.y + (m.y2 ?? m.y)) / 2;
  // Zoomen: bildens bredd som en multipel av rutans, så att skadan fyller rutan. Utsnittet räknas i
  // procent, så det blir rätt vilken storlek rutan än får (den krymper på låga skärmar).
  const zoom = Math.min(9, Math.max(1.6, 1 / Math.max(w, h / kvot) / 1.05));
  const zh = zoom / kvot; // bildens höjd som multipel av rutans
  const pos = (c: number, z: number) => (z === 1 ? 50 : ((0.5 - c * z) / (1 - z)) * 100);
  void STORLEK;
  return (
    <span
      className={className}
      aria-hidden="true"
      style={{
        backgroundImage: `url("${imageUrl(jobId, ev.imageId)}")`,
        backgroundSize: `${zoom * 100}% ${zh * 100}%`,
        backgroundPosition: `${Math.min(100, Math.max(0, pos(cx, zoom)))}% ${Math.min(100, Math.max(0, pos(cy, zh)))}%`,
      }}
    />
  );
}

/** Skadorna säljaren ska ta ställning till — samma urval som den nuvarande skärmen visar. */
function attGranska(result: ConditionResult): Damage[] {
  return result.damages.filter((d) => d.verification !== "REJECTED" || d.sellerAction);
}

/** Redigeringen, avskalad: vad det är, hur allvarligt, var det sitter och med egna ord. */
function Redigera({
  skada,
  sparar,
  onAvbryt,
  onSpara,
}: {
  skada: Damage;
  sparar: boolean;
  onAvbryt: () => void;
  onSpara: (patch: Pick<Damage, "type" | "part" | "severity" | "description">) => void;
}) {
  const t = useT();
  const [utkast, setUtkast] = useState({ type: skada.type, part: skada.part, severity: skada.severity, description: skada.description });

  return (
    <div className="v2-redigera">
      <label>
        {t("Vad är det?")}
        <select value={utkast.type} onChange={(e) => setUtkast({ ...utkast, type: e.target.value as Damage["type"] })}>
          {DAMAGE_TYPE_OPTIONS.map((o) => (
            <option key={o} value={o}>
              {typeLabel(o)}
            </option>
          ))}
        </select>
      </label>
      <div className="v2-falt" role="group" aria-label={t("Hur allvarligt?")}>
        <span>{t("Hur allvarligt?")}</span>
        <div className="v2-val">
          {SEVERITY_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={`v2-valknapp${utkast.severity === s ? " vald" : ""}`}
              onClick={() => setUtkast({ ...utkast, severity: s })}
            >
              {severityLabel(s)}
            </button>
          ))}
        </div>
      </div>
      <label>
        {t("Var sitter den?")}
        <input value={utkast.part} onChange={(e) => setUtkast({ ...utkast, part: e.target.value })} />
      </label>
      <label>
        {t("Beskrivning")}
        <textarea rows={3} value={utkast.description} onChange={(e) => setUtkast({ ...utkast, description: e.target.value })} />
      </label>
      <div className="v2-svar">
        <button className="btn btn-primary" disabled={sparar || !utkast.part} onClick={() => onSpara(utkast)}>
          {t("Spara och fortsätt")}
        </button>
        <button className="btn btn-text v2-lank" onClick={onAvbryt}>
          {t("Avbryt")}
        </button>
      </div>
    </div>
  );
}

function tillDataUrl(fil: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error(translate("Kunde inte läsa bilden.")));
    r.readAsDataURL(fil);
  });
}
