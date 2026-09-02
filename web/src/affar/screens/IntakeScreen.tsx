import { useEffect, useRef, useState } from "react";
import { analyse, createDeal, stashAnalysis, takeStashedAnalysis, type IntakePayload } from "../api";
import type { Analysis } from "../types";
import { navigate, sharedUrlFromQuery } from "../router";
import PreliminaryCard from "../components/PreliminaryCard";
import BuyerFlow from "./BuyerFlow";
import { useAuth } from "../../auth/AuthProvider";

/**
 * Köparens intag: annonsen in, preliminär bedömning ut.
 *
 * ORDNINGEN ÄR VALD. Bedömningen görs FÖRE inloggningen, och affären skapas efter. Skälet är att
 * köparen inte vet om vi är värda ett konto förrän de sett vad vi kan säga om deras annons — och
 * den som inte går vidare har då inte lämnat något efter sig hos oss alls. Se `/api/affar/tolka`,
 * som är publik och inte sparar en affär.
 *
 * DELNING FRÅN BLOCKET-APPEN landar här med adressen ifylld, via manifestets share_target. Det
 * fungerar bara när appen är installerad på hemskärmen — i en vanlig flik finns ingen delningsmeny
 * att vara mål för. Fältet går alltid att fylla i för hand.
 */
