import type { Translation } from "../translations";

/**
 * De tre dokumenten: cookiepolicyn, villkoren, integritetspolicyn.
 *
 * Översättningarna är till för att kunna LÄSAS — den svenska texten är den som gäller, och det står
 * på sidan (se LEGAL_NOTE i LegalScreen). Ett juridiskt dokument som översätts fritt blir två olika
 * löften; här är svenskan originalet och de andra två en tjänst åt den som inte läser svenska.
 */

export const LEGAL: Record<string, Translation> = {
  "Det här är en översättning. Vid tvist gäller den svenska texten.": {
    en: "This is a translation. In case of dispute, the Swedish text applies.",
    fr: "Ceci est une traduction. En cas de litige, le texte suédois fait foi.",
  },

  // ---- cookiepolicyn ----
  "Loopa lagrar fem saker i din webbläsare, och ingen av dem följer dig till någon annan webbplats. Vi har inga analysverktyg, ingen mätpixel och inga annonskakor — så det finns ingenting här att stänga av för att slippa bli spårad, av det enkla skälet att vi inte spårar.": {
    en: "Loopa stores five things in your browser, and none of them follows you to any other website. We have no analytics tools, no tracking pixel and no advertising cookies — so there is nothing here to switch off to avoid being tracked, for the simple reason that we don't track.",
    fr: "Loopa conserve cinq éléments dans votre navigateur, et aucun ne vous suit sur d'autres sites. Nous n'avons ni outil d'analyse, ni pixel de mesure, ni cookie publicitaire — il n'y a donc rien à désactiver ici pour éviter d'être suivi, pour la simple raison que nous ne suivons personne.",
  },
  "Nödvändigt — kräver inget samtycke": { en: "Necessary — no consent required", fr: "Nécessaire — sans consentement requis" },
  "Utan de här fungerar inte det du bett appen göra. De får enligt lag sättas utan att vi frågar, och de går inte att välja bort utan att sluta använda tjänsten.": {
    en: "Without these, what you've asked the app to do doesn't work. The law allows them to be set without asking, and they can't be opted out of without leaving the service.",
    fr: "Sans eux, ce que vous demandez à l'application ne fonctionne pas. La loi autorise leur dépôt sans demande préalable, et ils ne peuvent être refusés qu'en cessant d'utiliser le service.",
  },
  "Kaka · 24 timmar": { en: "Cookie · 24 hours", fr: "Cookie · 24 heures" },
  "Låter din webbläsare hämta bildrutorna från din egen möbel. En bild i en sida kan inte skicka med ett inloggningstoken, så utan den här kakan hade bildvägarna behövt vara öppna för vem som helst som gissade rätt jobb-ID. Den är signerad, går bara att läsa av servern, gäller bara adresser under": {
    en: "Lets your browser fetch the frames of your own furniture. An image in a page can't send a login token, so without this cookie the image routes would have to be open to anyone who guessed the right job ID. It is signed, readable only by the server, valid only for addresses under",
    fr: "Permet à votre navigateur de récupérer les images de votre propre meuble. Une image dans une page ne peut pas transmettre de jeton de connexion : sans ce cookie, les chemins d'images devraient être ouverts à quiconque devine le bon identifiant de tâche. Il est signé, lisible uniquement par le serveur, valable uniquement pour les adresses sous",
  },
  "och accepteras bara för hämtning — aldrig för att ändra något.": {
    en: "and accepted only for fetching — never for changing anything.",
    fr: "et accepté uniquement pour la lecture — jamais pour modifier quoi que ce soit.",
  },
  "Lokal lagring · tills du loggar ut": { en: "Local storage · until you log out", fr: "Stockage local · jusqu'à la déconnexion" },
  "Håller dig inloggad mellan besöken. Sätts av Supabase, som driver inloggningen. Rensas när du loggar ut.": {
    en: "Keeps you logged in between visits. Set by Supabase, which runs the login. Cleared when you log out.",
    fr: "Vous maintient connecté d'une visite à l'autre. Déposé par Supabase, qui gère la connexion. Effacé à la déconnexion.",
  },
  "Lokal lagring · tills du ändrar dig": { en: "Local storage · until you change your mind", fr: "Stockage local · jusqu'à ce que vous changiez d'avis" },
  "Ditt svar på cookierutan, och dagen du svarade. Den måste sparas — annars hade rutan kommit tillbaka vid varje sidladdning och ditt nej aldrig blivit ihågkommet.": {
    en: "Your answer to the cookie banner, and the day you answered. It has to be stored — otherwise the banner would come back on every page load and your no would never be remembered.",
    fr: "Votre réponse à la bannière cookies, et la date de cette réponse. Elle doit être conservée — sinon la bannière reviendrait à chaque chargement et votre refus ne serait jamais mémorisé.",
  },
  "Lokal lagring · tills du rensar": { en: "Local storage · until you clear it", fr: "Stockage local · jusqu'à effacement" },
  "Tvingar fram dator- eller mobillayout. Ingen knapp i appen skriver den — den finns bara för den som sätter den själv från webbläsarens konsol, och står med här för att listan ska vara fullständig.": {
    en: "Forces desktop or mobile layout. No button in the app writes it — it exists only for whoever sets it themselves from the browser console, and is listed here so the list is complete.",
    fr: "Force la mise en page bureau ou mobile. Aucun bouton de l'application ne l'écrit — il n'existe que pour qui le définit lui-même depuis la console du navigateur, et figure ici pour que la liste soit complète.",
  },
  "Funktionellt — kräver ditt samtycke": { en: "Functional — requires your consent", fr: "Fonctionnel — nécessite votre consentement" },
  "De senaste tolv meddelandena i chatten om en annons, så att samtalet finns kvar om du laddar om sidan. Säger du nej sparas ingenting — chatten fungerar precis som vanligt, men börjar om varje gång sidan laddas. Tar du tillbaka ett ja raderas det som redan lagrats.": {
    en: "The last twelve messages in the chat about a listing, so the conversation survives a page reload. Say no and nothing is stored — the chat works exactly as usual but starts over each time the page loads. Withdraw a yes and what was already stored is deleted.",
    fr: "Les douze derniers messages du chat d'une annonce, pour que la conversation survive à un rechargement. Si vous refusez, rien n'est conservé — le chat fonctionne normalement mais repart de zéro à chaque chargement. Si vous retirez votre accord, ce qui était stocké est supprimé.",
  },
  "Analys och marknadsföring": { en: "Analytics and marketing", fr: "Analyse et marketing" },
  "Inga. Den här rubriken står här tom med flit, så att du vet att den är tom och inte att vi glömde skriva den.": {
    en: "None. This heading is deliberately left empty, so you know it is empty rather than forgotten.",
    fr: "Aucun. Cette rubrique est volontairement vide, pour que vous sachiez qu'elle est vide et non oubliée.",
  },
  "Typsnitt från Google": { en: "Fonts from Google", fr: "Polices de Google" },
  "Appens typsnitt hämtas från": { en: "The app's fonts are loaded from", fr: "Les polices de l'application sont chargées depuis" },
  "Det sätter ingen kaka, men din IP-adress når Google när sidan laddas. Det kan du inte välja bort i rutan — det är en del av hur sidan hämtas, inte något som lagras hos dig.": {
    en: "That sets no cookie, but your IP address reaches Google when the page loads. You can't opt out of it in the banner — it's part of how the page is fetched, not something stored on your device.",
    fr: "Cela ne dépose aucun cookie, mais votre adresse IP parvient à Google au chargement de la page. Ce n'est pas refusable dans la bannière — cela relève du chargement de la page, non d'un stockage chez vous.",
  },
  "Ditt val": { en: "Your choice", fr: "Votre choix" },
  "Du har svarat: funktionell lagring är": { en: "You answered: functional storage is", fr: "Vous avez répondu : le stockage fonctionnel est" },
  godkänd: { en: "accepted", fr: "accepté" },
  avvisad: { en: "declined", fr: "refusé" },
  "sedan {datum}": { en: "since {datum}", fr: "depuis le {datum}" },
  "Du har inte svarat på cookierutan än.": { en: "You haven't answered the cookie banner yet.", fr: "Vous n'avez pas encore répondu à la bannière cookies." },
  "Ändra mitt val": { en: "Change my choice", fr: "Modifier mon choix" },
  "Du kan också rensa allt ovanstående när som helst i webbläsarens egna inställningar. Rensar du inloggningstoken loggas du ut.": {
    en: "You can also clear everything above at any time in your browser's own settings. Clearing the login token logs you out.",
    fr: "Vous pouvez aussi effacer tout ce qui précède à tout moment dans les réglages de votre navigateur. Effacer le jeton de connexion vous déconnecte.",
  },
  Mer: { en: "More", fr: "Plus" },
  "Vad vi gör med uppgifterna, vilka fler som ser dem och vad du kan kräva av oss står i": {
    en: "What we do with the data, who else sees it and what you can demand of us is set out in the",
    fr: "Ce que nous faisons des données, qui d'autre y a accès et ce que vous pouvez exiger de nous figure dans",
  },

  // ---- användarvillkoren ----
  "De här villkoren gäller mellan dig och {företag} när du använder Loopa. Läs dem — särskilt avsnittet om vad som händer med priset på en annons som ligger ute.": {
    en: "These terms apply between you and {företag} when you use Loopa. Read them — especially the section on what happens to the price of a listing that is up.",
    fr: "Ces conditions s'appliquent entre vous et {företag} lorsque vous utilisez Loopa. Lisez-les — en particulier la section sur l'évolution du prix d'une annonce en ligne.",
  },
  "Vad Loopa gör": { en: "What Loopa does", fr: "Ce que fait Loopa" },
  "Du filmar ett varv runt en möbel. Vi bedömer skicket, identifierar modellen, föreslår ett pris och skriver en annons. Väljer du att sälja lägger vi ut annonsen till salu och hör av oss när möbeln är såld.": {
    en: "You film one lap around a piece of furniture. We assess the condition, identify the model, suggest a price and write a listing. If you choose to sell, we put the listing up for sale and get in touch when the piece is sold.",
    fr: "Vous filmez un tour du meuble. Nous évaluons l'état, identifions le modèle, proposons un prix et rédigeons une annonce. Si vous choisissez de vendre, nous mettons l'annonce en ligne et vous prévenons dès que le meuble est vendu.",
  },
  Konto: { en: "Account", fr: "Compte" },
  "Du behöver ett konto för att spara en annons. Det är samma konto som i Vips — har du ett där fungerar det här. Du ansvarar för att uppgifterna du anger stämmer och för att hålla lösenordet för dig själv. Du måste vara 18 år eller ha målsmans tillstånd.": {
    en: "You need an account to save a listing. It's the same account as in Vips — if you have one there, it works here. You are responsible for the accuracy of the details you give and for keeping your password to yourself. You must be 18 or have a guardian's permission.",
    fr: "Un compte est nécessaire pour enregistrer une annonce. C'est le même compte que sur Vips — si vous en avez un là-bas, il fonctionne ici. Vous êtes responsable de l'exactitude des informations fournies et de la confidentialité de votre mot de passe. Vous devez avoir 18 ans ou l'autorisation d'un tuteur.",
  },
  "Vad du intygar när du laddar upp": { en: "What you confirm when you upload", fr: "Ce que vous attestez en envoyant des photos" },
  "att möbeln är din, eller att du på annat sätt har rätt att sälja den": {
    en: "that the furniture is yours, or that you otherwise have the right to sell it",
    fr: "que le meuble vous appartient ou que vous avez par ailleurs le droit de le vendre",
  },
  "att bilderna är dina egna": { en: "that the photos are your own", fr: "que les photos sont les vôtres" },
  "att du inte medvetet filmar andra människor, deras egendom eller något som identifierar dem": {
    en: "that you do not knowingly film other people, their property or anything identifying them",
    fr: "que vous ne filmez pas sciemment d'autres personnes, leurs biens ou tout élément permettant de les identifier",
  },
  "att du inte laddar upp något olagligt eller kränkande": {
    en: "that you do not upload anything unlawful or offensive",
    fr: "que vous n'envoyez rien d'illégal ni d'offensant",
  },
  "Rätten till dina bilder": { en: "Rights to your photos", fr: "Droits sur vos photos" },
  "Bilderna förblir dina. Du ger oss rätt att använda dem för att utföra tjänsten — bedöma skicket, bygga annonsen och publicera den där möbeln säljs. Vi använder dem inte till något annat, och rätten upphör när du raderar annonsen eller ditt konto. Vilka underleverantörer som får se bilderna på vägen står i": {
    en: "The photos remain yours. You grant us the right to use them to perform the service — assess the condition, build the listing and publish it where the furniture is sold. We use them for nothing else, and the right ends when you delete the listing or your account. Which subprocessors see the photos along the way is set out in the",
    fr: "Les photos restent les vôtres. Vous nous accordez le droit de les utiliser pour fournir le service — évaluer l'état, créer l'annonce et la publier là où le meuble est vendu. Nous ne les utilisons à aucune autre fin, et ce droit prend fin lorsque vous supprimez l'annonce ou votre compte. Les sous-traitants qui voient les photos en chemin sont indiqués dans",
  },
  "Bedömningen är ett förslag": { en: "The assessment is a suggestion", fr: "L'évaluation est une proposition" },
  "Skickbetyget, skadelistan och prisförslaget tas fram automatiskt ur dina bilder. De är kvalificerade bedömningar, inte garantier, och en modell kan både missa en skada och peka ut en som inte finns. Därför kan du invända mot varje enskilt fynd innan annonsen går ut.": {
    en: "The condition grade, the damage list and the suggested price are produced automatically from your photos. They are qualified assessments, not guarantees, and a model can both miss damage and point out damage that isn't there. That's why you can dispute every individual finding before the listing goes out.",
    fr: "La note d'état, la liste des dommages et le prix suggéré sont générés automatiquement à partir de vos photos. Ce sont des évaluations qualifiées, non des garanties : un modèle peut aussi bien manquer un dommage qu'en signaler un inexistant. Vous pouvez donc contester chaque constat avant la publication.",
  },
  "Annonsen är ditt ansvar.": { en: "The listing is your responsibility.", fr: "L'annonce relève de votre responsabilité." },
  "Det är du som säljer möbeln, och det är du som ansvarar för att det som står i annonsen stämmer. Läs igenom den innan du lägger ut den.": {
    en: "You are the one selling the furniture, and you are responsible for the accuracy of what the listing says. Read it through before you publish it.",
    fr: "C'est vous qui vendez le meuble et vous qui répondez de l'exactitude de l'annonce. Relisez-la avant de la publier.",
  },
  "Priset sänks automatiskt": { en: "The price drops automatically", fr: "Le prix baisse automatiquement" },
  "Lägger du ut en möbel sätter du ett startpris och ett lägsta pris. Ligger annonsen osåld sänks priset därefter automatiskt med": {
    en: "When you list a piece you set a starting price and a lowest price. If the listing stays unsold, the price is then lowered automatically by",
    fr: "En mettant un meuble en vente, vous fixez un prix de départ et un prix plancher. Si l'annonce reste invendue, le prix baisse ensuite automatiquement de",
  },
  "15 % i veckan": { en: "15% a week", fr: "15 % par semaine" },
  "tills ditt lägsta pris är nått — sedan står det stilla. Du väljer golvet, så du bestämmer var det slutar; sänkningen däremellan sköter sig själv och kräver ingen bekräftelse från dig.": {
    en: "until your lowest price is reached — then it stands still. You choose the floor, so you decide where it ends; the drops in between look after themselves and need no confirmation from you.",
    fr: "jusqu'à atteindre votre prix plancher — puis il n'évolue plus. Vous choisissez le plancher, donc vous décidez où cela s'arrête ; les baisses intermédiaires se font seules et ne requièrent aucune confirmation.",
  },
  "När annonsen väl ligger uppe går prisspannet inte längre att ändra i appen. Vill du ändra det behöver annonsen tas ned.": {
    en: "Once the listing is up, the price range can no longer be changed in the app. To change it, the listing has to be taken down.",
    fr: "Une fois l'annonce en ligne, la fourchette de prix n'est plus modifiable dans l'application. Pour la changer, l'annonce doit être retirée.",
  },
  Försäljningen: { en: "The sale", fr: "La vente" },
  "Annonsen publiceras via Loopas konto på Tradera. Traderas egna villkor gäller för själva köpet och för kontakten med köparen. Vi kan inte lova att en möbel blir såld, eller såld till ett visst pris.": {
    en: "The listing is published through Loopa's account on Tradera. Tradera's own terms govern the purchase itself and the contact with the buyer. We cannot promise that a piece will sell, or sell at a particular price.",
    fr: "L'annonce est publiée via le compte Loopa sur Tradera. Les conditions propres à Tradera régissent l'achat et les échanges avec l'acheteur. Nous ne pouvons garantir ni la vente d'un meuble, ni un prix de vente donné.",
  },
  "Det publika kortet": { en: "The public card", fr: "La fiche publique" },
  "Varje annons får ett Loopa-ID och ett publikt kort som vem som helst kan öppna, så att en köpare kan kontrollera skickpåståendet. Kortets bild är din egen möbel urklippt mot vit bakgrund — rummet omkring den klipps bort. Dina bildrutor som de togs ligger inte där, se": {
    en: "Every listing gets a Loopa ID and a public card anyone can open, so a buyer can verify the condition claim. The card's image is your own furniture cut out against a white background — the room around it is removed. Your frames as they were taken are not there; see the",
    fr: "Chaque annonce reçoit un identifiant Loopa et une fiche publique que tout le monde peut ouvrir, afin qu'un acheteur puisse vérifier l'état annoncé. L'image de la fiche est votre propre meuble détouré sur fond blanc — la pièce autour est supprimée. Vos photos telles qu'elles ont été prises n'y figurent pas ; voir",
  },
  "för exakt vad som syns.": { en: "for exactly what is shown.", fr: "pour le détail de ce qui est affiché." },
  "Sådant du inte får göra": { en: "Things you may not do", fr: "Ce que vous n'avez pas le droit de faire" },
  "försöka komma åt någon annans annonser, bilder eller konto": {
    en: "try to access someone else's listings, photos or account",
    fr: "tenter d'accéder aux annonces, photos ou comptes d'autrui",
  },
  "skrapa, belasta eller kringgå spärrar i tjänsten": {
    en: "scrape, overload or circumvent safeguards in the service",
    fr: "extraire des données, surcharger ou contourner les protections du service",
  },
  "ladda upp bilder på något annat än möbeln du säljer": {
    en: "upload photos of anything other than the furniture you're selling",
    fr: "envoyer des photos d'autre chose que le meuble que vous vendez",
  },
  "använda tjänsten för att sälja något du inte får sälja": {
    en: "use the service to sell something you're not allowed to sell",
    fr: "utiliser le service pour vendre ce que vous n'avez pas le droit de vendre",
  },
  "Vi kan stänga av ett konto som gör något av detta.": {
    en: "We may suspend an account that does any of this.",
    fr: "Nous pouvons suspendre un compte qui enfreint ces règles.",
  },
  Ansvar: { en: "Liability", fr: "Responsabilité" },
  "Tjänsten tillhandahålls i befintligt skick. Vi ansvarar inte för indirekt skada, utebliven vinst eller för att en möbel såldes för mindre än du hoppats. Ingenting i de här villkoren begränsar det ansvar som inte får begränsas enligt tvingande lag — är du konsument gäller dina rättigheter enligt konsumentlagstiftningen oavsett vad som står här.": {
    en: "The service is provided as is. We are not liable for indirect damage, lost profit or for a piece selling for less than you hoped. Nothing in these terms limits liability that may not be limited under mandatory law — if you are a consumer, your rights under consumer legislation apply regardless of what is written here.",
    fr: "Le service est fourni en l'état. Nous ne sommes pas responsables des dommages indirects, du manque à gagner ni du fait qu'un meuble se vende moins cher qu'espéré. Rien dans ces conditions ne limite une responsabilité qui ne peut l'être en vertu de dispositions impératives — si vous êtes consommateur, vos droits issus du droit de la consommation s'appliquent quoi qu'il soit écrit ici.",
  },
  "Att sluta": { en: "Leaving", fr: "Mettre fin à l'utilisation" },
  "Du kan sluta använda Loopa när du vill och begära att kontot och allt vi sparat raderas, via": {
    en: "You can stop using Loopa whenever you like and ask for the account and everything we've stored to be deleted, via",
    fr: "Vous pouvez cesser d'utiliser Loopa quand vous le souhaitez et demander la suppression du compte et de tout ce que nous avons conservé, via",
  },
  "En annons som redan ligger ute på Tradera behöver tas ned där.": {
    en: "A listing already up on Tradera needs to be taken down there.",
    fr: "Une annonce déjà en ligne sur Tradera doit y être retirée.",
  },
  "Ändringar, lag och tvist": { en: "Changes, law and disputes", fr: "Modifications, droit applicable et litiges" },
  "Ändrar vi villkoren i något väsentligt säger vi till i appen. Svensk lag gäller. Tvist prövas av svensk allmän domstol — är du konsument kan du också vända dig till Allmänna reklamationsnämnden,": {
    en: "If we change the terms in any material way, we'll say so in the app. Swedish law applies. Disputes are heard by Swedish general courts — if you are a consumer you may also turn to the Swedish National Board for Consumer Disputes,",
    fr: "Si nous modifions les conditions de manière substantielle, nous vous en informerons dans l'application. Le droit suédois s'applique. Les litiges relèvent des juridictions suédoises de droit commun — en tant que consommateur, vous pouvez aussi saisir la commission suédoise des litiges de consommation,",
  },

  // ---- integritetspolicyn ----
  "Loopa värderar begagnade möbler ur film du spelar in själv. För att göra det behöver vi dina bilder och ett konto att knyta dem till. Den här sidan säger exakt vad vi tar emot, vad vi gör med det, vilka fler som ser det och vad du kan kräva av oss.": {
    en: "Loopa values second-hand furniture from film you record yourself. To do that we need your photos and an account to tie them to. This page states exactly what we receive, what we do with it, who else sees it and what you can demand of us.",
    fr: "Loopa évalue des meubles d'occasion à partir de vidéos que vous filmez vous-même. Pour cela, nous avons besoin de vos photos et d'un compte auquel les rattacher. Cette page indique précisément ce que nous recevons, ce que nous en faisons, qui d'autre y a accès et ce que vous pouvez exiger de nous.",
  },
  "Vem som ansvarar för uppgifterna": { en: "Who is responsible for the data", fr: "Qui est responsable des données" },
  "Personuppgiftsansvarig är {företag} (org.nr {orgnr}), {adress}.": {
    en: "The data controller is {företag} (company no. {orgnr}), {adress}.",
    fr: "Le responsable du traitement est {företag} (n° d'entreprise {orgnr}), {adress}.",
  },
  "Frågor om den här policyn, och alla begäranden enligt avsnittet": {
    en: "Questions about this policy, and all requests under the section",
    fr: "Les questions sur cette politique, ainsi que toute demande au titre de la section",
  },
  "Dina rättigheter": { en: "Your rights", fr: "Vos droits" },
  "nedan, går till": { en: "below, go to", fr: "ci-dessous, sont à adresser à" },
  "Vad vi samlar in, och varför": { en: "What we collect, and why", fr: "Ce que nous collectons, et pourquoi" },
  "Ditt konto": { en: "Your account", fr: "Votre compte" },
  "E-postadress och lösenord när du registrerar dig, samt namn, användarnamn och profilbild om din profil har sådana. Lösenordet lagras aldrig i klartext — det hanteras av Supabase, som driver inloggningen åt oss.": {
    en: "Email address and password when you sign up, plus name, username and profile picture if your profile has them. The password is never stored in clear text — it is handled by Supabase, which runs the login for us.",
    fr: "Adresse e-mail et mot de passe lors de l'inscription, ainsi que nom, nom d'utilisateur et photo de profil s'ils existent. Le mot de passe n'est jamais stocké en clair — il est géré par Supabase, qui assure la connexion pour nous.",
  },
  "Det är samma konto som i Vips.": { en: "It's the same account as in Vips.", fr: "C'est le même compte que sur Vips." },
  "Loopa och Vips delar användardatabas, så ett konto du redan har i Vips fungerar här utan ny registrering — och ett konto du skapar här fungerar i Vips. Det är värt att veta innan du registrerar dig, inte efteråt.": {
    en: "Loopa and Vips share a user database, so an account you already have in Vips works here without signing up again — and an account you create here works in Vips. Worth knowing before you sign up, not after.",
    fr: "Loopa et Vips partagent la même base d'utilisateurs : un compte que vous avez déjà sur Vips fonctionne ici sans nouvelle inscription — et un compte créé ici fonctionne sur Vips. Mieux vaut le savoir avant de s'inscrire qu'après.",
  },
  "Rättslig grund: avtal (art. 6.1 b) — utan konto kan annonsen inte ägas av någon.": {
    en: "Legal basis: contract (art. 6(1)(b)) — without an account, nobody can own the listing.",
    fr: "Base légale : contrat (art. 6.1 b) — sans compte, l'annonce n'appartient à personne.",
  },
  "Filmen och bildrutorna": { en: "The film and the frames", fr: "La vidéo et les images" },
  "När du filmar ett varv runt möbeln plockas ett antal bildrutor ur filmen och laddas upp till vår server. Bilderna är tagna hemma hos dig, och det syns: de kan visa rummet, andra möbler, saker på golvet och personer som råkar gå förbi. Vi ber dig inte om något av det, men vi tar emot det, och därför står det här.": {
    en: "When you film one lap around the furniture, a number of frames are taken from the film and uploaded to our server. The photos are taken in your home, and it shows: they may include the room, other furniture, things on the floor and people who happen to walk past. We don't ask for any of that, but we do receive it, which is why it's stated here.",
    fr: "Lorsque vous filmez un tour du meuble, plusieurs images sont extraites de la vidéo et envoyées à notre serveur. Ces photos sont prises chez vous, et cela se voit : elles peuvent montrer la pièce, d'autres meubles, des objets au sol et des personnes de passage. Nous ne demandons rien de tout cela, mais nous le recevons — d'où cette mention.",
  },
  "Rättslig grund: avtal (art. 6.1 b) — bilderna är det tjänsten bedömer.": {
    en: "Legal basis: contract (art. 6(1)(b)) — the photos are what the service assesses.",
    fr: "Base légale : contrat (art. 6.1 b) — les photos sont l'objet même de l'évaluation.",
  },
  "Uppgifter om möbeln": { en: "Information about the furniture", fr: "Informations sur le meuble" },
  "Märke och modell du anger, mått och specifikationer, skickbetyget, varje skada med typ och placering, prisförslaget, samt det Loopa-ID annonsen får. Kopplat till ditt konto och till tidpunkten då du skapade den.": {
    en: "The brand and model you give, dimensions and specifications, the condition grade, every damage with its type and location, the suggested price, and the Loopa ID the listing is given. Linked to your account and to when you created it.",
    fr: "La marque et le modèle que vous indiquez, les dimensions et caractéristiques, la note d'état, chaque dommage avec son type et son emplacement, le prix suggéré, ainsi que l'identifiant Loopa attribué à l'annonce. Le tout lié à votre compte et à la date de création.",
  },
  "Rättslig grund: avtal (art. 6.1 b).": { en: "Legal basis: contract (art. 6(1)(b)).", fr: "Base légale : contrat (art. 6.1 b)." },
  "Frågor i annonschatten": { en: "Questions in the listing chat", fr: "Questions dans le chat de l'annonce" },
  "Skriver du en fråga till en annons skickas frågan, och de senaste svaren i samma samtal, till Google för att besvaras. Chatten är öppen — den kräver inget konto — så vi vet inte vem som frågar, bara vad som frågades.": {
    en: "If you write a question on a listing, the question and the most recent answers in the same conversation are sent to Google to be answered. The chat is open — no account required — so we don't know who is asking, only what was asked.",
    fr: "Si vous posez une question sur une annonce, celle-ci et les dernières réponses de la même conversation sont envoyées à Google pour y répondre. Le chat est ouvert — aucun compte requis — nous ne savons donc pas qui pose la question, seulement ce qui a été demandé.",
  },
  "Rättslig grund: berättigat intresse (art. 6.1 f) — att en köpare ska kunna kontrollera en annons.": {
    en: "Legal basis: legitimate interest (art. 6(1)(f)) — so a buyer can verify a listing.",
    fr: "Base légale : intérêt légitime (art. 6.1 f) — permettre à un acheteur de vérifier une annonce.",
  },
  "IP-adress vid chatten": { en: "IP address in the chat", fr: "Adresse IP lors du chat" },
  "Din IP-adress hålls i serverns minne i": { en: "Your IP address is held in the server's memory for", fr: "Votre adresse IP est conservée en mémoire du serveur pendant" },
  "60 sekunder": { en: "60 seconds", fr: "60 secondes" },
  "för att räkna hur många frågor som kommer från samma håll och stoppa överbelastning. Den skrivs inte till någon fil, kopplas inte till ditt konto och finns inte kvar efter en minut.": {
    en: "in order to count how many questions come from the same place and stop overload. It is not written to any file, not linked to your account, and is gone after a minute.",
    fr: "afin de compter le nombre de questions provenant de la même source et d'éviter la surcharge. Elle n'est écrite dans aucun fichier, n'est pas liée à votre compte et disparaît après une minute.",
  },
  "Rättslig grund: berättigat intresse (art. 6.1 f) — att hålla tjänsten uppe.": {
    en: "Legal basis: legitimate interest (art. 6(1)(f)) — keeping the service up.",
    fr: "Base légale : intérêt légitime (art. 6.1 f) — maintenir le service en fonctionnement.",
  },
  "Lagring i din webbläsare": { en: "Storage in your browser", fr: "Stockage dans votre navigateur" },
  "En inloggningskaka, en kaka som låter din webbläsare hämta dina egna bilder, och — om du godkänner det — chatthistoriken på en annons du läser. Varje post står uppräknad i": {
    en: "A login cookie, a cookie that lets your browser fetch your own photos, and — if you agree — the chat history on a listing you're reading. Every entry is listed in the",
    fr: "Un cookie de connexion, un cookie permettant à votre navigateur de récupérer vos propres photos et — si vous l'acceptez — l'historique du chat d'une annonce que vous consultez. Chaque élément est listé dans",
  },
  cookiepolicyn: { en: "cookie policy", fr: "la politique cookies" },
  "Vad vi inte gör": { en: "What we don't do", fr: "Ce que nous ne faisons pas" },
  "Vi har inga analysverktyg, ingen mätpixel och ingen annonsspårning i appen.": {
    en: "We have no analytics tools, no tracking pixel and no ad tracking in the app.",
    fr: "Nous n'avons ni outil d'analyse, ni pixel de mesure, ni suivi publicitaire dans l'application.",
  },
  "Vi följer dig inte till andra webbplatser.": { en: "We don't follow you to other websites.", fr: "Nous ne vous suivons pas sur d'autres sites." },
  "Vi säljer inte dina uppgifter, och lämnar dem inte till någon för marknadsföring.": {
    en: "We don't sell your data, and don't pass it to anyone for marketing.",
    fr: "Nous ne vendons pas vos données et ne les transmettons à personne à des fins marketing.",
  },
  "Vi fattar inga automatiska beslut med rättslig verkan för dig. Skickbetyget sätts av en modell, men det är ett förslag på din egen annons som du kan invända mot och ändra.": {
    en: "We make no automated decisions with legal effect for you. The condition grade is set by a model, but it's a suggestion on your own listing that you can dispute and change.",
    fr: "Nous ne prenons aucune décision automatisée produisant des effets juridiques à votre égard. La note d'état est établie par un modèle, mais il s'agit d'une proposition sur votre propre annonce, que vous pouvez contester et modifier.",
  },
  "Vad som blir publikt — och vad som inte blir det": {
    en: "What becomes public — and what doesn't",
    fr: "Ce qui devient public — et ce qui ne l'est pas",
  },
  "Läggs din möbel ut till salu får den ett publikt kort på": {
    en: "If your furniture is put up for sale it gets a public card at",
    fr: "Si votre meuble est mis en vente, il reçoit une fiche publique à l'adresse",
  },
  "och sitt Loopa-ID. Vem som helst som har ID:t kan öppna det, utan konto. Det är hela poängen: en annons som påstår att skicket är granskat ska gå att kontrollera.": {
    en: "and its Loopa ID. Anyone with the ID can open it, without an account. That's the whole point: a listing claiming the condition has been inspected should be verifiable.",
    fr: "ainsi que son identifiant Loopa. Toute personne disposant de l'identifiant peut l'ouvrir, sans compte. C'est tout l'intérêt : une annonce qui affirme que l'état a été inspecté doit pouvoir être vérifiée.",
  },
  "På det publika kortet står:": { en: "The public card shows:", fr: "La fiche publique indique :" },
  "möbelns märke, modell, mått och specifikationer": {
    en: "the furniture's brand, model, dimensions and specifications",
    fr: "la marque, le modèle, les dimensions et les caractéristiques du meuble",
  },
  "skickbetyget och varje skada som står kvar efter din granskning": {
    en: "the condition grade and every damage remaining after your review",
    fr: "la note d'état et chaque dommage subsistant après votre révision",
  },
  prisförslaget: { en: "the suggested price", fr: "le prix suggéré" },
  "en bild av möbeln, urklippt mot vit bakgrund.": {
    en: "an image of the furniture, cut out against a white background.",
    fr: "une image du meuble, détourée sur fond blanc.",
  },
  "Den görs ur en av dina egna bildrutor: möbeln behålls, allt annat i bilden klipps bort och ersätts med vitt. Går den inte att göra visar kortet tillverkarens produktbild av modellen i stället, när vi hittat en": {
    en: "It is made from one of your own frames: the furniture is kept, everything else in the picture is cut away and replaced with white. If it can't be made, the card shows the manufacturer's catalogue photo of the model instead, when we've found one",
    fr: "Elle est réalisée à partir d'une de vos images : le meuble est conservé, tout le reste est découpé et remplacé par du blanc. Si ce n'est pas possible, la fiche affiche à la place la photo catalogue du fabricant, lorsque nous en avons trouvé une",
  },
  "På det publika kortet står": { en: "The public card does", fr: "La fiche publique" },
  inte: { en: "not show", fr: "n'indique pas" },
  "ditt namn, din e-postadress eller något annat som pekar ut dig": {
    en: "your name, your email address or anything else identifying you",
    fr: "votre nom, votre adresse e-mail ni tout autre élément vous identifiant",
  },
  "dina bildrutor som de togs, eller närbilderna på skadorna": {
    en: "your frames as they were taken, or the close-ups of the damage",
    fr: "vos images telles qu'elles ont été prises, ni les gros plans des dommages",
  },
  "Dina fotografier stannar alltså bakom inloggningen — det enda som lämnar den är möbeln själv, fri från rummet den stod i. Skadorna visas på en ritning byggd ur måtten. Det är ett medvetet val: bilderna är tagna i ditt hem, och rummet behövs inte för att en köpare ska kunna kontrollera ett skick.": {
    en: "So your photographs stay behind the login — the only thing that leaves it is the furniture itself, free of the room it stood in. The damage is shown on a drawing built from the dimensions. That's a deliberate choice: the photos are taken in your home, and the room isn't needed for a buyer to verify a condition.",
    fr: "Vos photographies restent donc derrière la connexion — seul le meuble lui-même en sort, débarrassé de la pièce où il se trouvait. Les dommages sont représentés sur un schéma construit à partir des dimensions. C'est un choix délibéré : les photos sont prises chez vous, et la pièce n'est pas nécessaire pour qu'un acheteur vérifie un état.",
  },
  "Vilka fler som behandlar uppgifterna": { en: "Who else processes the data", fr: "Qui d'autre traite les données" },
  "Bildrutorna och texten om möbeln skickas till Googles modell-API för att bedömas, och chattfrågor skickas dit för att besvaras. Det är där själva analysen sker.": {
    en: "The frames and the text about the furniture are sent to Google's model API to be assessed, and chat questions are sent there to be answered. That's where the analysis itself happens.",
    fr: "Les images et le texte décrivant le meuble sont envoyés à l'API de modèles de Google pour évaluation, et les questions du chat y sont envoyées pour obtenir une réponse. C'est là qu'a lieu l'analyse elle-même.",
  },
  "Driver inloggningen och lagrar konto- och profiluppgifterna.": {
    en: "Runs the login and stores the account and profile data.",
    fr: "Gère la connexion et stocke les données de compte et de profil.",
  },
  "Väljer du att lägga ut möbeln till salu skickas annonstexten, bilderna som ska visas i annonsen, priset och ditt Loopa-ID till Tradera, där annonsen publiceras. Annonsen läggs upp via Loopas konto.": {
    en: "If you choose to put the furniture up for sale, the listing text, the photos to be shown in the ad, the price and your Loopa ID are sent to Tradera, where the ad is published. The ad goes up via Loopa's account.",
    fr: "Si vous choisissez de mettre le meuble en vente, le texte de l'annonce, les photos à afficher, le prix et votre identifiant Loopa sont transmis à Tradera, où l'annonce est publiée. L'annonce est publiée via le compte de Loopa.",
  },
  "Appens typsnitt hämtas från Googles servrar, vilket innebär att din IP-adress når Google när sidan laddas. Ingen kaka sätts av det.": {
    en: "The app's fonts are loaded from Google's servers, which means your IP address reaches Google when the page loads. No cookie is set by this.",
    fr: "Les polices de l'application sont chargées depuis les serveurs de Google, ce qui signifie que votre adresse IP parvient à Google au chargement de la page. Aucun cookie n'est déposé à cette occasion.",
  },
  "Loopas personal": { en: "Loopa's staff", fr: "Le personnel de Loopa" },
  "Ett fåtal namngivna administratörer kan läsa användarkonton och annonser för att kunna ge support och rätta fel. De kan läsa, aldrig ändra i din annons.": {
    en: "A small number of named administrators can read user accounts and listings in order to give support and fix errors. They can read, never change your listing.",
    fr: "Un petit nombre d'administrateurs nommés peuvent consulter les comptes et les annonces pour assurer le support et corriger les erreurs. Ils peuvent lire, jamais modifier votre annonce.",
  },
  "Överföring utanför EU/EES": { en: "Transfers outside the EU/EEA", fr: "Transferts hors UE/EEE" },
  "Google och Supabase kan behandla uppgifter utanför EU/EES. Sådana överföringar sker med stöd av EU-kommissionens standardavtalsklausuler eller ett giltigt beslut om adekvat skyddsnivå. Vill du veta vilken grund som gäller för en viss leverantör, hör av dig till": {
    en: "Google and Supabase may process data outside the EU/EEA. Such transfers rely on the European Commission's standard contractual clauses or a valid adequacy decision. If you want to know which basis applies to a given provider, get in touch at",
    fr: "Google et Supabase peuvent traiter des données hors UE/EEE. Ces transferts s'appuient sur les clauses contractuelles types de la Commission européenne ou sur une décision d'adéquation valide. Pour connaître la base applicable à un prestataire donné, écrivez à",
  },
  "Hur länge vi sparar": { en: "How long we keep it", fr: "Durées de conservation" },
  "Konto och profil:": { en: "Account and profile:", fr: "Compte et profil :" },
  "så länge du har ett konto.": { en: "for as long as you have an account.", fr: "tant que vous avez un compte." },
  "Bildrutor, skickrapport och annons:": { en: "Frames, condition report and listing:", fr: "Images, rapport d'état et annonce :" },
  "så länge annonsen finns kvar hos dig. Begär du radering tas de bort.": {
    en: "for as long as the listing remains with you. Request deletion and they are removed.",
    fr: "tant que l'annonce existe chez vous. Sur demande de suppression, ils sont effacés.",
  },
  "IP-adress vid chatten:": { en: "IP address in the chat:", fr: "Adresse IP lors du chat :" },
  "60 sekunder.": { en: "60 seconds.", fr: "60 secondes." },
  "Chatthistorik i din webbläsare:": { en: "Chat history in your browser:", fr: "Historique du chat dans votre navigateur :" },
  "de senaste tolv meddelandena per annons, tills du rensar webbläsaren eller tar tillbaka ditt samtycke.": {
    en: "the last twelve messages per listing, until you clear the browser or withdraw your consent.",
    fr: "les douze derniers messages par annonce, jusqu'à ce que vous vidiez le navigateur ou retiriez votre consentement.",
  },
  "En annons som redan publicerats på Tradera lyder under Traderas egna villkor och lagringstider så länge den ligger uppe där.": {
    en: "A listing already published on Tradera is subject to Tradera's own terms and retention periods for as long as it is up there.",
    fr: "Une annonce déjà publiée sur Tradera relève des conditions et durées de conservation propres à Tradera tant qu'elle y est en ligne.",
  },
  "Du har rätt att": { en: "You have the right to", fr: "Vous avez le droit de" },
  "få veta vilka uppgifter vi har om dig, och få en kopia av dem": {
    en: "know what data we hold about you, and get a copy of it",
    fr: "savoir quelles données nous détenons sur vous et en obtenir une copie",
  },
  "få felaktiga uppgifter rättade": { en: "have incorrect data corrected", fr: "faire rectifier des données inexactes" },
  "få uppgifter raderade": { en: "have data erased", fr: "faire effacer des données" },
  "invända mot behandling som vilar på berättigat intresse": {
    en: "object to processing based on legitimate interest",
    fr: "vous opposer au traitement fondé sur l'intérêt légitime",
  },
  "begära att behandlingen begränsas": { en: "request that the processing be restricted", fr: "demander la limitation du traitement" },
  "få de uppgifter du lämnat i ett maskinläsbart format, och flyttade till någon annan": {
    en: "receive the data you provided in a machine-readable format, and have it moved to someone else",
    fr: "recevoir les données que vous avez fournies dans un format lisible par machine et les faire transférer à un tiers",
  },
  "när som helst ta tillbaka ett samtycke du gett, utan att det påverkar det som redan gjorts": {
    en: "withdraw a consent you've given at any time, without affecting what has already been done",
    fr: "retirer à tout moment un consentement donné, sans que cela affecte ce qui a déjà été fait",
  },
  "Skicka din begäran till": { en: "Send your request to", fr: "Envoyez votre demande à" },
  "från adressen kontot ligger på. Vi svarar inom en månad.": {
    en: "from the address the account is registered to. We answer within a month.",
    fr: "depuis l'adresse associée au compte. Nous répondons sous un mois.",
  },
  "Tycker du att vi behandlar dina uppgifter fel har du rätt att klaga till Integritetsskyddsmyndigheten,": {
    en: "If you think we're handling your data wrongly, you have the right to complain to the Swedish Authority for Privacy Protection,",
    fr: "Si vous estimez que nous traitons mal vos données, vous pouvez déposer une plainte auprès de l'autorité suédoise de protection de la vie privée,",
  },
  Ändringar: { en: "Changes", fr: "Modifications" },
  "Ändrar vi vad vi samlar in, varför, eller vilka som får del av det, uppdaterar vi den här sidan och datumet överst. Rör ändringen något du gett samtycke till frågar vi om på nytt.": {
    en: "If we change what we collect, why, or who receives it, we update this page and the date at the top. If the change touches something you consented to, we ask again.",
    fr: "Si nous modifions ce que nous collectons, pourquoi, ou qui y a accès, nous mettons à jour cette page et la date en haut. Si la modification porte sur un point auquel vous avez consenti, nous vous le redemandons.",
  },
};
