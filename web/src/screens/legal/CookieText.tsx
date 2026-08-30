import { useConsent, reopenConsent } from "../../lib/consent";
import LegalLink from "../../components/LegalLink";
import { useLang, useT } from "../../lib/i18n";

/**
 * Cookiepolicyn — uppräkningen av vad appen faktiskt lägger i webbläsaren.
 *
 * Listan nedan ska stämma post för post med koden. Var de sätts:
 *   loopa_media            server/src/identity.ts
 *   sb-...-auth-token      web/src/lib/supabase.ts (Supabase-klienten)
 *   loopa.consent          web/src/lib/consent.ts
 *   loopa-card-chat:<ID>   web/src/components/ListingChat.tsx
 *   loopa.view-mode        web/src/lib/viewMode.ts
 *
 * Lägger någon till en post till utan att skriva in den här blir sidan osann, och en osann
 * cookielista är precis den sortens sak tillsynen tittar på.
 */
export default function CookieText() {
  const t = useT();
  const { lang } = useLang();
  const consent = useConsent();

  return (
    <>
      <p className="legal-lede">
        {t(
          "Loopa lagrar fem saker i din webbläsare, och ingen av dem följer dig till någon annan webbplats. Vi har inga analysverktyg, ingen mätpixel och inga annonskakor — så det finns ingenting här att stänga av för att slippa bli spårad, av det enkla skälet att vi inte spårar.",
        )}
      </p>

      <h2>{t("Nödvändigt — kräver inget samtycke")}</h2>
      <p>
        {t(
          "Utan de här fungerar inte det du bett appen göra. De får enligt lag sättas utan att vi frågar, och de går inte att välja bort utan att sluta använda tjänsten.",
        )}
      </p>

      <dl className="legal-list">
        <dt>
          <code>loopa_media</code> <span className="legal-tag">{t("Kaka · 24 timmar")}</span>
        </dt>
        <dd>
          {t(
            "Låter din webbläsare hämta bildrutorna från din egen möbel. En bild i en sida kan inte skicka med ett inloggningstoken, så utan den här kakan hade bildvägarna behövt vara öppna för vem som helst som gissade rätt jobb-ID. Den är signerad, går bara att läsa av servern, gäller bara adresser under",
          )}{" "}
          <code>/api/jobs</code> {t("och accepteras bara för hämtning — aldrig för att ändra något.")}
        </dd>

        <dt>
          <code>sb-…-auth-token</code>{" "}
          <span className="legal-tag">{t("Lokal lagring · tills du loggar ut")}</span>
        </dt>
        <dd>
          {t("Håller dig inloggad mellan besöken. Sätts av Supabase, som driver inloggningen. Rensas när du loggar ut.")}
        </dd>

        <dt>
          <code>loopa.consent</code>{" "}
          <span className="legal-tag">{t("Lokal lagring · tills du ändrar dig")}</span>
        </dt>
        <dd>
          {t(
            "Ditt svar på cookierutan, och dagen du svarade. Den måste sparas — annars hade rutan kommit tillbaka vid varje sidladdning och ditt nej aldrig blivit ihågkommet.",
          )}
        </dd>

        <dt>
          <code>loopa.view-mode</code>{" "}
          <span className="legal-tag">{t("Lokal lagring · tills du rensar")}</span>
        </dt>
        <dd>
          {t(
            "Tvingar fram dator- eller mobillayout. Ingen knapp i appen skriver den — den finns bara för den som sätter den själv från webbläsarens konsol, och står med här för att listan ska vara fullständig.",
          )}
        </dd>
      </dl>

      <h2>{t("Funktionellt — kräver ditt samtycke")}</h2>
      <dl className="legal-list">
        <dt>
          <code>loopa-card-chat:&lt;Loopa-ID&gt;</code>{" "}
          <span className="legal-tag">{t("Lokal lagring · tills du rensar")}</span>
        </dt>
        <dd>
          {t(
            "De senaste tolv meddelandena i chatten om en annons, så att samtalet finns kvar om du laddar om sidan. Säger du nej sparas ingenting — chatten fungerar precis som vanligt, men börjar om varje gång sidan laddas. Tar du tillbaka ett ja raderas det som redan lagrats.",
          )}
        </dd>
      </dl>

      <h2>{t("Analys och marknadsföring")}</h2>
      <p>
        {t(
          "Inga. Den här rubriken står här tom med flit, så att du vet att den är tom och inte att vi glömde skriva den.",
        )}
      </p>

      <h2>{t("Typsnitt från Google")}</h2>
      <p>
        {t("Appens typsnitt hämtas från")} <code>fonts.googleapis.com</code>.{" "}
        {t(
          "Det sätter ingen kaka, men din IP-adress når Google när sidan laddas. Det kan du inte välja bort i rutan — det är en del av hur sidan hämtas, inte något som lagras hos dig.",
        )}
      </p>

      <h2>{t("Ditt val")}</h2>
      {consent ? (
        <p>
          {t("Du har svarat: funktionell lagring är")}{" "}
          <strong>{consent.functional ? t("godkänd") : t("avvisad")}</strong>
          {consent.decidedAt
            ? ` ${t("sedan {datum}", { datum: new Date(consent.decidedAt).toLocaleDateString(lang) })}`
            : ""}
          .
        </p>
      ) : (
        <p>{t("Du har inte svarat på cookierutan än.")}</p>
      )}
      <p>
        <button className="btn btn-outline btn-small" onClick={reopenConsent}>
          {t("Ändra mitt val")}
        </button>
      </p>
      <p className="small muted">
        {t(
          "Du kan också rensa allt ovanstående när som helst i webbläsarens egna inställningar. Rensar du inloggningstoken loggas du ut.",
        )}
      </p>

      <h2>{t("Mer")}</h2>
      <p>
        {t("Vad vi gör med uppgifterna, vilka fler som ser dem och vad du kan kräva av oss står i")}{" "}
        <LegalLink doc="privacy">{t("integritetspolicyn")}</LegalLink>.
      </p>
    </>
  );
}
