import { useEffect, useRef, useState } from "react";
import type { Product } from "../types";
import { fetchDelivery, startCheckout, type DeliveryQuote } from "../api";
import { useAuth } from "../../auth/AuthProvider";
import AuthScreen from "../../screens/AuthScreen";
import { track } from "./Bits";

/**
 * Köpet: postnummer, leveransbesked, och vidare till betalningen.
 *
 * POSTNUMRET FRÅGAS FÖRE betalningen, inte efter. Leveransavgiften är en post på beloppet, och ett
 * belopp som ändras efter att kortet dragits är inte ett pris utan en överraskning. Zonen och
 * avgiften räknas dessutom på servern (butik/delivery.ts) — den här rutan visar bara svaret.
 *
 * LEVERANSTIDEN väljs däremot EFTER betalningen, på orderskärmen. Möbeln är unik: hade tiden valts
 * först hade vi hållit en leveransplats åt någon som ännu inte betalat, och släppt den igen i hälften
 * av fallen.
 *
 * INLOGGNINGEN ÄR ETT ARK, INTE ETT FELMEDDELANDE. Knappen säger "Logga in och betala", och den som
 * trycker på den har bett om båda sakerna. Förut skickades köpet iväg ändå, servern svarade
 * "Inloggning krävs", och texten dök upp i röd stil under knappen — köparen fick veta vad som
 * saknades men inte var det fanns, och vägen dit gick via en annan sida och tillbaka. Nu öppnas
 * inloggningen ovanpå kassan, och när den går igenom fortsätter köpet av sig självt: postnumret står
 * kvar, möbeln är densamma, och trycket räknades en gång.
 */
