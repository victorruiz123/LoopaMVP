/**
 * Bloggen: guider om att sälja möbler, på loopa.nu/blogg.
 *
 * VARFÖR DEN FINNS. Startsidan svarar på "sälja möbler" som ETT sökord. De frågor folk faktiskt
 * skriver — "var kan jag sälja mina möbler", "vad är min soffa värd", "sälja möbler inför flytt" —
 * behöver var sin sida som svarar på just den frågan, och de svaren pekar sedan tillbaka till
 * startsidan och säljflödet.
 *
 * EN KÄLLA FÖR BÅDA SIDORNA. Filen läses av appen (screens/BloggScreen.tsx), som ritar inläggen för
 * besökaren, och av servern (server/src/butik/seo.ts), som skickar samma text färdig i HTML:en så att
 * Google läser den utan att köra JavaScript. Därför importerar filen ingenting: servern kör den med
 * tsx direkt ur web/src, och ett beroende här vore ett beroende servern inte har installerat.
 *
 * VAD SOM FÅR STÅ OM LOOPA. Bara det som står i server/src/saljChat.ts (FAKTA) och i villkoren:
 * 20 % och högst 1 000 kr, ingen avgift om möbeln inte säljs, ingen kontakt med köparen, hämtning
 * och leverans, utbetalning via Swish eller bank, prissänkningar ned till säljarens golv. Aldrig hur
 * fort en möbel säljs eller vad en enskild möbel är värd — det vet vi inte, och ett blogginlägg som
 * lovar det är ett löfte någon annan får infria.
 *
 * LÄNKAR I TEXTEN skrivs [text](/adress) och ritas av `delarAvText`. Bara interna adresser.
 */

export interface BloggDel {
  rubrik: string;
  stycken: string[];
  /** En punktlista efter styckena, när ordningen eller uppräkningen är själva svaret. */
  punkter?: string[];
}

export interface BloggInlagg {
  slug: string;
  /** H1 och sidans titel. Sökordet först, frågan som folk skriver den. */
  titel: string;
  /** Meta-beskrivningen. Under 160 tecken, annars kapar Google den. */
  beskrivning: string;
  /** ISO-datum. */
  publicerad: string;
  uppdaterad: string;
  /** Svaret i korthet, överst. Det stycke Google helst plockar som utdrag. */
  ingress: string;
  delar: BloggDel[];
  fragor: Array<{ q: string; a: string }>;
}

export const BLOGG_RUBRIK = "Guider om att sälja möbler";
export const BLOGG_BESKRIVNING =
  "Guider om att sälja begagnade möbler: var du säljer dem, vad de är värda, hur du gör inför en flytt och hur Loopa säljer dem åt dig.";

