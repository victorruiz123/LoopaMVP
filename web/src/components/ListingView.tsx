import { useEffect, useMemo, useState } from "react";
import type { CardDamage, ListingViewData } from "../types";
import { formatSek } from "../lib/price";
import { severityLabel, typeLabel } from "../lib/labels";
import { brandLook, brandTypeStyle } from "../lib/brandLook";
import { archetypeFor, buildModel, parseDimensions, zoneForPart } from "../lib/furnitureModel";
import GradeBadge from "./GradeBadge";
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
  imageCount,
  reviewed,
  productImage,
  cover,
  loopaId,
  hideHeader = false,
  hideSources = false,
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
}) {
  const t = useT();
  const [selected, setSelected] = useState<string | null>(null);

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
  const discount = retail && now && retail > now ? Math.round((1 - now / retail) * 100) : null;

  const show = (section: ListingSection) => !only || only.includes(section);

  return (
    // `listing-bare` gör lådorna genomskinliga för layouten (display: contents), så delarna hamnar
    // direkt i anroparens rutnät i stället för i kortets egen kolumn.
    <article className={only ? "listing listing-bare" : "listing"}>
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
            <img
              key={shown.url}
              className="listing-cover"
              src={shown.url}
              alt={name}
              onLoad={() => setLoadedUrl(shown.url)}
              onError={() => setDead((d) => (d.includes(shown.url) ? d : [...d, shown.url]))}
            />
          </div>
          {/* Vad bilden är, sagt rakt ut.
              Bildrutan: säljarens egen bild, orörd. Att den ÄR orörd är en uppgift och inte en
              självklarhet — kortet påstår att det redovisar möbeln som den är, och då ska det stå
              vad bilden har varit med om.
              Urklippet: möbeln är säljarens egen, men den vita bakgrunden är VÅR redigering, och ett
              kort som räknar upp varje skråma får inte tiga om att det rört bilden. Ingen väg sätter
              "cutout" när produktbildssystemet lyckats och kvalitetskontrollen godkänt resultatet;
              annars är omslaget bildrutan och texten säger det.
              Katalogbilden: den visar inte ens möbeln som säljs, och då ska det stå — inte antas. */}
          {shown.kind === "photo" && (
            <p className="listing-cover-note">{t("Säljarens egen bild av möbeln, orörd")}</p>
          )}
          {shown.kind === "cutout" && (
            <p className="listing-cover-note">{t("Säljarens egen bild av möbeln, bakgrunden borttagen")}</p>
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
            {retail && now && retail > now && (
              <>
                <span className="listing-price-was">{formatSek(retail)}</span>
                <span className="listing-price-off">−{discount} %</span>
              </>
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

        {show("specs") && card.attributes.length > 0 && (
          <section className="listing-block">
            <h3>{t("Specifikationer")}</h3>
            <dl className="listing-specs">
              {card.attributes.map((a) => (
                <div key={a.key + a.label} className="listing-spec">
                  <dt>{a.label}</dt>
                  <dd>
                    {a.value}
                    {a.sourceUrl && !hideSources ? (
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
          </section>
        )}

        {show("condition") && (
        <section className="listing-block">
          <h3>{t("Skickrapport")}</h3>
          <div className="listing-condition-head">
            {grade && <GradeBadge grade={grade.grade} size={44} />}
            <div>
              <div className="card-verdict-label">{grade?.label ?? "—"}</div>
              <div className="muted small">
                {damages.length === 1
                  ? t("{antal} anmärkning", { antal: damages.length })
                  : t("{antal} anmärkningar", { antal: damages.length })}{" "}
                · {t("{antal} vyer", { antal: imageCount })} ·{" "}
                {reviewed ? t("två besiktningar") : t("en besiktning")}
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
              {t("Bilderna är säljarens egna, orörda så när som på markeringen. Numren är samma som i listan.")}
            </p>
          )}
        </section>
        )}

        {show("about") && (
        <section className="listing-block">
          <h3>{t("Om möbeln")}</h3>
          <div className="listing-title-line">{card.listing.title}</div>
          <p className="card-listing-body">{card.listing.description}</p>
          {card.listing.conditionText && <p className="card-listing-condition">{card.listing.conditionText}</p>}
        </section>
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
