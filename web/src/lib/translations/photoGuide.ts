import type { Translation } from "../translations";

/**
 * Bildguiden (components/PhotoCaptureFlow, lib/photoGuide) och skicktestsidan (screens/SkickTestScreen).
 *
 * En mening bor i EN av ordlistefilerna — se common.ts. Texter som redan fanns i en annan fil
 * ("Ladda upp", "Hoppa över", "Tillbaka", stegens etiketter) står kvar där och upprepas inte här.
 * Platshållarna ({antal}, {vy} …) ska vara oförändrade i alla tre språken.
 */
export const PHOTO_GUIDE: Record<string, Translation> = {
  // ---- introt ----
  "Bra bilder ger en bättre annons": { en: "Good photos make a better listing", fr: "De bonnes photos font une meilleure annonce" },
  "Fota från flera håll – då blir annonsen mer trovärdig och attraktiv.": {
    en: "Shoot from several angles – it makes your listing more trustworthy and attractive.",
    fr: "Photographiez sous plusieurs angles : votre annonce sera plus crédible et plus attrayante.",
  },
  "Gott om ljus": { en: "Plenty of light", fr: "Beaucoup de lumière" },
  "Öppna gardinerna, ingen blixt.": { en: "Open the curtains, no flash.", fr: "Ouvrez les rideaux, pas de flash." },
  "Hela möbeln syns": { en: "Show the whole piece", fr: "Tout le meuble visible" },
  "Backa så att den får plats.": { en: "Step back until it fits.", fr: "Reculez jusqu'à ce qu'il tienne dans le cadre." },
  "Gå nära på detaljer": { en: "Get close to details", fr: "Approchez-vous des détails" },
  "Material, mönster och eventuellt slitage.": {
    en: "Material, pattern and any wear.",
    fr: "Matière, motif et éventuelle usure.",
  },
  "Minst {antal} bilder. De två sista är valfria.": {
    en: "At least {antal} photos. The last two are optional.",
    fr: "Au moins {antal} photos. Les deux dernières sont facultatives.",
  },
  "Fortsätt med mina bilder": { en: "Continue with my photos", fr: "Continuer avec mes photos" },
  Stegen: { en: "The steps", fr: "Les étapes" },
  "Börja fota": { en: "Start taking photos", fr: "Commencer à photographier" },
  "Fortsätt fota": { en: "Keep taking photos", fr: "Continuer à photographier" },
  "Jag har bilderna redan – ladda upp": { en: "I already have the photos – upload", fr: "J'ai déjà les photos – importer" },

  // ---- stegen ----
  "Rakt framifrån": { en: "Straight from the front", fr: "Bien de face" },
  "Stå mitt framför möbeln och backa tills hela den syns, med golvet under.": {
    en: "Stand right in front of the furniture and step back until all of it is visible, with the floor beneath.",
    fr: "Placez-vous bien en face du meuble et reculez jusqu'à le voir en entier, avec le sol en dessous.",
  },
  "Sett framifrån: gå ett kvarts varv åt vänster. Hela sidan och benen ska synas.": {
    en: "Seen from the front: walk a quarter turn to the left. The whole side and the legs should be visible.",
    fr: "Vu de face : faites un quart de tour vers la gauche. Tout le côté et les pieds doivent être visibles.",
  },
  "Fortsätt runt. Står möbeln mot en vägg, ta det du kommer åt eller hoppa över.": {
    en: "Keep going around. If the furniture stands against a wall, take what you can reach or skip.",
    fr: "Continuez le tour. Si le meuble est contre un mur, photographiez ce qui est accessible ou passez.",
  },
  "Sett framifrån: sista sidan, mitt emot den du nyss tog. Hela sidan och benen ska synas.": {
    en: "Seen from the front: the last side, opposite the one you just took. The whole side and the legs should be visible.",
    fr: "Vu de face : le dernier côté, en face de celui que vous venez de prendre. Tout le côté et les pieds doivent être visibles.",
  },
  "Luta telefonen ner mot sits eller skiva. Nedsuttet tyg och repor i ytor syns bäst uppifrån.": {
    en: "Tilt the phone down toward the seat or top. Compressed fabric and surface scratches show best from above.",
    fr: "Inclinez le téléphone vers l'assise ou le plateau. Le tissu affaissé et les rayures de surface se voient mieux d'en haut.",
  },
  "Närbild på skador": { en: "Close-up of damage", fr: "Gros plan sur les dégâts" },
  "Gå nära det du själv skulle peka på: fläckar, repor, sprickor, nedsuttet tyg. Finns inget att visa, hoppa över.": {
    en: "Get close to whatever you would point out yourself: stains, scratches, cracks, compressed fabric. If there is nothing to show, skip.",
    fr: "Approchez-vous de ce que vous montreriez vous-même : taches, rayures, fissures, tissu affaissé. S'il n'y a rien à montrer, passez.",
  },
  "Extra bild": { en: "Extra photo", fr: "Photo supplémentaire" },
  "Fotografera en skada eller detalj du vill visa. Gå nära och se till att ytan syns skarpt.": {
    en: "Photograph a damage or detail you want to show. Get close and make sure the surface is sharp.",
    fr: "Photographiez un dégât ou un détail que vous voulez montrer. Approchez-vous et veillez à ce que la surface soit nette.",
  },
  "Extra bild · {antal} av {max}": { en: "Extra photo · {antal} of {max}", fr: "Photo supplémentaire · {antal} sur {max}" },

  // Kortnamn i stegraden och översikten: sju steg delar en telefonbredd.
  Omslag: { en: "Cover", fr: "Couverture" },
  Framsida: { en: "Front", fr: "Face" },
  Vänster: { en: "Left", fr: "Gauche" },
  Baksida: { en: "Back", fr: "Arrière" },
  Höger: { en: "Right", fr: "Droite" },
  Ovan: { en: "Top", fr: "Dessus" },
  Extra: { en: "Extra", fr: "Extra" },

  // ---- kameran och steget ----
  Tips: { en: "Tips", fr: "Conseils" },
  Klar: { en: "Done", fr: "Terminé" },
  "{antal} av minst {min}": { en: "{antal} of at least {min}", fr: "{antal} sur au moins {min}" },
  "Bild sparad: {vy}. {antal} av minst {min}.": {
    en: "Photo saved: {vy}. {antal} of at least {min}.",
    fr: "Photo enregistrée : {vy}. {antal} sur au moins {min}.",
  },
  "Bilden är tagen. Ta en ny för att byta ut den.": {
    en: "The photo is taken. Take a new one to replace it.",
    fr: "La photo est prise. Prenez-en une nouvelle pour la remplacer.",
  },
  "Kameran är av. Ladda upp en bild till det här steget, eller starta kameran.": {
    en: "The camera is off. Upload a photo for this step, or start the camera.",
    fr: "La caméra est éteinte. Importez une photo pour cette étape, ou démarrez la caméra.",
  },
  "Starta kameran": { en: "Start the camera", fr: "Démarrer la caméra" },
  "Välj från galleriet": { en: "Choose from the gallery", fr: "Choisir dans la galerie" },
  "Läser…": { en: "Reading…", fr: "Lecture…" },
  "Den bilden gick inte att läsa. Prova en JPEG- eller PNG-fil.": {
    en: "That image couldn't be read. Try a JPEG or PNG file.",
    fr: "Cette image n'a pas pu être lue. Essayez un fichier JPEG ou PNG.",
  },
  "Det där är ingen bildfil.": { en: "That isn't an image file.", fr: "Ce n'est pas un fichier image." },
  "Du har redan {max} bilder, det är max.": {
    en: "You already have {max} photos, which is the maximum.",
    fr: "Vous avez déjà {max} photos, c'est le maximum.",
  },
  "Kameran är inte tillgänglig här. Den kräver HTTPS eller localhost. Du kan ladda upp bilder du redan har.": {
    en: "The camera isn't available here. It requires HTTPS or localhost. You can upload photos you already have.",
    fr: "La caméra n'est pas disponible ici. Elle nécessite HTTPS ou localhost. Vous pouvez importer des photos que vous avez déjà.",
  },
  "Kameran har stängts. Tryck på Försök igen.": {
    en: "The camera has been closed. Press Try again.",
    fr: "La caméra a été fermée. Appuyez sur Réessayer.",
  },
  "Kameran är blockerad för den här sidan. Tillåt kameran i webbläsarens inställningar och försök igen.": {
    en: "The camera is blocked for this page. Allow the camera in your browser settings and try again.",
    fr: "La caméra est bloquée pour cette page. Autorisez-la dans les paramètres du navigateur et réessayez.",
  },
  "Ingen kamera hittades på enheten.": { en: "No camera was found on this device.", fr: "Aucune caméra n'a été trouvée sur cet appareil." },
  "Kameran används av något annat just nu. Stäng andra appar som har kameran igång och försök igen.": {
    en: "The camera is in use by something else right now. Close other apps using the camera and try again.",
    fr: "La caméra est utilisée par autre chose en ce moment. Fermez les autres applications qui l'utilisent et réessayez.",
  },

  // ---- granskningen ----
  "Dina bilder": { en: "Your photos", fr: "Vos photos" },
  "{antal} av högst {max} bilder": { en: "{antal} of at most {max} photos", fr: "{antal} sur {max} photos au maximum" },
  "Tryck på en bild för att ta om den.": { en: "Tap a photo to retake it.", fr: "Touchez une photo pour la refaire." },
  "Ta om: {vy}": { en: "Retake: {vy}", fr: "Refaire : {vy}" },
  Hoppad: { en: "Skipped", fr: "Passée" },
  Valfri: { en: "Optional", fr: "Facultative" },
  "Du behöver 1 bild till för att gå vidare.": {
    en: "You need 1 more photo to continue.",
    fr: "Il vous faut encore 1 photo pour continuer.",
  },
  "Du behöver {antal} bilder till för att gå vidare.": {
    en: "You need {antal} more photos to continue.",
    fr: "Il vous faut encore {antal} photos pour continuer.",
  },
  "Några bilder är identiska och räknas bara en gång.": {
    en: "Some photos are identical and only count once.",
    fr: "Certaines photos sont identiques et ne comptent qu'une fois.",
  },
  "Ta {steg}": { en: "Take {steg}", fr: "Prendre {steg}" },
  "Lägg till fler bilder": { en: "Add more photos", fr: "Ajouter d'autres photos" },
  "Närbilder på detaljer gör annonsen mer trovärdig.": {
    en: "Close-ups of details make your listing more trustworthy.",
    fr: "Les gros plans sur les détails rendent l'annonce plus crédible.",
  },
  "Fler vinklar ger en mer övertygande annons.": {
    en: "More angles make a more convincing listing.",
    fr: "Plus d'angles donnent une annonce plus convaincante.",
  },
  "Lägg till 1 bild till": { en: "Add 1 more photo", fr: "Ajouter 1 photo de plus" },
  "Lägg till {antal} bilder till": { en: "Add {antal} more photos", fr: "Ajouter {antal} photos de plus" },
  "Lämna fotograferingen?": { en: "Leave the photo session?", fr: "Quitter la prise de photos ?" },
  "Du har {antal} bilder som inte är skickade. De sparas inte om du lämnar.": {
    en: "You have {antal} photos that haven't been sent. They won't be saved if you leave.",
    fr: "Vous avez {antal} photos qui n'ont pas été envoyées. Elles ne seront pas conservées si vous quittez.",
  },
  Stanna: { en: "Stay", fr: "Rester" },
  Lämna: { en: "Leave", fr: "Quitter" },
  "Vi behöver minst {antal} olika bilder (fick {fick}).": {
    en: "We need at least {antal} different photos (got {fick}).",
    fr: "Il nous faut au moins {antal} photos différentes ({fick} reçues).",
  },

  // ---- resultatskärmen i testläget ----
  "Avsluta testet": { en: "End the test", fr: "Terminer le test" },
  "Testa igen": { en: "Test again", fr: "Tester à nouveau" },

  // ---- skicktestsidan ----
  Testläge: { en: "Test mode", fr: "Mode test" },
  "Testa skickbedömningen": { en: "Test the condition assessment", fr: "Tester l'évaluation de l'état" },
  "Här provar du bildguiden och skickbedömningen från början till slut. Inget annat körs — du slipper välja märke och modell.": {
    en: "Here you try the photo guide and the condition assessment from start to finish. Nothing else runs — you don't have to pick a brand and model.",
    fr: "Ici vous essayez le guide photo et l'évaluation de l'état du début à la fin. Rien d'autre ne s'exécute : inutile de choisir marque et modèle.",
  },
  "Det här körs": { en: "What runs", fr: "Ce qui s'exécute" },
  "Bildguiden: omslagsbild och fler vinklar, minst {antal} bilder, upp till {max}.": {
    en: "The photo guide: a cover photo and more angles, at least {antal} photos, up to {max}.",
    fr: "Le guide photo : une photo de couverture et d'autres angles, au moins {antal} photos, jusqu'à {max}.",
  },
  "Skickbedömningen: AI:n letar skador i bilderna.": {
    en: "The condition assessment: the AI looks for damage in the photos.",
    fr: "L'évaluation de l'état : l'IA cherche des dégâts dans les photos.",
  },
  "Du godkänner eller avvisar varje skada, och kan lägga till en missad.": {
    en: "You approve or reject each damage, and can add one that was missed.",
    fr: "Vous validez ou rejetez chaque dégât, et pouvez en ajouter un qui a été manqué.",
  },
  "Det här körs inte": { en: "What does not run", fr: "Ce qui ne s'exécute pas" },
  "Ingen modellsökning (identifiering).": { en: "No model search (identification).", fr: "Pas de recherche de modèle (identification)." },
  "Inga mått, material eller annonstext.": { en: "No dimensions, materials or ad text.", fr: "Pas de dimensions, de matériaux ni de texte d'annonce." },
  "Inget pris — heller inte när du rättar en skada.": {
    en: "No price — not even when you correct a damage.",
    fr: "Pas de prix — même quand vous corrigez un dégât.",
  },
  "Ingen produktbild eller annons.": { en: "No product image or ad.", fr: "Pas d'image produit ni d'annonce." },
  "Testjobbet är privat och syns inte i butiken. Dina rättelser sparas inte som träningsdata. Bilderna skickas till AI-tjänsten och kostar en vanlig skickbedömning.": {
    en: "The test job is private and not shown in the shop. Your corrections are not saved as training data. The photos are sent to the AI service and cost the same as a normal condition assessment.",
    fr: "La tâche de test est privée et n'apparaît pas dans la boutique. Vos corrections ne sont pas enregistrées comme données d'entraînement. Les photos sont envoyées au service d'IA et coûtent comme une évaluation normale.",
  },
  "Starta testet": { en: "Start the test", fr: "Lancer le test" },
  "Starta skickbedömning": { en: "Start condition assessment", fr: "Lancer l'évaluation de l'état" },
  "Skickar…": { en: "Sending…", fr: "Envoi…" },
  "Uppladdningen tog för lång tid. Kontrollera nätet och försök igen.": {
    en: "The upload took too long. Check your connection and try again.",
    fr: "L'envoi a pris trop de temps. Vérifiez votre connexion et réessayez.",
  },
  "Skickbedömningen gick inte att slutföra": { en: "The condition assessment couldn't be completed", fr: "L'évaluation de l'état n'a pas pu être terminée" },
  "Inget svar från servern. Kontrollera att den körs.": {
    en: "No response from the server. Check that it is running.",
    fr: "Pas de réponse du serveur. Vérifiez qu'il est en cours d'exécution.",
  },
  "Tillbaka till bilderna": { en: "Back to the photos", fr: "Retour aux photos" },
  "Börja om": { en: "Start over", fr: "Recommencer" },
  "Bedömer skicket…": { en: "Assessing the condition…", fr: "Évaluation de l'état…" },
  "Skickat. Väntar på servern…": { en: "Sent. Waiting for the server…", fr: "Envoyé. En attente du serveur…" },
  "{sek} s · {antal} bilder analyseras": { en: "{sek} s · {antal} photos being analysed", fr: "{sek} s · {antal} photos en cours d'analyse" },
  "Bilderna som skickades": { en: "The photos that were sent", fr: "Les photos envoyées" },
  SKICKTEST: { en: "CONDITION TEST", fr: "TEST D'ÉTAT" },
  "bara skick": { en: "condition only", fr: "état seulement" },
  Testinfo: { en: "Test info", fr: "Infos du test" },
  "Körs: besiktning. Körs inte: identifiering, mått, annonstext, pris, omslagsurklipp.": {
    en: "Runs: inspection. Does not run: identification, dimensions, ad text, price, cover cut-out.",
    fr: "S'exécute : inspection. Ne s'exécute pas : identification, dimensions, texte d'annonce, prix, détourage de couverture.",
  },
  Jobb: { en: "Job", fr: "Tâche" },
  Uppladdning: { en: "Upload", fr: "Envoi" },
  "Till resultat": { en: "To result", fr: "Jusqu'au résultat" },
  "föll bort": { en: "dropped", fr: "écartées" },
  "{antal} bilder valda": { en: "{antal} photos selected", fr: "{antal} photos sélectionnées" },
  "Händelser i guiden": { en: "Guide events", fr: "Événements du guide" },
  "Bilderna kan inte hämtas: bildsessionen misslyckades.": {
    en: "The images can't be fetched: the image session failed.",
    fr: "Les images ne peuvent pas être chargées : la session d'images a échoué.",
  },
};
