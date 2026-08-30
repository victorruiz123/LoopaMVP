import type { Translation } from "../translations";

/**
 * Annonsen och allt runt den: kortet, chatten, säljrutan, det publika uppslaget — plus
 * adminpanelen och den tekniska panelen, som är samma sorts text fast för oss.
 */

export const LISTING: Record<string, Translation> = {
  // ---- annonskortet ----
  "Säljarens egen bild av möbeln, bakgrunden borttagen": {
    en: "The seller's own photo of the furniture, background removed",
    fr: "Photo du meuble prise par le vendeur, fond supprimé",
  },
  "Produktbild av modellen — inte möbeln som säljs": {
    en: "Catalogue photo of the model — not the piece being sold",
    fr: "Photo catalogue du modèle — pas le meuble mis en vente",
  },
  "Marknadsvärde för skicket, efter {andel} % avdrag för skadorna.": {
    en: "Market value for this condition, after a {andel}% deduction for the damage.",
    fr: "Valeur de marché pour cet état, après une déduction de {andel} % pour les dommages.",
  },
  "Marknadsvärde för skicket, från jämförbara annonser.": {
    en: "Market value for this condition, from comparable listings.",
    fr: "Valeur de marché pour cet état, d'après des annonces comparables.",
  },
  Skickrapport: { en: "Condition report", fr: "Rapport d'état" },
  "{antal} anmärkning": { en: "{antal} finding", fr: "{antal} constat" },
  "{antal} anmärkningar": { en: "{antal} findings", fr: "{antal} constats" },
  "Inspektionen hittade inga synliga skador.": {
    en: "The inspection found no visible damage.",
    fr: "L'inspection n'a relevé aucun dommage visible.",
  },
  "Punkterna i bilden har samma nummer som listan.": {
    en: "The points on the drawing carry the same numbers as the list.",
    fr: "Les points du schéma portent les mêmes numéros que la liste.",
  },
  "Om möbeln": { en: "About the furniture", fr: "À propos du meuble" },
  "Tillbaka till skicket": { en: "Back to the condition", fr: "Retour à l'état" },
  "Letar upp modell och specifikationer…": {
    en: "Looking up model and specifications…",
    fr: "Recherche du modèle et des caractéristiques…",
  },
  "Inget märke angavs, så det fanns inget att söka på.": {
    en: "No brand was given, so there was nothing to search for.",
    fr: "Aucune marque n'a été indiquée, il n'y avait donc rien à rechercher.",
  },
  "Till startsidan": { en: "To the home screen", fr: "Vers l'accueil" },

  // ---- Loopa-ID ----
  "Loopa-ID": { en: "Loopa ID", fr: "Identifiant Loopa" },
  "Kopiera Loopa-ID": { en: "Copy Loopa ID", fr: "Copier l'identifiant Loopa" },
  Kopiera: { en: "Copy", fr: "Copier" },
  Kopierat: { en: "Copied", fr: "Copié" },
  "Annonsen är publik. ID:t står i Tradera-annonsen, och den som söker på det hos Loopa ser skicket, alla skador, måtten och källorna — men aldrig dina egna bilder eller ditt konto.": {
    en: "The listing is public. The ID appears in the Tradera ad, and anyone looking it up at Loopa sees the condition, every damage, the dimensions and the sources — but never your own photos or your account.",
    fr: "L'annonce est publique. L'identifiant figure dans l'annonce Tradera : quiconque le recherche chez Loopa voit l'état, chaque dommage, les dimensions et les sources — mais jamais vos propres photos ni votre compte.",
  },
  "Öppna den publika annonsen": { en: "Open the public listing", fr: "Ouvrir l'annonce publique" },

  // ---- chatten på kortet ----
  "Fråga om möbeln": { en: "Ask about the furniture", fr: "Poser une question sur le meuble" },
  "Ställ en fråga om {namn}. Svaren kommer ur besiktningen bakom den här annonsen — måtten, skicket, varje anmärkning och priset.": {
    en: "Ask a question about {namn}. The answers come from the inspection behind this listing — the dimensions, the condition, every finding and the price.",
    fr: "Posez une question sur {namn}. Les réponses proviennent de l'inspection derrière cette annonce — dimensions, état, chaque constat et le prix.",
  },
  "Allmän kunskap — inte besiktat för just den här möbeln.": {
    en: "General knowledge — not inspected for this particular piece.",
    fr: "Connaissance générale — non vérifiée pour ce meuble précis.",
  },
  "Skriver svar": { en: "Writing an answer", fr: "Rédaction de la réponse" },
  "Skriv en fråga…": { en: "Type a question…", fr: "Écrivez une question…" },
  "Skicka frågan": { en: "Send the question", fr: "Envoyer la question" },
  "Hur allvarliga är skadorna?": { en: "How serious is the damage?", fr: "Quelle est la gravité des dommages ?" },
  "Har den några skador alls?": { en: "Does it have any damage at all?", fr: "Présente-t-il le moindre dommage ?" },
  "Vilka mått har den?": { en: "What are its dimensions?", fr: "Quelles sont ses dimensions ?" },
  "Vad är den gjord av?": { en: "What is it made of?", fr: "En quoi est-il fabriqué ?" },
  "Varför just det priset?": { en: "Why that price?", fr: "Pourquoi ce prix ?" },
  "Vad säger besiktningen om skicket?": { en: "What does the inspection say about the condition?", fr: "Que dit l'inspection sur l'état ?" },

  // ---- sälj med Loopa ----
  "Sälj med Loopa": { en: "Sell with Loopa", fr: "Vendre avec Loopa" },
  "Möbeln är till salu": { en: "The furniture is for sale", fr: "Le meuble est en vente" },
  "Loopa sköter försäljningen härifrån. Du får besked så fort möbeln är såld — du behöver inte göra något mer. Annonsen ligger uppe på Tradera, på Loopas konto.": {
    en: "Loopa takes the sale from here. You'll hear from us as soon as the piece sells — nothing more for you to do. The ad is up on Tradera, on Loopa's account.",
    fr: "Loopa prend la vente en charge à partir d'ici. Vous serez prévenu dès que le meuble est vendu — vous n'avez plus rien à faire. L'annonce est en ligne sur Tradera, sur le compte de Loopa.",
  },
  "Till dina annonser": { en: "To your listings", fr: "Vers vos annonces" },
  "Lägger ut möbeln till salu…": { en: "Putting the furniture up for sale…", fr: "Mise en vente du meuble…" },
  "Annonsen köas och bilderna laddas upp. Det tar oftast under en minut.": {
    en: "The ad is queued and the photos are uploading. It usually takes under a minute.",
    fr: "L'annonce est en file d'attente et les photos sont en cours d'envoi. Cela prend généralement moins d'une minute.",
  },
  "Möbeln går inte att lägga ut till salu än.": {
    en: "The furniture can't be put up for sale yet.",
    fr: "Le meuble ne peut pas encore être mis en vente.",
  },
  "Annonsen kunde inte läggas ut: {fel}": { en: "The ad couldn't be published: {fel}", fr: "L'annonce n'a pas pu être publiée : {fel}" },
  "Vi lägger ut möbeln till salu till fast pris, med bilderna från skanningen och skicket från besiktningen. Sedan sköter vi annonsen — och hör av oss så fort den är såld.": {
    en: "We put the furniture up for sale at a fixed price, with the photos from the scan and the condition from the inspection. Then we run the ad — and get in touch as soon as it sells.",
    fr: "Nous mettons le meuble en vente à prix fixe, avec les photos du scan et l'état issu de l'inspection. Nous gérons ensuite l'annonce — et vous prévenons dès qu'il est vendu.",
  },
  "Vi lägger ut möbeln till salu i {dagar} dagar, med bilderna från skanningen och skicket från besiktningen. Sedan sköter vi annonsen — och hör av oss så fort den är såld.": {
    en: "We put the furniture up for sale for {dagar} days, with the photos from the scan and the condition from the inspection. Then we run the ad — and get in touch as soon as it sells.",
    fr: "Nous mettons le meuble en vente pendant {dagar} jours, avec les photos du scan et l'état issu de l'inspection. Nous gérons ensuite l'annonce — et vous prévenons dès qu'il est vendu.",
  },
  "Annonspriset börjar på {start} och sänks {andel} % i veckan ner till {golv}, där det stannar. De {frakt} för hemleveransen ligger kvar oförändrade hela vägen.": {
    en: "The ad price starts at {start} and drops {andel}% a week down to {golv}, where it stops. The {frakt} for home delivery stays unchanged the whole way.",
    fr: "Le prix affiché démarre à {start} et baisse de {andel} % par semaine jusqu'à {golv}, où il s'arrête. Les {frakt} de livraison à domicile restent inchangés tout du long.",
  },
  "Trycker du på ja går möbeln ut till salu direkt, till fast pris. Därifrån sköter Loopa annonsen och kontakten med köparen, och hör av sig när den är såld.": {
    en: "Press yes and the furniture goes up for sale right away, at a fixed price. From there Loopa runs the ad and the contact with the buyer, and gets in touch when it sells.",
    fr: "Si vous appuyez sur oui, le meuble est mis en vente immédiatement, à prix fixe. Loopa gère ensuite l'annonce et le contact avec l'acheteur, et vous prévient à la vente.",
  },
  "Trycker du på ja går möbeln ut till salu direkt, som auktion i {dagar} dagar. Därifrån sköter Loopa annonsen och kontakten med köparen, och hör av sig när den är såld.": {
    en: "Press yes and the furniture goes up for sale right away, as an auction lasting {dagar} days. From there Loopa runs the ad and the contact with the buyer, and gets in touch when it sells.",
    fr: "Si vous appuyez sur oui, le meuble est mis en vente immédiatement, aux enchères pendant {dagar} jours. Loopa gère ensuite l'annonce et le contact avec l'acheteur, et vous prévient à la vente.",
  },
  "Det här läggs ut": { en: "This is what goes up", fr: "Voici ce qui sera publié" },
  Rubrik: { en: "Title", fr: "Titre" },
  Kategori: { en: "Category", fr: "Catégorie" },
  "Pris (Köp Nu)": { en: "Price (Buy Now)", fr: "Prix (Achat immédiat)" },
  Utropspris: { en: "Starting bid", fr: "Mise à prix" },
  "{pris} för möbeln + {frakt} hemleverans": {
    en: "{pris} for the furniture + {frakt} home delivery",
    fr: "{pris} pour le meuble + {frakt} de livraison",
  },
  "ditt startpris": { en: "your starting price", fr: "votre prix de départ" },
  "annonsgeneratorns förslag, utan skadeavdrag": {
    en: "the listing generator's suggestion, without damage deduction",
    fr: "suggestion du générateur d'annonce, sans déduction pour dommages",
  },
  Prisplan: { en: "Price plan", fr: "Plan tarifaire" },
  "−{andel} % i veckan ner till {golv}": { en: "−{andel}% a week down to {golv}", fr: "−{andel} % par semaine jusqu'à {golv}" },
  "golvet nås efter {antal} vecka. Sänkningen tar bara av möbelns pris, aldrig av frakten.": {
    en: "the floor is reached after {antal} week. The drop only comes off the furniture's price, never the shipping.",
    fr: "le plancher est atteint après {antal} semaine. La baisse ne porte que sur le prix du meuble, jamais sur la livraison.",
  },
  "golvet nås efter {antal} veckor. Sänkningen tar bara av möbelns pris, aldrig av frakten.": {
    en: "the floor is reached after {antal} weeks. The drop only comes off the furniture's price, never the shipping.",
    fr: "le plancher est atteint après {antal} semaines. La baisse ne porte que sur le prix du meuble, jamais sur la livraison.",
  },
  Annonstyp: { en: "Listing type", fr: "Type d'annonce" },
  "Endast Köp Nu — ingen budgivning": { en: "Buy Now only — no bidding", fr: "Achat immédiat uniquement — pas d'enchères" },
  "Auktion, {dagar} dagar": { en: "Auction, {dagar} days", fr: "Enchère, {dagar} jours" },
  Bilder: { en: "Photos", fr: "Photos" },
  "Läggs ut på": { en: "Published on", fr: "Publiée sur" },
  "på Loopas konto, du behöver inget eget": {
    en: "on Loopa's account, you don't need one of your own",
    fr: "sur le compte de Loopa, vous n'avez pas besoin du vôtre",
  },
  "annonstexten hänvisar till det publika kortet": {
    en: "the ad text points to the public card",
    fr: "le texte de l'annonce renvoie à la fiche publique",
  },
  Leverans: { en: "Delivery", fr: "Livraison" },
  "Hemleverans ingår": { en: "Home delivery included", fr: "Livraison à domicile incluse" },
  "budfirma bokas efter köpet, ingen extra kostnad för köparen": {
    en: "a courier is booked after the purchase, at no extra cost to the buyer",
    fr: "un transporteur est réservé après l'achat, sans frais supplémentaires pour l'acheteur",
  },
  "Annonsen går upp direkt och blir publik.": {
    en: "The ad goes up straight away and becomes public.",
    fr: "L'annonce est publiée immédiatement et devient publique.",
  },
  "Ja, sälj den": { en: "Yes, sell it", fr: "Oui, vendez-le" },
  "Lägger ut…": { en: "Publishing…", fr: "Publication…" },
  "Ligger på": { en: "Currently at", fr: "Actuellement à" },
  "frakt inräknad": { en: "delivery included", fr: "livraison comprise" },
  "Lägsta priset är nått. Annonsen ligger kvar på {pris}.": {
    en: "The lowest price is reached. The ad stays at {pris}.",
    fr: "Le prix plancher est atteint. L'annonce reste à {pris}.",
  },
  "Nästa sänkning {datum} till {pris}. Golvet är {golv}.": {
    en: "Next drop {datum} to {pris}. The floor is {golv}.",
    fr: "Prochaine baisse le {datum} à {pris}. Le plancher est {golv}.",
  },
  "{antal} sänkning hittills, från {start}.": { en: "{antal} drop so far, from {start}.", fr: "{antal} baisse jusqu'ici, depuis {start}." },
  "{antal} sänkningar hittills, från {start}.": { en: "{antal} drops so far, from {start}.", fr: "{antal} baisses jusqu'ici, depuis {start}." },
  "Senaste sänkningen gick inte igenom: {fel} Vi försöker igen.": {
    en: "The last drop didn't go through: {fel} We'll try again.",
    fr: "La dernière baisse n'a pas abouti : {fel} Nous réessaierons.",
  },

  // ---- publika kortet ----
  "PUBLIK ANNONS": { en: "PUBLIC LISTING", fr: "ANNONCE PUBLIQUE" },
  "Sök på Loopa-ID": { en: "Search by Loopa ID", fr: "Rechercher par identifiant Loopa" },
  "Varje annons hos Loopa är publik och har ett eget ID, som står i Tradera-annonsen. Slå upp det så ser du hela besiktningen bakom priset: skicket, varje skada, måtten och källorna.": {
    en: "Every Loopa listing is public and has its own ID, printed in the Tradera ad. Look it up and you'll see the whole inspection behind the price: the condition, every damage, the dimensions and the sources.",
    fr: "Chaque annonce Loopa est publique et possède son propre identifiant, indiqué dans l'annonce Tradera. Recherchez-le pour voir toute l'inspection derrière le prix : l'état, chaque dommage, les dimensions et les sources.",
  },
  "Söker…": { en: "Searching…", fr: "Recherche…" },
  "Visa annons": { en: "Show listing", fr: "Afficher l'annonce" },
  "Annons {id}": { en: "Listing {id}", fr: "Annonce {id}" },
  "Besiktigat av Loopas AI {datum}": { en: "Inspected by Loopa's AI on {datum}", fr: "Inspecté par l'IA de Loopa le {datum}" },
  "Se annonsen på Tradera": { en: "See the ad on Tradera", fr: "Voir l'annonce sur Tradera" },
  "Sälj din egen möbel med Loopa": { en: "Sell your own furniture with Loopa", fr: "Vendez votre meuble avec Loopa" },

  // ---- adminpanelen ----
  "Nya användare": { en: "New users", fr: "Nouveaux utilisateurs" },
  "Nya konton": { en: "New accounts", fr: "Nouveaux comptes" },
  "Konton som registrerade sig idag eller igår": {
    en: "Accounts that signed up today or yesterday",
    fr: "Comptes créés aujourd'hui ou hier",
  },
  "{antal} av {total} konton": { en: "{antal} of {total} accounts", fr: "{antal} comptes sur {total}" },
  "Sök på e-post eller namn": { en: "Search by email or name", fr: "Rechercher par e-mail ou par nom" },
  "Sök användare": { en: "Search users", fr: "Rechercher des utilisateurs" },
  "Ingen träff": { en: "No match", fr: "Aucun résultat" },
  "Inga nya konton": { en: "No new accounts", fr: "Aucun nouveau compte" },
  "Ingen av de nya användarna matchar sökningen.": {
    en: "None of the new users match the search.",
    fr: "Aucun nouvel utilisateur ne correspond à la recherche.",
  },
  "Ingen har registrerat sig idag eller igår. Kontona som fanns sedan tidigare ligger kvar — de visas bara inte här.": {
    en: "Nobody signed up today or yesterday. Existing accounts are still there — they're just not shown here.",
    fr: "Personne ne s'est inscrit aujourd'hui ni hier. Les comptes existants sont toujours là — ils ne sont simplement pas affichés ici.",
  },
  "{antal} annons": { en: "{antal} listing", fr: "{antal} annonce" },
  "{antal} annonser": { en: "{antal} listings", fr: "{antal} annonces" },
  "{antal} utan kort": { en: "{antal} without a card", fr: "{antal} sans fiche" },
  "Alla användare": { en: "All users", fr: "Tous les utilisateurs" },
  "Inga annonser": { en: "No listings", fr: "Aucune annonce" },
  "Kontot har inte fått någon besiktning hela vägen till en annons.": {
    en: "This account has no inspection that made it all the way to a listing.",
    fr: "Ce compte n'a aucune inspection allée jusqu'à une annonce.",
  },
  "Utan annons": { en: "Without a listing", fr: "Sans annonce" },

  // ---- tekniska panelen ----
  "Teknisk information": { en: "Technical information", fr: "Informations techniques" },
  "Hämtar debug-data…": { en: "Fetching debug data…", fr: "Récupération des données de débogage…" },
  Körning: { en: "Run", fr: "Exécution" },
  Täckning: { en: "Coverage", fr: "Couverture" },
  Cache: { en: "Cache", fr: "Cache" },
  Tokens: { en: "Tokens", fr: "Jetons" },
  "Total tid": { en: "Total time", fr: "Temps total" },
  Dedup: { en: "Dedup", fr: "Déduplication" },
  Syfte: { en: "Purpose", fr: "Objectif" },
  Tid: { en: "Time", fr: "Durée" },
  Helhetsbedömning: { en: "Overall assessment", fr: "Évaluation globale" },
  Slitagenivå: { en: "Wear level", fr: "Niveau d'usure" },
  Utbredning: { en: "Extent", fr: "Étendue" },
  "Funktion påverkad": { en: "Function affected", fr: "Fonction affectée" },
  "Struktur intakt": { en: "Structure intact", fr: "Structure intacte" },
  "Ser tydligt använd ut": { en: "Clearly looks used", fr: "Aspect visiblement usagé" },
  Betygsspår: { en: "Grading trace", fr: "Trace de notation" },
  Prissättning: { en: "Pricing", fr: "Tarification" },
  Status: { en: "Status", fr: "Statut" },
  Orsak: { en: "Reason", fr: "Motif" },
  Svarstid: { en: "Response time", fr: "Temps de réponse" },
  Intervall: { en: "Range", fr: "Fourchette" },
  Underlag: { en: "Basis", fr: "Base" },
  Möbeltyp: { en: "Furniture type", fr: "Type de meuble" },
  Säkerhet: { en: "Confidence", fr: "Confiance" },
  Skadeavdrag: { en: "Damage deduction", fr: "Déduction pour dommages" },
  Grad: { en: "Grade", fr: "Note" },
  Avdrag: { en: "Deduction", fr: "Déduction" },
  Värdering: { en: "Valuation", fr: "Valorisation" },
  Fynd: { en: "Findings", fr: "Constats" },
  Syntes: { en: "Visible", fr: "Visible" },
  "Utsnittet som verifieringen bedömde": {
    en: "The crop the verification assessed",
    fr: "L'extrait évalué par la vérification",
  },
  "Inget utsnitt — fyndet gick aldrig till verifiering": {
    en: "No crop — the finding never went to verification",
    fr: "Aucun extrait — le constat n'est jamais passé en vérification",
  },
  "Hög säkerhet": { en: "High confidence", fr: "Confiance élevée" },
  "Medelhög säkerhet": { en: "Medium confidence", fr: "Confiance moyenne" },
  "Låg säkerhet": { en: "Low confidence", fr: "Confiance faible" },
  "Ingen säkerhet": { en: "No confidence", fr: "Aucune confiance" },
  "Uppmätt avdrag": { en: "Measured deduction", fr: "Déduction mesurée" },
  "Uppskattad lagningskostnad": { en: "Estimated repair cost", fr: "Coût de réparation estimé" },
  "För liten för att påverka priset": { en: "Too small to affect the price", fr: "Trop faible pour influer sur le prix" },
  "Kunde inte värderas": { en: "Could not be valued", fr: "Impossible à valoriser" },

  // ---- cookierutan och de tre dokumenten ----
  Cookies: { en: "Cookies", fr: "Cookies" },
  "Loopa sparar det som krävs för att hålla dig inloggad och visa dina bilder. Utöver det bara en sak: chatthistoriken på en annons du läser.": {
    en: "Loopa stores what's needed to keep you logged in and show your photos. Beyond that, one thing only: the chat history on a listing you're reading.",
    fr: "Loopa conserve ce qui est nécessaire pour vous garder connecté et afficher vos photos. Au-delà, une seule chose : l'historique du chat d'une annonce que vous consultez.",
  },
  "Ingen analys, inga annonskakor, ingen spårning.": {
    en: "No analytics, no advertising cookies, no tracking.",
    fr: "Aucune analyse, aucun cookie publicitaire, aucun suivi.",
  },
  "Bara nödvändiga": { en: "Essential only", fr: "Strictement nécessaires" },
  "Godkänn alla": { en: "Accept all", fr: "Tout accepter" },
  Integritetspolicy: { en: "Privacy policy", fr: "Politique de confidentialité" },
  "Cookies och lagring": { en: "Cookies and storage", fr: "Cookies et stockage" },
  Användarvillkor: { en: "Terms of service", fr: "Conditions d'utilisation" },
  "Senast uppdaterad {datum}": { en: "Last updated {datum}", fr: "Dernière mise à jour : {datum}" },
  "Fler dokument": { en: "More documents", fr: "Autres documents" },
  "Till Loopa": { en: "To Loopa", fr: "Vers Loopa" },

  "Ditt prisspann": { en: "Your price range", fr: "Votre fourchette de prix" },
  "Rensa sökning": { en: "Clear search", fr: "Effacer la recherche" },
  Valt: { en: "Selected", fr: "Sélectionné" },
  "Märket finns inte i listan — men du kan använda det ändå.": {
    en: "The brand isn't in the list — but you can still use it.",
    fr: "La marque ne figure pas dans la liste — vous pouvez tout de même l'utiliser.",
  },
  "Verifieringsanropet hoppades över — inget fynd var osäkert nog att motivera det.": {
    en: "The verification call was skipped — no finding was uncertain enough to warrant it.",
    fr: "L'appel de vérification a été ignoré — aucun constat n'était assez incertain pour le justifier.",
  },
  "Inga fynd rapporterades.": { en: "No findings were reported.", fr: "Aucun constat n'a été signalé." },
};
