/**
 * FRÅGORNA TILL AI-LÄGET OCH LÄSNINGEN AV SVARET — SerpApi-flödet.
 *
 * GENERERAD FIL. Allt under den här kommentaren är ett MEKANISKT utdrag ur main.js i appskalet (ett lokalt testverktyg som inte ligger i repot), med bara typangivelser tillagda. Ändra frågorna
 * med eftertanke: SerpApi-flödet ska ställa EXAKT samma frågor som skalet, annars mäter vi inte samma sak. tests/serpapi.test.ts jämför varje fråga med main.js ord för ord när den filen finns.
 */
/* eslint-disable */

/**
 * FRÅGORNA TILL AI-LÄGET — korta, utan exempel och utan färdigt svarsformat. Mätt 2026-10-29 (samma foton av en Sits-fåtölj som säljaren själv ser Googles webb-AI svara
 * "Impulse" på, utloggat, 2–3 körningar per rad):
 *   - den långa strukturprompten (FÖRSLAG n / SÄKERHET n / …, med "Brandon" som exempel på namnformat) gav Brandon först, och Impulse aldrig först;
 *   - en kort fråga i vanlig text gav Impulse först i fyra av sex körningar och med bland de fyra i alla sex;
 *   - samma korta fråga med "ge också mått och material" på slutet tappade Impulse helt i två av tre: en fråga får inte bära två uppgifter.
 * Därför två frågor i samma samtal: först vilken modell det är, sedan — utan nya bilder — mått och material för förslag 1. Servern översätter fritexten (externalIdentify.ts).
 *
 * 2026-10-30, fyra körningar per rad, samma möbel (Impulse bland de fyra / först):
 *   - "Ge 4 förslag på vilka Sits fåtöljer fåtöljen på dessa bilder kan vara." med omslag + sex ramar: 2 / 0 (och 4–6 förslag, ibland med rubriker som förslag);
 *   - "Fåtöljen på dessa bilder är från Sits. Ge 4 förslag på vilka Sits fåtöljer den kan vara, den mest sannolika först, och ange hur säker du är på varje samt en länk …" med omslag + ramar: 4 / 1;
 *   - samma fråga med BARA omslaget: 4 / 4, och fyra förslag varje gång.
 * Alltså: typen i frågan ("fåtöljer", inte bara "modeller") — och bara det skarpa omslagsfotot. Typen läses ur fotot av servern (typFranFoto) medan bilden läggs in.
 */
export const TYP_ORD: Record<string, { def: string; plur: string }> = {
  fåtölj: { def: "Fåtöljen", plur: "fåtöljer" },
  soffa: { def: "Soffan", plur: "soffor" },
  stol: { def: "Stolen", plur: "stolar" },
  bord: { def: "Bordet", plur: "bord" },
  säng: { def: "Sängen", plur: "sängar" },
};
/**
 * AKTUELL ELLER UTGÅNGEN: säljarens möbel är ofta äldre än tillverkarens nuvarande sortiment, och AI-läget kan annars hålla sig till det som säljs idag. Säljarens IKEA-barstol, som
 * säljaren själv anger är en utgången INGEMAR (inte verifierat av oss), kom inte med i appens första körning (NORDVIKEN, NORRÅKER, INGOLF, BERGMUND). Meningen säger att möbeln kan vara
 * någon av delarna, att båda ska sökas igenom och att varje förslag ska märkas — det sista gör det synligt i svaret vad som är en äldre modell.
 * Mätt 2026-11-01 med bara omslaget i frågan, "INGEMAR bland de fyra förslagen": utan meningen 2 av 3 körningar, med en kortare variant 3 av 4, med den här 4 av 4 (alltid förslag 2).
 * Med omslaget plus EN eller flera videoramar gav varken denna eller de andra formuleringarna INGEMAR i någon av 15 körningar, se App.tsx.
 */
const AKTUELL_ELLER_UTGANGEN = (def: string) =>
  `${def} kan vara antingen en aktuell modell som säljs idag eller en utgången modell som inte längre säljs. Sök igenom både aktuella och utgångna modeller och ta med båda möjligheterna bland förslagen; ange för varje förslag om den är aktuell eller utgången.`;
