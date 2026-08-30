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
 * bortretuscherade. Renderingen är stället där de två sakerna möts — en produktbild där varje
 * anmärkning sitter på den del den faktiskt gäller.
 *
 * Vyn tar EXPLICITA props och inte ett ConditionResult, för att kortet ritas på två ställen: hos
 * säljaren, som äger jobbet, och publikt, där kortet slås upp på sitt Loopa-ID av någon som inte har
 * något konto hos oss. Det publika svaret bär mindre (se server/src/publicCard.ts) — men det ska vara
 * SAMMA kort, inte en förenklad kopia som kan börja säga något annat.
 */
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
   * RENDERINGEN STÅR INTE I LISTAN, och det är hela poängen med den. Omslaget är ett foto av möbeln
   * som säljs, eller ingenting alls. En 3D-figur högst upp läser som en produktbild men visar en möbel
   * som aldrig fotograferats: kortets första och största påstående blir då en ritning. Figuren har sin
   * plats längre ned, i skickrapporten, där den är en karta över anmärkningarna och inte en bild av
   * varan.
   */
  const candidates = useMemo(() => {
    const list: Array<{ url: string; kind: "cutout" | "photo" | "product"; sourceUrl?: string | null }> = [];
    if (cover) list.push(cover);
    if (productImage) list.push({ ...productImage, kind: "product" });
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

  // Modellen byggs bara när måtten finns. Se furnitureModel.ts: hellre ingen bild än en bild av en
  // möbel med påhittade proportioner.
  const model = useMemo(() => {
    const archetype = archetypeFor(card.identity.category, card.listing.title);
    const dims = parseDimensions(card.attributes, archetype);
    // Kategorin, annonsrubriken och varianten följer med in i bygget: det är där "3-sits",
    // "utan armstöd" och träslaget står, och det är de orden som gör figuren till just den här
    // möbeln i stället för till kategorin i allmänhet.
    return dims
      ? buildModel(archetype, dims, card.attributes, {
          category: card.identity.category,
          title: card.listing.title,
          variant: card.identity.variant,
        })
      : null;
  }, [card]);

  const pins = useMemo(() => (model ? placeDamages(damages, model) : []), [damages, model]);
  const retail = card.pricing.retailPriceSek;
  const now = price?.status === "ok" ? price.default : null;
  const discount = retail && now && retail > now ? Math.round((1 - now / retail) * 100) : null;

  return (
    <article className="listing">
      {shown && (
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
              Urklippet: möbeln är säljarens egen, men den vita bakgrunden är VÅR redigering, och ett
              kort som räknar upp varje skråma får inte tiga om att det rört bilden.
              Katalogbilden: den visar inte ens möbeln som säljs, och då ska det stå — inte antas. */}
          {shown.kind === "cutout" && (
            <p className="listing-cover-note">{t("Säljarens egen bild av möbeln, bakgrunden borttagen")}</p>
          )}
          {shown.kind === "product" && (
            <p className="listing-cover-note">
              {t("Produktbild av modellen — inte möbeln som säljs")}
              {shown.sourceUrl && (
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

      <div className="listing-facts">
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

        {card.attributes.length > 0 && (
          <section className="listing-block">
            <h3>{t("Specifikationer")}</h3>
            <dl className="listing-specs">
              {card.attributes.map((a) => (
                <div key={a.key + a.label} className="listing-spec">
                  <dt>{a.label}</dt>
                  <dd>
                    {a.value}
                    {a.sourceUrl ? (
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
          {/* Renderingens enda plats på kortet. Den är inte dekoration och inte ett omslag, utan
              skickrapportens karta: varje anmärkning som en numrerad punkt på den del den gäller,
              med samma nummer som raderna under. Villkoret satt förut på att en bild tagit omslaget
              — figuren fick annars flytta upp och bli kortets produktbild, vilket den aldrig var. */}
          {model && (
            <div className="listing-damage-render">
              <FurnitureRender model={model} pins={pins} selectedId={selected} onSelect={setSelected} />
            </div>
          )}
          {damages.length === 0 ? (
            <p className="muted small listing-no-damage">{t("Inspektionen hittade inga synliga skador.")}</p>
          ) : (
            <ol className="pin-list">
              {damages.map((d, i) => {
                const pin = pins.find((p) => p.id === d.id);
                const active = selected === d.id;
                return (
                  <li key={d.id}>
                    <button
                      type="button"
                      className={`pin-row ${active ? "pin-row-active" : ""}`}
                      onClick={() => setSelected(active ? null : d.id)}
                      aria-pressed={active}
                    >
                      <span className={`pin-num ${pin ? "" : "pin-num-unplaced"}`}>{pin ? pin.number : i + 1}</span>
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
          {model && pins.length > 0 && (
            <p className="listing-pin-note">{t("Punkterna i bilden har samma nummer som listan.")}</p>
          )}
        </section>

        <section className="listing-block">
          <h3>{t("Om möbeln")}</h3>
          <div className="listing-title-line">{card.listing.title}</div>
          <p className="card-listing-body">{card.listing.description}</p>
          {card.listing.conditionText && <p className="card-listing-condition">{card.listing.conditionText}</p>}
        </section>

        {/* Sist, efter allt som går att läsa. Frågor uppstår när man läst skicket och beskrivningen —
            en chatt placerad före dem hade bjudit in till att fråga om det som stod två rader ned. */}
        {loopaId && (
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
 * Skadorna ut på modellen.
 *
 * Två skador på samma del skulle annars hamna på exakt samma punkt och dölja varandra, så följande
 * på en upptagen zon förskjuts i sidled längs ytan. Skador vars del inte gick att tolka fördelas på
 * kategorins lediga zoner i tur och ordning — de får en plats i bilden utan att påstå exakt vilken.
 */
function placeDamages(damages: CardDamage[], model: ReturnType<typeof buildModel>): RenderPin[] {
  const used = new Map<string, number>();
  let fallbackIndex = 0;
  const pins: RenderPin[] = [];

  for (const [i, d] of damages.entries()) {
    let zone = zoneForPart(d.part, d.semanticLocation, model);
    if (!zone) {
      zone = model.fallbackZones[fallbackIndex % model.fallbackZones.length] ?? null;
      fallbackIndex++;
    }
    const anchor = zone ? model.anchors[zone] : undefined;
    if (!anchor) continue;

    const seen = used.get(zone!) ?? 0;
    used.set(zone!, seen + 1);
    // Förskjutningen växlar sida: 0, +12, −12, +24 … så en klunga sprider sig kring delens mitt.
    const step = Math.ceil(seen / 2) * 12 * (seen % 2 === 1 ? 1 : -1);
    const spread = Math.abs(anchor.normal.x) > 0.5 ? { x: 0, y: 0, z: step } : { x: step, y: 0, z: 0 };

    pins.push({
      id: d.id,
      number: i + 1,
      point: {
        x: anchor.point.x + spread.x,
        y: anchor.point.y + spread.y,
        z: anchor.point.z + spread.z,
      },
      normal: anchor.normal,
      label: `${typeLabel(d.type)} — ${d.part}`,
      severity: d.severity,
    });
  }
  return pins;
}
