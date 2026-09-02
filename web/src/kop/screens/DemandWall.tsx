import { useEffect, useState } from "react";
import { vagg, type WallItem } from "../api";
import { track } from "../../butik/components/Bits";
import { CATEGORY_LABELS } from "../labels";

/**
 * /efterlyses — efterlysningsväggen.
 *
 * VÄND MOT SÄLJARE, inte mot köpare. Sidan är produktens billigaste utbudsgenerering: en lista över
 * vad folk faktiskt vill ha, med en knapp som leder rakt in i säljverktyget med kategorin ifylld.
 * Den som ser "Sökes: String-hylla i valnöt — någon har väntat i tolv dagar" och råkar ha en sådan
 * i förrådet har fått ett skäl att filma den i kväll.
 *
 * INGEN KÖPARE GÅR ATT PEKA UT. Raderna är aggregerade på servern (wall.ts): flera som söker samma
 * sak blir en rad, området är grovt och blir "Stockholm" så fort gruppen är oense, och köparens egen
 * anteckning lämnar aldrig systemet.
 */
export default function DemandWall({ kategori }: { kategori: string | null }) {
  const [poster, setPoster] = useState<WallItem[] | null>(null);

  useEffect(() => {
    track("wanted_page_visit", { kategori });
    vagg(kategori).then((r) => setPoster(r.poster)).catch(() => setPoster([]));
  }, [kategori]);

  const rubrik = kategori
    ? `Sökes: ${(CATEGORY_LABELS[kategori] ?? kategori).toLowerCase()} i Stockholm`
    : "Det här söker folk just nu";

  return (
    <div className="vagg">
      <header className="vagg-head">
        <h1>{rubrik}</h1>
        <p>
          Riktiga köpare i Stockholm som väntar på en möbel. Har du en av dem i förrådet? Filma den på
          tre minuter — vi besiktigar, prissätter och hämtar hem den.
        </p>
      </header>

      {poster === null && <div className="butik-skeleton" style={{ height: 160 }} />}

      {poster?.length === 0 && (
        <p className="vagg-tom">
          Ingen öppen efterlysning i den här kategorin just nu.
        </p>
      )}

      <ul className="vagg-lista">
        {(poster ?? []).map((p) => (
          <li key={p.key} className="vagg-post">
            <div className="vagg-post-text">
              <h2>{p.title}</h2>
              <p className="vagg-post-meta">
                {p.area ?? "Stockholm"}
                {p.count > 1 ? ` · ${p.count} köpare söker detta` : ""}
                {p.waitingDays > 0 ? ` · väntat i ${p.waitingDays} ${p.waitingDays === 1 ? "dag" : "dagar"}` : ""}
              </p>
            </div>
            <a
              className="vagg-post-cta"
              href={`/?kategori=${encodeURIComponent(p.categorySlug ?? "")}&fran=efterlyses`}
              onClick={() => track("wanted_page_visit_sell_click", { kategori: p.categorySlug })}
            >
              Har du en? Sälj den nu →
            </a>
          </li>
        ))}
      </ul>

      {/* Kategorilänkarna finns för sökmotorerna lika mycket som för besökaren: "sökes string hylla
          stockholm" är en fråga folk faktiskt ställer, och varje kategori är en egen sida som svarar. */}
      <nav className="vagg-kategorier" aria-label="Kategorier">
        <span>Se efter kategori:</span>
        {Object.entries(CATEGORY_LABELS).map(([slug, label]) => (
          <a key={slug} href={`/efterlyses/${slug}`}>{label}</a>
        ))}
      </nav>
    </div>
  );
}
