import { useEffect, useState } from "react";
import { browse } from "../../butik/api";
import { butikHref } from "../../butik/router";
import { track } from "../../butik/components/Bits";
import type { Product } from "../../butik/types";

/**
 * "Eller köp direkt ur vårt granskade utbud."
 *
 * DÖLJER SIG UNDER FYRA OBJEKT. En horisontell rad med två kort ser ut som ett tomt lager, och ett
 * tomt lager är ett sämre argument än inget lager alls — sidans huvudlöfte handlar ju om möbler som
 * finns NÅGON ANNANSTANS. Raden är ett komplement och ska bara synas när den är ett bra sådant.
 *
 * BARA LOOPA-GRANSKADE. Tradera-annonser hör hemma i katalogen och i direktsvepet, men inte i en rad
 * som heter "vårt granskade utbud" — den meningen får inte kunna bli osann.
 */

const MIN = 4;
const MAX = 12;

export default function Utbudsrad() {
  const [varor, setVaror] = useState<Product[] | null>(null);

  useEffect(() => {
    browse({ onlyLoopa: true, sortering: "nyinkommet", antal: MAX })
      .then((r) => setVaror(r.items))
      .catch(() => setVaror([]));
  }, []);

  // Null = laddar. Inget skimmer: raden är underordnad och ska inte reservera plats den kanske
  // aldrig fyller.
  if (!varor || varor.length < MIN) return null;

  return (
    <section className="utbud">
      <div className="utbud-huvud">
        <h2>Eller köp direkt ur vårt granskade utbud</h2>
        <a href={butikHref({ name: "search", q: "" })} onClick={() => track("utbudsrad_click", { plats: "rubrik" })}>
          Visa allt →
        </a>
      </div>

      <ul className="utbud-rad">
        {varor.map((p) => (
          <li key={p.id}>
            <a
              className="utbud-kort"
              href={butikHref({ name: "product", id: p.id })}
              onClick={() => track("utbudsrad_click", { produkt: p.id, plats: "kort" })}
            >
              <span className="utbud-bild">
                {p.imageUrl ? <img src={p.imageUrl} alt="" loading="lazy" /> : <span className="utbud-tom" />}
              </span>
              <span className="utbud-titel">{p.title}</span>
              <span className="utbud-rad-under">
                <span className="utbud-pris">{p.priceSek === null ? "—" : `${p.priceSek.toLocaleString("sv-SE")} kr`}</span>
                {p.condition?.label && <span className="utbud-skick">{p.condition.label}</span>}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
