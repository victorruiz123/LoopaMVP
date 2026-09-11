import { useEffect, useState } from "react";
import type { Product } from "../types";
import type { PublicCard } from "../../types";
import { fetchProduct } from "../api";
import { fetchPublicCard } from "../../api";
import ListingView from "../../components/ListingView";
import { Link, SellCta, TrustRow, track } from "../components/Bits";
import { dimensionLabel, timeLeft } from "../components/ProductCard";
import { brandInk, brandLook, brandNameStyle } from "../../lib/brandLook";
import FitsThrough from "../components/FitsThrough";
import BuyPanel from "../components/BuyPanel";
import LetarDuMobel from "../../components/LetarDuMobel";
import { useViewItem } from "../components/ProductGrid";

/**
 * Produktsidan — och den ÄR sanningskortet.
 *
 * Kortet finns redan: `ListingView` ritar bilden, betyget, varje skada med närbild, måtten och
 * texten, och det är samma vy säljaren såg och samma vy en Tradera-läsare når via /c/LP-XXXX-XXXX.
 * Butiken lägger ingen ny sanning ovanpå den — den lägger ett köp runt den. Delarna hämtas därför
 * med `only` i stället för att ritas om här: en andra beskrivning av möbelns skick är en andra
 * sanning, och den dagen de säger olika saker är kortet inte värt något.
 *
 * LAYOUTEN, och varför den ser ut så:
 *
 *   Märke + modell
 *   ┌────────────────────────┬──────────────────┐
 *   │ Bilden                 │ Köp (med priset) │
 *   │ Skickrapporten         │ Måtten           │
 *   │ Beskrivningen          │ Frågorna         │
 *   └────────────────────────┴──────────────────┘
 *   Får den plats?
 *
 * Vänsterspalten är vad möbeln ÄR — se den, se skicket, läs om den. Högerspalten är vad man GÖR —
 * köpa, kontrollera måtten, fråga. Priset står i köpsektionen och ingen annanstans: ett pris i en
 * ingress och ett till i en köpruta är två priser på samma möbel.
 *
 * "Får den plats?" ligger under båda spalterna med flit. Den är sista frågan man ställer sig innan
 * man trycker på köp, och den behöver hela bredden för sitt svar.
 *
 * SAMMA SKÄRM RITAR DEN KÖPFRIA VERSIONEN (`utanKop`, /butik/info/<id>). Det är EN prop och inte en
 * egen skärm, av samma skäl som säljarens annons är säljverktygets kort: möbeln är densamma och
 * sanningen om den är densamma, och två filer hade glidit isär den vecka någon la till en rad i den
 * ena. Det som skiljer är högerspalten — vad man GÖR — och det är precis vad propen byter ut.
 */

const SEK = new Intl.NumberFormat("sv-SE");

