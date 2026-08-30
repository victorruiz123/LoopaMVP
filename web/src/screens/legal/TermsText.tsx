import LegalLink from "../../components/LegalLink";
import { CONTROLLER } from "../../lib/legal";
import { useT } from "../../lib/i18n";

/**
 * Användarvillkoren.
 *
 * Inloggningen har hänvisat till "användarvillkoren" i löptext sedan den skrevs, utan att det fanns
 * några. Den meningen är det som gör dem nödvändiga: ett godkännande av ett dokument som inte finns
 * är inget godkännande.
 *
 * Håller sig till det appen faktiskt gör. Prisstegen nedan är inte en formulering utan en beskrivning
 * av server/src/priceLadder.ts — annonsens pris sänks verkligen, av sig självt, och en säljare som
 * inte fått veta det skulle med rätta bli förvånad.
 */
export default function TermsText() {
  const t = useT();
  return (
    <>
      <p className="legal-lede">
        {t(
          "De här villkoren gäller mellan dig och {företag} när du använder Loopa. Läs dem — särskilt avsnittet om vad som händer med priset på en annons som ligger ute.",
          { företag: CONTROLLER.legalName },
        )}
      </p>

      <h2>{t("Vad Loopa gör")}</h2>
      <p>
        {t(
          "Du filmar ett varv runt en möbel. Vi bedömer skicket, identifierar modellen, föreslår ett pris och skriver en annons. Väljer du att sälja lägger vi ut annonsen till salu och hör av oss när möbeln är såld.",
        )}
      </p>

      <h2>{t("Konto")}</h2>
      <p>
        {t(
          "Du behöver ett konto för att spara en annons. Det är samma konto som i Vips — har du ett där fungerar det här. Du ansvarar för att uppgifterna du anger stämmer och för att hålla lösenordet för dig själv. Du måste vara 18 år eller ha målsmans tillstånd.",
        )}
      </p>

      <h2>{t("Vad du intygar när du laddar upp")}</h2>
      <ul>
        <li>{t("att möbeln är din, eller att du på annat sätt har rätt att sälja den")}</li>
        <li>{t("att bilderna är dina egna")}</li>
        <li>{t("att du inte medvetet filmar andra människor, deras egendom eller något som identifierar dem")}</li>
        <li>{t("att du inte laddar upp något olagligt eller kränkande")}</li>
      </ul>

      <h2>{t("Rätten till dina bilder")}</h2>
      <p>
        {t(
          "Bilderna förblir dina. Du ger oss rätt att använda dem för att utföra tjänsten — bedöma skicket, bygga annonsen och publicera den där möbeln säljs. Vi använder dem inte till något annat, och rätten upphör när du raderar annonsen eller ditt konto. Vilka underleverantörer som får se bilderna på vägen står i",
        )}{" "}
        <LegalLink doc="privacy">{t("integritetspolicyn")}</LegalLink>.
      </p>

      <h2>{t("Bedömningen är ett förslag")}</h2>
      <p>
        {t(
          "Skickbetyget, skadelistan och prisförslaget tas fram automatiskt ur dina bilder. De är kvalificerade bedömningar, inte garantier, och en modell kan både missa en skada och peka ut en som inte finns. Därför kan du invända mot varje enskilt fynd innan annonsen går ut.",
        )}
      </p>
      <p>
        <strong>{t("Annonsen är ditt ansvar.")}</strong>{" "}
        {t(
          "Det är du som säljer möbeln, och det är du som ansvarar för att det som står i annonsen stämmer. Läs igenom den innan du lägger ut den.",
        )}
      </p>

      <h2>{t("Priset sänks automatiskt")}</h2>
      <p>
        {t("Lägger du ut en möbel sätter du ett startpris och ett lägsta pris. Ligger annonsen osåld sänks priset därefter automatiskt med")}{" "}
        <strong>{t("15 % i veckan")}</strong>{" "}
        {t(
          "tills ditt lägsta pris är nått — sedan står det stilla. Du väljer golvet, så du bestämmer var det slutar; sänkningen däremellan sköter sig själv och kräver ingen bekräftelse från dig.",
        )}
      </p>
      <p>
        {t(
          "När annonsen väl ligger uppe går prisspannet inte längre att ändra i appen. Vill du ändra det behöver annonsen tas ned.",
        )}
      </p>

      <h2>{t("Försäljningen")}</h2>
      <p>
        {t(
          "Annonsen publiceras via Loopas konto på Tradera. Traderas egna villkor gäller för själva köpet och för kontakten med köparen. Vi kan inte lova att en möbel blir såld, eller såld till ett visst pris.",
        )}
      </p>

      <h2>{t("Det publika kortet")}</h2>
      <p>
        {t(
          "Varje annons får ett Loopa-ID och ett publikt kort som vem som helst kan öppna, så att en köpare kan kontrollera skickpåståendet. Kortets bild är din egen möbel urklippt mot vit bakgrund — rummet omkring den klipps bort. Dina bildrutor som de togs ligger inte där, se",
        )}{" "}
        <LegalLink doc="privacy">{t("integritetspolicyn")}</LegalLink>{" "}
        {t("för exakt vad som syns.")}
      </p>

      <h2>{t("Sådant du inte får göra")}</h2>
      <ul>
        <li>{t("försöka komma åt någon annans annonser, bilder eller konto")}</li>
        <li>{t("skrapa, belasta eller kringgå spärrar i tjänsten")}</li>
        <li>{t("ladda upp bilder på något annat än möbeln du säljer")}</li>
        <li>{t("använda tjänsten för att sälja något du inte får sälja")}</li>
      </ul>
      <p>{t("Vi kan stänga av ett konto som gör något av detta.")}</p>

      <h2>{t("Ansvar")}</h2>
      <p>
        {t(
          "Tjänsten tillhandahålls i befintligt skick. Vi ansvarar inte för indirekt skada, utebliven vinst eller för att en möbel såldes för mindre än du hoppats. Ingenting i de här villkoren begränsar det ansvar som inte får begränsas enligt tvingande lag — är du konsument gäller dina rättigheter enligt konsumentlagstiftningen oavsett vad som står här.",
        )}
      </p>

      <h2>{t("Att sluta")}</h2>
      <p>
        {t("Du kan sluta använda Loopa när du vill och begära att kontot och allt vi sparat raderas, via")}{" "}
        <a href={`mailto:${CONTROLLER.email}`}>{CONTROLLER.email}</a>.{" "}
        {t("En annons som redan ligger ute på Tradera behöver tas ned där.")}
      </p>

      <h2>{t("Ändringar, lag och tvist")}</h2>
      <p>
        {t(
          "Ändrar vi villkoren i något väsentligt säger vi till i appen. Svensk lag gäller. Tvist prövas av svensk allmän domstol — är du konsument kan du också vända dig till Allmänna reklamationsnämnden,",
        )}{" "}
        <a href="https://www.arn.se" target="_blank" rel="noopener noreferrer">
          arn.se
        </a>
        .
      </p>
    </>
  );
}