export default function IntakeScreen() {
  const { user } = useAuth();
  const [adUrl, setAdUrl] = useState("");
  const [description, setDescription] = useState("");
  const [asking, setAsking] = useState("");
  const [postal, setPostal] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  /** Länken som ska köras genom hela flödet. Sätts när köparen skickar formuläret. */
  const [flowUrl, setFlowUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /** Sant tills hämtningen visat sig inte fungera. Styr hur mycket av formuläret som visas. */
  const [manualNeeded, setManualNeeded] = useState(false);
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const autoRan = useRef(false);

  // Delad adress från en annan app, och en bedömning som överlevde en inloggningsomväg.
  useEffect(() => {
    const shared = sharedUrlFromQuery();
    if (shared) setAdUrl(shared);
    const stashed = takeStashedAnalysis();
    if (stashed) {
      setAnalysis(stashed.analysis);
      setAdUrl(stashed.payload.adUrl ?? "");
      setDescription(stashed.payload.description ?? "");
      setAsking(stashed.payload.askingPriceSek ? String(stashed.payload.askingPriceSek) : "");
    }
  }, []);

  const payload = (): IntakePayload => ({
    images,
    adUrl: adUrl.trim() || null,
    description: description.trim() || null,
    askingPriceSek: asking.trim() ? Number(asking.replace(/\D/g, "")) : null,
  });

  const pickImages = async (files: FileList | null) => {
    if (!files) return;
    const read = (f: File) =>
      new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error("Kunde inte läsa bilden"));
        fr.readAsDataURL(f);
      });
    const next: string[] = [];
    for (const f of Array.from(files).slice(0, 8)) {
      try { next.push(await read(f)); } catch { /* hoppa över den som inte gick att läsa */ }
    }
    setImages((prev) => [...prev, ...next].slice(0, 8));
  };

  const run = async (override?: { adUrl?: string }) => {
    setBusy(true);
    setError(null);
    setFallbackReason(null);

    try {
      const result = await analyse({ ...payload(), ...(override ?? {}) });
      setAnalysis(result);
      // Hämtningen föll tillbaka på köparens eget material. Då behöver formuläret öppnas.
      if (result.fallbackReason) {
        setFallbackReason(result.fallbackReason);
        setManualNeeded(true);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Kunde inte bedöma annonsen.";
      setError(msg);
      // Servern svarar 422 med en förklaring när den varken fick hämta eller hade något att gå på.
      setManualNeeded(true);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Kom en länk med från butiken körs bedömningen direkt.
   *
   * Köparen har redan gjort sitt val — de klistrade in länken och tryckte. Att möta dem med samma
   * fält igen och en knapp de nyss tryckt på är att be dem bekräfta något de redan sagt.
   */
  useEffect(() => {
    if (autoRan.current || analysis) return;
    const shared = sharedUrlFromQuery();
    if (!shared) return;
    autoRan.current = true;
    setAdUrl(shared);
    setFlowUrl(shared);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startDeal = async () => {
    if (!user) {
      // Bedömningen läggs undan så köparen inte behöver göra om den efter inloggningen.
      if (analysis) stashAnalysis(payload(), analysis);
      window.location.href = "/";
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const { deal } = await createDeal({ ...payload(), postnummer: postal });
      navigate({ name: "deal", id: deal.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kunde inte skapa affären.");
      setCreating(false);
    }
  };

  // En länk räcker: servern läser annonsen. Bilder och text är reservvägen, inte kravet.
  const canAnalyse = adUrl.trim().length > 0 || images.length > 0 || description.trim().length > 10;

  /**
   * En LÄNK går genom hela flödet — modellval, mått, pris, annons — som när någon säljer.
   *
   * Egna skärmbilder går den korta vägen: att köra kandidatsökningen på skärmdumpar av en annonssida
   * ger sämre förslag än på annonsens egna produktbilder, och tar en minut för att göra det.
   */
  if (flowUrl) {
    return (
      <BuyerFlow
        adUrl={flowUrl}
        onNeedsManual={(reason) => {
          setFlowUrl(null);
          setFallbackReason(reason);
          setManualNeeded(true);
        }}
      />
    );
  }

  return (
    <div className="affar-page">
      <header className="affar-hero">
        <span className="affar-geo">📍 Just nu i Stockholm</span>
        <h1>Hittat en möbel någon annanstans?</h1>
        <p>
          Klistra in annonsen så säger vi vad vi tror om möbeln och priset — innan du hör av dig till säljaren.
          Vill du sedan köpa den tryggt sköter vi granskning, betalning och hemleverans.
        </p>
      </header>

      <section className="affar-card">
        <h2>Annonsen</h2>

        <label className="affar-label" htmlFor="ad-url">Länk till annonsen</label>
        <input
          id="ad-url"
          className="affar-input"
          type="url"
          inputMode="url"
          placeholder="https://www.blocket.se/annons/..."
          value={adUrl}
          onChange={(e) => setAdUrl(e.target.value)}
        />
        {/* Texten sa tidigare "vi öppnar inte länken", vilket var sant när köparen laddade upp allt
            själv. Nu läser servern annonsen — och en rad som beskriver förra versionen av produkten
            är värre än ingen rad alls. */}
        <p className="affar-hint">
          {manualNeeded
            ? "Länken sparas som din egen referens till annonsen. Bedömningen görs på bilderna du laddar upp."
            : "Vi öppnar annonsen och läser rubrik, bilder, text och pris åt dig."}
        </p>

        {fallbackReason && (
          <p className="affar-hint affar-fallback">{fallbackReason}</p>
        )}

        {!manualNeeded && !analysis && (
          <p className="affar-hint">
            Det räcker med länken — vi läser annonsens bilder, text och pris åt dig. Går det inte ber vi om
            skärmbilder i stället.
          </p>
        )}

        {manualNeeded && (
        <>
        <label className="affar-label">Skärmbilder av annonsen</label>
        <div className="affar-uploads">
          {images.map((src, i) => (
            <div key={i} className="affar-thumb">
              <img src={src} alt={`Annonsbild ${i + 1}`} />
              <button type="button" aria-label="Ta bort bilden" onClick={() => setImages((p) => p.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          {images.length < 8 && (
            <button type="button" className="affar-add" onClick={() => fileRef.current?.click()}>
              + Lägg till
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => { void pickImages(e.target.files); e.target.value = ""; }}
        />
        <p className="affar-hint">Ju fler vinklar, desto mer kan vi säga. Åtta bilder räcker gott.</p>

        <label className="affar-label" htmlFor="ad-text">Annonsens text</label>
        <textarea
          id="ad-text"
          className="affar-input affar-textarea"
          rows={4}
          placeholder="Klistra in säljarens beskrivning. Står märke och modell där hjälper det oss mycket."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <p className="affar-hint">
          Telefonnummer och mejladresser plockas bort automatiskt innan något sparas.
        </p>

        <label className="affar-label" htmlFor="ad-price">Begärt pris</label>
        <input
          id="ad-price"
          className="affar-input affar-input-short"
          type="number"
          inputMode="numeric"
          placeholder="4500"
          value={asking}
          onChange={(e) => setAsking(e.target.value)}
        />
        </>
        )}

        {error && <p className="affar-error">{error}</p>}

        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !canAnalyse}
          onClick={() => {
            const link = adUrl.trim();
            if (link && images.length === 0) return setFlowUrl(link);
            void run();
          }}
        >
          {busy ? "Läser annonsen…" : analysis ? "Bedöm igen" : "Bedöm annonsen"}
        </button>
        {!canAnalyse && (
          <p className="affar-hint">
            {manualNeeded
              ? "Ladda upp minst en bild, eller klistra in annonstexten."
              : "Klistra in länken till annonsen."}
          </p>
        )}
      </section>

      {analysis && (
        <>
          <PreliminaryCard analysis={analysis} />

          <section className="affar-card affar-cta">
            <h2>Köp tryggt via Loopa</h2>
            <p>
              Vi granskar möbeln på riktigt, håller betalningen tills du fått den, och kör hem den till dig.
              Säljaren behöver bara filma möbeln — resten sköter vi.
            </p>

            <label className="affar-label" htmlFor="postal">Ditt postnummer</label>
            <input
              id="postal"
              className="affar-input affar-input-short"
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="112 23"
              value={postal}
              onChange={(e) => setPostal(e.target.value)}
            />
            <p className="affar-hint">Vi kör bara inom Stockholms län än så länge.</p>

            <button
              type="button"
              className="btn btn-primary"
              disabled={creating || postal.replace(/\D/g, "").length < 5}
              onClick={startDeal}
            >
              {creating ? "Skapar affären…" : user ? "Bjud in säljaren" : "Logga in och bjud in säljaren"}
            </button>
          </section>
        </>
      )}
    </div>
  );
}
