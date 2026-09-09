import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CardDamage, ListingAttribute, ListingViewData } from "../types";
import { formatSek } from "../lib/price";
import { severityLabel, typeLabel } from "../lib/labels";
import { brandLook, brandTypeStyle } from "../lib/brandLook";
import { archetypeFor, buildModel, parseDimensions, zoneForPart } from "../lib/furnitureModel";
import GradeBadge from "./GradeBadge";
import { ChevronRight } from "./icons";
import FurnitureRender, { type RenderPin } from "./FurnitureRender";
import ListingChat from "./ListingChat";
import { useT } from "../lib/i18n";

/** Så länge omslaget får hänga innan tystnaden räknas som ett nej. */
const COVER_TIMEOUT_MS = 12_000;

/**
 * Annonsen.
 *
 * Kortet såg tidigare ut som en rapport: rubrik, faktarutor, listor. Men det ÄR en annons — det är
 * vad säljaren publicerar — och en möbel säljs på att se ut som en produkt någon vill ha. Därför
 * ligger den nu som ett produktkort: bild överst, namn, pris, specifikationer, beskrivning.
 *
 * Skillnaden mot en annons för en NY möbel är att skicket står med, och det är hela poängen med
 * Loopa: en begagnad möbel presenterad lika helt som en ny, med skadorna utsatta i stället för
 * bortretuscherade. Skickrapporten är stället där de två sakerna möts — säljarens EGNA bilder, med
 * varje anmärkning inringad på det foto den syns i.
 *
 * Vyn tar EXPLICITA props och inte ett ConditionResult, för att kortet ritas på två ställen: hos
 * säljaren, som äger jobbet, och publikt, där kortet slås upp på sitt Loopa-ID av någon som inte har
 * något konto hos oss. Det publika svaret bär mindre (se server/src/publicCard.ts) — men det ska vara
 * SAMMA kort, inte en förenklad kopia som kan börja säga något annat.
 */
/** Kortets delar, var för sig. Se `only` nedan. */
export type ListingSection = "cover" | "specs" | "condition" | "about" | "chat";