export const INLAGG: BloggInlagg[] = [
  {
    slug: "var-kan-jag-salja-mina-mobler",
    titel: "Var kan jag sälja mina möbler? 6 alternativ jämförda",
    beskrivning:
      "Var säljer man begagnade möbler bäst? Vi jämför Blocket, Facebook, Tradera, second hand-butiker, att skänka och Loopa – tid, krångel och betalt.",
    publicerad: "2026-10-30",
    uppdaterad: "2026-10-30",
    ingress:
      "Du kan sälja begagnade möbler själv på Blocket, Facebook Marketplace eller Tradera, lämna dem till en second hand-butik eller låta en tjänst som Loopa sköta hela försäljningen åt dig. Vilket som passar beror på hur mycket tid du har, hur mycket möbeln är värd och om du vill träffa köpare själv.",
    delar: [
      {
        rubrik: "Först: vad är viktigast för dig?",
        stycken: [
          "Frågan \"vart kan jag sälja möbler?\" har inget enda svar. Den som har gott om tid och inte har något emot att svara på meddelanden kan få bra betalt på egen hand. Den som ska flytta om två veckor, eller bara inte orkar, vill hellre att någon annan gör jobbet.",
          "Tre saker avgör nästan alltid valet: hur mycket tid du vill lägga, hur mycket du vill få betalt och hur du får möbeln till köparen. En soffa går inte att posta, och det är ofta transporten som stjälper en annars enkel affär.",
        ],
      },
      {
        rubrik: "1. Blocket",
        stycken: [
          "Blocket är Sveriges största marknadsplats för begagnat och den plats många tänker på först. Du når många köpare, men du gör allt själv: fotar, skriver annonsen, sätter priset, svarar på frågor, prutar och bokar visning eller hämtning.",
          "Passar dig som har tid och vill ha full kontroll. Räkna med att svara på en hel del meddelanden, och att alla som hör av sig inte dyker upp.",
        ],
      },
      {
        rubrik: "2. Facebook Marketplace och köp/sälj-grupper",
        stycken: [
          "Facebook är gratis och snabbt att komma igång med, och lokala köp/sälj-grupper kan ge snabba svar. Nackdelen är densamma som på Blocket, fast ofta mer: många frågor, pruttbud och köpare som inte hör av sig igen.",
          "Passar billigare möbler som du vill bli av med snabbt, och dig som inte har något emot att träffa köparen hemma.",
        ],
      },
      {
        rubrik: "3. Tradera",
        stycken: [
          "På Tradera säljer du på auktion eller till fast pris. Auktion kan fungera bra för design- och märkesmöbler där flera köpare vill ha samma sak. För stora möbler måste du ändå lösa frakten eller låta köparen hämta.",
        ],
      },
      {
        rubrik: "4. Second hand-butiker och auktionshus",
        stycken: [
          "Att lämna möbeln till en second hand-butik eller ett auktionshus är enkelt, men du får sällan särskilt mycket betalt, och alla tar inte emot stora möbler. Auktionshus passar bäst för äldre designmöbler med ett känt namn.",
        ],
      },
      {
        rubrik: "5. Skänka eller återvinna",
        stycken: [
          "Är möbeln sliten eller värd väldigt lite kan det vara bättre att skänka den eller lämna den på återvinningen. Det tar tid också – du behöver fortfarande transportera den – men du slipper allt annonserande.",
        ],
      },
      {
        rubrik: "6. Loopa – vi säljer möbeln åt dig",
        stycken: [
          "Loopa är för dig som vill få betalt för möbeln men inte vill göra jobbet. Du filmar ett varv runt möbeln med mobilen. Vår AI känner igen märke och modell, granskar skicket och föreslår ett marknadspris. Du godkänner priset, och sedan sköter vi annonsen, frågorna från köpare, hämtningen och leveransen. Du träffar aldrig köparen.",
          "Loopa tar 20 % av försäljningspriset men aldrig mer än 1 000 kr, och blir möbeln inte såld kostar det ingenting. Läs mer i [så säljer du dina möbler med Loopa](/blogg/sa-saljer-du-mobler-med-loopa).",
        ],
      },
      {
        rubrik: "Jämförelsen i korthet",
        stycken: ["Så här skiljer sig alternativen åt:"],
        punkter: [
          "Blocket och Facebook: mest kontroll och ingen mellanhand, men mest tid och flest kontakter med okända köpare.",
          "Tradera: bra för märkesmöbler som många vill ha, men du löser frakten själv.",
          "Second hand och auktionshus: lite jobb, oftast lite betalt.",
          "Skänka eller återvinna: när möbeln inte är värd att sälja.",
          "Loopa: minst jobb – du filmar, vi gör resten – och du betalar bara om möbeln blir såld.",
        ],
      },
    ],
    fragor: [
      {
        q: "Var säljer man begagnade möbler snabbast?",
        a: "Det beror mest på priset. En möbel som är rätt prissatt säljs snabbare var den än ligger ute. Lokala Facebook-grupper kan ge snabba svar på billiga möbler, medan Blocket och Tradera når fler köpare.",
      },
      {
        q: "Kan jag sälja möbler utan att träffa köparen?",
        a: "Ja. Med Loopa sköter vi kontakten med köparen, hämtningen hos dig och leveransen. Du filmar möbeln och godkänner priset.",
      },
      {
        q: "Vad kostar det att sälja möbler med Loopa?",
        a: "Loopa tar 20 % av försäljningspriset, men aldrig mer än 1 000 kr. Det kostar ingenting att lägga upp möbeln, och blir den inte såld betalar du ingenting.",
      },
    ],
  },
  {
    slug: "sa-saljer-du-mobler-med-loopa",
    titel: "Så säljer du dina möbler med Loopa – steg för steg",
    beskrivning:
      "Filma ett varv runt möbeln – Loopa känner igen den, granskar skicket, sätter priset och sköter försäljningen. Så går det till, och vad det kostar.",
    publicerad: "2026-10-30",
    uppdaterad: "2026-10-30",
    ingress:
      "Med Loopa filmar du ett varv runt möbeln med mobilen. Vi känner igen den, granskar skicket, föreslår ett pris och sköter sedan annonsen, köparna, hämtningen och leveransen. Du får betalt via Swish eller bank när möbeln är såld, och du träffar aldrig köparen.",
    delar: [
      {
        rubrik: "Varför sälja möbler med Loopa?",
        stycken: [
          "Det tråkiga med att sälja en begagnad möbel är sällan själva försäljningen. Det är allt runt omkring: fotografera, mäta, skriva annonsen, gissa ett pris, svara på samma frågor tio gånger och sedan få hem en främling som vill pruta i hallen. Loopa tar över allt det där.",
        ],
      },
      {
        rubrik: "Steg för steg",
        stycken: ["Så här går en försäljning till, från början till slut:"],
        punkter: [
          "Välj möbelns märke på [startsidan](/). Står märket inte i listan skriver du in det – vi tar emot alla märken.",
          "Filma ett varv runt möbeln med mobilen och ta sist en omslagsbild.",
          "Vår AI känner igen möbeln – märke, modell och mått – ur filmen.",
          "Samma AI granskar skicket. Varje repa, fläck och nötning listas med en bild på var den sitter, och möbeln får ett skickbetyg.",
          "En prismotor räknar fram ett marknadsvärde för just det skicket, utifrån jämförbara annonser.",
          "Du ser förslaget och bekräftar priset. Ingenting publiceras utan att du har sagt ja.",
          "Loopa lägger upp annonsen och sköter kontakten med köparna.",
          "När möbeln är såld hämtas den hos dig och körs till köparen.",
          "Du får betalt via Swish eller banköverföring.",
        ],
      },
      {
        rubrik: "Vad kostar det?",
        stycken: [
          "Loopa tar 20 % av vad möbeln säljs för, men aldrig mer än 1 000 kr. Säljs en möbel för mer än 5 000 kr är avgiften alltså 1 000 kr, och resten är ditt. Det finns ingen avgift för att lägga upp möbeln och ingen månadskostnad – blir den inte såld kostar det ingenting.",
          "Avgiften räknas bara på möbelns pris. Det köparen betalar för hemleveransen går vidare till budfirman.",
        ],
      },
      {
        rubrik: "Priset sänks automatiskt om möbeln inte säljs",
        stycken: [
          "När du lägger ut möbeln sätter du ett startpris, ett lägsta pris och hur fort priset ska sänkas. Ligger annonsen kvar osåld sänks priset automatiskt steg för steg tills ditt lägsta pris är nått. Du bestämmer var det slutar – resten sköter sig själv.",
        ],
      },
      {
        rubrik: "Skador är inget hinder",
        stycken: [
          "En möbel med repor eller fläckar går utmärkt att sälja. Skadorna räknas in i priset och syns i annonsen med bild. Det är hela poängen: köparen vet exakt vad hen får, och du slipper diskussioner i efterhand. Läs mer om [vad dina möbler är värda](/blogg/vad-ar-mina-mobler-varda).",
        ],
      },
      {
        rubrik: "Vilka möbler kan jag sälja?",
        stycken: [
          "Loopa säljer begagnade möbler i Stockholmsområdet: soffor, fåtöljer, bord, stolar, sängar, förvaring och mycket annat, av vilket märke som helst. Märkeslistan på startsidan är en genväg, inte en gräns.",
        ],
      },
    ],
    fragor: [
      {
        q: "Måste jag träffa köparen?",
        a: "Nej. Loopa sköter annonsen, frågorna och hämtningen. Möbeln hämtas hos dig och körs till köparen.",
      },
      {
        q: "Hur får jag betalt?",
        a: "Utbetalningen sker via Swish eller banköverföring.",
      },
      {
        q: "Vad händer om möbeln inte blir såld?",
        a: "Då kostar det ingenting. Under tiden sänks priset automatiskt, men aldrig under det lägsta pris du själv har valt.",
      },
      {
        q: "Var finns Loopa?",
        a: "Loopa säljer begagnade möbler i Stockholmsområdet.",
      },
    ],
  },
  {
    slug: "vad-ar-mina-mobler-varda",
    titel: "Vad är mina begagnade möbler värda? Så sätts priset",
    beskrivning:
      "Vad kan du få för din begagnade soffa, ditt bord eller din fåtölj? Märke, skick och efterfrågan avgör – så räknar du ut ett rimligt pris.",
    publicerad: "2026-10-30",
    uppdaterad: "2026-10-30",
    ingress:
      "Vad en begagnad möbel är värd avgörs av tre saker: märket och modellen, skicket och hur många som vill ha just den möbeln just nu. Det bästa sättet att hitta ett rimligt pris är att jämföra med liknande möbler som faktiskt har sålts – inte med vad den kostade ny.",
    delar: [
      {
        rubrik: "Nypriset är en dålig utgångspunkt",
        stycken: [
          "Det vanligaste misstaget är att utgå från vad möbeln kostade i butik. Begagnade möbler säljs till en bråkdel av nypriset, och hur stor bråkdelen blir varierar mycket. En välkänd designklassiker kan behålla mycket av sitt värde, medan en billig massproducerad möbel ofta är värd väldigt lite begagnad, även om den är nästan ny.",
        ],
      },
      {
        rubrik: "Det här påverkar priset",
        stycken: ["De viktigaste faktorerna, ungefär i ordning:"],
        punkter: [
          "Märke och modell. Kända märken och eftertraktade modeller säljer bättre och till högre pris.",
          "Skick. Repor, fläckar, nötningar och lösa delar drar ned priset – men en ärligt beskriven skada drar ned mindre än en upptäckt i efterhand.",
          "Efterfrågan. Vissa möbeltyper och stilar är mer eftertraktade än andra, och efterfrågan skiftar över tid.",
          "Storlek och transport. En stor möbel som är svår att flytta har färre möjliga köpare.",
          "Var du bor. I en storstad som Stockholm finns fler köpare än på landsbygden.",
        ],
      },
      {
        rubrik: "Så räknar du ut ett pris själv",
        stycken: [
          "Sök efter samma märke och modell på marknadsplatserna och titta på möbler i liknande skick. Kom ihåg att annonspriset inte är detsamma som försäljningspriset – många möbler ligger ute länge för att de är för dyra. Sätt hellre ett pris som är rimligt från början och var beredd att sänka det om ingen hör av sig.",
        ],
      },
      {
        rubrik: "Så sätter Loopa priset",
        stycken: [
          "När du säljer med Loopa behöver du inte gissa. Vår AI känner igen märke och modell ur filmen du tar, granskar skicket och listar varje skada med bild. En prismotor räknar sedan ett marknadsvärde för just det skicket, utifrån jämförbara annonser. Du ser förslaget och bestämmer själv – ingenting publiceras utan att du har godkänt priset.",
          "Du väljer också ett lägsta pris. Blir möbeln inte såld sänks priset automatiskt steg för steg, men aldrig under ditt golv. [Så går en försäljning till med Loopa](/blogg/sa-saljer-du-mobler-med-loopa).",
        ],
      },
      {
        rubrik: "Vad du får behålla",
        stycken: [
          "Loopa tar 20 % av försäljningspriset men aldrig mer än 1 000 kr. Ju dyrare möbeln är, desto mindre andel går alltså till oss – över 5 000 kr är avgiften alltid 1 000 kr. Blir möbeln inte såld betalar du ingenting.",
        ],
      },
    ],
    fragor: [
      {
        q: "Hur mycket är min begagnade soffa värd?",
        a: "Det beror på märke, modell, skick och efterfrågan. Jämför med liknande soffor i samma skick, eller filma soffan i Loopa så får du ett prisförslag utifrån jämförbara annonser.",
      },
      {
        q: "Går det att sälja en möbel med skador?",
        a: "Ja. Skadorna räknas in i priset. Hos Loopa listas varje skada med bild i annonsen, så att köparen vet exakt vad hen får.",
      },
      {
        q: "Måste jag acceptera Loopas prisförslag?",
        a: "Nej. Du ser förslaget och bekräftar priset själv. Ingenting publiceras utan att du har sagt ja.",
      },
    ],
  },
  {
    slug: "salja-mobler-infor-flytt",
    titel: "Sälja möbler inför flytten – tidsplan och tips",
    beskrivning:
      "Ska du flytta och sälja möbler? En enkel tidsplan för vad du ska sälja, när du ska börja och hur du blir av med möblerna utan stress.",
    publicerad: "2026-10-30",
    uppdaterad: "2026-10-30",
    ingress:
      "Börja sälja möblerna du inte ska ha med dig så tidigt som möjligt – helst fyra till sex veckor före flytten. Bestäm först vad som ska med, sälj de dyraste och största möblerna först och spara det du behöver till sista veckan. Allt du säljer är något du slipper bära, packa och betala för att flytta.",
    delar: [
      {
        rubrik: "Varför sälja innan du flyttar?",
        stycken: [
          "Varje möbel som följer med kostar tid, plats i flyttbilen och ofta pengar. En flytt är dessutom ett bra tillfälle att rensa: möblerna som inte passar i det nya hemmet blir sällan bättre av att stå i ett förråd.",
        ],
      },
      {
        rubrik: "Tidsplan",
        stycken: ["Så här kan du lägga upp det:"],
        punkter: [
          "6 veckor före: gå igenom hemmet rum för rum och bestäm vad som ska med, vad som ska säljas och vad som ska skänkas eller slängas.",
          "5 veckor före: lägg upp de dyraste och största möblerna först – soffan, matgruppen, sängen du inte ska ha. De tar längst tid att sälja.",
          "3–4 veckor före: lägg upp resten av det du vill sälja. Sänk priset på det som inte rört sig.",
          "1–2 veckor före: sälj det du använder in i det sista, och bestäm vad som ska skänkas eller återvinnas om det inte blir sålt.",
          "Flyttdagen: det enda som ska stå kvar är det som ska med.",
        ],
      },
      {
        rubrik: "Svårast är logistiken",
        stycken: [
          "Det som gör flyttförsäljningar stressiga är sällan att hitta köpare – det är att få möblerna till dem. Mitt i packningen ska du boka visningar, vara hemma när köparna kommer och hjälpa till att bära ut. Har du flera möbler att sälja blir det snabbt många kvällar.",
          "Med Loopa slipper du det. Du filmar varje möbel, godkänner priset, och vi sköter köparna, hämtningen hos dig och leveransen. Du träffar aldrig köparen.",
          "Loopa tar 20 % av försäljningspriset men aldrig mer än 1 000 kr, och blir möbeln inte såld kostar det ingenting. Läs [så går en försäljning till med Loopa](/blogg/sa-saljer-du-mobler-med-loopa).",
        ],
      },
      {
        rubrik: "Tips för att sälja möbler snabbt inför flytt",
        stycken: ["Det här gör störst skillnad när tiden är knapp:"],
        punkter: [
          "Sätt ett rimligt pris från början. En för dyr möbel blir stående, och tid är det du har minst av. Läs [vad dina möbler är värda](/blogg/vad-ar-mina-mobler-varda).",
          "Var ärlig om skador. Köpare som vet vad de får köper snabbare och klagar inte efteråt.",
          "Ta tydliga bilder eller filma möbeln i dagsljus, innan rummet fylls med flyttkartonger.",
          "Ange mått. En köpare som inte vet om soffan går in genom dörren hör av sig med frågor i stället för att köpa.",
          "Bestäm ett lägsta pris i förväg, så att du inte behöver fundera varje gång någon prutar.",
        ],
      },
    ],
    fragor: [
      {
        q: "Hur tidigt ska jag börja sälja möblerna inför flytten?",
        a: "Gärna fyra till sex veckor innan. Stora och dyra möbler tar längst tid att sälja, så börja med dem.",
      },
      {
        q: "Kan någon hämta möblerna åt mig?",
        a: "Ja. När du säljer med Loopa hämtas möbeln hos dig och körs till köparen när den är såld.",
      },
      {
        q: "Vad gör jag med möbler som inte blir sålda?",
        a: "Skänk dem till en second hand-butik eller välgörenhet, eller lämna dem på återvinningen. Har du sålt via Loopa och möbeln inte blev såld har det inte kostat dig något.",
      },
    ],
  },
  {
    slug: "salja-begagnade-mobler-tips",
    titel: "Sälja begagnade möbler: 8 tips som får dem att säljas",
    beskrivning:
      "Så säljer du begagnade möbler snabbare och till ett bättre pris: bilder, mått, ärliga skador, rätt pris och hur du slipper allt krångel.",
    publicerad: "2026-10-30",
    uppdaterad: "2026-10-30",
    ingress:
      "Begagnade möbler säljs snabbast när köparen direkt ser vad den får: tydliga bilder, exakta mått, ärligt beskrivna skador och ett pris som stämmer med skicket. Här är åtta tips som gör skillnad – och hur du slipper göra allt själv.",
    delar: [
      {
        rubrik: "1. Rengör möbeln först",
        stycken: [
          "Dammsug soffan, torka av bordet och ta bort sådant som inte hör till möbeln. Det tar tio minuter och gör stor skillnad för hur möbeln upplevs på bild.",
        ],
      },
      {
        rubrik: "2. Ta bilder i dagsljus – eller filma",
        stycken: [
          "Mörka eller suddiga bilder är den vanligaste anledningen till att en annons inte får svar. Fota i dagsljus, från flera vinklar, och visa möbeln i sin helhet. En film ett varv runt möbeln visar mer än tio bilder – det är därför man filmar möbeln när man säljer med Loopa.",
        ],
      },
      {
        rubrik: "3. Ange exakta mått",
        stycken: [
          "Höjd, bredd och djup avgör om möbeln får plats hos köparen. Utan mått får du frågor i stället för bud.",
        ],
      },
      {
        rubrik: "4. Skriv märke och modell",
        stycken: [
          "Många söker efter ett visst märke eller en viss modell. Står det i annonsen hittar de möbeln – står det inte där hittar de den inte.",
        ],
      },
      {
        rubrik: "5. Var ärlig om skador",
        stycken: [
          "Visa repor, fläckar och slitage med bild. Det kan kännas fel, men en ärligt beskriven skada sänker priset mindre än en köpare som känner sig lurad. Hos Loopa listas varje skada med en bild på var den sitter, så att köparen vet exakt vad hen får.",
        ],
      },
      {
        rubrik: "6. Sätt rätt pris från början",
        stycken: [
          "Jämför med liknande möbler i samma skick, inte med nypriset. En möbel som är för dyr blir stående, och en annons som legat länge ser mindre intressant ut. Läs mer om [vad dina möbler är värda](/blogg/vad-ar-mina-mobler-varda).",
        ],
      },
      {
        rubrik: "7. Bestäm hur möbeln ska till köparen",
        stycken: [
          "Stora möbler stjälper många affärer i sista steget. Skriv om köparen ska hämta, om du kan hjälpa till att bära eller om leverans ingår. Ju enklare det är för köparen, desto fler kan tänka sig att köpa.",
        ],
      },
      {
        rubrik: "8. Låt någon annan göra jobbet",
        stycken: [
          "Har du inte tid eller lust att göra allt ovan kan Loopa sälja möbeln åt dig. Du filmar ett varv runt möbeln. Vi känner igen märke och modell, mäter, granskar skicket, föreslår ett pris och skriver annonsen. Sedan sköter vi köparna, hämtningen och leveransen. Loopa tar 20 % av försäljningspriset men högst 1 000 kr – och blir möbeln inte såld kostar det ingenting.",
          "[Sälj din möbel med Loopa](/) eller läs [så går en försäljning till](/blogg/sa-saljer-du-mobler-med-loopa).",
        ],
      },
    ],
    fragor: [
      {
        q: "Hur säljer man begagnade möbler snabbt?",
        a: "Med tydliga bilder, exakta mått, ärligt beskrivna skador och ett pris som stämmer med skicket. Ju enklare det är för köparen att få hem möbeln, desto snabbare går det.",
      },
      {
        q: "Vilka möbler är lättast att sälja begagnat?",
        a: "Möbler av kända märken i gott skick, i storlekar som passar många hem. Men nästan allt går att sälja till rätt pris.",
      },
      {
        q: "Måste jag fota själv om jag säljer med Loopa?",
        a: "Du filmar ett varv runt möbeln med mobilen och tar en omslagsbild. Resten – identifiering, mått, skick, pris och annonstext – gör Loopa.",
      },
    ],
  },
];

