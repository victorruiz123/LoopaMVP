import { useEffect, useRef, useState } from "react";
import { CheckIcon, GlobeIcon } from "./icons";
import { LANGS, useLang, useT } from "../lib/i18n";

/**
 * Språkväljaren, bredvid namnet i profilen.
 *
 * Ligger i profilen och inte i topplisten med flit: språk är en inställning man ändrar en gång, och
 * en knapp som står bredvid varje skärms innehåll konkurrerar för alltid med det man faktiskt kom
 * för. Profilen är där resten av kontots inställningar redan bor.
 *
 * Språknamnen står PÅ SITT EGET SPRÅK — "English", inte "Engelska". Den som letar efter engelska i
 * ett svenskt gränssnitt letar efter ordet "English"; att översätta språknamn är att gömma dem för
 * precis de läsare de finns för.
 */
export default function LanguagePicker() {
  const t = useT();
  const { lang, setLang } = useLang();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Ett tryck utanför stänger. Menyn är liten och ska inte kräva att man hittar tillbaka till knappen.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="lang-picker" ref={root}>
      <button
        className="lang-button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t("Språk")}
      >
        <GlobeIcon size={15} />
        {t("Språk")}
      </button>
      {open && (
        <div className="lang-menu" role="menu">
          {LANGS.map((option) => (
            <button
              key={option.code}
              className={`lang-option ${option.code === lang ? "lang-option-active" : ""}`}
              role="menuitemradio"
              aria-checked={option.code === lang}
              onClick={() => {
                setLang(option.code);
                setOpen(false);
              }}
            >
              <span className="lang-option-name">{option.label}</span>
              {option.code === lang && <CheckIcon size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
