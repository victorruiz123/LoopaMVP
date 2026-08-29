import { useCallback, useEffect, useState } from "react";
import { fetchPublicCard } from "../api";
import { loopaIdFromPath, publicCardPath, readTypedLoopaId } from "../lib/loopaId";
import { ArrowLeftIcon, CardSearchIcon, CloseIcon } from "../components/icons";
import TruthCardView from "../components/TruthCardView";
import type { PublicCard } from "../types";
import { usePageTitle } from "../lib/pageTitle";

/**
 * Det publika truth-cardet — uppslaget på sitt Loopa-ID.
 *
 * Två vägar hit, samma skärm. Inifrån appen, via ikonen i topplisten, är det en sökruta säljaren kan
 * slå upp vilket kort som helst i. Utifrån, på /c/LP-XXXX-XXXX, är det sidan en köpare landar på från
 * Tradera-annonsen — utan konto, utan inloggning. Det är hela poängen med att kortet är publikt: ett
 * skick som inte går att kontrollera är bara ett påstående.
 *
 * Kortet ritas av samma vy som säljarens egen (TruthCardView). Det som skiljer ligger i svaret från
 * servern, inte här: säljarens bildrutor och ägaren följer aldrig med ut.
 */
export default function PublicCardScreen({
  initialId,
  onBack,
}: {
  initialId?: string | null;
  /** Saknas när skärmen är sidan på /c/… — då finns ingen app att gå tillbaka till. */
  onBack?: () => void;
}) {
  const [query, setQuery] = useState(initialId ?? "");
  const [card, setCard] = useState<PublicCard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const standalone = !onBack;
  usePageTitle(card ? `Truth-card ${card.loopaId}` : "Publikt truth-card");

  const lookup = useCallback(
    async (raw: string) => {
      const id = readTypedLoopaId(raw);
      if (!id) return;
      setLoading(true);
      setError(null);
      try {
        const found = await fetchPublicCard(id);
        setCard(found);
        // Adressen följer med sökningen, men bara på den fristående sidan: den är delbar och ska
        // peka på det kort som visas. Inne i appen vore det en väg tillbaka som lämnar appen.
        if (standalone) window.history.replaceState(null, "", publicCardPath(found.loopaId));
      } catch (err) {
        setCard(null);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [standalone],
  );

  // Ett ID i adressen slås upp direkt. Den som kommer från en annons har redan sökt.
  useEffect(() => {
    if (initialId) void lookup(initialId);
  }, [initialId, lookup]);

  return (
    <div className="screen screen-light public-card-screen">
      {onBack ? (
        <button className="btn btn-text btn-back" onClick={onBack}>
          <ArrowLeftIcon /> Tillbaka
        </button>
      ) : (
        <div className="app-bar">
          <span className="app-wordmark">Loopa</span>
        </div>
      )}

      <header className="public-card-head">
        <span className="brand-pill">
          <span className="brand-dot" /> PUBLIKT TRUTH-CARD
        </span>
        <h1 className="public-card-title">Sök på Loopa-ID</h1>
        <p className="muted small">
          Varje truth-card hos Loopa är publikt och har ett eget ID, som står i annonsen. Slå upp det så
          ser du hela besiktningen bakom priset: skicket, varje skada, måtten och källorna.
        </p>
      </header>

      <form
        className="brand-search public-card-search"
        onSubmit={(e) => {
          e.preventDefault();
          void lookup(query);
        }}
      >
        <span className="brand-search-icon">
          <CardSearchIcon size={17} />
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="LP-XXXX-XXXX"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          aria-label="Loopa-ID"
        />
        {query && (
          <button
            type="button"
            className="brand-search-clear"
            onClick={() => {
              setQuery("");
              setCard(null);
              setError(null);
            }}
            aria-label="Rensa"
          >
            <CloseIcon size={12} />
          </button>
        )}
      </form>
      <button className="btn btn-primary public-card-submit" onClick={() => void lookup(query)} disabled={loading || !query.trim()}>
        {loading ? "Söker…" : "Visa truth-card"}
      </button>

      {error && !loading && <p className="public-card-error">{error}</p>}

      {card && !loading && (
        <>
          <div className="public-card-meta">
            <span className="loopa-id-value">{card.loopaId}</span>
            <span className="muted small">Besiktigat av Loopas AI {formatDate(card.createdAt)}</span>
          </div>
          <TruthCardView
            card={card.card}
            identity={card.identity}
            grade={card.grade}
            price={card.price}
            damages={card.damages}
            imageCount={card.imageCount}
            reviewed={card.reviewed}
            productImage={card.productImage}
            loopaId={card.loopaId}
          />
          {card.tradera?.status === "published" && card.tradera.url && (
            <a className="btn btn-primary public-card-tradera" href={card.tradera.url} target="_blank" rel="noreferrer">
              Se annonsen på Tradera
            </a>
          )}
        </>
      )}

      {/* Bara på den fristående sidan. Den som kommit hit från en annons är inte inloggad och har
          ingen väg vidare in i Loopa — inne i appen är knappen en väg tillbaka till där man står. */}
      {standalone && (
        <a className="public-card-cta" href="/">
          Skickbedöm din egen möbel med Loopa
        </a>
      )}
    </div>
  );
}

/** Adressens ID, när sidan är öppnad utifrån. Läses en gång vid start — appen har ingen router. */
export function publicCardIdFromLocation(): string | null {
  return loopaIdFromPath(window.location.pathname);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("sv-SE", { day: "numeric", month: "long", year: "numeric" });
}
