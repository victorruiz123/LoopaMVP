import { setViewModeOverride, useCanSwitchView, useViewMode } from "../lib/viewMode";
import { DesktopIcon, MobileIcon } from "./icons";

/**
 * Reglaget för dator-/mobilvy. Syns bara i fönster som är breda nog att båda lägena betyder något —
 * på en telefon är valet redan gjort, och en knapp som bara har ett vettigt svar är inte ett val.
 *
 * Att välja för hand låser läget: automatiken har gissat, och den som rättar gissningen ska slippa
 * få den påtvingad igen vid nästa fönsterändring.
 */
export default function ViewModeSwitch() {
  const mode = useViewMode();
  const canSwitch = useCanSwitchView();
  if (!canSwitch) return null;

  return (
    <div className="view-switch" role="group" aria-label="Vy">
      <button
        type="button"
        className={`view-switch-btn ${mode === "mobile" ? "view-switch-btn-on" : ""}`}
        aria-pressed={mode === "mobile"}
        onClick={() => setViewModeOverride("mobile")}
      >
        <MobileIcon size={14} />
        Mobil
      </button>
      <button
        type="button"
        className={`view-switch-btn ${mode === "desktop" ? "view-switch-btn-on" : ""}`}
        aria-pressed={mode === "desktop"}
        onClick={() => setViewModeOverride("desktop")}
      >
        <DesktopIcon size={14} />
        Dator
      </button>
    </div>
  );
}
