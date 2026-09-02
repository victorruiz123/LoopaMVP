import { useState } from "react";
import type { Product } from "../types";

/**
 * "Får den plats?"
 *
 * Den vanligaste anledningen att en begagnad möbel kommer i retur är att den inte gick in genom
 * dörren. Verktyget jämför köparens dörrbredd med möbelns SMALASTE tvärmått — en soffa bärs på
 * högkant, så det som måste passera är bredden eller djupet, vilket som är minst.
 *
 * DET SOM GÖR DET ÄRLIGT: svaret säger vilket mått det räknade på, och vägrar svara när måttet är
 * uppskattat i stället för uppmätt (`dimensions.estimated`). Ett glatt "den får plats!" grundat på
 * ett typiskt mått för möbeltypen är precis det löfte som blir en retur.
 */
export default function FitsThrough({ product }: { product: Product }) {
  const [doorCm, setDoorCm] = useState("");
  const { widthMm, depthMm, heightMm, estimated } = product.dimensions;

  const candidates = [widthMm, depthMm].filter((v): v is number => v !== null);
  const narrowestMm = candidates.length ? Math.min(...candidates) : null;

  if (narrowestMm === null) {
    return (
      <section className="butik-explainer" style={{ padding: 18 }}>
        <h2 style={{ fontSize: 18 }}>Får den plats?</h2>
        <p style={{ margin: 0 }}>Vi har inte tillräckligt med mått på den här möbeln för att kunna svara.</p>
      </section>
    );
  }

  const door = Number(doorCm.replace(",", "."));
  const valid = doorCm.trim() !== "" && Number.isFinite(door) && door > 0;
  const narrowestCm = Math.round(narrowestMm / 10);
  const margin = valid ? Math.round(door - narrowestCm) : 0;
  const which = narrowestMm === widthMm ? "bredden" : "djupet";

  return (
    <section className="butik-explainer" style={{ padding: 18, margin: "18px 0" }}>
      <h2 style={{ fontSize: 18 }}>Får den plats?</h2>
      <p style={{ marginBottom: 14 }}>
        Möbeln mäter {[widthMm, depthMm, heightMm].map((v) => (v === null ? "–" : Math.round(v / 10))).join(" × ")} cm.
        Smalaste tvärmåttet är {narrowestCm} cm ({which}) — det är det som ska igenom dörren.
      </p>
      <div className="butik-field-row">
        <input
          className="butik-input"
          type="number"
          inputMode="decimal"
          placeholder="Din dörrbredd i cm"
          value={doorCm}
          onChange={(e) => setDoorCm(e.target.value)}
          aria-label="Dörrbredd i centimeter"
        />
      </div>
      {valid && (
        <p style={{ marginTop: 12, marginBottom: 0, fontWeight: 600, lineHeight: 1.5 }}>
          {estimated ? (
            <span style={{ color: "var(--amber-ink)" }}>
              ⚠ Måttet är uppskattat för möbeltypen, inte uppmätt på just den här. Mät efter innan du bestämmer dig.
            </span>
          ) : margin >= 5 ? (
            <span style={{ color: "var(--green-dark)" }}>
              ✓ Den går in med {margin} cm till godo.
            </span>
          ) : margin >= 0 ? (
            <span style={{ color: "var(--amber-ink)" }}>
              ⚠ Det går, men bara med {margin} cm marginal. Räkna med att lyfta av dörren.
            </span>
          ) : (
            <span style={{ color: "var(--danger-dark)" }}>
              ✕ Den är {Math.abs(margin)} cm för bred för den öppningen.
            </span>
          )}
        </p>
      )}
    </section>
  );
}
