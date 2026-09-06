import { useEffect, useState } from "react";
import type { Product } from "../types";
import type { PublicCard } from "../../types";
import { fetchProduct } from "../api";
import { fetchPublicCard } from "../../api";
import ListingView from "../../components/ListingView";
import { Link, SellCta, TrustRow, track } from "../components/Bits";
import { dimensionLabel, timeLeft } from "../components/ProductCard";
import { brandInk, brandLook, brandTypeStyle } from "../../lib/brandLook";
import FitsThrough from "../components/FitsThrough";
import BuyPanel from "../components/BuyPanel";
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
 */

const SEK = new Intl.NumberFormat("sv-SE");

export default function ProductScreen({ id }: { id: string }) {
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
            style={{ ...brandTypeStyle(brandLook(product.brand).type), color: brandInk(product.brand) }}
          >
            {product.brand}
          </span>
        )}
        <h1>{product.title}</h1>
      </header>

      {sold && (
        <div className="butik-notice" role="status">
          <span aria-hidden="true">●</span>
          <span>Den här möbeln är såld. Lägg en bevakning så hör vi av oss när något liknande kommer in.</span>
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
            {loopa ? (
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

      <SellCta categorySlug={product.categorySlug} brand={product.brand} />
    </>
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

      {sold && <p className="butik-buybox-note">Möbeln är såld och går inte längre att köpa.</p>}
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
