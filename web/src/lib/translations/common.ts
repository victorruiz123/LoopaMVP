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
  // Toppradens väg till köpsidan. Verb, inte substantiv: knappen leder till att handla, och
  // "Shop"/"Boutique" hade beskrivit en plats i stället för vad man kan göra där.
  "Köp": { en: "Buy", fr: "Acheter" },
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
  "Granskas av Loopa": { en: "Under review", fr: "En cours de vérification" },
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

  // ---- profilen (screens/ProfileScreen.tsx) ----
  " på Tradera": { en: " on Tradera", fr: " sur Tradera" },
  "5 % på allt de säljer": { en: "5% of everything they sell", fr: "5 % sur tout ce qu'ils vendent" },
  "Affiliate": { en: "Affiliate", fr: "Affiliation" },
  "Affärer": { en: "Deals", fr: "Affaires" },
  "Annons uppe": { en: "Listing live", fr: "Annonce en ligne" },
  "Bjud in": { en: "Invite", fr: "Inviter" },
  "Dela": { en: "Share", fr: "Partager" },
  "Din tur": { en: "Your move", fr: "À vous" },
  "En vän": { en: "A friend", fr: "Un ami" },
  "För varje såld annons från någon som registrerat sig via din länk.": { en: "For every sold listing from someone who signed up through your link.", fr: "Pour chaque annonce vendue par quelqu'un inscrit via votre lien." },
  "Gäller till {datum}": { en: "Valid until {datum}", fr: "Valable jusqu'au {datum}" },
  "Inga köp än": { en: "No purchases yet", fr: "Aucun achat pour l'instant" },
  "Inget att visa just nu": { en: "Nothing to show right now", fr: "Rien à afficher pour l'instant" },
  "Inget här just nu": { en: "Nothing here right now", fr: "Rien ici pour l'instant" },
  "Jag säljer mina möbler med Loopa AI. Du filmar, de sköter resten.": { en: "I sell my furniture with Loopa AI. You film it, they handle the rest.", fr: "Je vends mes meubles avec Loopa AI. Vous filmez, ils s'occupent du reste." },
  "Kopierad": { en: "Copied", fr: "Copié" },
  "Köper": { en: "Buying", fr: "Achats" },
  "Köpt": { en: "Bought", fr: "Acheté" },
  "Länk": { en: "Link", fr: "Lien" },
  "När en vän lagt upp sin första annons.": { en: "When a friend posts their first listing.", fr: "Quand un ami publie sa première annonce." },
  "Nästa försäljning gratis": { en: "Next sale free", fr: "Prochaine vente gratuite" },
  "Profil": { en: "Profile", fr: "Profil" },
  "Registrerad": { en: "Signed up", fr: "Inscrit" },
  "Sparade": { en: "Saved", fr: "Enregistrées" },
  "Sälj dina begagnade möbler med Loopa AI.": { en: "Sell your used furniture with Loopa AI.", fr: "Vendez vos meubles d'occasion avec Loopa AI." },
  "Säljer": { en: "Selling", fr: "Ventes" },
  "Sålda": { en: "Sold", fr: "Vendues" },
  "Sålt": { en: "Sold", fr: "Vendu" },
  "Tjäna": { en: "Earn", fr: "Gagner" },
  "Utbetalt {belopp}": { en: "Paid out {belopp}", fr: "Versé {belopp}" },
  "Visa": { en: "Show", fr: "Afficher" },
  "Värde": { en: "Value", fr: "Valeur" },
  "annonser": { en: "listings", fr: "annonces" },
  "gratis": { en: "free", fr: "gratuites" },
  "gratisförsäljning": { en: "free sale", fr: "vente gratuite" },
  "inbjudna": { en: "invited", fr: "invités" },
  "registrerade": { en: "signed up", fr: "inscrits" },
  "sålda": { en: "sold", fr: "vendues" },
  "uppe 1 dag": { en: "live 1 day", fr: "en ligne depuis 1 jour" },
  "uppe {antal} dagar": { en: "live {antal} days", fr: "en ligne depuis {antal} jours" },
  "utbetalt": { en: "paid out", fr: "versé" },
  "utlagd i dag": { en: "listed today", fr: "publiée aujourd'hui" },
  "väntande": { en: "pending", fr: "en attente" },
  "väntar på dig": { en: "waiting for you", fr: "vous attend" },
  "{antal} klick": { en: "{antal} clicks", fr: "{antal} clics" },
  "{antal} ute": { en: "{antal} live", fr: "{antal} en ligne" },
  "{antal} visningar": { en: "{antal} views", fr: "{antal} vues" },
  "{belopp} ute": { en: "{belopp} live", fr: "{belopp} en ligne" },
};
