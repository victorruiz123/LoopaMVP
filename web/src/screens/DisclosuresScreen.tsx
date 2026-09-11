import { useState } from "react";
import { usePageTitle } from "../lib/pageTitle";
import { useT } from "../lib/i18n";

/** Snabbvalen. Matgrupper kommer i fyra och sex; två och tre är resten av verkligheten. */
const SNABBVAL = [1, 2, 3, 4, 6, 8];
/** Samma tak som servern håller — se MAX_ANTAL_STOLAR i stolPris.ts. */
const MAX_ANTAL = 12;

/**
 * Frågorna bilderna inte kan besvara: pälsdjur i hemmet, lukt — och för stolar hur många som säljs.
 *
 * VARFÖR DE STÄLLS ALLS. Besiktningen ser bara det som syns. En katt syns inte på en soffa, och lukt
 * syns aldrig — men båda är precis det en köpare skriver ett meddelande om, och det en allergiker
 * måste veta innan de köper. Svaren går till annonstexten under en egen rubrik, som säljarens ord
 * och inte som AI:ns: se composeAd på servern.
 *
 * VARFÖR HÄR OCH INTE PÅ EN EGEN PLATS I FLÖDET. Skärmen ligger i väntan efter modellvalet, där
 * annonsen redan byggs i bakgrunden. Det är den enda paus i flödet som ändå är död tid, och två
 * ja/nej-frågor kostar där ingenting — som ett eget steg hade de kostat en skärm och ett tryck till.
 * Därför säger sidfoten också vad som händer bakom: den som svarar snabbt ska förstå att pausen som
 * följer inte är något de orsakat.
 *
 * BÅDA FRÅGORNA MÅSTE BESVARAS för att gå vidare, och det är inte stränghet: ett obesvarat nej går
 * inte att skriva i en annons — det blir en tystnad, och tystnaden är vad frågan skulle bort med.
 * Lukten beskrivs i fritext bara när svaret är ja, och beskrivningen är frivillig: en säljare som
 * inte hittar orden ska inte hindras från att erkänna lukten.
 *
 * DEN TREDJE FRÅGAN — antalet stolar — ställs bara när möbeln är en stol, och är av ett annat slag
 * än de två andra: den beskriver inte möbeln, den ändrar PRISET. Prismotorn räknar fram vad EN
 * begagnad stol av modellen är värd (se stolPris.ts på servern), och den som säljer sex säljer sex.
 * Frågan hör ändå hemma här och inte på prisskärmen: den är en uppgift om vad som säljs, och den
 * måste vara ställd innan talet räknas — på prisskärmen hade svaret kommit efter siffran och fått
 * den att hoppa.
 *
 * INGET FÖRVALT ANTAL, av samma skäl som ja/nej saknar förvalt läge. "1" hade sett ut som ett svar
 * och släppt igenom den som inte läste frågan, med ett prisförslag på en sjättedel av bunten.
 */
export default function DisclosuresScreen({
  onDone,
  saving,
  error,
  chairLike = false,
}: {
  onDone: (svar: { pets: boolean; smell: boolean; smellNote: string | null; chairCount: number | null }) => void;
  /** Sparandet pågår. Knappen kvitterar; skärmen står kvar tills servern svarat. */
  saving: boolean;
  /** Sparandet föll. Se DisclosuresGate — säljaren släpps vidare ändå. */
  error?: string | null;
  /** Möbeln är en stol: fråga hur många som säljs, för priset räknas på antalet. */
  chairLike?: boolean;
}) {
  const t = useT();
  usePageTitle(chairLike ? "Tre frågor om möbeln" : "Två frågor om möbeln");
  const [pets, setPets] = useState<boolean | null>(null);
  const [smell, setSmell] = useState<boolean | null>(null);
  const [note, setNote] = useState("");
  const [antal, setAntal] = useState<number | null>(null);

  const klart = pets !== null && smell !== null && (!chairLike || antal !== null);

  return (
    <div className="screen screen-light">
      <header className="home-header">
        <h1 className="home-title">
          {chairLike ? t("Tre frågor") : t("Två frågor")}
          <br />
          <span className="accent">{t("om möbeln")}</span>
        </h1>
        <p className="home-lede">
          {t("Det här ser inte AI:n på bilderna, och det är det köparen frågar om. Svaren står i annonsen som dina ord.")}
        </p>
      </header>

      <div className="fragor">
        <Fraga label={t("Har du pälsdjur i hemmet?")} value={pets} onChange={setPets} name="pets" />
        <Fraga label={t("Luktar möbeln något?")} value={smell} onChange={setSmell} name="smell">
          {/* Fritexten hänger under sin fråga och inte sist på skärmen: den hör till svaret ovanför,
              och en ruta som dyker upp längst ned läser som en ny fråga. */}
          {smell === true && (
            <div className="fraga-foljd">
              <label htmlFor="smell-note">{t("Beskriv lukten")}</label>
              <textarea
                id="smell-note"
                value={note}
                autoFocus
                maxLength={300}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t("t.ex. svag röklukt i dynorna")}
              />
              <p className="fraga-hjalp">
                {t("Dina egna ord går rakt in i annonsen. En köpare skiljer på röklukt och källarlukt.")}
              </p>
            </div>
          )}
        </Fraga>
        {/* Antalet står SIST fastän det väger tyngst. De två första frågorna är ja/nej och går på ett
            par sekunder; en sifferfråga överst hade blivit skärmens tröskel. */}
        {chairLike && <AntalStolar value={antal} onChange={setAntal} />}
      </div>

      {error && <p className="fraga-fel">{error}</p>}

      <button
        className="btn btn-primary"
        disabled={!klart || saving}
        onClick={() =>
          onDone({
            pets: pets!,
            smell: smell!,
            smellNote: smell && note.trim() ? note.trim() : null,
            chairCount: chairLike ? antal : null,
          })
        }
      >
        {saving ? t("Sparar…") : t("Fortsätt")}
      </button>
      {/* Vad som händer medan man svarar. Utan den raden ser den paus som följer ut som att trycket
          på "Fortsätt" hängde sig. */}
      <p className="fraga-bygger">{t("Annonsen byggs medan du svarar.")}</p>
    </div>
  );
}

