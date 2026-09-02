import { useEffect, useState } from "react";
import type { BrandFacet, ConditionGrade, SortKey } from "../types";
import { track } from "./Bits";

/**
 * Filterraden och arket bakom den.
 *
 * Raden visar det som ändras oftast — källa, sortering, kategori — och resten ligger i ett ark. På
 * en telefon finns ingen sidokolumn att lägga tolv filter i, och en rad med tolv piller går inte att
 * läsa. Arket är därför inte en nödlösning för mobilen utan formen.
 *
 * TVÅ FILTER GÄLLER BARA VÅRA EGNA VAROR, och det står i gränssnittet i stället för att tyst ge färre
 * träffar: skick (Tradera har inget betyg vi granskat) och mått (deras sökresultat bär inga mått).
 * Se `applyFilter` i server/src/butik/inventory.ts, som räknar bortfallet och skickar tillbaka det.
 */

export interface FilterState {
  onlyLoopa: boolean;
  marke: string[];
  minPris: number | null;
  maxPris: number | null;
  skick: ConditionGrade[];
  maxBredd: number | null;
  maxDjup: number | null;
  maxHojd: number | null;
  hemleverans: boolean;
  sortering: SortKey;
}

export const EMPTY_FILTER: FilterState = {
  onlyLoopa: false,
  marke: [],
  minPris: null,
  maxPris: null,
  skick: [],
  maxBredd: null,
  maxDjup: null,
  maxHojd: null,
  hemleverans: false,
  sortering: "relevans",
};

/** Skalan som köparen läser den. Betygen är pipelinens egna — se GradeExplanation i serverns types. */
const GRADE_LABELS: Array<{ grade: ConditionGrade; label: string }> = [
  { grade: "A", label: "Nyskick" },
  { grade: "B", label: "Mycket bra" },
  { grade: "C", label: "Bra" },
  { grade: "D", label: "Slitage" },
];

const SORT_LABELS: Array<{ key: SortKey; label: string }> = [
  { key: "relevans", label: "Relevans" },
  { key: "nyinkommet", label: "Nyinkommet" },
  { key: "pris_upp", label: "Lägsta pris" },
  { key: "pris_ner", label: "Högsta pris" },
];

export function countActive(f: FilterState): number {
  return (
    (f.onlyLoopa ? 1 : 0) + f.marke.length + (f.minPris !== null || f.maxPris !== null ? 1 : 0) +
    f.skick.length + (f.maxBredd !== null || f.maxDjup !== null || f.maxHojd !== null ? 1 : 0) +
    (f.hemleverans ? 1 : 0)
  );
}