export default function ProductScreen({ id, utanKop = false }: { id: string; utanKop?: boolean }) {
  const [product, setProduct] = useState<Product | null>(null);
  const [card, setCard] = useState<PublicCard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setProduct(null);
    setCard(null);
    setError(null);
    fetchProduct(id)
      .then((r) => {
        setProduct(r.product);
        // Sanningskortet hämtas separat och får misslyckas: priset, köpknappen och måtten ska stå
        // även om besiktningsdetaljerna inte kommer fram.
        return fetchPublicCard(r.product.id).then(setCard).catch(() => undefined);
      })
      .catch(() => setError("Vi hittar inte den här möbeln. Den kan vara såld."));
  }, [id]);

  useViewItem(product);

  if (error) {
    return (
      <div className="butik-empty">
        <h3>Möbeln finns inte kvar</h3>
        <p>{error}</p>
        <Link to={{ name: "search", q: "" }} className="btn btn-outline btn-small">Till butiken</Link>
      </div>
    );
  }

  if (!product) {
    return (
      <div style={{ padding: "40px 0" }}>
        <div className="butik-skeleton" style={{ height: 260, marginBottom: 16 }} />
        <div className="butik-skeleton" style={{ height: 24, width: "60%", marginBottom: 10 }} />
        <div className="butik-skeleton" style={{ height: 24, width: "35%" }} />
      </div>
    );
  }

  const sold = product.state !== "live" && product.state !== "reserved";
  const reserved = product.state === "reserved";
  const loopa = product.source === "loopa";

  return (
    <>
      <header className="butik-pdp-head">
        {/* Samma behandling som på kortet i rutnätet: märkets egen färg och bokstavsform. */}
        {product.brand && (
          <span
            className="butik-card-brand"
            style={{ ...brandNameStyle(product.brand), color: brandInk(product.brand) }}
          >
            {product.brand}
          </span>
        )}
        <h1>{product.title}</h1>
      </header>

      {sold && (
        <div className="butik-notice" role="status">
          <span aria-hidden="true">●</span>
          {/*
            Två meningar för två sidor. Raden på köpsidan lovar nästa steg — "berätta vad du letar
            efter" — och det steget finns bara där: den köpfria sidan har ingen sådan ruta under sig
            (se foten), och en hänvisning till något som inte står någonstans är ett löfte i tomma
            luften. Kvar blir uppgiften själv, som är det den som kontrollerar en annons kom för.
          */}
          <span>
            {utanKop
              ? "Den här möbeln är såld och annonsen är avslutad. Uppgifterna nedan står kvar som de var när den låg ute."
              : "Den här möbeln är såld. Berätta vad du letar efter, så hör vi av oss när något liknande kommer in."}
          </span>
        </div>
      )}

      {/*
        Varje del ligger i en egen låda med eget klassnamn. Det behövs för att spalterna ska kunna
        LÖSAS UPP på en telefon: där finns inget "till höger om bilden", och köpsektionen ska då
        följa direkt på bilden i stället för att hamna efter hela skickrapporten. Utan handtag går
        de tre kortsektionerna inte att skilja åt — de heter alla `listing-block`.
      */}
      <div className="butik-pdp">
        <div className="butik-pdp-main">
          <div className="butik-slot butik-slot-cover">
            {card ? (
              <ListingView {...card} loopaId={product.id} hideSources only={["cover"]} />
            ) : (
              <div className="butik-skeleton" style={{ aspectRatio: "1 / 1" }} />
            )}
          </div>

          <div className="butik-slot butik-slot-condition">
            {card ? (
              <ListingView {...card} loopaId={product.id} hideSources only={["condition"]} />
            ) : (
              <div className="butik-skeleton" style={{ height: 280 }} />
            )}
          </div>

          <div className="butik-slot butik-slot-about">
            {card && <ListingView {...card} loopaId={product.id} hideSources only={["about"]} />}
          </div>
        </div>

        <aside className="butik-pdp-side">
          <div className="butik-slot butik-slot-buy">
            {utanKop ? (
              <InfoBox product={product} sold={sold} tradera={card?.tradera ?? null} />
            ) : loopa ? (
              <BuyBox product={product} sold={sold} reserved={reserved} />
            ) : (
              <TraderaPanel product={product} />
            )}
          </div>

          <div className="butik-slot butik-slot-specs">
            {card && <ListingView {...card} loopaId={product.id} hideSources only={["specs"]} />}
          </div>

          <div className="butik-slot butik-slot-chat">
            {card && <ListingView {...card} loopaId={product.id} hideSources only={["chat"]} />}
          </div>
        </aside>
      </div>

      {loopa && <FitsThrough product={product} />}

      {/*
        Står under köpblocket — utom när raden redan TAGIT köpblockets plats.
        Det händer bara i ett fall: en såld möbel som är vår egen (se BuyBox). En såld
        Tradera-annons har ingen sådan ruta, och utan undantaget för `loopa` hade just den sidan —
        en död länk till någon annans avslutade annons — blivit den enda utan väg vidare.
      */}
      {!utanKop && !(sold && loopa) && <LetarDuMobel varifran={`/butik/objekt/${product.id}`} />}

      {/*
        INGEN VÄRVNING PÅ DEN KÖPFRIA SIDAN — varken "berätta vad du letar efter" eller "har du en
        liknande möbel?". Läsaren kom hit mitt i någon annans annons för att kontrollera EN uppgift:
        stämmer skicket. Varje ruta som i stället ber dem beskriva en annan möbel eller sälja sin
        egen är en uppmaning att lämna den annonsen, och det är inte vår sida att be om det på.
      */}
      {!utanKop && <SellCta categorySlug={product.categorySlug} brand={product.brand} />}
    </>
  );
}

