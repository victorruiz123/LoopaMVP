import { useState } from "react";
import { track } from "../../butik/components/Bits";
import { CATEGORY_LABELS } from "../labels";

/**
 * Fångaren: tre fält för den som inte hittat något än.
 *
 * INGEN TOLKNING, INGET MODELLANROP. Kategori, maxpris, e-post — och klart. Sidan finns för att fånga
 * en avsikt hos någon som är på väg någon annanstans, och varje sekund formuläret kostar är en
 * avsikt som hinner rinna bort. Den som vill beskriva mer i detalj kan göra det senare; det här är
 * inte platsen.
 *
 * INGET KONTO. E-postadressen ÄR vägen att nå personen, och det var alltid vad kravet handlade om.
 * Se `nabar` i efterlysning/types.ts och DECISIONS.md #9.
 *
 * TVÅ PLATSER, SAMMA KOMPONENT. Här som fotblock, och som utväg när ett Trygg affär-ärende avbryts —
 * den som just fick veta att vi inte kunde läsa deras annons ska mötas av något att göra i stället
 * för en återvändsgränd.
 */
export default function Efterlysningsfangare({
  kompakt = false,
  rubrik = "Hittat inget än?",
  ingress = "Säg vad du letar efter, så hör vi av oss när en dyker upp.",
}: {
  /** Utvägsläget: smalare, utan egen bakgrund. */
  kompakt?: boolean;
  rubrik?: string;
  ingress?: string;
}) {
  const [kategori, setKategori] = useState("");
  const [maxpris, setMaxpris] = useState("");
  const [epost, setEpost] = useState("");
  const [fel, setFel] = useState<string | null>(null);
  const [klar, setKlar] = useState(false);
  const [skickar, setSkickar] = useState(false);

  const skicka = async () => {
    setFel(null);
    if (!kategori) return setFel("Välj vilken sorts möbel du letar efter.");
    if (!epost.trim()) return setFel("Vi behöver en e-postadress för att kunna höra av oss.");
    setSkickar(true);
    try {
      const res = await fetch("/api/efterlysning/enkel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kategori,
          maxpris: maxpris ? Number(maxpris.replace(/[^\d]/g, "")) : null,
          epost: epost.trim(),
        }),
      });
      const kropp = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((kropp as { error?: string }).error ?? "Det gick inte just nu.");
      track("efterlysning_saved", { parse_method: "form", kategori });
      setKlar(true);
    } catch (e) {
      setFel(e instanceof Error ? e.message : "Det gick inte just nu.");
    } finally {
      setSkickar(false);
    }
  };

  if (klar) {
    return (
      <section className={kompakt ? "fangare fangare-kompakt" : "fangare"}>
        <h2>Vi hör av oss</h2>
        <p>
          Så fort något som stämmer dyker upp — hos oss, på väg in till oss eller på Tradera — skickar vi
          ett mejl. Inget mer förrän dess.
        </p>
      </section>
    );
  }

  return (
    <section className={kompakt ? "fangare fangare-kompakt" : "fangare"}>
      <h2>{rubrik}</h2>
      <p>{ingress}</p>

      <form
        className="fangare-form"
        onSubmit={(e) => { e.preventDefault(); void skicka(); }}
      >
        <label>
          <span>Vad</span>
          <select value={kategori} onChange={(e) => { setKategori(e.target.value); setFel(null); }}>
            <option value="">Välj möbel…</option>
            {Object.entries(CATEGORY_LABELS).map(([slug, label]) => (
              <option key={slug} value={slug}>{label}</option>
            ))}
          </select>
        </label>

        <label>
          <span>Högst</span>
          <input
            inputMode="numeric"
            value={maxpris}
            onChange={(e) => setMaxpris(e.target.value)}
            placeholder="kr"
            aria-label="Högsta pris i kronor"
          />
        </label>

        <label className="fangare-epost">
          <span>Din e-post</span>
          <input
            type="email"
            value={epost}
            onChange={(e) => { setEpost(e.target.value); setFel(null); }}
            placeholder="du@exempel.se"
            autoComplete="email"
          />
        </label>

        <button type="submit" disabled={skickar}>
          {skickar ? "Sparar…" : "Säg till mig"}
        </button>
      </form>

      {fel && <p className="fangare-fel" role="status">{fel}</p>}
      <p className="fangare-fot">
        Vi använder adressen för att höra av oss om den här möbeln. Inget nyhetsbrev, ingen vidareförsäljning.
      </p>
    </section>
  );
}
