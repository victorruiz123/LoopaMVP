import { useEffect, useMemo, useRef, useState } from "react";
import { KNOWN_BRANDS } from "../lib/brands";
import { POPULAR_BRANDS } from "../lib/brandSeed";
import BrandAvatar from "./BrandAvatar";
import { CheckIcon, CloseIcon, PlusIcon, SearchIcon } from "./icons";
import { useT } from "../lib/i18n";

const ANIMATION_MS = 420;
/** Hur långt ned man måste dra, eller hur snabbt, för att släppet ska räknas som "stäng". */
const DISMISS_DISTANCE = 110;
const DISMISS_VELOCITY = 0.6; // px/ms

/** Gemener utan diakriter, så "kallemo" hittar Källemo och "hastens" hittar Hästens. */
function fold(s: string): string {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

const POPULAR_SET = new Set(POPULAR_BRANDS.map(fold));

/**
 * Sökregistret: startlistan UNIONERAD med de mätta korpusmärkena, med startlistans stavning först.
 *
 * Båda halvorna behövs. Skeidar, Norell Möbel och West Elm står i startlistan men saknas i korpusen,
 * och utan unionen gav en sökning på "west" noll träffar på ett märke som syntes i rutan ovanför.
 * Åt andra hållet stavar korpusen HAY som "Hay", så samma märke visades olika beroende på om man
 * bläddrade eller sökte — startlistans stavning vinner därför.
 */
const ALL_NAMES = [
  ...POPULAR_BRANDS,
  ...KNOWN_BRANDS.map((b) => b.name).filter((n) => !POPULAR_SET.has(fold(n))),
];

export default function BrandSheet({
  open,
  selected,
  onSelect,
  onClose,
}: {
  open: boolean;
  selected: string | null;
  onSelect: (brand: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  /**
   * `open` styr om arket SKA synas, `shown` om det syns just nu. Två flaggor behövs för att animera
   * åt båda hållen: en komponent som avmonteras i samma tick som den stängs hinner aldrig glida ned.
   */
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  /** Fingerts position under en dragning. null när ingen dragning pågår. */
  const [dragY, setDragY] = useState<number | null>(null);
  const dragRef = useRef({ startY: 0, lastY: 0, lastT: 0, velocity: 0 });

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Måla en bildruta i utgångsläget innan transformen ändras, annars finns inget att tweena från.
      const raf = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    const timer = window.setTimeout(() => setMounted(false), ANIMATION_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Nollställ först när arket ÄR stängt. Att rensa vid stängningen hade tömt listan mitt i animationen.
  useEffect(() => {
    if (mounted) return;
    setQuery("");
    setDragY(null);
  }, [mounted]);

  // Sidan bakom får inte scrolla med när arket är uppe.
  useEffect(() => {
    if (!mounted) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [mounted]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const results = useMemo(() => {
    const q = fold(query);
    if (!q) return POPULAR_BRANDS;
    // Söker igenom hela den mätta listan, inte bara de populära: sökrutan ska svara på vad som FINNS,
    // och startlistan är en genväg, inte ett register. Träffar på namnets början först.
    const hits = ALL_NAMES.filter((n) => fold(n).includes(q));
    hits.sort((a, b) => {
      const rank = (n: string) => (fold(n).startsWith(q) ? 0 : 1) - (POPULAR_SET.has(fold(n)) ? 0.5 : 0);
      return rank(a) - rank(b) || a.localeCompare(b, "sv");
    });
    return hits;
  }, [query]);

  // ---- dra ned för att stänga ---------------------------------------------
  // Bara på handtaget och rubriken. Att lyssna på hela arket hade gjort varje listsvep till en
  // halvstängning, och listan är det man mest av allt gör i det här arket.
  function onPointerDown(e: React.PointerEvent) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { startY: e.clientY, lastY: e.clientY, lastT: e.timeStamp, velocity: 0 };
    setDragY(0);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (dragY === null) return;
    const d = dragRef.current;
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.velocity = (e.clientY - d.lastY) / dt;
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
    const raw = e.clientY - d.startY;
    // Uppåt tar emot i stället för att följa med: arket är redan i sitt övre läge, och att låta det
    // glida högre hade avslöjat bakgrunden under underkanten.
    setDragY(raw < 0 ? raw / 6 : raw);
  }

  function onPointerUp() {
    if (dragY === null) return;
    const { velocity } = dragRef.current;
    const shouldClose = dragY > DISMISS_DISTANCE || velocity > DISMISS_VELOCITY;
    setDragY(null);
    if (shouldClose) onClose();
  }

  if (!mounted) return null;

  const dragging = dragY !== null;
  const offset = dragging ? Math.max(dragY, -20) : 0;

  return (
    <div className="sheet-root" role="dialog" aria-modal="true" aria-label={t("Välj märke")}>
      <div
        className={`sheet-overlay ${shown ? "sheet-overlay-shown" : ""}`}
        style={dragging ? { opacity: Math.max(0.15, 1 - dragY / 400) } : undefined}
        onClick={onClose}
      />
      <div
        className={`sheet ${shown ? "sheet-shown" : ""} ${dragging ? "sheet-dragging" : ""}`}
        style={dragging ? { transform: `translateY(${offset}px)` } : undefined}
      >
        <div
          className="sheet-grip"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="sheet-handle" aria-hidden="true" />
          <header className="sheet-header">
            <h2>{t("Välj märke")}</h2>
            <button type="button" className="sheet-close" onClick={onClose} aria-label={t("Stäng")}>
              <CloseIcon />
            </button>
          </header>
        </div>

        <div className="sheet-search">
          <span className="sheet-search-icon">
            <SearchIcon />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Sök märke")}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label={t("Sök märke")}
          />
          {query && (
            <button type="button" className="sheet-search-clear" onClick={() => setQuery("")} aria-label={t("Rensa sökning")}>
              <CloseIcon size={12} />
            </button>
          )}
        </div>

        <div className="sheet-body">
          {results.length === 0 ? (
            <div className="sheet-empty">
              <span className="sheet-empty-mark" aria-hidden="true">
                <SearchIcon size={22} />
              </span>
              <p className="sheet-empty-title">Inga träffar på ”{query.trim()}”</p>
              <p className="sheet-empty-hint">{t("Märket finns inte i listan — men du kan använda det ändå.")}</p>
              {/* Sökrutan innehåller redan det märket ska heta, så den manuella vägen behöver inget
                  eget fält — bara ett sätt att säga "ja, det där". */}
              <button type="button" className="brand-use-typed" onClick={() => onSelect(query.trim())}>
                <PlusIcon />
                Använd ”{query.trim()}”
              </button>
            </div>
          ) : (
            <>
              <div className="sheet-section-title">{query.trim() ? "Sökresultat" : "Populära märken"}</div>
              <ul className="brand-rows">
                {results.map((name) => {
                  const isSelected = !!selected && fold(selected) === fold(name);
                  return (
                    <li key={name}>
                      <button
                        type="button"
                        className={`brand-row ${isSelected ? "brand-row-selected" : ""}`}
                        onClick={() => onSelect(name)}
                      >
                        <BrandAvatar name={name} size={34} />
                        <span className="brand-row-name">{name}</span>
                        {isSelected && (
                          <span className="brand-row-check" role="img" aria-label={t("Valt")}>
                            <CheckIcon />
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