export const PROMPT = (brand: string | null | undefined, type: string | null | undefined): string => {
  const ord = type ? TYP_ORD[type] : null;
  const gren = ord && brand ? `${ord.def} på dessa bilder är från ${brand}. Ge 4 förslag på vilka ${brand} ${ord.plur} den kan vara` : brand ? `Denna möbel är av varumärket ${brand}. Ge 4 förslag på vilka modeller den kan vara` : "Ge 4 förslag på vilka modeller möbeln på dessa bilder kan vara";
  return `${gren}, den mest sannolika först, och ange hur säker du är på varje samt en länk till modellens produktsida. ${AKTUELL_ELLER_UTGANGEN(ord ? ord.def : "Möbeln")}`;
};
/**
 * Gav Google färre än fyra förslag ber vi om resten i samma samtal. Även här: aktuella OCH utgångna modeller. De redan nämnda modellerna står med i frågan: det gör frågan olika varje
 * varv (en ordagrant lika fråga fick det gamla svaret, se `ask`) och Google slipper gissa vad "de du redan nämnt" är.
 */
export const MORE_PROMPT = (brand: string | null | undefined, type: string | null | undefined, names: string[]): string => {
  const ord = type ? TYP_ORD[type] : null;
  const lista = names.length > 1 ? `${names.slice(0, -1).join(", ")} och ${names[names.length - 1]}` : names[0] || "de du redan nämnt";
  return `Ge ${Math.max(1, 4 - names.length)} förslag till på ${brand ? `${brand}-` : ""}${ord ? ord.plur : "modeller"} som den på bilderna kan vara, andra än ${lista}, på samma sätt: modellnamn, hur säker du är och en länk till modellens produktsida. Ta med både aktuella och utgångna modeller och ange om varje förslag är aktuell eller utgången.`;
};
/**
 * De OLIKA modellerna i svaret (i ordning), vilket format Google än väljer: "1. Sits Brandon", "**2. Stella**", en rad "Sits Impulse" följd av "Sannolikhet: …", eller en TABELL med rader som
 * "1⇥NORDVIKEN Barstol (svart)⇥Aktuell⇥100 %" (mätt 2026-11-02; tabellen räknades förut som tre förslag av fyra och gav en onödig uppföljning). Räknas bara före "AI kan göra misstag":
 * under den raden ligger källkorten ("SITS Quattro Sofas, Armchairs …"), som inte är förslag.
 */
