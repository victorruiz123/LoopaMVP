import { useEffect, useRef, useState } from "react";
import { adressFranPosition, type AdressTraff } from "../api";
import { useT } from "../lib/i18n";

/**
 * Adressen där säljaren står: gata, postnummer och ort, ifyllda åt dem.
 *
 * FYLLS I AV SIG SJÄLVT när formuläret öppnas (`auto`). Den som registrerar sig gör det med möbeln
 * framför sig, hemma — adressen vi frågar om är nästan alltid den de står på. Att skriva den för
 * hand är tre fält och en felkälla för en uppgift telefonen redan har.
 *
 * DET ÄR ETT FÖRSLAG, INTE ETT SVAR. En position inomhus är ungefärlig — i ett flerfamiljshus eller
 * på en gata med tätt mellan husen landar den gärna på grannens nummer. Därför fylls fälten i och
 * säljaren ombeds titta, i stället för att vi tyst litar på satelliten. Det står hårdare när
 * webbläsaren själv säger att positionen är osäker.
 *
 * TRE FÄLT, INTE SEX. Hus eller lägenhet, portkod och våning kommer aldrig härifrån — de är
 * uppgifter om hemmet och inte om platsen, och ingen satellit vet dem. De frågas som förut.
 *
 * LOVET FRÅGAS EN GÅNG, OCH SVARET RESPEKTERAS. Har webbläsaren redan ett svar sedan tidigare
 * hämtas adressen utan att någon ruta dyker upp. Har den det inte frågas det direkt när formuläret
 * öppnas — det är då uppgiften behövs, och en fråga som kommer när svaret ska användas är lättare
 * att förstå än en som kommer av sig själv på en sida man bara tittar på. Säger säljaren nej står
 * knappen kvar, men frågan ställs inte igen: ett nej som körs över är inte ett nej.
 *
 * Knappen visas inte alls där webbläsaren saknar platstjänster.
 */

/** Över det här många metrarna kan huset bredvid lika gärna vara rätt. */
const OSAKER_M = 40;

export default function NuvarandeAdress({
  onTraff,
  auto = false,
}: {
  /** `automatiskt` = sidan bad om adressen, inte säljaren. Se fyllAdress i AuthScreen. */
  onTraff: (traff: AdressTraff, automatiskt: boolean) => void;
  /** Hämta adressen när formuläret öppnas, utan att säljaren behöver trycka. */
  auto?: boolean;
}) {
  const t = useT();
  const [soker, setSoker] = useState(false);
  const [besked, setBesked] = useState<{ fel: boolean; text: string } | null>(null);
  /**
   * Att vi redan hämtat en gång. En ref och inte ett tillstånd: den får inte rita om något, och den
   * ska gälla direkt — React kör effekter två gånger i utvecklingsläge, och två positionsfrågor i
   * rad ger två rutor att svara på för samma sak.
   */
  const gjort = useRef(false);

  useEffect(() => {
    if (!auto || gjort.current) return;
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) return;
    gjort.current = true;

    /**
     * Frågar bara där ett svar kan komma ut av det.
     *
     * "granted" hämtar tyst, "prompt" frågar. "denied" gör ingenting alls: webbläsaren hade ändå
     * svarat nej direkt, och att skriva ut det som ett fel på en sida säljaren just öppnat är att
     * skylla på dem för ett val de gjort. Saknas Permissions API frågar vi — det är det äldre
     * beteendet, och det fungerar.
     */
    void (async () => {
      try {
        const status = await navigator.permissions?.query({ name: "geolocation" as PermissionName });
        if (status?.state === "denied") return;
      } catch {
        // Permissions API saknas eller vägrar svara om geolocation. Då frågar vi som förut.
      }
      hamta(true);
    })();
  }, [auto]);

  if (typeof navigator === "undefined" || !("geolocation" in navigator)) return null;

  /**
   * `tyst` = hämtningen startades av sidan och inte av ett tryck. Då sägs ingenting när den faller:
   * säljaren har inte bett om något, och ett rött besked om en plats de aldrig efterfrågat är brus
   * ovanför ett formulär de ska fylla i. Knappen står kvar för den som vill försöka på riktigt.
   */
  function hamta(tyst = false) {
    setBesked(null);
    setSoker(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const traff = await adressFranPosition(pos.coords.latitude, pos.coords.longitude);
          if (!traff) {
            if (!tyst) setBesked({ fel: true, text: t("Hittade ingen adress där du är. Skriv in den i stället.") });
            return;
          }
          onTraff(traff, tyst);
          setBesked({
            fel: false,
            text:
              pos.coords.accuracy > OSAKER_M
                ? t("Kontrollera husnumret — positionen är ungefärlig.")
                : t("Kontrollera att adressen stämmer."),
          });
        } catch {
          if (!tyst) setBesked({ fel: true, text: t("Platsen gick inte att hämta. Skriv in adressen i stället.") });
        } finally {
          setSoker(false);
        }
      },
      (err) => {
        setSoker(false);
        if (tyst) return;
        setBesked({
          fel: true,
          text:
            err.code === err.PERMISSION_DENIED
              ? t("Du har inte gett sidan tillgång till din plats. Skriv in adressen i stället.")
              : t("Platsen gick inte att hämta. Skriv in adressen i stället."),
        });
      },
      // Hög noggrannhet: det är husnumret som står på spel. En gammal position ur cachen kan vara från
      // någon annanstans än där säljaren bor.
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  }

  return (
    <>
      <button type="button" className="adress-har" onClick={() => hamta()} disabled={soker}>
        {soker ? t("Hämtar din plats…") : t("Använd min nuvarande adress")}
      </button>
      {besked && (
        <p className={besked.fel ? "adress-har-besked fel" : "adress-har-besked"} role="status">
          {besked.text}
        </p>
      )}
    </>
  );
}
