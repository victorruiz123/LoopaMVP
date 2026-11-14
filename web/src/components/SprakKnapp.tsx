import { useLang, type Lang } from "../lib/i18n";

/**
 * Språkknappen i topplisten: SV | EN.
 *
 * VARFÖR DEN FINNS. Väljaren låg tidigare bara i profilen (components/LanguagePicker), och appen
 * öppnades på webbläsarens språk. En svensk kund med telefonen på engelska fick då hela sajten på
 * engelska — utan konto fanns ingen profil, och därmed ingen väg tillbaka. Språket är numera svenska
 * tills någon väljer annat, och valet ska gå att göra där alla ser det: på startsidan, utloggad.
 *
 * TVÅ LÄGEN OCH INTE EN MENY. Svenska och engelska är de två en besökare på loopa.nu letar efter, och
 * ett segment visar båda på en gång — vilket språk som gäller och vilket man kan byta till, utan att
 * något behöver fällas ut. Franskan finns kvar i profilens väljare.
 *
 * Koderna står som de är ("SV", "EN") och översätts inte, av samma skäl som språknamnen i
 * LanguagePicker: den som letar efter engelska letar efter "EN".
 *
 * `variant` styr bara var den syns, med CSS (se .sprak-knapp-* i styles.css): "rad" syns på breda
 * skärmar, "ovanfor" på smala, där ordmärket och flikarna redan fyller bredden. Utan variant syns den
 * alltid — startsidan väljer placering själv efter sitt dator-/mobilläge (lib/viewMode).
 */
const VAL: Array<{ code: Lang; short: string; label: string }> = [
  { code: "sv", short: "SV", label: "Svenska" },
  { code: "en", short: "EN", label: "English" },
];

export default function SprakKnapp({ variant }: { variant?: "rad" | "ovanfor" }) {
  const { lang, setLang } = useLang();
  return (
    <div className={`sprak-knapp ${variant ? `sprak-knapp-${variant}` : ""}`} role="group" aria-label="Språk / Language">
      {VAL.map((v) => {
        const aktiv = lang === v.code;
        return (
          <button
            key={v.code}
            type="button"
            lang={v.code}
            className={`sprak-knapp-val ${aktiv ? "sprak-knapp-aktiv" : ""}`}
            aria-pressed={aktiv}
            aria-label={v.label}
            title={v.label}
            onClick={() => setLang(v.code)}
          >
            {v.short}
          </button>
        );
      })}
    </div>
  );
}
