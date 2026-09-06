import { useState } from "react";
import type { ConditionGrade, Product } from "../types";
import { butikHref } from "../router";
import { brandInk, brandLook, brandTypeStyle } from "../../lib/brandLook";

/**
 * Ett kort i rutnätet — och den enda plats där de två källorna möts som jämlikar.
 *
 * SKILLNADEN SOM MÅSTE SYNAS: en Loopa-vara bär stjärnor, ett skickord och "Hemleverans"; en
 * Tradera-vara bär "Säljs via Tradera" och orden "ej granskat". Det är inte en artighet mot Tradera
 * utan butikens hela premiss — påståendet "granskad" är värdelöst i samma sekund det står på något
 * vi inte granskat. Kortet får därför aldrig visa säljarens egen skickuppgift som ett betyg.
 *
 * "KONTROLLERAD AV LOOPA" STOD SOM EN EGEN RAD HÄR och är borttagen. Betyget säger redan att någon
 * granskat möbeln — en bock som upprepar det gör kortet till en reklamplats för oss i stället för en
 * uppgift om möbeln. Motsatsen står kvar: en ogranskad vara MÅSTE säga att den är ogranskad, för
 * det är en uppgift köparen inte kan sluta sig till på egen hand.
 *
 * Klicket går också åt olika håll: vår vara till vår produktsida, deras till deras annons i en ny
 * flik. Vi proxar aldrig Traderas kassa.
 *
 * FYRA UPPGIFTER, I DEN ORDNINGEN: märke, modell, pris, skick. Här stod tidigare en variantrad
 * under modellen — färg, material och mått, satt i grått. Den lades till för att skilja två
 * exemplar av samma modell åt, men i rutnätet blev den en fjärde textrad som konkurrerade med
 * priset om blicken och gjorde varje kort till en annons med finstilt. Skillnaden mellan två
 * Söderhamn hör hemma på produktsidan, där det finns plats att visa den; kortets uppgift är att
 * få någon dit.
 */

const SEK = new Intl.NumberFormat("sv-SE");

function priceLabel(p: Product): string {
  if (p.priceSek === null) return "Pris saknas";
  return `${SEK.format(p.priceSek)} kr`;
}

/** "2 dagar kvar", "4 tim kvar" — auktionens tid, i den enhet som säger något. */
export function timeLeft(endsAt: string | null): string | null {
  if (!endsAt) return null;
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return "Avslutad";
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 48) return `${Math.floor(hours / 24)} dagar kvar`;
  if (hours >= 1) return `${hours} tim kvar`;
  return `${Math.max(1, Math.floor(ms / 60_000))} min kvar`;
}

/**
 * Måtten som en rad: "205 × 90 × 80 cm".
 *
 * Är bara något av de tre känt skrivs det ut med sitt namn — "Höjd 75 cm" — i stället för som
 * "– × – × 75 cm". Båda säger samma sanning, men den senare läser som en trasig sida, och en butik
 * som ser trasig ut blir inte trodd om resten heller. Ingenting gissas i någondera formen.
 */
export function dimensionLabel(p: Product): string | null {
  const { widthMm, depthMm, heightMm } = p.dimensions;
  const cm = (mm: number | null) => (mm === null ? null : Math.round(mm / 10));
  const named: Array<[string, number | null]> = [["Bredd", cm(widthMm)], ["Djup", cm(depthMm)], ["Höjd", cm(heightMm)]];
  const known = named.filter((entry): entry is [string, number] => entry[1] !== null);
  if (known.length === 0) return null;
  if (known.length === 3) return `${known.map(([, v]) => v).join(" × ")} cm`;
  return known.map(([label, v]) => `${label} ${v} cm`).join(" · ");
}

/**
 * Titeln utan märket i början.
 *
 * Märket står redan i sin egen rad, i sin egen färg. "IKEA / IKEA Söderhamn 3-sits soffa" läser som
 * ett fel i datat, inte som en butik. Faller strippningen bort blir titeln oförändrad — vi tar hellre
 * en upprepning än en titel som börjar mitt i ett ord.
 */
export function titleWithoutBrand(title: string, brand: string | null): string {
  if (!brand) return title;
  const b = brand.trim().toLowerCase();
  const t = title.trim();
  if (!t.toLowerCase().startsWith(b)) return t;
  const rest = t.slice(brand.trim().length).replace(/^[\s\u2013\u2014-]+/, "");
  return rest.length > 1 ? rest[0].toUpperCase() + rest.slice(1) : t;
}

