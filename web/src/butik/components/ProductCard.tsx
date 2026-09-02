import type { Product } from "../types";
import { butikHref } from "../router";

/**
 * Ett kort i rutnätet — och den enda plats där de två källorna möts som jämlikar.
 *
 * SKILLNADEN SOM MÅSTE SYNAS: en Loopa-vara bär "Loopa-granskad ✓" och ett betyg; en Tradera-vara
 * bär "Säljs via Tradera" och orden "ej granskad". Det är inte en artighet mot Tradera utan
 * butikens hela premiss — påståendet "granskad" är värdelöst i samma sekund det står på något vi
 * inte granskat. Kortet får därför aldrig visa säljarens egen skickuppgift som ett betyg.
 *
 * Klicket går också åt olika håll: vår vara till vår produktsida, deras till deras annons i en ny
 * flik. Vi proxar aldrig Traderas kassa.
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

export default function ProductCard({ product }: { product: Product }) {
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
        {sold ? (
          <span className="butik-badge butik-badge-sold">Såld</span>
        ) : loopa ? (
          <span className="butik-badge butik-badge-loopa">Loopa-granskad ✓</span>
        ) : (
          <span className="butik-badge butik-badge-tradera">Säljs via Tradera</span>
        )}
        {product.imageUrl ? (
          <img
            src={product.imageUrl}
            alt={product.title}
            className={contain ? "contain" : undefined}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <ProductPlaceholder product={product} />
        )}
      </div>
      <div className="butik-card-body">
        {product.brand && <span className="butik-card-brand">{product.brand}</span>}
        <h3 className="butik-card-title">{product.title}</h3>
        <div className="butik-card-meta">
          {loopa && product.condition ? (
            <span>{product.condition.canonical}</span>
          ) : (
            <span title={product.sellerCondition ? `Säljarens egen uppgift: ${product.sellerCondition}` : undefined}>
              Ej granskad
            </span>
          )}
          {dimensionLabel(product) && (
            <>
              <span className="sep">·</span>
              <span className="butik-dim">{dimensionLabel(product)}</span>
            </>
          )}
        </div>
        <div className="butik-card-foot">
          <span className="butik-price">{priceLabel(product)}</span>
          {product.retailPriceSek && saving !== null && (
            <>
              <span className="butik-price-was">{SEK.format(product.retailPriceSek)} kr</span>
              <span className="butik-save">−{saving} %</span>
            </>
          )}
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