export function inlaggFor(slug: string): BloggInlagg | null {
  return INLAGG.find((i) => i.slug === slug) ?? null;
}

/**
 * Vilken bloggsida adressen pekar på. Null = ingen bloggsida.
 *
 * `{ slug: null }` är listan på /blogg. En okänd slug ger `{ slug: "…" }` ändå — sidan säger då att
 * inlägget inte finns, i stället för att besökaren hamnar i säljflödet utan förklaring.
 */
export function bloggVagFranAdress(pathname: string): { slug: string | null } | null {
  const m = /^\/blogg(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!m) return null;
  return { slug: m[1] ? decodeURIComponent(m[1]) : null };
}

export type TextDel = { text: string; href?: string };

/** "Läs [så här](/blogg/x)." → text och länkar, i ordning. Bara interna adresser blir länkar. */
export function delarAvText(text: string): TextDel[] {
  const ut: TextDel[] = [];
  const re = /\[([^\]]+)\]\((\/[^)\s]*)\)/g;
  let senast = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > senast) ut.push({ text: text.slice(senast, m.index) });
    ut.push({ text: m[1], href: m[2] });
    senast = m.index + m[0].length;
  }
  if (senast < text.length) ut.push({ text: text.slice(senast) });
  return ut;
}

/** Inläggets text som ren text, utan länkmarkering. För ordräkning och strukturerad data. */
export function renText(text: string): string {
  return delarAvText(text).map((d) => d.text).join("");
}
