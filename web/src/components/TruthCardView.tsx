import { useMemo, useState } from "react";
import type { CardDamage, TruthCardData } from "../types";
import { formatSek } from "../lib/price";
import { SEVERITY_LABELS, TYPE_LABELS } from "../lib/labels";
import { brandLook, brandTypeStyle } from "../lib/brandLook";
import { archetypeFor, buildModel, parseDimensions, zoneForPart } from "../lib/furnitureModel";
import GradeBadge from "./GradeBadge";
import FurnitureRender, { type RenderPin } from "./FurnitureRender";
import TruthCardChat from "./TruthCardChat";

const STATUS_LABELS: Record<string, string> = {
  full: "Allt belagt med källa",
  partial: "Delvis belagt",
  fallback: "Kunde inte beläggas mot källor",
};

/**
 * Truth-cardet som annons.
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
export default function TruthCardView({
  card,
  identity,
  grade,
  price,
  damages,
  imageCount,
  reviewed,
  productImage,
  loopaId,
}: TruthCardData & {
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
  const [selected, setSelected] = useState<string | null>(null);
  // Omslaget ligger på en annan sajt än vi, och den kan svara 404 eller neka hotlinking. Faller
  // bilden är renderingen kvar — kortet ska aldrig ha ett tomt hål där bilden skulle stått.
  const [coverBroken, setCoverBroken] = useState(false);

  const name = card.identity.exactProduct ?? card.identity.variant ?? identity?.model ?? "Möbel";
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

  /**
   * Omslaget är tillverkarens produktbild: möbeln framifrån mot vit bakgrund.
   *
   * Det är så en möbel säljs. En köpare ska först se VAD det är — och en katalogbild svarar på den
   * frågan på en tiondels sekund, vilket varken en ritning eller ett vardagsrumsfoto gör.
   *
   * Bilden visar en ny exemplar av modellen och säger därför ingenting om skicket. Det är avsiktligt
   * åtskilt: renderingen med de numrerade anmärkningarna flyttar ned i skickrapporten, där skicket
   * hör hemma, i stället för att försvinna. Saknas produktbilden tar renderingen omslagets plats.
   */
  const cover = coverBroken ? null : productImage;

  return (
    <article className="listing">
      {(cover || model) && (
        /* Bilden och dess härkomst är EN sak, och hålls ihop av ett element: på datorvyn är
           kolumnen ett rutnät, och två syskon hade lagt bildtexten i en egen rad långt under. */
        <div className="listing-cover-block">
          <div className={`listing-stage ${cover ? "listing-stage-photo" : ""}`}>
            {grade && (
              <span className="listing-stage-badge">
                <GradeBadge grade={grade.grade} size={26} />
                {grade.canonicalCondition}
              </span>
            )}
            {cover ? (
              <img className="listing-cover" src={cover.url} alt={name} onError={() => setCoverBroken(true)} />
            ) : (
              model && <FurnitureRender model={model} pins={pins} selectedId={selected} onSelect={setSelected} />
            )}
          </div>
          {/* Vems bild det är, sagt rakt ut. Omslaget är det enda på kortet som INTE visar möbeln som
              säljs, och då ska det stå — inte antas. */}
          {cover && (
            <p className="listing-cover-note">
              Produktbild av modellen
              {cover.sourceUrl && (
                <>
                  {" · "}
                  <a href={cover.sourceUrl} target="_blank" rel="noreferrer">
                    källa
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
                  `Marknadsvärde för skicket, efter ${Math.round(price.damageDeduction * 100)} % avdrag för skadorna.`
                : "Marknadsvärde för skicket, från jämförbara annonser."
              : (price?.unavailableReason ?? "Prismotorn kunde inte nås.")}
          </p>
        </div>

        {card.attributes.length > 0 && (
          <section className="listing-block">
            <h3>Specifikationer</h3>
            <dl className="listing-specs">
              {card.attributes.map((a) => (
                <div key={a.key + a.label} className="listing-spec">
                  <dt>{a.label}</dt>
                  <dd>
                    {a.value}
                    {a.sourceUrl && (
                      <a className="truth-src" href={a.sourceUrl} target="_blank" rel="noreferrer">
                        källa
                      </a>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        <section className="listing-block">
          <h3>Skickrapport</h3>
          <div className="listing-condition-head">
            {grade && <GradeBadge grade={grade.grade} size={44} />}
            <div>
              <div className="truth-verdict-label">{grade?.label ?? "—"}</div>
              <div className="muted small">
                {damages.length} {damages.length === 1 ? "anmärkning" : "anmärkningar"} · {imageCount} vyer ·{" "}
                {reviewed ? "två besiktningar" : "en besiktning"}
              </div>
            </div>
          </div>
          {/* Renderingen sitter här när produktbilden tagit omslaget. Den är inte dekoration utan
              skickrapportens karta: varje anmärkning som en numrerad punkt på den del den gäller,
              med samma nummer som raderna under. */}
          {cover && model && (
            <div className="listing-damage-render">
              <FurnitureRender model={model} pins={pins} selectedId={selected} onSelect={setSelected} />
            </div>
          )}
          {damages.length === 0 ? (
            <p className="muted small listing-no-damage">Inspektionen hittade inga synliga skador.</p>
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
                          {TYPE_LABELS[d.type]}
                          <span className="pin-part">{d.part}</span>
                        </span>
                        <span className="pin-desc">{d.description}</span>
                      </span>
                      <span className={`chip chip-${d.severity}`}>{SEVERITY_LABELS[d.severity]}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          {model && pins.length > 0 && <p className="listing-pin-note">Punkterna i bilden har samma nummer som listan.</p>}
        </section>

        <section className="listing-block">
          <h3>Om möbeln</h3>
          <div className="listing-title-line">{card.listing.title}</div>
          <p className="truth-listing-body">{card.listing.description}</p>
          {card.listing.conditionText && <p className="truth-listing-condition">{card.listing.conditionText}</p>}
        </section>

        <section className="listing-block listing-provenance">
          <h3>Underlag</h3>
          {/* Sagt rakt ut, inte begravt: en annons där måtten är gissade ska inte se likadan ut som
              en där de har en källa. */}
          <div className={`truth-confidence truth-confidence-${card.status ?? "partial"}`}>
            {STATUS_LABELS[card.status ?? "partial"] ?? card.status}
            {card.identity.confidence ? ` · träffsäkerhet ${card.identity.confidence}` : ""}
          </div>
          {card.identity.uncertain && card.identity.uncertaintyNote && (
            <p className="truth-caveat">{card.identity.uncertaintyNote}</p>
          )}
          {model && model.dims.assumed.length > 0 && (
            <p className="truth-caveat">
              Måtten märkta ≈ i bilden stod inte i underlaget utan är typiska för kategorin.
            </p>
          )}
          {card.sources.length > 0 && (
            <ul className="truth-sources">
              {card.sources.map((s) => (
                <li key={s.url}>
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.title || s.url}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {card.missingNotes && card.missingNotes.length > 0 && (
            <div className="truth-missing">
              <p className="muted small">Kunde inte bekräftas:</p>
              <ul>
                {card.missingNotes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* Sist, efter allt som går att läsa. Frågor uppstår när man läst skicket och underlaget —
            en chatt placerad före dem hade bjudit in till att fråga om det som stod två rader ned. */}
        {loopaId && (
          <TruthCardChat
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
      label: `${TYPE_LABELS[d.type]} — ${d.part}`,
      severity: d.severity,
    });
  }
  return pins;
}