/**
 * Betyget som stjärnor.
 *
 * Skalan är vår egen A–F, satt av besiktningen — stjärnorna är bara dess ordbild. De ersätter inte
 * skickordet utan står bredvid det: en femgradig skala utan ord säger inte VAD som är bra.
 * D, E och F heter alla "Okej skick" men är inte samma möbel, och stjärnorna behåller den skillnad
 * som det gemensamma ordet tappar.
 */
const STARS: Record<ConditionGrade, number> = { A: 5, B: 4, C: 3, D: 2, E: 2, F: 1 };

function Stars({ grade }: { grade: ConditionGrade }) {
  const n = STARS[grade];
  return (
    <span className="butik-stars" aria-label={`${n} av 5`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <svg key={i} viewBox="0 0 20 19" width="11" height="11" aria-hidden="true" className={i < n ? "on" : "off"}>
          <path d="M10 0l2.9 6.2 6.6.9-4.8 4.7 1.2 6.8L10 15.4 3.9 18.6l1.2-6.8L.3 7.1l6.6-.9z" />
        </svg>
      ))}
    </span>
  );
}

/**
 * Lastbilen: streckritad, i textens egen färg. Bocken lånas ur Bits — samma bock som förtroenderaden
 * på skärmarna bär, så kortet och sidan säger samma sak med samma tecken.
 *
 * INGA EMOJier. En ✓ och en 🚚 ritas av mottagarens system i dess egna färger — samma kort blir gult
 * och blått på en telefon och platt grått på en annan — och färgade småbilder läser som en
 * loppisannons. Två streckfigurer i samma grå som raden de står i läser som en butik.
 */
function Truck() {
  return (
    <svg viewBox="0 0 20 16" width="13" height="13" aria-hidden="true" className="butik-ikon">
      <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 3h10v8H1z" />
        <path d="M11 6h4l3 3v2h-7z" />
        <circle cx="5.5" cy="13" r="1.6" />
        <circle cx="14.5" cy="13" r="1.6" />
      </g>
    </svg>
  );
}

