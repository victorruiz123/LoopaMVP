import { useState } from "react";
import type { ModelCandidate } from "../types";
import { ChevronRight } from "../components/icons";

/**
 * Vilken modell är det?
 *
 * Tvetydighet mellan VERKLIGA produkter lämnas till säljaren i stället för att slås ut med fler
 * modellanrop — mänsklig särskiljning är billig, modellatens är dyr. Skärmen visas bara när det finns
 * något att välja mellan: kunde identifieringen avgöra saken själv hoppas den över helt.
 */
export default function ModelSelectScreen({
  brand,
  candidates,
  onSelect,
  onManual,
}: {
  brand: string | null;
  candidates: ModelCandidate[];
  onSelect: (candidate: ModelCandidate) => void;
  onManual: (model: string) => void;
}) {
  const [manual, setManual] = useState("");
  const [manualOpen, setManualOpen] = useState(false);

  return (
    <div className="screen screen-light">
      <header className="home-header">
        <span className="brand-pill">
          <span className="brand-dot" /> STEG 1 AV 4
        </span>
        <h1 className="home-title">
          Vilken modell
          <br />
          <span className="accent">är det?</span>
        </h1>
        <p className="home-lede">
          {candidates.length > 0
            ? `Vi hittade ${candidates.length} ${brand ?? ""}-modeller som stämmer med bilderna. Välj den som är din.`
            : "Vi kunde inte peka ut någon modell ur bilderna. Skriv namnet själv om du vet det."}
        </p>
      </header>

      {candidates.length > 0 && (
        <div className="candidate-list">
          {candidates.map((c, i) => (
            <button key={`${c.model}-${i}`} className="candidate" onClick={() => onSelect(c)}>
              {/* Bild och namn, inget annat. Bilden ÄR jämförelsen — en säljare känner igen sin
                  möbel på en sekund och behöver inte läsa sig till skillnaden. */}
              <span className="candidate-photo">
                {c.imageUrl ? (
                  <img src={c.imageUrl} alt="" loading="lazy" onError={(e) => e.currentTarget.remove()} />
                ) : (
                  <span className="candidate-photo-empty" aria-hidden="true" />
                )}
              </span>
              <span className="candidate-name">{c.model}</span>
              <span className="candidate-chevron">
                <ChevronRight size={18} />
              </span>
            </button>
          ))}
        </div>
      )}

      {!manualOpen ? (
        <button className="btn btn-text manual-model-link" onClick={() => setManualOpen(true)}>
          {candidates.length > 0 ? "Ingen av dem — jag skriver själv" : "Skriv modellnamnet"}
        </button>
      ) : (
        <div className="form-group manual-model">
          <div className="form-row">
            <label className="form-row-label" htmlFor="manual-model">
              Modell
            </label>
            <input
              id="manual-model"
              className="form-row-input"
              value={manual}
              autoFocus
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && manual.trim() && onManual(manual.trim())}
              placeholder="t.ex. Söderhamn"
            />
          </div>
        </div>
      )}
      {manualOpen && (
        <button className="btn btn-primary" disabled={!manual.trim()} onClick={() => onManual(manual.trim())}>
          Fortsätt
        </button>
      )}
    </div>
  );
}
