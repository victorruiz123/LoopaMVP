import { ArrowLeftIcon } from "../components/icons";
import { usePageTitle } from "../lib/pageTitle";
import { useLang, useT } from "../lib/i18n";
import { LEGAL_TITLES, legalUpdated, legalHref, type LegalDoc } from "../lib/legal";
import PrivacyText from "./legal/PrivacyText";
import CookieText from "./legal/CookieText";
import TermsText from "./legal/TermsText";

/**
 * De tre juridiska sidorna, med samma ram.
 *
 * De ligger utanför säljflödet och nås på sin egen adress — inte som ett läge i App:s useState —
 * eftersom de måste gå att länka till: från inloggningen, från cookierutan, och från en Tradera-
 * annons om någon frågar var uppgifterna tar vägen. Se lib/legal.ts.
 */
export default function LegalScreen({ doc }: { doc: LegalDoc }) {
  const t = useT();
  const { lang } = useLang();
  usePageTitle(LEGAL_TITLES[doc]);

  /**
   * Sidorna öppnas i en ny flik, och i en ny flik finns ingenting att gå tillbaka TILL.
   *
   * `history.length > 1` skiljer de två fallen: den som klickade sig hit inifrån appen får en väg
   * tillbaka dit de var, den som öppnade länken i en tom flik får en väg in i appen i stället.
   * Måttet är inte exakt i alla webbläsare, men fel åt båda hållen ger en fungerande länk — och
   * alternativet, en knapp som ibland inte gör något, är sämre än så.
   */
  const canGoBack = window.history.length > 1;

  return (
    <div className="screen screen-light legal">
      {canGoBack ? (
        <button className="btn btn-text btn-back" onClick={() => window.history.back()}>
          <ArrowLeftIcon /> {t("Tillbaka")}
        </button>
      ) : (
        <a className="btn btn-text btn-back" href="/">
          <ArrowLeftIcon /> {t("Till Loopa")}
        </a>
      )}

      <header className="legal-head">
        <h1 className="legal-title">{t(LEGAL_TITLES[doc])}</h1>
        <p className="legal-updated">{t("Senast uppdaterad {datum}", { datum: legalUpdated(lang) })}</p>
      </header>

      {/* Ett juridiskt dokument som översätts blir två löften om man inte säger vilket som gäller.
          Svenskan är originalet — den här raden står bara för den som läser en översättning. */}
      {lang !== "sv" && (
        <p className="legal-translation-note">
          {t("Det här är en översättning. Vid tvist gäller den svenska texten.")}
        </p>
      )}

      <article className="legal-body">
        {doc === "privacy" && <PrivacyText />}
        {doc === "cookies" && <CookieText />}
        {doc === "terms" && <TermsText />}
      </article>

      {/* De tre hör ihop och läses ofta i följd — den som letar efter var bilderna tar vägen vet
          inte på förhand vilken av dem som svarar. */}
      <nav className="legal-nav" aria-label={t("Fler dokument")}>
        {(Object.keys(LEGAL_TITLES) as LegalDoc[])
          .filter((other) => other !== doc)
          .map((other) => (
            <a key={other} className="legal-nav-link" href={legalHref(other)}>
              {t(LEGAL_TITLES[other])}
            </a>
          ))}
      </nav>
    </div>
  );
}
