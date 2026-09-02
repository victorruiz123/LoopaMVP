/**
 * Hela resan, från inklistrad länk till möbel i rummet.
 *
 * DELAD I TVÅ AV EN ANLEDNING. Allt före "Ni länkas hos Loopa" kostar köparen ingenting och binder
 * dem inte till något — de kan sluta där med en gratis värdering i handen. Allt efter är själva
 * affären, där vi tar över ansvaret. Att lista sex steg i rad hade dolt just den gränsen, och det
 * är den enda gränsen i produkten som betyder något för den som tvekar.
 *
 * ANDRA HALVAN VAR TIDIGARE OSAGD. Sidan slutade vid "bjud in säljaren" och lämnade den största
 * frågan obesvarad: vem bär möbeln? Granskningen, den skyddade betalningen och hemleveransen är vad
 * man faktiskt betalar Loopa för, och de stod ingenstans.
 */

const BEFORE = [
  {
    n: "1",
    title: "Du klistrar in länken",
    body: "Vilken annonssida som helst. Vi öppnar den och läser rubrik, bilder, text och pris åt dig.",
  },
  {
    n: "2",
    title: "Du får veta vad det är",
    body: "Modell, mått och egenskaper — och ett marknadspris byggt på vad liknande möbler faktiskt säljs för. Gratis, utan konto.",
  },
  {
    n: "3",
    title: "Du bjuder in säljaren",
    body: "Du får en färdig text med din egen länk att skicka där du redan pratar med säljaren. Vi hör aldrig av oss till dem själva.",
  },
];

const AFTER = [
  {
    n: "4",
    title: "Säljaren filmar möbeln",
    body: "Tre minuter med telefonen. Vinklarna väljs ut automatiskt, så inget kan hamna utanför bild.",
  },
  {
    n: "5",
    title: "Vi granskar den åt dig",
    body: "Varje skada pekas ut med närbild, möbeldel för möbeldel — och priset justeras efter det som faktiskt är fel. Nu vet du vad du köper.",
  },
  {
    n: "6",
    title: "Du betalar tryggt",
    body: "Pengarna hålls hos oss tills möbeln står hos dig. Blir den inte som utlovat får du dem tillbaka.",
  },
  {
    n: "7",
    title: "Vi kör hem den",
    body: "Vi hämtar hos säljaren och bär in till dig — du behöver varken släp, hiss eller en kompis som är ledig på lördag.",
  },
];

export default function HowItWorks() {
  return (
    <section className="how" id="sa-funkar-det">
      <div className="how-head">
        <h2>Så går det till</h2>
        <p>
          Från en annons du hittat till en möbel i rummet. De tre första stegen kostar ingenting och
          binder dig inte till något.
        </p>
      </div>

      <div className="how-phase">
        <span className="how-phase-label">Gratis, innan du bestämt dig</span>
        <ol className="how-steps">
          {BEFORE.map((s) => <Step key={s.n} {...s} />)}
        </ol>
      </div>

      {/* Gränsen ritas ut. Det är här köparen går från att titta till att handla. */}
      <div className="how-divider">
        <span>Säljaren tackar ja — nu tar vi över</span>
      </div>

      <div className="how-phase">
        <span className="how-phase-label">Affären, med oss emellan</span>
        <ol className="how-steps">
          {AFTER.map((s) => <Step key={s.n} {...s} />)}
        </ol>
      </div>

      <p className="how-foot">
        Hemleverans i Stockholms län. Vi hämtar hos säljaren, kör hem till dig och bär in — och pengarna
        släpps först när du sett möbeln.
      </p>
    </section>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <li className="how-step">
      <span className="how-step-n" aria-hidden="true">{n}</span>
      <h3>{title}</h3>
      <p>{body}</p>
    </li>
  );
}