/**
 * Upplysningsrutan — den köpfria sidans högerspalt.
 *
 * DEN TAR KÖPRUTANS PLATS OCH INTE DESS FORM. Samma ram och samma position som `BuyBox`, för att
 * priset hör hemma där ögat letar efter det — men utan postnummer, utan kassa och utan knapp som
 * gör något med pengar. Rubriken säger varför: sidan är besiktningen bakom annonsen, inte ett andra
 * ställe att göra affären på.
 *
 * PRISET STÅR MED, och det är ett medvetet val. Att utelämna det hade gjort sidan svårare att lita
 * på — en köpare som ser ett skick men inget pris vet inte om de läser om samma möbel som annonsen
 * de kom ifrån. Det står som UPPGIFT: "Annonsen ligger på 2 400 kr", inte som ett anbud.
 *
 * LÄNKEN TILLBAKA TILL ANNONSEN är det enda den här sidan ber någon göra. Utan den är sidan en
 * återvändsgränd för den som blev övertygad — och att skicka dem tillbaka dit budet redan ligger är
 * motsatsen till att fånga in köpet hit.
 */
function InfoBox({
  product,
  sold,
  tradera,
}: {
  product: Product;
  sold: boolean;
  tradera: PublicCard["tradera"];
}) {
  const annonsUrl = tradera?.status === "published" ? tradera.url : null;

  return (
    <section className="butik-buybox">
      <h2 className="butik-buybox-titel">Om den här möbeln</h2>
      <div className="butik-buybox-price">
        <span className="butik-price" style={{ fontSize: 30 }}>
          {product.priceSek !== null ? `${SEK.format(product.priceSek)} kr` : "Pris saknas"}
        </span>
        {/* Vem talet tillhör. Samma siffra utan avsändare läser som en kassa. */}
        <span className="butik-price-was">Priset i annonsen</span>
      </div>

      <TrustRow />

      <div
        className="butik-notice"
        style={{ background: "var(--field)", color: "var(--ink-soft)", margin: "12px 0" }}
      >
        <span aria-hidden="true">ℹ</span>
        <span>
          Den här sidan är <strong>besiktningen bakom annonsen</strong> — skicket, varje skada, måtten
          och källorna. Du köper inte här: möbeln säljs i annonsen du kom ifrån.
        </span>
      </div>

      {!sold && annonsUrl && (
        <a
          className="btn btn-primary"
          href={annonsUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: "inline-flex", justifyContent: "center", marginTop: 8 }}
          onClick={() => track("info_tillbaka_till_annons", { item_id: product.id })}
        >
          Tillbaka till annonsen →
        </a>
      )}
    </section>
  );
}

/**
 * Köpsektionen — priset, löftena och knappen.
 *
 * Priset bor HÄR och ingen annanstans på sidan. Det är det enda stället där det står bredvid det man
 * faktiskt gör med det.
 */
