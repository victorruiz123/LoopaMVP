import type { VerifiedCard as Card } from "../types";

/**
 * Det verifierade kortet — och skillnaden mot det preliminära ska synas på en meter.
 *
 * Det gula kortet är vad vi trodde om någon annans annonsbilder. Det här är vad vi FANN när möbeln
 * filmades: samma pipeline som varje säljare i appen går igenom, samma betyg, samma fynd. Därför
 * grönt märke i stället för gult, "granskad" i stället för "preliminär", och ett datum.
 *
 * BÅDA PARTER SER EXAKT DETTA. Här upphör asymmetrin i affären: fram till skanningen har köparen
 * haft ett underlag säljaren inte sett, och det var med flit. Nu förs prisförhandlingen på samma
 * papper.
 *
 * SÄLJAREN KAN INTE REDIGERA NÅGOT HÄR. Pris, beskrivning och hämtningstider är säljarens; betyg,
 * fynd och mått är besiktningens. Ett kort där säljaren kan tona ned en skada är inget kort.
 */

const SEVERITY_LABEL: Record<string, string> = {
  S1: "Mindre", S2: "Mindre", S3: "Tydlig", S4: "Allvarlig",
};

export default function VerifiedCard({ card }: { card: Card }) {
  const name = [card.brand, card.model].filter(Boolean).join(" ");
  return (
    <section className="affar-verified">
      <header className="affar-verified-head">
        <span className="affar-verified-tag">Loopa-granskad ✓</span>
        {card.inspectedAt && (
          <span className="affar-verified-date">
            AI-granskad {new Date(card.inspectedAt).toLocaleDateString("sv-SE", { day: "numeric", month: "long" })}
          </span>
        )}
      </header>

      {name && <h2 className="affar-verified-name">{name}</h2>}

      <div className="affar-verified-grade">
        <strong>{card.gradeLabel ?? card.grade}</strong>
        {card.gradeRationale && <p>{card.gradeRationale}</p>}
        <p className="affar-hint">
          {card.defects.length === 0
            ? "Inga synliga skador hittades."
            : `${card.defects.length} ${card.defects.length === 1 ? "anmärkning" : "anmärkningar"}`}
          {" · "}{card.imageCount} vyer{" · "}{card.reviewed ? "två besiktningar" : "en besiktning"}
        </p>
      </div>

      {card.defects.length > 0 && (
        <div className="affar-block">
          <h3>Det här hittade granskningen</h3>
          <ul className="affar-defects">
            {card.defects.map((d) => (
              <li key={d.id}>
                <span className="affar-defect-part">{d.part}</span>
                <span className="affar-defect-desc">{d.description}</span>
                <span className={`affar-sev affar-sev-${d.severity}`}>{SEVERITY_LABEL[d.severity] ?? d.severity}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {card.measurements.length > 0 && (
        <div className="affar-block">
          <h3>Mått</h3>
          <dl className="affar-measures">
            {card.measurements.map((m) => (
              <div key={m.label}><dt>{m.label}</dt><dd>{m.value}</dd></div>
            ))}
          </dl>
        </div>
      )}

      <p className="affar-hint affar-verified-foot">
        Betyg, anmärkningar och mått kommer från granskningen och går inte att ändra — det är det som
        gör dem värda något. Priset kommer ni överens om i nästa steg.
      </p>
    </section>
  );
}