/**
 * En fråga med två svar.
 *
 * Ja och nej står som två LIKA STORA knappar och inte som en strömbrytare: en strömbrytare har ett
 * förvalt läge, och ett förvalt "nej" på lukt är ett påstående appen gör åt säljaren. Här finns inget
 * svar förrän någon tryckt.
 */
function Fraga({
  label,
  value,
  onChange,
  name,
  children,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean) => void;
  name: string;
  children?: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="fraga">
      <p className="fraga-text" id={`fraga-${name}`}>
        {label}
      </p>
      <div className="fraga-svar" role="group" aria-labelledby={`fraga-${name}`}>
        <button
          type="button"
          className={`fraga-knapp${value === true ? " is-valt" : ""}`}
          aria-pressed={value === true}
          onClick={() => onChange(true)}
        >
          {t("Ja")}
        </button>
        <button
          type="button"
          className={`fraga-knapp${value === false ? " is-valt" : ""}`}
          aria-pressed={value === false}
          onClick={() => onChange(false)}
        >
          {t("Nej")}
        </button>
      </div>
      {children}
    </div>
  );
}

/**
 * Hur många stolar som säljs.
 *
 * SNABBVAL FÖRST, fritext bakom en knapp. Nästan varje svar är ett av sex tal, och sex knappar är ett
 * tryck där ett sifferfält är ett tangentbord som skjuter upp över skärmen. Den som har fem eller tio
 * stolar får ändå plats — under "Annat antal", som bara den behöver öppna.
 *
 * TAKET ÄR TOLV, och är inte teknik utan trolighet: ett större tal är nästan alltid en felskrivning,
 * och en felskrivning som tolvfaldigar prisförslaget är värre än en fråga som måste ställas om.
 * Servern håller samma gräns — den här är bekvämlighet, inte skydd.
 */
function AntalStolar({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const t = useT();
  const [fritext, setFritext] = useState(false);
  /**
   * Fältets text hålls för sig, skild från antalet.
   *
   * Med `value` som fältets värde försvann siffrorna under fingrarna: "13" är ogiltigt, alltså blev
   * antalet null, alltså tömdes fältet mitt i inmatningen — och en trettonde stol gick inte att
   * skriva ens som ett steg på vägen till någonting annat. Nu står texten kvar som den skrevs, och
   * det är ANTALET som uteblir tills den betyder ett tal vi tar emot.
   */
  const [text, setText] = useState("");

  return (
    <div className="fraga">
      <p className="fraga-text" id="fraga-antal">
        {t("Hur många stolar säljer du?")}
      </p>
      <div className="fraga-antal" role="group" aria-labelledby="fraga-antal">
        {SNABBVAL.map((n) => (
          <button
            key={n}
            type="button"
            className={`fraga-knapp${value === n && !fritext ? " is-valt" : ""}`}
            aria-pressed={value === n && !fritext}
            onClick={() => {
              setFritext(false);
              onChange(n);
            }}
          >
            {n}
          </button>
        ))}
      </div>
      {fritext ? (
        <div className="fraga-foljd">
          <label htmlFor="antal-annat">{t("Antal stolar")}</label>
          <input
            id="antal-annat"
            className="fraga-antal-falt"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_ANTAL}
            autoFocus
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              const n = Math.floor(Number(e.target.value.trim()));
              // Ett tomt fält är inget svar, och ett tal utanför spannet är inte heller ett: båda
              // lämnar antalet obesvarat, så knappen nedanför står kvar låst i stället för att skicka
              // en siffra servern ändå avvisar.
              onChange(e.target.value.trim() && Number.isInteger(n) && n >= 1 && n <= MAX_ANTAL ? n : null);
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          className="fraga-annat"
          onClick={() => {
            setFritext(true);
            setText("");
            onChange(null);
          }}
        >
          {t("Annat antal")}
        </button>
      )}
      <p className="fraga-hjalp fraga-antal-hjalp">
        {t("Prisförslaget räknas på antalet — ett set säljs sällan för antalet gånger styckpriset.")}
      </p>
    </div>
  );
}