export default function Filters({
  value,
  onChange,
  brands,
}: {
  value: FilterState;
  onChange: (next: FilterState) => void;
  brands: BrandFacet[];
}) {
  const [sheet, setSheet] = useState(false);
  const set = (patch: Partial<FilterState>) => {
    onChange({ ...value, ...patch });
    track("filter_use", { keys: Object.keys(patch) });
  };
  const active = countActive(value);

  return (
    <>
      <div className="butik-filterbar" role="group" aria-label="Filter och sortering">
        <button
          type="button"
          className={`butik-chip ${value.onlyLoopa ? "butik-chip-on" : ""}`}
          aria-pressed={value.onlyLoopa}
          onClick={() => set({ onlyLoopa: !value.onlyLoopa })}
        >
          Endast Loopa-granskade
        </button>
        <button type="button" className={`butik-chip ${active ? "butik-chip-on" : ""}`} onClick={() => setSheet(true)}>
          Filter {active > 0 && <span className="butik-chip-count">{active}</span>}
        </button>
        <select
          className="butik-chip"
          aria-label="Sortering"
          value={value.sortering}
          onChange={(e) => set({ sortering: e.target.value as SortKey })}
        >
          {SORT_LABELS.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
      </div>
      {sheet && <FilterSheet value={value} brands={brands} onClose={() => setSheet(false)} onApply={(next) => { onChange(next); setSheet(false); }} />}
    </>
  );
}

function FilterSheet({
  value,
  brands,
  onClose,
  onApply,
}: {
  value: FilterState;
  brands: BrandFacet[];
  onClose: () => void;
  onApply: (next: FilterState) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [brandQuery, setBrandQuery] = useState("");

  // Escape stänger. Ett ark utan väg ut med tangentbordet är en fälla för den som inte pekar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (patch: Partial<FilterState>) => setDraft({ ...draft, ...patch });
  const toggle = <T,>(list: T[], item: T): T[] => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  const num = (v: string): number | null => (v.trim() === "" ? null : Math.max(0, Number(v)) || null);
  const shown = brands.filter((b) => b.brand.toLowerCase().includes(brandQuery.toLowerCase()));

  return (
    <div className="butik-sheet-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Filter">
      <div className="butik-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="butik-sheet-grip" />
        <h3>Filter</h3>

        <div className="butik-field">
          <div className="butik-toggle">
            <span className="butik-toggle-text">
              Endast Loopa-granskade
              <span className="butik-toggle-hint" style={{ display: "block" }}>Besiktigade av oss, med hemleverans i Stockholm.</span>
            </span>
            <input type="checkbox" checked={draft.onlyLoopa} onChange={(e) => set({ onlyLoopa: e.target.checked })} style={{ width: 22, height: 22 }} />
          </div>
        </div>

        <div className="butik-field">
          <span className="butik-field-label">Pris (kr)</span>
          <div className="butik-field-row">
            <input className="butik-input" type="number" inputMode="numeric" placeholder="Från" value={draft.minPris ?? ""} onChange={(e) => set({ minPris: num(e.target.value) })} />
            <input className="butik-input" type="number" inputMode="numeric" placeholder="Till" value={draft.maxPris ?? ""} onChange={(e) => set({ maxPris: num(e.target.value) })} />
          </div>
        </div>

        <div className="butik-field">
          <span className="butik-field-label">Skick — gäller Loopa-granskade</span>
          <div className="butik-field-row">
            {GRADE_LABELS.map((g) => (
              <button
                key={g.grade}
                type="button"
                className={`butik-chip ${draft.skick.includes(g.grade) ? "butik-chip-on" : ""}`}
                aria-pressed={draft.skick.includes(g.grade)}
                onClick={() => set({ skick: toggle(draft.skick, g.grade) })}
              >
                {g.label}
              </button>
            ))}
          </div>
          {draft.skick.length > 0 && (
            <p className="butik-toggle-hint" style={{ marginTop: 8 }}>
              Tradera-annonser visas inte med skickfilter — vi har inte granskat dem.
            </p>
          )}
        </div>

        <div className="butik-field">
          <span className="butik-field-label">Får den plats? Max mått i cm</span>
          <div className="butik-field-row">
            <input className="butik-input" type="number" inputMode="numeric" placeholder="Bredd" value={draft.maxBredd ?? ""} onChange={(e) => set({ maxBredd: num(e.target.value) })} />
            <input className="butik-input" type="number" inputMode="numeric" placeholder="Djup" value={draft.maxDjup ?? ""} onChange={(e) => set({ maxDjup: num(e.target.value) })} />
            <input className="butik-input" type="number" inputMode="numeric" placeholder="Höjd" value={draft.maxHojd ?? ""} onChange={(e) => set({ maxHojd: num(e.target.value) })} />
          </div>
        </div>

        {brands.length > 0 && (
          <div className="butik-field">
            <span className="butik-field-label">Märke</span>
            {brands.length > 6 && (
              <input className="butik-input" style={{ marginBottom: 8, width: "100%" }} placeholder="Sök märke" value={brandQuery} onChange={(e) => setBrandQuery(e.target.value)} />
            )}
            <div className="butik-field-row">
              {shown.map((b) => (
                <button
                  key={b.brand}
                  type="button"
                  className={`butik-chip ${draft.marke.includes(b.brand) ? "butik-chip-on" : ""}`}
                  aria-pressed={draft.marke.includes(b.brand)}
                  onClick={() => set({ marke: toggle(draft.marke, b.brand) })}
                >
                  {b.brand} <span className="butik-chip-count">{b.count}</span>
                </button>
              ))}
              {shown.length === 0 && <span className="butik-toggle-hint">Inget märke matchar.</span>}
            </div>
          </div>
        )}

        <div className="butik-field">
          <div className="butik-toggle">
            <span className="butik-toggle-text">
              Hemleverans möjlig
              <span className="butik-toggle-hint" style={{ display: "block" }}>Vi kör hem möbeln inom Stockholm.</span>
            </span>
            <input type="checkbox" checked={draft.hemleverans} onChange={(e) => set({ hemleverans: e.target.checked })} style={{ width: 22, height: 22 }} />
          </div>
        </div>

        <div className="butik-sheet-actions">
          <button type="button" className="btn btn-outline" style={{ flex: 1 }} onClick={() => setDraft(EMPTY_FILTER)}>Rensa</button>
          <button type="button" className="btn btn-primary" style={{ flex: 2 }} onClick={() => onApply(draft)}>Visa resultat</button>
        </div>
      </div>
    </div>
  );
}