function BuyBox({ product, sold, reserved }: { product: Product; sold: boolean; reserved: boolean }) {
  const saving =
    product.retailPriceSek && product.priceSek && product.retailPriceSek > product.priceSek
      ? Math.round((1 - product.priceSek / product.retailPriceSek) * 100)
      : null;

  return (
    <section className="butik-buybox">
      {/*
        HELA KÖPET I EN RUTA, MED AVSÄNDAREN I KANTEN.
        Delarna — priset, löftena, postnumret, knappen — låg tidigare som fyra fristående stycken i
        en vit spalt bland sidans andra vita kort, och köpet syntes därför inte som ETT ställe utan
        som fyra. En inramad ruta med en rubrik är hur varje möbelbutik sätter sin kassa: det som
        står innanför ramen är vad du får och vad det kostar, och det som står utanför är beskrivning.

        "Köp hos Loopa" och inte "Köp": på en sida som också visar andras annonser är avsändaren
        halva beskedet. Det är VI som tar betalt, kör hem möbeln och tar tillbaka den — Tradera-rutan
        säger med samma ord att det inte är vi.
      */}
      <h2 className="butik-buybox-titel">Köp hos Loopa</h2>
      <div className="butik-buybox-price">
        <span className="butik-price" style={{ fontSize: 30 }}>
          {product.priceSek !== null ? `${SEK.format(product.priceSek)} kr` : "Pris saknas"}
        </span>
        {product.retailPriceSek && saving !== null && (
          <>
            <span className="butik-price-was">Nypris ca {SEK.format(product.retailPriceSek)} kr</span>
            <span className="butik-save">Du sparar {saving} %</span>
          </>
        )}
      </div>

      <TrustRow />

      {reserved && (
        <p className="butik-buybox-note butik-buybox-note-warn">
          Någon står i kassan med den här möbeln just nu. Håller köpet inte hela vägen släpps den igen inom en kvart.
        </p>
      )}

      {!sold && !reserved && <BuyPanel product={product} />}

      {/*
        SÅLD: raden ERSÄTTER köpet i stället för att stå under det.
        "Möbeln är såld och går inte längre att köpa" var sant och en återvändsgränd — sidans enda
        kvarvarande handling var att backa. Nu är den kvarvarande handlingen att berätta vad man
        letade efter, vilket är precis vad någon som landat på en såld möbel har på gång.
      */}
      {sold && <LetarDuMobel varifran={`/butik/objekt/${product.id}`} istallet />}
    </section>
  );
}

/**
 * Panelen för en Tradera-annons.
 *
 * Sidan finns knappt för dem — kortet i rutnätet länkar rakt till Tradera — men adressen kan nås
 * ändå, och då måste den vara ärlig: ingen granskning, ingen hemleverans, och köpet sker hos
 * Tradera. Säljarens egen skickuppgift står med som ett citat, aldrig som ett betyg.
 */
function TraderaPanel({ product }: { product: Product }) {
  const auction = product.auction;
  return (
    <section className="butik-buybox">
      {/* Samma ruta, motsatt besked: rubriken säger vem säljaren är innan priset hinner antyda att
          det är vi. Se BuyBox ovan. */}
      <h2 className="butik-buybox-titel butik-buybox-titel-extern">Köp via Tradera</h2>
      <div className="butik-buybox-price">
        <span className="butik-price" style={{ fontSize: 30 }}>
          {product.priceSek !== null ? `${SEK.format(product.priceSek)} kr` : "Pris saknas"}
        </span>
      </div>
      <div className="butik-notice" style={{ background: "var(--field)", color: "var(--ink-soft)", margin: "12px 0" }}>
        <span aria-hidden="true">ℹ</span>
        <span>
          Den här annonsen ligger på <strong>Tradera</strong> och är <strong>inte granskad av Loopa</strong>. Vi har inte sett
          möbeln och kan inte leverera den.
          {product.sellerCondition && <> Säljaren anger själv skicket som ”{product.sellerCondition}”.</>}
        </span>
      </div>
      {auction?.isAuction && (
        <p className="butik-card-meta">
          {auction.bidCount ? `${auction.bidCount} bud` : "Inga bud"}
          {timeLeft(auction.endsAt) && <> · {timeLeft(auction.endsAt)}</>}
        </p>
      )}
      {dimensionLabel(product) && <p className="butik-card-meta">Mått enligt annonsen: {dimensionLabel(product)}</p>}
      {product.externalUrl && (
        <a
          className="btn btn-primary"
          href={product.externalUrl}
          target="_blank"
          rel="noopener noreferrer nofollow"
          style={{ display: "inline-flex", justifyContent: "center", marginTop: 8 }}
          onClick={() => track("outbound_tradera", { item_id: product.id })}
        >
          Visa annonsen på Tradera →
        </a>
      )}
    </section>
  );
}
