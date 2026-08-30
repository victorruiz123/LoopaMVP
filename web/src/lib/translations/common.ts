import type { Translation } from "../translations";

/**
 * Text som står på fler än en skärm: knappar, topplist, felmeddelanden, sidtitlar.
 *
 * En mening bor i EN av de fyra ordlistefilerna. Står samma svenska sträng i två filer vinner den
 * som spridas sist i lib/translations.ts, och då är det slumpen som översätter — så håll dem isär.
 */
export const COMMON: Record<string, Translation> = {
  // ---- knappar och navigering ----
  Tillbaka: { en: "Back", fr: "Retour" },
  "Logga in": { en: "Log in", fr: "Se connecter" },
  "Logga ut": { en: "Log out", fr: "Se déconnecter" },
  "Skapa konto": { en: "Create account", fr: "Créer un compte" },
  "Din profil": { en: "Your profile", fr: "Votre profil" },
  Rensa: { en: "Clear", fr: "Effacer" },
  Stäng: { en: "Close", fr: "Fermer" },
  Avbryt: { en: "Cancel", fr: "Annuler" },
  "Försök igen": { en: "Try again", fr: "Réessayer" },
  "Fortsätt ändå": { en: "Continue anyway", fr: "Continuer quand même" },
  "Byt modell": { en: "Change model", fr: "Changer de modèle" },
  Språk: { en: "Languages", fr: "Langues" },
  Möbel: { en: "Furniture", fr: "Meuble" },
  och: { en: "and", fr: "et" },

  // ---- sidtitlar (lib/pageTitle.ts) ----
  "Sälj din möbel": { en: "Sell your furniture", fr: "Vendez votre meuble" },
  Annons: { en: "Listing", fr: "Annonce" },
  "Publik annons": { en: "Public listing", fr: "Annonce publique" },
  "Välj modell": { en: "Choose model", fr: "Choisir le modèle" },
  "Analyserar möbeln": { en: "Analysing the furniture", fr: "Analyse du meuble" },
  Skickbedömning: { en: "Condition report", fr: "État du meuble" },
  "Mått och specifikationer": { en: "Dimensions and specifications", fr: "Dimensions et caractéristiques" },
  Prisförslag: { en: "Suggested price", fr: "Prix suggéré" },
  "Fotografera möbeln": { en: "Photograph the furniture", fr: "Photographier le meuble" },
  "Filma möbeln": { en: "Film the furniture", fr: "Filmer le meuble" },
  Adminpanel: { en: "Admin panel", fr: "Panneau d'administration" },

  // ---- listor och kort som går igen ----
  "Sparade annonser": { en: "Saved listings", fr: "Annonces enregistrées" },
  "Till salu": { en: "For sale", fr: "En vente" },
  "Läggs ut…": { en: "Publishing…", fr: "Mise en ligne…" },
  "Kunde inte läggas ut": { en: "Could not be published", fr: "Publication impossible" },
  "{antal} st": { en: "{antal} listings", fr: "{antal} annonces" },
  "Betyg {betyg}": { en: "Grade {betyg}", fr: "Note {betyg}" },

  // ---- fel som kan möta vilken skärm som helst ----
  "Vi fick inget svar från servern.": {
    en: "We got no response from the server.",
    fr: "Le serveur n'a pas répondu.",
  },
  "Analysen avbröts.": { en: "The analysis was interrupted.", fr: "L'analyse a été interrompue." },
};
