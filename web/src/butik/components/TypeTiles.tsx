import type { FurnitureType } from "../types";
import { Link } from "./Bits";
import { typeHeading } from "../screens/TypeScreen";

/**
 * Möbeltypsbrickorna — tredje ingången, under märkena.
 *
 * Märket är hur folk letar när de vet vad de vill ha; typen är hur de letar när de vet vad de
 * BEHÖVER. "En soffa" är en vanligare utgångspunkt än "en Sits", och brickan här är den utgångspunkten
 * som en klickbar sak: ordet för möbeln, och hur många vi har.
 *
 * Brickan är NEUTRAL med flit, till skillnad från märkesbrickan: ett märke har en egen färg att känna
 * igen, en soffa har det inte. Ordet bär hela brickan, i Loopas egen typografi.
 *
 * Antalet är DELAT per källa av samma skäl som på märkesbrickan: en granskad möbel går att köpa i
 * dag med hemleverans, en Tradera-annons är någon annans. Bara typer med varor visas — servern räknar
 * (typeFacetsMerged), och en bricka som leder till en tom sida är ett löfte som bryts i samma klick.
 */
export default function TypeTiles({ types }: { types: FurnitureType[] }) {
  if (types.length === 0) return null;
  return (
    <nav className="butik-types" aria-label="Möbeltyper">
      {types.map((t) => (
        <Link key={t.slug} to={{ name: "type", slug: t.slug }} className="butik-type-tile">
          <span className="butik-type-name">{t.label}</span>
          <span className="butik-type-sub">{typeHeading(t).toLowerCase()}</span>
          <span className="butik-type-count">
            {t.loopa > 0 && `${t.loopa} granskade`}
            {t.loopa > 0 && t.tradera > 0 && " · "}
            {t.tradera > 0 && `${t.tradera} via Tradera`}
          </span>
        </Link>
      ))}
    </nav>
  );
}
