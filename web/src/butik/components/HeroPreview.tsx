/**
 * Vad man får tillbaka, visat i stället för beskrivet.
 *
 * Rubriken lovar "vi granskar den" — men en besökare som aldrig sett produkten vet inte vad det
 * betyder i praktiken. Kortet här är svaret: så här ser en annons ut när vi läst den, och så här ser
 * den ut när säljaren filmat. Två kolumner, samma möbel, och skillnaden mellan dem ÄR produkten.
 *
 * MÄRKT SOM EXEMPEL, i klartext och inte bara i tonen. Ett påhittat kort som ser ut som ett riktigt
 * är precis den sortens sak resten av produkten finns för att slippa — vi säger aldrig något om en
 * möbel vi inte sett, och då får inte förstasidan göra det heller.
 */

const BEFORE = [
  { k: "Rubrik", v: "Madison 3-sits soffa" },
  { k: "Pris", v: "4 500 kr" },
  { k: "Skick", v: "”Fint skick” — säljarens ord" },
  { k: "Mått", v: "Står inte i annonsen" },
];

const AFTER = [
  { k: "Modell", v: "Mio Madison, 3-sits" },
  { k: "Mått", v: "217 × 100 × 84 cm" },
  { k: "Marknadsvärde", v: "3 000–7 000 kr" },
  { k: "Skick", v: "Betyg B — två märken på armstödet" },
];

export default function HeroPreview() {
  return (
    <aside className="hero-preview" aria-label="Exempel på vad du får">
      <span className="hero-preview-tag">Exempel</span>

      <div className="hero-preview-pair">
        <div className="hero-preview-card hero-preview-before">
          <h3>Annonsen du hittade</h3>
          <dl>
            {BEFORE.map((r) => (
              <div key={r.k}><dt>{r.k}</dt><dd>{r.v}</dd></div>
            ))}
          </dl>
        </div>

        <div className="hero-preview-arrow" aria-hidden="true">↓</div>

        <div className="hero-preview-card hero-preview-after">
          <h3>Efter Loopa <span className="hero-preview-check">✓</span></h3>
          <dl>
            {AFTER.map((r) => (
              <div key={r.k}><dt>{r.k}</dt><dd>{r.v}</dd></div>
            ))}
          </dl>
          <p className="hero-preview-foot">Hemkörd och inburen. Pengarna hålls tills du sett den.</p>
        </div>
      </div>
    </aside>
  );
}
