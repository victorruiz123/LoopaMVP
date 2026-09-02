import { useState } from "react";
import type { Spec } from "../api";
import { CATEGORY_LABELS } from "../labels";

/**
 * Sammanfattningen köparen bekräftar.
 *
 * DET HÄR KORTET ÄR KONTRAKTET. Det köparen godkänner här är exakt vad vi bevakar — inte meningen de
 * skrev, inte vår tolkning av den. Därför är varje fält redigerbart: en tolkning som satte 5 000 kr
 * när köparen menade 15 000 ska gå att rätta med ett tryck, inte genom att skriva om meningen och
 * hoppas att modellen läser den bättre den här gången.
 *
 * OCH DÄRFÖR STÅR BARA DET VI FAKTISKT FILTRERAR PÅ. Ett fält vi inte förstod visas som tomt och inte
 * som en gissning — ett kort som listar "färg: grön" när ingen färg fastnat i filtret hade beskrivit
 * en bevakning som inte finns.
 */
export default function SpecCard({
  spec, busy, compact = false, onChange, onConfirm, onRestart,
}: {
  spec: Spec;
  busy: boolean;
  /** Efter svepet: samma kort men hopfällt, som en rubrik över träffarna. */
  compact?: boolean;
  onChange: (s: Spec) => void;
  onConfirm: () => void;
  onRestart: () => void;
}) {
  const [open, setOpen] = useState(!compact);
  const f = spec.filter;

  const set = (patch: Partial<Spec["filter"]>) => onChange({ ...spec, filter: { ...f, ...patch } });
  const cm = (mm: number | null | undefined) => (mm ? String(Math.round(mm / 10)) : "");
  const toMm = (v: string) => {
    const n = Number(v.replace(/[^\d]/g, ""));
    return Number.isFinite(n) && n > 0 ? n * 10 : null;
  };

  if (compact && !open) {
    return (
      <div className="kop-spec kop-spec-compact">
        <span className="kop-spec-line">{spec.summary}</span>
        <button type="button" className="kop-spec-edit" onClick={() => setOpen(true)}>Ändra</button>
      </div>
    );
  }

  return (
    <div className="kop-spec">
      <div className="kop-spec-head">
        <h3>Så här förstod vi dig</h3>
        <p className="kop-spec-line">{spec.summary}</p>
      </div>

      <div className="kop-spec-grid">
        <label>
          <span>Vad</span>
          <select value={f.categorySlug ?? ""} onChange={(e) => set({ categorySlug: e.target.value || null })}>
            <option value="">Välj möbel…</option>
            {Object.entries(CATEGORY_LABELS).map(([slug, label]) => (
              <option key={slug} value={slug}>{label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Högsta pris</span>
          <input
            inputMode="numeric"
            value={f.maxPriceSek ?? ""}
            onChange={(e) => {
              const n = Number(e.target.value.replace(/[^\d]/g, ""));
              set({ maxPriceSek: Number.isFinite(n) && n > 0 ? n : null });
            }}
            placeholder="kr"
          />
        </label>
        <label>
          <span>Max bredd</span>
          <input inputMode="numeric" value={cm(f.maxWidthMm)} onChange={(e) => set({ maxWidthMm: toMm(e.target.value) })} placeholder="cm" />
        </label>
        <label>
          <span>Max djup</span>
          <input inputMode="numeric" value={cm(f.maxDepthMm)} onChange={(e) => set({ maxDepthMm: toMm(e.target.value) })} placeholder="cm" />
        </label>
        <label>
          <span>Max höjd</span>
          <input inputMode="numeric" value={cm(f.maxHeightMm)} onChange={(e) => set({ maxHeightMm: toMm(e.target.value) })} placeholder="cm" />
        </label>
        <label>
          <span>Färg</span>
          <input
            value={(f.colors ?? []).join(", ")}
            onChange={(e) => set({ colors: splitList(e.target.value) })}
            placeholder="t.ex. grön"
          />
        </label>
        <label>
          <span>Material</span>
          <input
            value={(f.materials ?? []).join(", ")}
            onChange={(e) => set({ materials: splitList(e.target.value) })}
            placeholder="t.ex. sammet"
          />
        </label>
        <label>
          <span>Märke</span>
          <input
            value={(f.brands ?? []).join(", ")}
            onChange={(e) => set({ brands: splitList(e.target.value) })}
            placeholder="t.ex. String"
          />
        </label>
      </div>

      {/* Hårt och mjukt sägs rakt ut. Köparen ska veta vilka fält som kan fälla en möbel. */}
      <p className="kop-spec-note">
        Pris och mått är gränser vi aldrig bryter mot. Färg, material och märke gör en träff bättre —
        vi visar även det som nästan stämmer, och säger vad som skiljer.
      </p>

      <div className="kop-spec-actions">
        <button type="button" className="kop-spec-go" disabled={busy} onClick={onConfirm}>
          {busy ? "Söker…" : "Visa vad ni har"}
        </button>
        {compact
          ? <button type="button" className="kop-spec-edit" onClick={() => setOpen(false)}>Dölj</button>
          : <button type="button" className="kop-spec-edit" onClick={onRestart}>Börja om</button>}
      </div>
    </div>
  );
}

/** "grön, blå" -> ["grön","blå"]. Tomt fält blir null, inte en tom lista — null betyder "inget krav". */
function splitList(raw: string): string[] | null {
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}
