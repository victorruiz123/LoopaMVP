import { useEffect, useRef, useState } from "react";
import { skickaFeedback } from "../api";
import { CheckIcon, CloseIcon } from "./icons";
import { useT } from "../lib/i18n";

/**
 * "Vad tyckte du om processen?" — frågan efter ja:et.
 *
 * NÄR: precis efter att möbeln lämnats över, ovanpå kvittot. Det är det enda ögonblick i flödet där
 * säljaren har hela resan färsk i minnet OCH ingenting kvar att göra. Frågas den senare, i ett mejl
 * eller i profilen, svarar bara den som redan är arg eller redan är förtjust; frågas den tidigare är
 * den ett hinder i ett arbete som pågår.
 *
 * VARFÖR DEN GÅR ATT STÄNGA UTAN ATT SVARA, och varför "Hoppa över" står som en riktig knapp och
 * inte som ett litet kryss: säljaren har just gjort oss en tjänst genom att lämna över en möbel.
 * Att spärra vägen ut tills de betygsatt oss är att ta betalt för något de redan gett.
 *
 * VARFÖR BÅDE SIFFRAN OCH TEXTEN ÄR VALFRIA var för sig. Att kräva båda är att växla in svar mot
 * tystnad: den som bara vill trycka på en fyra gör inte om sig till en som skriver ett stycke — de
 * stänger rutan, och då har vi varken siffran eller stycket. Servern accepterar halva svar av
 * exakt samma skäl (server/src/feedback.ts).
 *
 * VARFÖR ETT FEL INTE SYNS. Anropet svarar bara ja eller nej (`skickaFeedback` kastar aldrig), och
 * rutan tackar likadant i båda fallen. Ett rött felmeddelande här hade gjort det sista säljaren
 * minns av oss till ett haveri i ett ärende som inte ens var deras.
 *
 * VARFÖR DEN BARA FRÅGAS EN GÅNG. Svaret — eller överhoppet — märks av i webbläsaren per möbel, så
 * en omladdning av kvittot inte ställer frågan igen. Märket är avsiktligt lokalt och inte en
 * serverflagga: det styr ingenting, det ska bara inte tjata.
 */
export default function ProcessFeedback({ jobId, onStang }: { jobId: string; onStang: () => void }) {
  const t = useT();
  const [betyg, setBetyg] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [skickar, setSkickar] = useState(false);
  const [tackat, setTackat] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  // Sidan bakom får inte rulla med medan rutan ligger över den. Samma grepp som bekräftelsen.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  // Escape räknas som att hoppa över: rutan är frivillig hela vägen ut.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !skickar) onStang();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [skickar, onStang]);

  // Tacket får stå ett ögonblick och stänger sig sedan självt. Det finns ingenting att göra i det,
  // och en kvarstående ruta med en enda knapp är ett steg till för den som redan är klar.
  useEffect(() => {
    if (!tackat) return;
    const id = window.setTimeout(onStang, 1600);
    return () => window.clearTimeout(id);
  }, [tackat, onStang]);

  const nagotAttSkicka = betyg !== null || text.trim().length > 0;

  async function skicka() {
    if (!nagotAttSkicka) return;
    setSkickar(true);
    await skickaFeedback({ jobId, betyg, text: text.trim() || null });
    setSkickar(false);
    setTackat(true);
  }

  if (tackat) {
    return (
      <div className="sell-modal-root feedback-modal" role="dialog" aria-modal="true" aria-label={t("Tack")}>
        <div className="sell-modal-scrim" />
        <div className="sell-modal-panel feedback-tack" ref={panel} tabIndex={-1}>
          <div className="feedback-tack-markning" aria-hidden="true">
            <CheckIcon size={24} />
          </div>
          <p role="status">{t("Tack! Det hjälper oss att göra nästa möbel enklare.")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="sell-modal-root feedback-modal" role="dialog" aria-modal="true" aria-labelledby="feedback-rubrik">
      <div className="sell-modal-scrim" onClick={skickar ? undefined : onStang} />
      <div className="sell-modal-panel" ref={panel} tabIndex={-1}>
        <header className="sell-modal-head">
          <h2 id="feedback-rubrik">{t("Vad tyckte du om processen?")}</h2>
          <button className="sell-modal-close" onClick={onStang} disabled={skickar} aria-label={t("Stäng")}>
            <CloseIcon size={15} />
          </button>
        </header>

        <div className="sell-modal-body">
          <p className="sell-modal-lede">
            {t("Möbeln är överlämnad. Innan du går: hur var det att lägga upp den?")}
          </p>

          {/*
            SKALAN ÄR FEM STEG MED ORD I ÄNDARNA. Siffror ensamma betyder olika saker för olika
            personer — en fyra är toppbetyg för den ena och ett klagomål för den andra. Ändarna
            namnges därför, och bara de: att sätta ord på var mellansteg är att be om en
            språkbedömning i stället för ett intryck.
          */}
          <div className="feedback-skala" role="radiogroup" aria-labelledby="feedback-rubrik">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={betyg === n}
                aria-label={t("{n} av 5", { n })}
                className={`feedback-steg${betyg === n ? " vald" : ""}`}
                onClick={() => setBetyg(betyg === n ? null : n)}
                disabled={skickar}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="feedback-skala-andar" aria-hidden="true">
            <span>{t("Krångligt")}</span>
            <span>{t("Väldigt enkelt")}</span>
          </div>

          <label className="feedback-text">
            <span>{t("Något som kunde varit bättre? (frivilligt)")}</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              maxLength={4000}
              disabled={skickar}
              placeholder={t("Skriv några ord…")}
            />
          </label>
        </div>

        <footer className="sell-modal-actions">
          <button className="btn btn-text" onClick={onStang} disabled={skickar}>
            {t("Hoppa över")}
          </button>
          <button className="btn btn-primary" onClick={skicka} disabled={skickar || !nagotAttSkicka}>
            {skickar ? t("Skickar…") : t("Skicka")}
          </button>
        </footer>
      </div>
    </div>
  );
}