export function countProposals(text: string, brand: string | null | undefined): number {
  return proposalNames(text, brand).length;
}
export function proposalNames(text: string, brand: string | null | undefined): string[] {
  // Varje del (första svaret, "FLER FÖRSLAG") räknas för sig fram till sin egen "AI kan göra misstag"-rad.
  const body = String(text)
    .split(/=== FLER FÖRSLAG[^\n]*\n/)
    .map((del) => del.split(/AI kan göra misstag/i)[0])
    .join("\n");
  const b = (brand || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const namn = new Map<string, string>();
  const skip = /^(Fåtölj|Fåtöljer|Baserat|Här|Modell|Tittar|Sits|IKEA|Det|Detta|Den|Om|För|Vill|Hur|AI|Stolen|Furniture|Collection|Möbler|Sannolikhet\S*|Säkerhet\S*|Beskrivning\S*|Motivering\S*|Status\S*|Detaljer\S*|Länk\S*|Produktsida\S*)$/i;
  const add = (n: string | undefined) => {
    if (n && !skip.test(n) && !namn.has(n.toLowerCase())) namn.set(n.toLowerCase(), n);
  };
  // Versaler och bokstäver med Unicode: "RÄVSTEN" och "NORRÅKER" föll förut på Ä/Å (\w är bara ASCII). Före namnet kan det stå siffra, punkt, stjärnor eller en emoji ("1. 🥇 IKEA NORDVIKEN").
  const NAMN = "(\\p{Lu}[\\p{L}\\p{N}-]+)";
  const FORE = "[^\\p{L}\\n]*";
  const MARKE = b ? `(?:(?:${b}|${b.toUpperCase()})[ \\t]+)?` : "";
  // 1) Numrerad rad: "1. Sits Brandon", "**2. Stella**", och en tabellrad "1⇥NORDVIKEN Barstol".
  for (const m of body.matchAll(new RegExp(`^\\s*(?:[#*•-]+\\s*)?[1-9][ \\t]*(?:[.)]|\\t)${FORE}${MARKE}${NAMN}`, "gmu"))) add(m[1]);
  // 2) Märket följt av namnet först på raden: "Sits Impulse", "IKEA NORDVIKEN (Barstol)".
  if (b) for (const m of body.matchAll(new RegExp(`^${FORE}(?:${b}|${b.toUpperCase()})[ \\t]+${NAMN}`, "gmu"))) add(m[1]);
  // 3) Namnet ensamt på en rad ("INGEMAR Barstol", "NORDVIKEN (Barstol)") med Sannolikhet:/Säkerhet:/Beskrivning: på raden under (mätt: Google väljer ibland bort märket före namnet).
  for (const m of body.matchAll(new RegExp(`^${FORE}${MARKE}${NAMN}[^\\n]*\\n\\s*\\**\\s*(?:Sannolikhet|Säkerhet|Beskrivning|Motivering|Status|Detaljer|Länk)\\b`, "gmu"))) add(m[1]);
  return [...namn.values()];
}
/**
 * Måttfrågan nämner modellen vid namn när identifieringens första förslag går att läsa ut ("1. Sits Impulse"): en uppföljning som hänvisar till "förslag 1 i din lista" fick i fyra av sju
 * försök svaret "Det verkar inte finnas något svar för den här sökningen", en fråga om en namngiven produkt har fått svar varje gång. Går namnet inte att läsa ut används den allmänna formen.
 */
/**
 * FRÅGAN EFTER VALET (2026-11-02). Ställs först när säljaren valt modell, och gäller DEN modellen (förut: förslag 1 direkt, innan något valts). AI-läget ska avgöra vilken EXAKT variant
 * det är ur bilderna och ge mått, material och nypris för just den, och inte räkna upp vilka tyger, färger och utföranden modellen kan ha: svaret på "vilka mått och vilket material har
 * Sits Impulse?" blev (säljarens skärmbild) en materialruta med "valbart i hundratals tyger och läderstrukturer" och fyra mått med spann i stället för säljarens fåtölj.
 * Raderna i svaret ger servern något att hålla sig till (externalIdentify.ts, SPEC_SYSTEM). Nyprisets ord: "kostade ny" och årtal för en utgången modell.
 *
 * Mätt 2026-11-02 med omslaget som enda bild, ett samtal per körning (utloggat), fråga 1 = identifieringsfrågan, EN körning per rad och möbel (Impulse och NORRNÄS): den här formen (raderna Variant,
 * Mått, Material, Nypris, Länk) och en fritext-variant gav båda EN vald variant ("vit/Isunda grå"; "Standard komfort, fast klädsel, Caleido Light Grey"), konkreta mått, material märkt "uppskattat"
 * där det inte stod i en källa, och ett nypris. Skillnaden mellan formerna går inte att visa på så få körningar; raderna valdes för att svaret får en egen Länk-rad. Måtten och nyprisets belopp svänger
 * mellan körningar för samma möbel (Impulse: bredd 92 respektive 81 cm, nypris 10 390 respektive 7 490 kr), så de är uppgifter att kontrollera, inte fakta.
 */
const TYP_MATT: Record<string, { variant: string; matt: string; delar: string }> = {
  fåtölj: { variant: "klädselns tyg och färg, benens material och färg, och storlek eller bredd om modellen finns i flera", matt: "bredd, djup, höjd, sitthöjd, armstödshöjd", delar: "stomme, klädsel och ben" },
  soffa: { variant: "klädselns tyg och färg, benens material och färg, och storlek eller antal sitsar", matt: "bredd, djup, höjd, sitthöjd, armstödshöjd", delar: "stomme, klädsel och ben" },
  stol: { variant: "klädselns tyg och färg, stommens och benens material och färg, och storlek om modellen finns i flera", matt: "bredd, djup, höjd, sitthöjd", delar: "stomme, klädsel och ben" },
  bord: { variant: "skivans material och färg, benens eller underredets material och färg, och storlek eller om bordet är utdragbart", matt: "längd, bredd, höjd", delar: "bordsskiva och ben" },
  säng: { variant: "ramens material och färg, huvudgavelns klädsel och färg, och storlek", matt: "längd, bredd, höjd", delar: "stomme och huvudgavel" },
  annat: { variant: "färg, material och yta, och storlek om modellen finns i flera", matt: "bredd, djup, höjd", delar: "de viktigaste delarna" },
};
/**
 * DJUP, KRITISK RESEARCH (2026-11-04, på säljarens begäran; prompten ändrades först då). Den förra formen gav för Sits Impulse nypris 5 990 kr (länk till en butikssida, inte tillverkarens) och vid
 * andra körningar 7 490 och 10 390 kr: AI-läget tog första träffen, ofta ett "från"-pris, ett annat tyg eller en annan möbel med samma namn. Den här formen ber om samma saker som en researcher
 * gör: tillverkarens sida först, minst två svenska återförsäljare, kontroll av att sidan gäller RÄTT märke, pris för just varianten (inte "från", rea eller annan storlek), en andra kontroll av
 * misstänkta belopp, och "okänt" i stället för en gissning. Nyprisets belopp är ETT tal (servern tar det högre om svaret anger ett spann, externalIdentify.ts), och raderna Prisunderlag och Säkerhet
 * låter säljaren och oss se vad priset vilar på. Mått och material får fortfarande uppskattas (märkta "uppskattat"), nypriset aldrig.
 */
export const SPEC_PROMPT = (brand: string | null | undefined, model: string, type: string | null | undefined): string => {
  const namn = `${brand ? brand + " " : ""}${model}`;
  const ord = type ? TYP_ORD[type] : null;
  const m = (type && TYP_MATT[type]) || TYP_MATT.annat;
  return (
    `Anta att ${(ord ? ord.def : "Möbeln").toLowerCase()} på bilderna är ${namn}. Gör en djup och kritisk research innan du svarar, som en noggrann researcher som aldrig nöjer sig med första bästa träff: ett fel pris eller fel mått är värre än att skriva att något är okänt.\n` +
    `1. Variant: titta noga på bilderna och avgör vilken EXAKT variant av ${namn} det är: ${m.variant}. Välj EN variant, den som stämmer bäst med bilderna, och skriv aldrig en lista över möjliga utföranden, tyger eller färger.\n` +
    `2. Källor: börja med tillverkarens egen produktsida för ${namn} och kontrollera sedan minst två svenska återförsäljare eller prislistor som säljer just den modellen. Kontrollera på varje sida att produkten verkligen är ${namn}${brand ? ` från ${brand}` : ""} och inte en annan möbel med samma eller liknande namn från ett annat märke eller en butiks eget märke. Använd aldrig begagnatsajter som Tradera, Blocket eller Facebook som källa till nypriset.\n` +
    "3. Nypris: leta upp priset för just den variant du valt (rätt storlek, klädsel eller tyggrupp och ben), inte ett \"från\"-pris för modellens billigaste utförande, inte ett rea-, kampanj- eller outletpris, inte priset på en annan storlek eller ett annat tyg och inte priset på en tillbehörsdel. Kostar modellens utföranden olika mycket, ta reda på modellens prisspann och placera din variant rätt i det innan du väljer belopp. Verkar ett pris för lågt eller för högt jämfört med modellens övriga utföranden eller med jämförbara möbler, kontrollera det i en annan källa innan du skriver det.\n" +
    "4. Väg källorna mot varandra: stämmer de inte överens, lita mest på tillverkarens egen sida, därefter återförsäljare som anger exakt utförande, och skriv vilka belopp som skilde sig och varför du valde som du gjorde. Kan du inte styrka ett pris för just den varianten skriver du okänt i stället för att gissa.\n" +
    "Svara sedan med de här raderna:\n" +
    "Variant: variantens namn, tyg eller yta och färg\n" +
    `Mått i cm: ${m.matt} för just den varianten\n` +
    `Material: ${m.delar} för just den varianten\n` +
    "Nypris: ETT belopp i kronor för just den varianten (aldrig ett spann), med årtal om modellen är utgången, eller okänt\n" +
    "Prisunderlag: de priser du jämförde (källa och belopp) och varför du valde just det\n" +
    "Länk: adressen till sidan som nyprisets belopp kommer från (tillverkarens eller en återförsäljares produktsida)\n" +
    "Säkerhet: hög, medel eller låg för varianten, måtten och priset var för sig, och en mening om vad som är osäkert\n" +
    'Mått och material som inte står i någon källa får du uppskatta utifrån varianten och bilderna, och skriver då "uppskattat". Nypriset får aldrig uppskattas.'
  );
};


/**
 * UNDERTYPEN ("barstol") en modell har i AI-lägets svar, ur raderna om just den modellen: samma namn kan vara två möbler (IKEA NORDVIKEN är både matstol och barstol), och en bildsökning efter
 * "IKEA NORDVIKEN stol" gav matstolens bild åt barstolen (2026-11-03). Samma regel som servern (externalImages.ts, undertypForKandidat); stämmer de inte överens söks bilden på nytt, aldrig fel.
 */
export function undertypUr(answer: string, name: string): "barstol" | null {
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!esc) return null;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${esc}([^\\p{L}\\p{N}]|$)`, "iu");
  const rader = String(answer).split("\n");
  const egna: string[] = [];
  rader.forEach((l, i) => {
    if (egna.length >= 3 || !re.test(l) || /^\s*(länk|link|https?:)/i.test(l)) return;
    egna.push(l);
    if (l.length < 80 && rader[i + 1]) egna.push(rader[i + 1]);
  });
  return /barstol|bar stool|barstool|counter stool|counter height|bänkhöjd|bankhojd|bar chair|barkrakk/i.test(egna.join(" \n ")) ? "barstol" : null;
}