export default function ListingView({
  card,
  identity,
  grade,
  price,
  damages,
  /* `imageCount` och `reviewed` kommer med i ListingViewData men plockas inte ut här längre: de bar
     raden "12 vyer · två besiktningar" under betyget, som är siffror ur vår process och inte ur
     möbeln. Fälten ligger kvar i typen — servern skickar dem, och adminvyn läser dem. */
  productImage,
  cover,
  bilder,
  loopaId,
  hideHeader = false,
  hideSources = false,
  collapsible = false,
  onSaveListing,
  only,
}: ListingViewData & {
  /**
   * Kortets publika ID. Enda extra propen, och den finns bara för chatten: den frågar servern på
   * ID:t, som är det enda boten behöver för att se exakt samma kort som läsaren.
   *
   * Valfri, eftersom säljarens kort ritas i samma ögonblick jobbet blir klart och ID:t kan ha
   * kommit från ett äldre jobbsvar som inte bar det. Då står kortet utan chatt, i stället för med
   * en ruta som svarar 404.
   */
  loopaId?: string;
  /**
   * Vilka delar som ska ritas, och i vilken ordning anroparen vill ha dem.
   *
   * Kortet är en färdig sida på /c/LP-… och i säljflödet — där ritas allt, i den ordning som står
   * nedan. Butikens produktsida behöver samma delar men utspridda i två kolumner, med köpsektionen
   * och måtten emellan. Utan det här hade den fått en egen kopia av skickrapporten, och då finns
   * möbelns skick beskrivet på två ställen som kan glida isär — vilket är precis det kortet finns
   * för att förhindra.
   *
   * Utelämnat = allt, i kortets egen ordning. Anges `only` faller layoutlådorna bort (se
   * `listing-bare`) så att delarna blir syskon i anroparens rutnät.
   */
  only?: ListingSection[];
  /**
   * Utelämnar kortets egen rubrik och prisruta.
   *
   * Finns för butikens produktsida, som ÄR det här kortet men med ett köp runt omkring: den visar
   * märke, namn och pris i sin egen ingress ovanför, med en köpknapp intill. Utan flaggan står
   * möbelns namn och pris två gånger på samma sida, och de två prisrutorna dessutom med olika ord —
   * "2 633 kr" i butiken och "Marknadsvärde för skicket" här. Två priser på samma möbel är en fråga
   * köparen inte ska behöva ställa.
   *
   * Falskt överallt annars: säljarens eget kort och det publika kortet på /c/LP-XXXX-XXXX har ingen
   * ingress ovanför sig och måste bära sin rubrik själva.
   */
  hideHeader?: boolean;
  /**
   * Utelämnar källänkarna vid specifikationerna och under omslaget.
   *
   * BUTIKEN ÄR EN BUTIK, INTE EN REDOVISNING. Ett "källa" efter varje mått läser som fotnoter i en
   * utredning — och den som handlar möbler läser dem som att butiken inte själv står för uppgiften.
   * Ingen möbelhandlare fotnotar sitt sitthöjdsmått; de skriver måttet, och tar ansvar för det.
   *
   * Uppgifterna är desamma och `sourceUrl` följer orört med i svaret: det som faller bort är länken,
   * inte belägget. "Uppskattat" står kvar — det är en reservation om vad vi VET, inte en hänvisning
   * till någon annan, och att tiga om den vore att påstå mer än vi kan.
   *
   * Falskt överallt annars. Säljarens eget kort och det publika kortet på /c/LP-XXXX-XXXX ÄR en
   * redovisning — där är källan halva poängen, för läsaren kontrollerar oss.
   */
  hideSources?: boolean;
  /**
   * Sektionerna som hopfällbara rader i stället för utfällda kort.
   *
   * SÄLJARENS SKÄRM, och bara den. Det säljaren gör här är att godkänna en annons och trycka på
   * "Sälj med Loopa" — och den knappen låg tre skärmhöjder ned, bakom skickrapporten, beskrivningen
   * och specifikationerna. Fällda rader gör hela beslutet synligt på en skärm, och den som vill
   * granska en del fäller ut den.
   *
   * INTE på det publika kortet (/c/LP-XXXX-XXXX). Den sidan finns för att en köpare ska kunna
   * kontrollera ett skickpåstående, och en rapport vars bevis kräver ett klick läser som ett
   * påstående igen — samma skäl som står vid skadefotona nedan. Inte heller i butiken, som redan
   * placerar sektionerna själv med `only`.
   *
   * Innehållet är detsamma i båda lägena. Det enda som skiljer är om raden börjar öppen.
   */
  collapsible?: boolean;
  /**
   * Säljarens rättelser: måtten och beskrivningen skrivs tillbaka härifrån.
   *
   * ALLT PÅ KORTET ÄR MASKINELLT FRAMTAGET — måtten ur en sidskörd eller uppskattade för möbeltypen,
   * texten ur en generator — och den enda som VET är personen som står bredvid möbeln. Utan en väg
   * att rätta är deras enda val att publicera något de vet är fel, eller att låta bli att sälja.
   *
   * Skicket rättas inte här. Det har sin egen väg på skickskärmen, där en ändring kan backas av ett
   * foto och räknas om i betyget (se ResultScreen och pipeline/dispute.ts) — en skada är ett
   * påstående om möbeln, inte en uppgift om den, och de två tål inte samma sorts redigering.
   *
   * Utelämnad = ingen redigering. Så ser det publika kortet och butiken ut: där är uppgifterna
   * någon annans, och en penna vore ett löfte som inte går att infria.
   */
  onSaveListing?: (patch: {
    attributes?: ListingAttribute[];
    description?: string;
    conditionText?: string;
  }) => Promise<void>;
}) {
  const t = useT();
  const [selected, setSelected] = useState<string | null>(null);

  /**
   * Redigeringen: vilken sektion som står öppen, och utkastet i den.
   *
   * UTKASTET ÄR EN KOPIA, inte kortets egna fält. Skriver man direkt i `card` ändras annonsen medan
   * man skriver, och "Avbryt" har då ingenting att gå tillbaka till. Kopian tas när rutan öppnas och
   * skickas i sin helhet när man sparar; svaret från servern blir det nya kortet.
   */
  const [redigerar, setRedigerar] = useState<null | "about" | "specs">(null);
  const [sparar, setSparar] = useState(false);
  const [sparfel, setSparfel] = useState<string | null>(null);
  const [utkastText, setUtkastText] = useState({ description: "", conditionText: "" });
  const [utkastAttr, setUtkastAttr] = useState<ListingAttribute[]>([]);

  const oppnaText = () => {
    setSparfel(null);
    setUtkastText({
      description: card.listing.description ?? "",
      conditionText: card.listing.conditionText ?? "",
    });
    setRedigerar("about");
  };
  const oppnaAttr = () => {
    setSparfel(null);
    setUtkastAttr(card.attributes.map((a) => ({ ...a })));
    setRedigerar("specs");
  };
  const spara = async (patch: Parameters<NonNullable<typeof onSaveListing>>[0]) => {
    if (!onSaveListing) return;
    setSparar(true);
    setSparfel(null);
    try {
      await onSaveListing(patch);
      setRedigerar(null);
    } catch (e) {
      setSparfel(e instanceof Error ? e.message : t("Ändringen kunde inte sparas."));
    } finally {
      setSparar(false);
    }
  };

  /**
   * Omslaget är MÖBELN SOM SÄLJS: säljarens egen bild framifrån, med rummet bortklippt och bakgrunden
   * vit (server: pipeline/cutout.ts).
   *
   * Här stod förut tillverkarens katalogbild. Den svarade snabbt på "vad är det här?" — men den visade
   * en NY exemplar av modellen ovanför ett pris som gäller en begagnad. På ett kort som annars räknar
   * upp varje skråma var bilden det enda påståendet som var hämtat någon annanstans ifrån. Urklippet
   * gör samma jobb utan att byta möbel: vit bakgrund, möbeln centrerad, ingenting av rummet kvar.
   *
   * Kandidaterna står i fallande sanning: urklippet, säljarens bildruta som den togs — den skickas bara
   * till säljarens eget kort, se ListingScreen — och sist katalogbilden av modellen.
   *
   * OMSLAGET ÄR ETT FOTO, eller ingenting alls. Här stod förut en 3D-figur som reserv; den läste som
   * en produktbild men visade en möbel som aldrig fotograferats, och kortets första och största
   * påstående blev då en ritning. Figuren är borta helt — skadorna visas numera på säljarens egna
   * bilder längre ned, vilket är det enda stället där en bild av möbeln kan bevisa något.
   */
  const candidates = useMemo(() => {
    /**
     * SÄLJARENS EGEN MÖBEL FÖRST — men bara när den är urklippt.
     *
     * Ordningen har vänt två gånger och skälet är samma varje gång: omslaget ska vara den bästa
     * bilden AV MÖBELN SOM SÄLJS, och vilken det är beror på vad vi lyckats göra.
     *
     * Är `cover` ett urklipp (`cutout`) är den vinnaren utan konkurrens: rätt möbel, rätt slitage,
     * rätt färg, mot rent vitt precis som varje annan produktbild man handlar efter. Är den en orörd
     * bildruta (`photo`) — alltså ett vardagsrum med en soffa i — går katalogbilden före, för den
     * ser ut som en möbel man köper. Att den visar en NY exemplar sägs rakt ut i bildtexten under,
     * och det är det som gör den ordningen försvarlig i stället för smickrande.
     */
    const list: Array<{ url: string; kind: "cutout" | "photo" | "product"; sourceUrl?: string | null }> = [];
    if (cover?.kind === "cutout") list.push(cover);
    if (productImage) list.push({ ...productImage, kind: "product" });
    if (cover && cover.kind !== "cutout") list.push(cover);
    return list;
  }, [cover, productImage]);

  /**
   * Adresserna som visat sig inte bära en bild — de hoppas över, och nästa kandidat får försöka.
   *
   * En bild kan falla på två sätt. Den kan säga ifrån: katalogbilden ligger på en annan sajt än vi, och
   * den kan svara 404 eller neka hotlinking. Värre är att den kan TIGA — en hängande hämtning mot ett
   * långsamt CDN ger varken `onload` eller `onerror`, och webbläsaren väntar bara vidare, i minuter,
   * utan tidsgräns att erbjuda. Därför tidsgränsen nedan: efter den räknas tystnaden som ett nej.
   *
   * Förut ledde båda fallen till renderingen. Nu leder de till nästa foto, och finns inget sådant blir
   * det inget omslag — kortet börjar i stället på namnet.
   */
  const [dead, setDead] = useState<string[]>([]);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const shown = candidates.find((c) => !dead.includes(c.url)) ?? null;

  useEffect(() => {
    const url = shown?.url;
    if (!url || loadedUrl === url) return;
    const id = setTimeout(() => setDead((d) => (d.includes(url) ? d : [...d, url])), COVER_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [shown?.url, loadedUrl]);

  /**
   * Annonsens galleri, eller tom lista när det inte finns någon bläddring att göra.
   *
   * BARA NÄR OMSLAGET ÄR URKLIPPET. Är det som visas katalogbilden eller säljarens orörda bildruta
   * har servern antingen inte lämnat något galleri, eller så har omslagets adress fallit här i vyn
   * — och i båda fallen vore en bläddring en rad miniatyrer under en bild som inte hör till dem.
   *
   * En ensam bild räknas inte som ett galleri: prickar och bläddring under EN bild lovar något som
   * inte finns.
   */
  const galleri = useMemo(() => {
    if (shown?.kind !== "cutout") return [];
    const kvar = (bilder ?? []).filter((b) => !dead.includes(b.url));
    return kvar.length > 1 ? kvar : [];
  }, [bilder, shown?.kind, dead]);

  /**
   * Vilken bild bläddringen står på. Läses UR remsan och styr den inte.
   *
   * Bläddringen är webbläsarens egen — `scroll-snap`, alltså ett svep på en telefon och ett drag med
   * styrplattan på en dator, precis som varje annan bildkarusell användaren mött. Vyn räknar bara ut
   * var den hamnade, för prickarna och bildtexten. Att i stället styra remsan från React hade
   * inneburit att återuppfinna tröghet och fingersläpp, och göra dem sämre.
   */
  const remsa = useRef<HTMLDivElement | null>(null);
  const [aktiv, setAktiv] = useState(0);
  const vidRullning = () => {
    const el = remsa.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    setAktiv(Math.max(0, Math.min(galleri.length - 1, i)));
  };

  /**
   * Tillbaka till första bilden när kortet byter möbel.
   *
   * Butiken är en enda sida som byter innehåll, så vyn lever vidare mellan två produkter. Utan det
   * här stod bläddringen kvar på bild fyra för en möbel som har två — med en bildtext som beskrev en
   * bild ingen tittade på, och en markerad miniatyr som inte fanns.
   */
  const galleriNyckel = galleri.map((b) => b.url).join("|");
  useEffect(() => {
    setAktiv(0);
    remsa.current?.scrollTo({ left: 0 });
  }, [galleriNyckel]);

  const name = card.identity.exactProduct ?? card.identity.variant ?? identity?.model ?? t("Möbel");
  const brand = card.identity.brand ?? identity?.brand ?? null;

  /**
   * Anmärkningarna som HAR ett foto, med sitt nummer ur listan.
   *
   * Numret räknas ur `damages` och inte ur den filtrerade listan: rad 3 i skickrapporten ska heta 3
   * i bilden även när rad 2 saknar bevisruta. En skada utan foto står kvar i listan — den är sann
   * ändå — men har ingenting att visa i galleriet.
   */
  const fotade = useMemo(
    () => damages.map((d, i) => ({ d, nummer: i + 1 })).filter((x) => x.d.bild),
    [damages],
  );

  const retail = card.pricing.retailPriceSek;
  const now = price?.status === "ok" ? price.default : null;

  const show = (section: ListingSection) => !only || only.includes(section);

  return (
    // `listing-bare` gör lådorna genomskinliga för layouten (display: contents), så delarna hamnar
    // direkt i anroparens rutnät i stället för i kortets egen kolumn.
    <article className={only ? "listing listing-bare" : `listing ${collapsible ? "listing-kompakt" : ""}`}>
      {show("cover") && shown && (
        /* Bilden och dess härkomst är EN sak, och hålls ihop av ett element: på datorvyn är
           kolumnen ett rutnät, och två syskon hade lagt bildtexten i en egen rad långt under. */
        <div className="listing-cover-block">
          <div
            className={`listing-stage listing-stage-photo ${
              shown.kind === "cutout" ? "listing-stage-cutout" : ""
            }`}
          >
            {grade && (
              <span className="listing-stage-badge">
                <GradeBadge grade={grade.grade} size={26} />
                {grade.canonicalCondition}
              </span>
            )}
            {galleri.length > 1 ? (
              /* Bläddringen. Se `galleri` och `remsa` ovan för varför den är webbläsarens egen. */
              <div className="listing-carousel" ref={remsa} onScroll={vidRullning}>
                {galleri.map((b, i) => (
                  <img
                    key={b.url}
                    className="listing-cover"
                    src={b.url}
                    alt={i === 0 ? name : t("{namn}, bild {nr}", { namn: name, nr: String(i + 1) })}
                    /* Bara första bilden hämtas direkt: resten ligger utanför rutan tills någon
                       bläddrar, och fem kvadrater på 1600 px är en halv megabyte var. */
                    loading={i === 0 ? "eager" : "lazy"}
                    decoding="async"
                    onLoad={() => i === 0 && setLoadedUrl(b.url)}
                    onError={() => setDead((d) => (d.includes(b.url) ? d : [...d, b.url]))}
                  />
                ))}
              </div>
            ) : (
              <img
                key={shown.url}
                className="listing-cover"
                src={shown.url}
                alt={name}
                onLoad={() => setLoadedUrl(shown.url)}
                onError={() => setDead((d) => (d.includes(shown.url) ? d : [...d, shown.url]))}
              />
            )}
          </div>
          {galleri.length > 1 && (
            /*
              Miniatyrerna, och de är KNAPPAR och inte prickar.
              En rad prickar säger hur många bilder som finns; miniatyrer säger vad de visar. På en
              annons där bild två är ryggen och bild tre är en fläck på sitsen är det skillnaden
              mellan att bläddra och att leta. De fungerar dessutom som prickarna gjorde — den
              aktiva är markerad — så ingenting är förlorat.
            */
            <div className="listing-thumbs" role="tablist" aria-label={t("Bilder av möbeln")}>
              {galleri.map((b, i) => (
                <button
                  key={b.url}
                  type="button"
                  role="tab"
                  aria-selected={i === aktiv}
                  aria-label={t("Bild {nr}", { nr: String(i + 1) })}
                  className={`listing-thumb ${i === aktiv ? "is-active" : ""}`}
                  onClick={() =>
                    remsa.current?.scrollTo({ left: i * remsa.current.clientWidth, behavior: "smooth" })
                  }
                >
                  <img src={b.url} alt="" loading="lazy" decoding="async" />
                </button>
              ))}
            </div>
          )}
          {/* Vad bilden är, sagt rakt ut.
              Bildrutan: säljarens egen bild, orörd. Att den ÄR orörd är en uppgift och inte en
              självklarhet — kortet påstår att det redovisar möbeln som den är, och då ska det stå
              vad bilden har varit med om. Ingen väg sätter "cutout" utan att produktbildssystemet
              lyckats och kvalitetskontrollen godkänt resultatet; annars är omslaget bildrutan och
              texten säger det.
              Katalogbilden: den visar inte ens möbeln som säljs, och då ska det stå — inte antas. */}
          {shown.kind === "photo" && (
            <p className="listing-cover-note">{t("Säljarens egen bild av möbeln, orörd")}</p>
          )}
          {/*
              Urklippet: möbeln är säljarens egen, men bakgrunden är VÅR, och ett kort som räknar upp
              varje skråma får inte tiga om att det rört bilden. Texten skiljer på de två sakerna vi
              gör, för de är olika stora: på galleriets bilder är rummet BORTTAGET och ersatt med
              vitt, medan annonsens första bild dessutom står i en studio vi själva låtit generera.
              Att kalla båda "bakgrunden borttagen" hade varit sant om den ena och tyst om den andra.
          */}
          {shown.kind === "cutout" && (
            <p className="listing-cover-note">
              {aktiv === 0 && cover?.backdrop
                ? t("Säljarens egen bild av möbeln, mot vår studiobakgrund")
                : t("Säljarens egen bild av möbeln, bakgrunden borttagen")}
            </p>
          )}
          {shown.kind === "product" && (
            <p className="listing-cover-note">
              {t("Produktbild av modellen — inte möbeln som säljs")}
              {shown.sourceUrl && !hideSources && (
                <>
                  {" · "}
                  <a href={shown.sourceUrl} target="_blank" rel="noreferrer">
                    {t("källa")}
                  </a>
                </>
              )}
            </p>
          )}
        </div>
      )}

      <div className={only ? "listing-facts listing-bare" : "listing-facts"}>
        {/* `only` betyder exakt de delar som räknas upp — rubriken och prisrutan är inga av dem.
            Utan villkoret ritade butikens produktsida namnet och priset en gång per anropad sektion:
            fem rubriker och fem priser på samma möbel. */}
        {!hideHeader && !only && (
        <header className="listing-head">
          {brand && (
            <div className="listing-brand" style={brandTypeStyle(brandLook(brand).type)}>
              {brand}
            </div>
          )}
          <h1 className="listing-name">{name}</h1>
          <p className="listing-variant">
            {[card.identity.category, card.identity.variant].filter(Boolean).join(" · ") || "—"}
          </p>
        </header>
        )}

        {!hideHeader && !only && (
        <div className="listing-price">
          <div className="listing-price-row">
            <span className="listing-price-now">{now !== null ? formatSek(now) : "Inget prisförslag"}</span>
            {/* Nypriset står med av samma skäl som i en annons för en ny möbel: det är referensen som
                gör priset läsbart. Det VÄRDERAR inte möbeln — prisförslaget kommer från prismotorns
                annonskorpus och har redan skickavdraget inräknat. */}
            {/* Procenten är borttagen. Nypriset står kvar och gör samma jobb — den som ser
                24 900 kr överstruket bredvid 8 400 kr behöver ingen som räknar ut skillnaden åt sig,
                och ett rabattmärke i accentfärg drar dessutom blicken från priset det ska förklara. */}
            {retail && now && retail > now && (
              <span className="listing-price-was">{formatSek(retail)}</span>
            )}
          </div>
          <p className="listing-price-note">
            {price?.status === "ok"
              ? price.damageDeduction
                ? /* ANDEL, inte kronor. Prismotorn svarar med en kvot (0,22 = 22 %) och skalar hela
                     intervallet med den. formatSek på den kvoten gav "0 kr" — kortet påstod alltså
                     noll avdrag på just de möbler där avdraget var som störst. */
                  t("Marknadsvärde för skicket, efter {andel} % avdrag för skadorna.", {
                    andel: Math.round(price.damageDeduction * 100),
                  })
                : t("Marknadsvärde för skicket, från jämförbara annonser.")
              : (price?.unavailableReason ?? t("Prismotorn kunde inte nås."))}
          </p>
        </div>
        )}

        {show("about") && (
        /*
          BESKRIVNINGEN, UTAN RUBRIK OCH DIREKT UNDER PRISET.
          Så står den i varje annons som är värd att läsa: man ser möbeln, ser vad den kostar, och
          läser sedan om den. Här låg den sist av allt, under en etikett som stod "OM MÖBELN" —
          en rubrik som bara säger vad texten under den uppenbarligen är.

          ANNONSENS EGEN RUBRIK stod dessutom först i blocket, i fetstil, ovanför beskrivningen. Den
          är en andra rubrik på ett kort som redan har en: möbeln heter något i huvudet, och det
          namnet står överst. Rubriken som faktiskt publiceras ser säljaren i bekräftelsen, där den
          betyder något (se SellWithLoopa).
        */
        <Block collapsible={collapsible} titel={t("Beskrivning")} className="listing-about">
          {redigerar === "about" ? (
            <div className="listing-edit">
              <label className="listing-edit-falt">
                <span>{t("Beskrivning")}</span>
                <textarea
                  rows={9}
                  value={utkastText.description}
                  onChange={(e) => setUtkastText((v) => ({ ...v, description: e.target.value }))}
                />
              </label>
              {/* Skicktexten står som eget fält. Den är annonsens mening om slitaget och den enda
                  text på kortet som säger något om möbelns skick i ord — klumpas den ihop med
                  beskrivningen försvinner den för den som bara vill rätta en mening om färgen. */}
              <label className="listing-edit-falt">
                <span>{t("Om skicket")}</span>
                <textarea
                  rows={3}
                  value={utkastText.conditionText}
                  onChange={(e) => setUtkastText((v) => ({ ...v, conditionText: e.target.value }))}
                />
              </label>
              <EditFot
                sparar={sparar}
                fel={sparfel}
                onAvbryt={() => setRedigerar(null)}
                onSpara={() => void spara({ description: utkastText.description, conditionText: utkastText.conditionText })}
              />
            </div>
          ) : (
            <>
              <p className="card-listing-body">{card.listing.description}</p>
              {card.listing.conditionText && <p className="card-listing-condition">{card.listing.conditionText}</p>}
              {onSaveListing && (
                <button type="button" className="listing-edit-knapp" onClick={oppnaText}>
                  {t("Ändra texten")}
                </button>
              )}
            </>
          )}
        </Block>
        )}

        {show("condition") && (
        <Block
          collapsible={collapsible}
          titel={t("Skick")}
          rubrik={t("Skick")}
          /* Sammanfattningen på den fällda raden. Betyget och antalet — det är de två talen man
             öppnar rapporten för att se, och står de redan i raden slipper många öppna den. */
          sammanfattning={[
            grade?.label,
            damages.length === 1
              ? t("{antal} anmärkning", { antal: damages.length })
              : t("{antal} anmärkningar", { antal: damages.length }),
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <div className="listing-condition-head">
            {grade && <GradeBadge grade={grade.grade} size={44} />}
            <div>
              <div className="card-verdict-label">{grade?.label ?? "—"}</div>
              {/* ANTALET, och inget mer. Här stod "· 12 vyer · två besiktningar" också — sant,
                  men det är siffror ur vår process, och de gjorde raden till en revisionsnotering
                  mitt i en annons. Den som vill veta hur noga vi tittat ser resultatet under: varje
                  anmärkning med sitt foto. */}
              <div className="muted small">
                {damages.length === 1
                  ? t("{antal} anmärkning", { antal: damages.length })
                  : t("{antal} anmärkningar", { antal: damages.length })}
              </div>
            </div>
          </div>
          {/*
            SKADORNA PÅ SÄLJARENS EGNA BILDER.
            Här stod förut en 3D-figur med anmärkningarna som numrerade nålar. Den var en karta över
            en möbel vi ritat själva — proportionerna kom från måtten, ytan från ingenting — och en
            läsare som vill veta hur stor repan är får inget svar av en nål på en teckning. Fotot där
            skadan syns, med den inringad, svarar direkt och är dessutom det enda vi kan belägga.

            Alltid synliga, inte gömda bakom ett klick: bilderna ÄR skickrapporten, och en rapport
            vars bevis kräver att man letar läser som ett påstående. Rutnätet håller dem små och
            lika stora — en vald bild fäller ut sig i full bredd för den som vill se närmare.
          */}
          {fotade.length > 0 && (
            <div className="listing-damage-photos">
              {fotade.map(({ d, nummer }) => (
                <SkadeFoto
                  key={d.id}
                  bild={d.bild!}
                  nummer={nummer}
                  titel={`${typeLabel(d.type)} — ${d.part}`}
                  vald={selected === d.id}
                  onValj={() => setSelected(selected === d.id ? null : d.id)}
                />
              ))}
            </div>
          )}
          {damages.length === 0 ? (
            <p className="muted small listing-no-damage">{t("Inspektionen hittade inga synliga skador.")}</p>
          ) : (
            <ol className="pin-list">
              {damages.map((d, i) => {
                const active = selected === d.id;
                return (
                  <li key={d.id}>
                    <button
                      type="button"
                      className={`pin-row ${active ? "pin-row-active" : ""}`}
                      onClick={() => setSelected(active ? null : d.id)}
                      aria-pressed={active}
                    >
                      {/* Grått nummer = anmärkningen har ingen bevisruta, och står alltså inte i
                          galleriet ovanför. Att den syns i listan ändå är avsiktligt: en skada som
                          försvinner för att fotot fattas är en skada vi tigit om. */}
                      <span className={`pin-num ${d.bild ? "" : "pin-num-unplaced"}`}>{i + 1}</span>
                      <span className="pin-body">
                        <span className="pin-title">
                          {typeLabel(d.type)}
                          <span className="pin-part">{d.part}</span>
                        </span>
                        <span className="pin-desc">{d.description}</span>
                      </span>
                      <span className={`chip chip-${d.severity}`}>{severityLabel(d.severity)}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          {fotade.length > 0 && (
            <p className="listing-pin-note">
              {t("Säljarens egna bilder, orörda så när som på markeringen.")}
            </p>
          )}
        </Block>
        )}

        {/* `|| onSaveListing`: en möbel där generatorn inte hittade ett enda mått är precis den som
            mest behöver att säljaren kan skriva in dem. Utan den här halvan fanns ingen sektion att
            öppna, och "lägg till uppgift" gick inte att nå. */}
        {show("specs") && (card.attributes.length > 0 || !!onSaveListing) && (
          <Block collapsible={collapsible} titel={t("Mått och material")} rubrik={t("Specifikationer")}>
            {redigerar === "specs" ? (
              <div className="listing-edit">
                <div className="listing-edit-rader">
                  {utkastAttr.map((a, i) => (
                    /* Nyckeln är RADENS PLATS och inte dess innehåll: etiketten är ett fält man
                       skriver i, och en nyckel som ändras vid varje tangenttryck monterar om
                       inmatningen och tappar markören. */
                    <div className="listing-edit-rad" key={i}>
                      <input
                        className="listing-edit-etikett"
                        value={a.label}
                        placeholder={t("Uppgift")}
                        aria-label={t("Uppgift")}
                        onChange={(e) =>
                          setUtkastAttr((v) => v.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                        }
                      />
                      <input
                        className="listing-edit-varde"
                        value={a.value}
                        placeholder={t("Värde")}
                        aria-label={t("Värde")}
                        onChange={(e) =>
                          setUtkastAttr((v) => v.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
                        }
                      />
                      <button
                        type="button"
                        className="listing-edit-bort"
                        aria-label={t("Ta bort raden")}
                        onClick={() => setUtkastAttr((v) => v.filter((_, j) => j !== i))}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="listing-edit-lagg"
                  onClick={() => setUtkastAttr((v) => [...v, { key: "", label: "", value: "" }])}
                >
                  + {t("Lägg till uppgift")}
                </button>
                <EditFot
                  sparar={sparar}
                  fel={sparfel}
                  onAvbryt={() => setRedigerar(null)}
                  /* Tomma rader skickas inte med. Servern kastar dem också, men en rad man lämnat
                     tom ska försvinna för att man lämnade den tom — inte för att servern städade. */
                  onSpara={() =>
                    void spara({ attributes: utkastAttr.filter((a) => a.label.trim() && a.value.trim()) })
                  }
                />
              </div>
            ) : (
              <>
                <dl className="listing-specs">
                  {card.attributes.map((a) => (
                    <div key={a.key + a.label} className="listing-spec">
                      <dt>{a.label}</dt>
                      <dd>
                        {a.value}
                        {/* Härkomsten, i fallande ordning av vad den binder oss vid: säljarens egen
                            uppgift går först, för den ersätter både källan och uppskattningen — se
                            `sellerEdited` i types.ts. */}
                        {a.sellerEdited ? (
                          <span className="card-est">
                            {onSaveListing ? t("angivet av dig") : t("angivet av säljaren")}
                          </span>
                        ) : a.sourceUrl && !hideSources ? (
                          <a className="card-src" href={a.sourceUrl} target="_blank" rel="noreferrer">
                            {t("källa")}
                          </a>
                        ) : (
                          // Uppskattningen står på källänkens plats, i grått och utan länk — det finns
                          // ingen sida att gå till, och det är hela poängen med märkningen.
                          a.estimated && <span className="card-est">{t("uppskattat")}</span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
                {onSaveListing && (
                  <button type="button" className="listing-edit-knapp" onClick={oppnaAttr}>
                    {card.attributes.length ? t("Ändra uppgifterna") : t("Fyll i mått och material")}
                  </button>
                )}
              </>
            )}
          </Block>
        )}

        {/* Sist, efter allt som går att läsa. Frågor uppstår när man läst skicket och beskrivningen —
            en chatt placerad före dem hade bjudit in till att fråga om det som stod två rader ned. */}
        {show("chat") && loopaId && (
          <ListingChat
            loopaId={loopaId}
            name={name}
            damageCount={damages.length}
            specLabels={card.attributes.map((a) => a.label)}
            hasPrice={price?.status === "ok" && price.default !== null}
          />
        )}
      </div>
    </article>
  );
}


/**
 * Foten i en redigeringsruta: felet, avbryt och spara.
 *
 * SPARA ÄR EN FYLLD KNAPP OCH AVBRYT ÄR TEXT, inte tvärtom och inte två likadana. Den som öppnat
 * rutan har redan bestämt sig för att ändra något; att göra "spara" och "avbryt" lika tunga gör ett
 * avslut till ett val mellan två okända.
 *
 * Felet står ÖVER knapparna och inte under. Ett fel under en knapp man just tryckt på hamnar under
 * tummen på en telefon, och den som inte ser det trycker igen.
 */
function EditFot({
  sparar,
  fel,
  onAvbryt,
  onSpara,
}: {
  sparar: boolean;
  fel: string | null;
  onAvbryt: () => void;
  onSpara: () => void;
}) {
  const t = useT();
  return (
    <>
      {fel && <p className="listing-edit-fel">{fel}</p>}
      <div className="listing-edit-fot">
        <button type="button" className="btn btn-text" onClick={onAvbryt} disabled={sparar}>
          {t("Avbryt")}
        </button>
        <button type="button" className="btn btn-primary btn-small" onClick={onSpara} disabled={sparar}>
          {sparar ? t("Sparar…") : t("Spara")}
        </button>
      </div>
    </>
  );
}

/**
 * En sektion på kortet — utfälld ruta eller hopfällbar rad.
 *
 * SAMMA INNEHÅLL I BÅDA LÄGENA, och det är hela villkoret för att den här komponenten får finnas.
 * Skillnaden är om raden börjar öppen, inte vad som står i den. Så fort de två grenarna börjar visa
 * olika saker har kortet två versioner av sanningen, och då är det inte längre ETT kort.
 *
 * `<details>` och inte en egen öppna/stäng-krets: webbläsaren ger tangentbord, skärmläsare och
 * webbläsarens egen sidsökning ("hitta på sidan" hittar in i en stängd details i moderna
 * webbläsare) utan en rad kod, och en accordion byggd på useState gör alla tre sämre.
 */
function Block({
  collapsible,
  titel,
  rubrik,
  sammanfattning,
  className,
  children,
}: {
  collapsible: boolean;
  /** Raden när den är fälld. */
  titel: string;
  /** Rubriken när sektionen står öppen. Utelämnad = ingen rubrik alls, som för beskrivningen. */
  rubrik?: string;
  sammanfattning?: string;
  className?: string;
  children: ReactNode;
}) {
  if (!collapsible) {
    return (
      <section className={`listing-block ${className ?? ""}`}>
        {rubrik && <h3>{rubrik}</h3>}
        {children}
      </section>
    );
  }
  return (
    <details className={`listing-block listing-fold ${className ?? ""}`}>
      <summary>
        <span className="listing-fold-titel">{titel}</span>
        {sammanfattning && <span className="listing-fold-sam">{sammanfattning}</span>}
        <span className="listing-fold-pil" aria-hidden="true">
          <ChevronRight size={16} />
        </span>
      </summary>
      <div className="listing-fold-kropp">{children}</div>
    </details>
  );
}

/**
 * Bildrutan med anmärkningen utmärkt — en ruta i skickrapportens galleri.
 *
 * RUTAN ÄR ANGIVEN I ANDELAR av bilden, så behållaren måste ha bildens EGNA proportion — annars
 * sitter markeringen fel, och en markering som pekar ut fel ställe är sämre än ingen. Därför följer
 * måtten med från servern i stället för att läsas ur bilden när den laddat: en ruta som hoppar på
 * plats en halv sekund efter att bilden dykt upp läser som ett fel.
 *
 * Samma klasser som säljarens egen bevisvy (`marked-thumb`) — det är samma sak som visas, och två
 * uppsättningar stilar för en röd fyrkant hade glidit isär vid första justeringen. Rutan har en
 * FAST höjd och bilden ligger inpassad i den: säljarens bildrutor kommer i olika format, och ett
 * galleri där varje bild är olika hög blir en trasa i stället för en rad.
 *
 * Knapp och inte figur, för att den går att fälla ut: vald ruta tar hela bredden och blir hög nog
 * att läsa skadan i. Det är samma val som raden i listan gör, och de två håller varandra i takt.
 */
function SkadeFoto({
  bild,
  nummer,
  titel,
  vald,
  onValj,
}: {
  bild: NonNullable<CardDamage["bild"]>;
  nummer: number;
  titel: string;
  vald: boolean;
  onValj: () => void;
}) {
  const m = bild.mark;
  return (
    <button
      type="button"
      className={`skadefoto ${vald ? "skadefoto-vald" : ""}`}
      onClick={onValj}
      aria-pressed={vald}
    >
      <span className="marked-thumb skadefoto-ruta">
        <span className="marked-thumb-inner" style={{ aspectRatio: `${bild.width} / ${bild.height}` }}>
          <img src={bild.url} alt={titel} loading="lazy" decoding="async" />
          {m.kind === "box" ? (
            <span
              className="marked-thumb-box"
              style={{
                left: `${m.x * 100}%`,
                top: `${m.y * 100}%`,
                width: `${(m.w ?? 0.1) * 100}%`,
                height: `${(m.h ?? 0.1) * 100}%`,
              }}
            />
          ) : (
            <svg className="marked-thumb-line" viewBox="0 0 100 100" preserveAspectRatio="none">
              <line x1={m.x * 100} y1={m.y * 100} x2={(m.x2 ?? m.x) * 100} y2={(m.y2 ?? m.y) * 100} />
            </svg>
          )}
        </span>
        {/* Numret i hörnet är hela kopplingen till listan under. Utan det är galleriet en hög
            bilder som läsaren själv får para ihop med raderna. */}
        <span className="skadefoto-num">{nummer}</span>
      </span>
      <span className="skadefoto-titel">{titel}</span>
    </button>
  );
}