export default function ProductCard({ product }: { product: Product }) {
  // Sant när bildlänken svarat med ett fel. Se bildblocket nedan.
  const [bildDog, setBildDog] = useState(false);
  const loopa = product.source === "loopa";
  const sold = product.state === "sold" || product.state === "delivered" || product.state === "returned";
  const auction = product.auction;
  const saving =
    product.retailPriceSek && product.priceSek && product.retailPriceSek > product.priceSek
      ? Math.round((1 - product.priceSek / product.retailPriceSek) * 100)
      : null;

  // Katalogbilder ligger mot vit botten och tål inte beskärning; Traderas är fotografier.
  const contain = loopa && !!product.imageUrl && !product.imageUrl.startsWith("/api/");

  const inner = (
    <>
      <div className="butik-card-media">
        {/*
          BRICKAN PÅ BILDEN SÄGER EN SAK, INTE TRE. "Loopa-granskad" stod här förut och står nu i
          kortets text tillsammans med betyget och leveransen, där en köpare läser den som en av
          butikens utfästelser i stället för som en stämpel på ett fotografi. Kvar på bilden blir det
          som bara hör bilden till: att varan är såld, att den är någon annans, eller vad den sparar.
        */}
        {sold ? (
          <span className="butik-badge butik-badge-sold">Såld</span>
        ) : !loopa ? (
          <span className="butik-badge butik-badge-tradera">Säljs via Tradera</span>
        ) : saving !== null ? (
          <span className="butik-badge butik-badge-save">−{saving} %</span>
        ) : null}
        {/*
          EN DÖD BILDLÄNK BLIR MÖBELN RITAD UR MÅTTEN, inte en trasig bildikon.
          Omslaget är i första hand tillverkarens katalogbild, och den ligger på någon annans server:
          mätt på lagret svarar tre av fyrtiotre med 404 eller 403. Utan det här visade de korten en
          sönderbruten ikon med en alt-text bredvid — det enda på hela sidan som ser ut som att
          butiken är trasig. Platshållaren finns redan och säger sant om formen.
        */}
        {product.imageUrl && !bildDog ? (
          <img
            src={product.imageUrl}
            alt={product.title}
            className={contain ? "contain" : undefined}
            loading="lazy"
            decoding="async"
            onError={() => setBildDog(true)}
          />
        ) : (
          <ProductPlaceholder product={product} />
        )}
      </div>
      <div className="butik-card-body">
        {/*
          MÄRKET I MÄRKETS EGEN FÄRG OCH BOKSTAVSFORM, också här.
          Raden var grå versal för alla — samma ord som stod på märkesbrickan, fast anonymt. Nu läser
          den likadant på kortet som på brickan och på märkessidan, ur samma tabell (lib/brandLook.ts).

          `brandInk` och inte `look.fg`: brickans par är gjort för en färgad platta, och IKEAs par är
          gult på blått. På ett vitt kort bär den mörkare av de två — gult på vitt är ingen
          igenkänning, det är en osynlig rad.
        */}
        {product.brand && (
          <span
            className="butik-card-brand"
            style={{ ...brandTypeStyle(brandLook(product.brand).type), color: brandInk(product.brand) }}
          >
            {product.brand}
          </span>
        )}
        <h3 className="butik-card-title">{titleWithoutBrand(product.title, product.brand)}</h3>
        <div className="butik-card-foot">
          <div className="butik-card-prices">
            <span className="butik-price">{priceLabel(product)}</span>
            {product.retailPriceSek && saving !== null && (
              <span className="butik-price-was">Nypris {SEK.format(product.retailPriceSek)} kr</span>
            )}
          </div>
          {/*
            BUTIKENS HALVA AV KORTET — och den enda halvan som skiljer en möbel från en annons.
            Betyg, kontroll och leverans står som tre påståenden under priset, i den ordning en
            köpare frågar efter dem: hur bra är den, vem har sagt det, och kommer den hem till mig.

            EN TRADERA-VARA FÅR INGEN AV DEM. Den har inget betyg (vi har inte sett den), ingen
            kontroll och ingen leverans utlovad av oss — den bär i stället orden "ej granskad", för
            påståendet "kontrollerad" är värdelöst i samma sekund det står på något vi inte kontrollerat.
          */}
          <div className="butik-card-trust">
            {loopa && product.condition ? (
              <span className="butik-trust-row butik-trust-grade">
                <Stars grade={product.condition.grade} />
                {product.condition.canonical}
              </span>
            ) : (
              <span
                className="butik-trust-row butik-trust-ogranskad"
                title={product.sellerCondition ? `Säljarens egen uppgift: ${product.sellerCondition}` : undefined}
              >
                Skick ej granskat
              </span>
            )}
            {loopa && product.homeDeliveryAvailable && (
              <span className="butik-trust-row">
                <Truck /> Hemleverans
              </span>
            )}
          </div>
          {auction?.isAuction && timeLeft(auction.endsAt) && (
            <span className="butik-auction">
              {auction.bidCount ? `${auction.bidCount} bud · ` : ""}
              {timeLeft(auction.endsAt)}
            </span>
          )}
        </div>
      </div>
    </>
  );

  if (!loopa && product.externalUrl) {
    return (
      <a
        className="butik-card"
        href={product.externalUrl}
        target="_blank"
        /* noopener: en främmande sida ska inte få en referens till vårt fönster. */
        rel="noopener noreferrer nofollow"
      >
        {inner}
      </a>
    );
  }
  return (
    <a className="butik-card" href={butikHref({ name: "product", id: product.id })}>
      {inner}
    </a>
  );
}

/**
 * Möbeln utan foto.
 *
 * Ingen grå ruta: kortet visar möbelns proportioner ritade ur måtten, samma stand-in som
 * sanningskortet använder. Bilden säger sant om formen och håller tyst om allt annat — vilket är
 * bättre än en platshållare som inte säger något alls. Saknas även måtten står bara märket.
 */
function ProductPlaceholder({ product }: { product: Product }) {
  const { widthMm, depthMm, heightMm } = product.dimensions;
  const w = widthMm ?? depthMm ?? 800;
  const h = heightMm ?? 800;
  const scale = 62 / Math.max(w, h);
  const bw = Math.max(16, w * scale);
  const bh = Math.max(16, h * scale);
  const label = [widthMm, depthMm, heightMm]
    .map((mm) => (mm === null ? null : Math.round(mm / 10)))
    .filter((v): v is number => v !== null)
    .join(" × ");
  return (
    <svg viewBox="0 0 120 90" width="100%" height="100%" role="img" aria-label={`${product.title}, ingen bild`}>
      <rect x={(120 - bw) / 2} y={72 - bh} width={bw} height={bh} rx="3" fill="var(--surface-sunk)" stroke="var(--border)" />
      <line x1="18" y1="72" x2="102" y2="72" stroke="var(--border)" strokeWidth="1" />
      {/* Texten står NEDTILL: märket "Loopa-granskad" sitter i övre vänstra hörnet och lade sig
          annars ovanpå den. Måtten säger dessutom mer än märkesnamnet, som redan står under kortet. */}
      {label && (
        <text x="60" y="84" textAnchor="middle" fontSize="7" fill="var(--muted-soft)" fontWeight="600">
          {label} cm
        </text>
      )}
    </svg>
  );
}