export default function BuyPanel({ product }: { product: Product }) {
  const { user } = useAuth();
  const [postal, setPostal] = useState("");
  const [quote, setQuote] = useState<DeliveryQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const digits = postal.replace(/\D/g, "");

  useEffect(() => {
    if (digits.length < 5) { setQuote(null); return; }
    let live = true;
    fetchDelivery(digits).then((q) => { if (live) setQuote(q); }).catch(() => { if (live) setQuote(null); });
    return () => { live = false; };
  }, [digits]);

  // Kassan avstängd: ingen knapp alls hellre än en som leder till ett fel.
  const [configured, setConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    fetchDelivery("").then((q) => setConfigured(q.checkoutConfigured)).catch(() => setConfigured(false));
  }, []);

  const total = product.priceSek !== null ? product.priceSek + (quote?.zone?.feeSek ?? 0) : null;

  /** Inloggningsarket ovanpå kassan. Öppnas av knappen, inte av ett fel. */
  const [visaInloggning, setVisaInloggning] = useState(false);
  /**
   * Sant medan vi väntar på att sessionen ska landa efter en inloggning i arket.
   *
   * `signIn` fyller `user` via AuthProviders lyssnare, alltså i en senare rendering — inte när
   * `onDone` anropas. Att kalla `startCheckout` direkt i `onDone` hade därför skickat samma anrop
   * utan token som förut, och köparen hade fått tillbaka exakt det fel arket just stängde.
   */
  const fortsattEfterInloggning = useRef(false);

  const startaKassan = async () => {
    setBusy(true);
    setError(null);
    try {
      track("begin_checkout", { item_id: product.id, price: product.priceSek, delivery: quote?.zone?.id ?? null });
      const { checkoutUrl } = await startCheckout(product.id, digits);
      // Stripe tar över härifrån. Ordern är redan skapad och möbeln reserverad.
      window.location.href = checkoutUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kunde inte starta kassan.");
      setBusy(false);
    }
  };

  const buy = () => {
    // Utan konto: fråga efter det HÄR, ovanpå kassan. Se resonemanget överst.
    if (!user) {
      setError(null);
      setVisaInloggning(true);
      return;
    }
    void startaKassan();
  };

  // Sessionen landade efter inloggningen i arket — fortsätt till betalningen utan ett tryck till.
  useEffect(() => {
    if (!user || !fortsattEfterInloggning.current) return;
    fortsattEfterInloggning.current = false;
    void startaKassan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  if (configured === false) {
    return (
      <div className="butik-notice" role="status">
        <span aria-hidden="true">ℹ</span>
        <span>Kassan öppnar inom kort. Lägg en bevakning så hör vi av oss när möbeln går att köpa.</span>
      </div>
    );
  }

  return (
    /* Ingen egen ram och ingen egen rubrik: panelen bor inuti köprutan, som redan har båda (se
       .butik-buybox i butik.css). Måtten stod som inline-stilar och slog därför stilmallens regel —
       resultatet var en ruta i rutan med ett eget "Köp och hemleverans" under rubriken "Köp hos Loopa". */
    <section className="butik-explainer">
      <h2 style={{ fontSize: 18 }}>Köp och hemleverans</h2>
      {/* Klassen finns för att telefonen flyttar den här raden NER under fältet — se butik.css. */}
      <p className="butik-kop-lede" style={{ marginBottom: 14 }}>
        Skriv ditt postnummer så ser du fraktpris och totalsumma innan du betalar.
      </p>

      <div className="butik-field-row">
        <input
          className="butik-input"
          type="text"
          inputMode="numeric"
          maxLength={6}
          placeholder="Postnummer"
          value={postal}
          onChange={(e) => setPostal(e.target.value)}
          aria-label="Postnummer"
        />
      </div>

      {quote && (
        <div style={{ marginTop: 12 }}>
          <p style={{ margin: "0 0 8px", color: quote.deliverable ? "var(--green-dark)" : "var(--amber-ink)", lineHeight: 1.5 }}>
            {quote.deliverable ? "✓ " : "⚠ "}{quote.message}
          </p>
          {product.priceSek !== null && (
            <dl style={{ margin: 0, fontSize: "var(--fs-md)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                <dt>Möbeln</dt><dd style={{ margin: 0 }}>{product.priceSek.toLocaleString("sv-SE")} kr</dd>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                <dt>Hemleverans</dt>
                <dd style={{ margin: 0 }}>{quote.zone ? `${quote.zone.feeSek} kr` : "Ingår ej – vi hör av oss"}</dd>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0 0", borderTop: "1px solid var(--border)", marginTop: 6, fontWeight: 700 }}>
                <dt>Att betala</dt><dd style={{ margin: 0 }}>{total!.toLocaleString("sv-SE")} kr</dd>
              </div>
            </dl>
          )}
        </div>
      )}

      {error && <p style={{ color: "var(--danger-dark)", marginTop: 12, lineHeight: 1.5 }}>{error}</p>}

      <button
        type="button"
        className="btn btn-primary"
        style={{ marginTop: 14 }}
        disabled={busy || digits.length < 5 || product.priceSek === null}
        onClick={buy}
      >
        {busy ? "Öppnar kassan…" : user ? "Gå till betalning" : "Logga in och betala"}
      </button>
      <p className="butik-card-meta" style={{ marginTop: 10, lineHeight: 1.5 }}>
        Möbeln reserveras åt dig i 15 minuter medan du betalar. Leveranstid väljer du direkt efter köpet.
      </p>

      {visaInloggning && (
        /* Samma ark som filtren och bevakningen använder — ett mönster butiken redan har, och som
           stänger på klick utanför. `inbaddad` tar bort helsidesdelarna ur inloggningen; utan den
           ritas den som en egen skärm mitt i arket. */
        <div
          className="butik-sheet-backdrop"
          onClick={() => setVisaInloggning(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Logga in för att betala"
        >
          <div className="butik-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="butik-sheet-grip" />
            <AuthScreen
              intent="kop"
              inbaddad
              onDone={() => {
                fortsattEfterInloggning.current = true;
                setVisaInloggning(false);
              }}
              onBack={() => setVisaInloggning(false)}
            />
          </div>
        </div>
      )}
    </section>
  );
}
