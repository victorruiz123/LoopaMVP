/**
 * Var i flödet man står.
 *
 * Stegräkningen fanns redan, men bara på två av fyra skärmar: modellvalet sa "STEG 1 AV 4",
 * måttskärmen "STEG 2 AV 4", och sedan tog den slut — prisvyn sa "PRISFÖRSLAG" och skickvyn
 * ingenting. En räkning som slutar halvvägs är sämre än ingen, för då vet man inte om den tog
 * slut eller om man gick fel.
 *
 * Fyra steg, inte fem: filmningen ligger före räkningen (den har ingen väg tillbaka och inget
 * val i sig) och truth-cardet efter den — kortet är vad de fyra stegen blir, inte ett femte.
 */
const FLOW_STEPS = ["Modell", "Mått och specifikationer", "Pris", "Skick"];

export type FlowStep = 1 | 2 | 3 | 4;

export default function FlowSteps({ current }: { current: FlowStep }) {
  return (
    <nav className="flow-steps" aria-label="Steg i flödet">
      {/* Ifylld fram till och med det steg man står på. Att i stället märka ut det aktuella
          segmentet hade krävt att man läser tre färger; en mätare läses på längden. */}
      <ol className="flow-steps-track">
        {FLOW_STEPS.map((label, i) => (
          <li
            key={label}
            className={`flow-step ${i < current ? "flow-step-done" : ""}`}
            aria-current={i + 1 === current ? "step" : undefined}
          >
            <span className="visually-hidden">{`Steg ${i + 1}: ${label}`}</span>
          </li>
        ))}
      </ol>
      <p className="flow-steps-label">
        Steg {current} av {FLOW_STEPS.length}
        <span className="flow-steps-name">{FLOW_STEPS[current - 1]}</span>
      </p>
    </nav>
  );
}
