import LegalLink from "../../components/LegalLink";
import { CONTROLLER } from "../../lib/legal";
import { useT } from "../../lib/i18n";

/**
 * Integritetspolicyn.
 *
 * Skriven ur koden och inte ur en mall. Varje rad om vad vi samlar in går att peka ut i repot:
 * kontot i web/src/auth/AuthProvider.tsx, bildrutorna i server/src/jobStore.ts, det publika kortet i
 * server/src/publicCard.ts, chattens IP-spärr i server/src/server.ts. Ändras något av det ska den
 * här texten ändras i samma commit — en policy som beskriver en äldre version av tjänsten är inte en
 * mindre bra policy, den är fel.
 *
 * Det som INTE står här är lika medvetet: ingen mening om analysverktyg, mätpixlar eller annonsörer,
 * eftersom appen inte har några. En policy som gardera-räknar upp allt en app skulle kunna göra gör
 * det omöjligt att veta vad just den här gör.
 */
export default function PrivacyText() {
  const t = useT();
  return (
    <>
      <p className="legal-lede">
        {t(
          "Loopa värderar begagnade möbler ur film du spelar in själv. För att göra det behöver vi dina bilder och ett konto att knyta dem till. Den här sidan säger exakt vad vi tar emot, vad vi gör med det, vilka fler som ser det och vad du kan kräva av oss.",
        )}
      </p>

      <h2>{t("Vem som ansvarar för uppgifterna")}</h2>
      <p>
        {t("Personuppgiftsansvarig är {företag} (org.nr {orgnr}), {adress}.", {
          företag: CONTROLLER.legalName,
          orgnr: CONTROLLER.orgNumber,
          adress: CONTROLLER.address,
        })}{" "}
        {t("Frågor om den här policyn, och alla begäranden enligt avsnittet")} <em>{t("Dina rättigheter")}</em>{" "}
        {t("nedan, går till")} <a href={`mailto:${CONTROLLER.email}`}>{CONTROLLER.email}</a>.
      </p>

      <h2>{t("Vad vi samlar in, och varför")}</h2>

      <h3>{t("Ditt konto")}</h3>
      <p>
        {t(
          "E-postadress och lösenord när du registrerar dig, samt namn, användarnamn och profilbild om din profil har sådana. Lösenordet lagras aldrig i klartext — det hanteras av Supabase, som driver inloggningen åt oss.",
        )}
      </p>
      <p>
        <strong>{t("Det är samma konto som i Vips.")}</strong>{" "}
        {t(
          "Loopa och Vips delar användardatabas, så ett konto du redan har i Vips fungerar här utan ny registrering — och ett konto du skapar här fungerar i Vips. Det är värt att veta innan du registrerar dig, inte efteråt.",
        )}
      </p>
      <p className="legal-basis">
        {t("Rättslig grund: avtal (art. 6.1 b) — utan konto kan annonsen inte ägas av någon.")}
      </p>

      <h3>{t("Filmen och bildrutorna")}</h3>
      <p>
        {t(
          "När du filmar ett varv runt möbeln plockas ett antal bildrutor ur filmen och laddas upp till vår server. Bilderna är tagna hemma hos dig, och det syns: de kan visa rummet, andra möbler, saker på golvet och personer som råkar gå förbi. Vi ber dig inte om något av det, men vi tar emot det, och därför står det här.",
        )}
      </p>
      <p className="legal-basis">{t("Rättslig grund: avtal (art. 6.1 b) — bilderna är det tjänsten bedömer.")}</p>

      <h3>{t("Uppgifter om möbeln")}</h3>
      <p>
        {t(
          "Märke och modell du anger, mått och specifikationer, skickbetyget, varje skada med typ och placering, prisförslaget, samt det Loopa-ID annonsen får. Kopplat till ditt konto och till tidpunkten då du skapade den.",
        )}
      </p>
      <p className="legal-basis">{t("Rättslig grund: avtal (art. 6.1 b).")}</p>

      <h3>{t("Frågor i annonschatten")}</h3>
      <p>
        {t(
          "Skriver du en fråga till en annons skickas frågan, och de senaste svaren i samma samtal, till Google för att besvaras. Chatten är öppen — den kräver inget konto — så vi vet inte vem som frågar, bara vad som frågades.",
        )}
      </p>
      <p className="legal-basis">
        {t("Rättslig grund: berättigat intresse (art. 6.1 f) — att en köpare ska kunna kontrollera en annons.")}
      </p>

      <h3>{t("IP-adress vid chatten")}</h3>
      <p>
        {t("Din IP-adress hålls i serverns minne i")} <strong>{t("60 sekunder")}</strong>{" "}
        {t(
          "för att räkna hur många frågor som kommer från samma håll och stoppa överbelastning. Den skrivs inte till någon fil, kopplas inte till ditt konto och finns inte kvar efter en minut.",
        )}
      </p>
      <p className="legal-basis">{t("Rättslig grund: berättigat intresse (art. 6.1 f) — att hålla tjänsten uppe.")}</p>

      <h3>{t("Lagring i din webbläsare")}</h3>
      <p>
        {t(
          "En inloggningskaka, en kaka som låter din webbläsare hämta dina egna bilder, och — om du godkänner det — chatthistoriken på en annons du läser. Varje post står uppräknad i",
        )}{" "}
        <LegalLink doc="cookies">{t("cookiepolicyn")}</LegalLink>.
      </p>

      <h2>{t("Vad vi inte gör")}</h2>
      <ul>
        <li>{t("Vi har inga analysverktyg, ingen mätpixel och ingen annonsspårning i appen.")}</li>
        <li>{t("Vi följer dig inte till andra webbplatser.")}</li>
        <li>{t("Vi säljer inte dina uppgifter, och lämnar dem inte till någon för marknadsföring.")}</li>
        <li>
          {t(
            "Vi fattar inga automatiska beslut med rättslig verkan för dig. Skickbetyget sätts av en modell, men det är ett förslag på din egen annons som du kan invända mot och ändra.",
          )}
        </li>
      </ul>

      <h2>{t("Vad som blir publikt — och vad som inte blir det")}</h2>
      <p>
        {t("Läggs din möbel ut till salu får den ett publikt kort på")} <code>/c/</code>{" "}
        {t(
          "och sitt Loopa-ID. Vem som helst som har ID:t kan öppna det, utan konto. Det är hela poängen: en annons som påstår att skicket är granskat ska gå att kontrollera.",
        )}
      </p>
      <p>{t("På det publika kortet står:")}</p>
      <ul>
        <li>{t("möbelns märke, modell, mått och specifikationer")}</li>
        <li>{t("skickbetyget och varje skada som står kvar efter din granskning")}</li>
        <li>{t("prisförslaget")}</li>
        <li>
          <strong>{t("en bild av möbeln, urklippt mot vit bakgrund.")}</strong>{" "}
          {t(
            "Den görs ur en av dina egna bildrutor: möbeln behålls, allt annat i bilden klipps bort och ersätts med vitt. Går den inte att göra visar kortet tillverkarens produktbild av modellen i stället, när vi hittat en",
          )}
        </li>
      </ul>
      <p>
        {t("På det publika kortet står")} <strong>{t("inte")}</strong>:
      </p>
      <ul>
        <li>{t("ditt namn, din e-postadress eller något annat som pekar ut dig")}</li>
        <li>{t("dina bildrutor som de togs, eller närbilderna på skadorna")}</li>
      </ul>
      <p>
        {t(
          "Dina fotografier stannar alltså bakom inloggningen — det enda som lämnar den är möbeln själv, fri från rummet den stod i. Skadorna visas på en ritning byggd ur måtten. Det är ett medvetet val: bilderna är tagna i ditt hem, och rummet behövs inte för att en köpare ska kunna kontrollera ett skick.",
        )}
      </p>

      <h2>{t("Vilka fler som behandlar uppgifterna")}</h2>
      <dl className="legal-list">
        <dt>Google (Gemini)</dt>
        <dd>
          {t(
            "Bildrutorna och texten om möbeln skickas till Googles modell-API för att bedömas, och chattfrågor skickas dit för att besvaras. Det är där själva analysen sker.",
          )}
        </dd>

        <dt>Supabase</dt>
        <dd>{t("Driver inloggningen och lagrar konto- och profiluppgifterna.")}</dd>

        <dt>Tradera</dt>
        <dd>
          {t(
            "Väljer du att lägga ut möbeln till salu skickas annonstexten, bilderna som ska visas i annonsen, priset och ditt Loopa-ID till Tradera, där annonsen publiceras. Annonsen läggs upp via Loopas konto.",
          )}
        </dd>

        <dt>Google Fonts</dt>
        <dd>
          {t(
            "Appens typsnitt hämtas från Googles servrar, vilket innebär att din IP-adress når Google när sidan laddas. Ingen kaka sätts av det.",
          )}
        </dd>

        <dt>{t("Loopas personal")}</dt>
        <dd>
          {t(
            "Ett fåtal namngivna administratörer kan läsa användarkonton och annonser för att kunna ge support och rätta fel. De kan läsa, aldrig ändra i din annons.",
          )}
        </dd>
      </dl>

      <h2>{t("Överföring utanför EU/EES")}</h2>
      <p>
        {t(
          "Google och Supabase kan behandla uppgifter utanför EU/EES. Sådana överföringar sker med stöd av EU-kommissionens standardavtalsklausuler eller ett giltigt beslut om adekvat skyddsnivå. Vill du veta vilken grund som gäller för en viss leverantör, hör av dig till",
        )}{" "}
        <a href={`mailto:${CONTROLLER.email}`}>{CONTROLLER.email}</a>.
      </p>

      <h2>{t("Hur länge vi sparar")}</h2>
      <ul>
        <li>
          <strong>{t("Konto och profil:")}</strong> {t("så länge du har ett konto.")}
        </li>
        <li>
          <strong>{t("Bildrutor, skickrapport och annons:")}</strong>{" "}
          {t("så länge annonsen finns kvar hos dig. Begär du radering tas de bort.")}
        </li>
        <li>
          <strong>{t("IP-adress vid chatten:")}</strong> {t("60 sekunder.")}
        </li>
        <li>
          <strong>{t("Chatthistorik i din webbläsare:")}</strong>{" "}
          {t("de senaste tolv meddelandena per annons, tills du rensar webbläsaren eller tar tillbaka ditt samtycke.")}
        </li>
      </ul>
      <p>
        {t(
          "En annons som redan publicerats på Tradera lyder under Traderas egna villkor och lagringstider så länge den ligger uppe där.",
        )}
      </p>

      <h2>{t("Dina rättigheter")}</h2>
      <p>{t("Du har rätt att")}</p>
      <ul>
        <li>{t("få veta vilka uppgifter vi har om dig, och få en kopia av dem")}</li>
        <li>{t("få felaktiga uppgifter rättade")}</li>
        <li>{t("få uppgifter raderade")}</li>
        <li>{t("invända mot behandling som vilar på berättigat intresse")}</li>
        <li>{t("begära att behandlingen begränsas")}</li>
        <li>{t("få de uppgifter du lämnat i ett maskinläsbart format, och flyttade till någon annan")}</li>
        <li>{t("när som helst ta tillbaka ett samtycke du gett, utan att det påverkar det som redan gjorts")}</li>
      </ul>
      <p>
        {t("Skicka din begäran till")} <a href={`mailto:${CONTROLLER.email}`}>{CONTROLLER.email}</a>{" "}
        {t("från adressen kontot ligger på. Vi svarar inom en månad.")}
      </p>
      <p>
        {t("Tycker du att vi behandlar dina uppgifter fel har du rätt att klaga till Integritetsskyddsmyndigheten,")}{" "}
        <a href="https://www.imy.se" target="_blank" rel="noopener noreferrer">
          imy.se
        </a>
        .
      </p>

      <h2>{t("Ändringar")}</h2>
      <p>
        {t(
          "Ändrar vi vad vi samlar in, varför, eller vilka som får del av det, uppdaterar vi den här sidan och datumet överst. Rör ändringen något du gett samtycke till frågar vi om på nytt.",
        )}
      </p>
    </>
  );
}
