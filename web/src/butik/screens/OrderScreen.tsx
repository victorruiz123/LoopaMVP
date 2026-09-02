import { useEffect, useState } from "react";
import { bookSlot, fetchDelivery, fetchOrder, requestReturn, type DeliverySlot, type Order } from "../api";
import type { Product } from "../types";
import { Link, SellCta, track } from "../components/Bits";

/**
 * Orderskärmen: bekräftad → planerad leverans → levererad.
 *
 * Leveranstiden väljs HÄR och inte i kassan, för möbeln är unik och en tid som hålls åt någon som
 * inte betalat är en tid som släpps igen i hälften av fallen.
 *
 * Att köparen står på den här sidan betyder INTE att betalningen gick igenom — adressen kan öppnas
 * av vem som helst som har ordernumret. Statusen läses därför från servern, som bara sätter "paid"
 * på en signaturverifierad webhook från Stripe. Kommer köparen tillbaka innan webhooken hunnit fram
 * står det att betalningen behandlas, inte att den misslyckades.
 */
export default function OrderScreen({ id }: { id: string }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const [slots, setSlots] = useState<DeliverySlot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let live = true;
    fetchOrder(id)
      .then((r) => {
        if (!live) return;
        setOrder(r.order);
        setProduct(r.product);
        if (r.order.status === "paid" && r.order.postalCode) {
          fetchDelivery(r.order.postalCode).then((q) => live && setSlots(q.slots)).catch(() => undefined);
        }
        // Webhooken kan vara sekunder efter köparen. Pollar en kort stund i stället för att påstå
        // att betalningen inte kom fram.
        if (r.order.status === "pending" && tries < 10) {
          setTimeout(() => live && setTries((n) => n + 1), 1500);
        }
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "Kunde inte hämta ordern."));
    return () => { live = false; };
  }, [id, tries]);

  useEffect(() => {
    if (order?.status === "paid") track("purchase", { transaction_id: order.reference, value: order.priceSek + order.deliveryFeeSek, currency: "SEK" });
  }, [order?.status]);

  if (error) {
    return (
      <div className="butik-empty">
        <h3>Vi hittar inte ordern</h3>
        <p>{error}</p>
        <Link to={{ name: "search", q: "" }} className="btn btn-outline btn-small">Till butiken</Link>
      </div>
    );
  }
  if (!order) return <div className="butik-skeleton" style={{ height: 220, margin: "30px 0" }} />;

  const steps: Array<{ key: Order["status"][]; label: string }> = [
    { key: ["paid", "scheduled", "delivered", "return_requested", "returned"], label: "Bekräftad" },
    { key: ["scheduled", "delivered", "return_requested", "returned"], label: "Planerad leverans" },
    { key: ["delivered", "return_requested", "returned"], label: "Levererad" },
  ];

  const book = async (slot: DeliverySlot) => {
    setBusy(true);
    try {
      const r = await bookSlot(order.id, slot.date, slot.window);
      setOrder(r.order);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kunde inte boka tiden.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="butik-hero" style={{ paddingBottom: 14 }}>
        <span className="butik-geo">Order {order.reference}</span>
        <h1 style={{ fontSize: "clamp(24px, 5.5vw, 34px)" }}>
          {order.status === "pending" ? "Vi behandlar din betalning" : order.status === "cancelled" ? "Köpet gick inte igenom" : "Tack för ditt köp!"}
        </h1>
        {order.status === "pending" && <p>Det tar oftast några sekunder. Sidan uppdaterar sig själv.</p>}
        {order.status === "cancelled" && (
          <p>
            Möbeln hann bli såld i en annan kanal medan betalningen behandlades. Har pengar dragits betalas de tillbaka
            automatiskt — vi hör av oss på {order.reference}.
          </p>
        )}
      </header>

      {order.status !== "pending" && order.status !== "cancelled" && (
        <>
          <ol style={{ display: "flex", gap: 8, listStyle: "none", padding: 0, margin: "0 0 24px", flexWrap: "wrap" }}>
            {steps.map((s) => {
              const done = s.key.includes(order.status);
              return (
                <li key={s.label} className="butik-trust-item" style={{ opacity: done ? 1 : 0.45 }}>
                  {done ? "✓" : "○"} {s.label}
                </li>
              );
            })}
          </ol>

          <section className="butik-explainer" style={{ padding: 18 }}>
            <h2 style={{ fontSize: 18 }}>{product?.title ?? "Din möbel"}</h2>
            <dl style={{ margin: 0, fontSize: "var(--fs-md)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                <dt>Möbeln</dt><dd style={{ margin: 0 }}>{order.priceSek.toLocaleString("sv-SE")} kr</dd>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                <dt>Hemleverans</dt><dd style={{ margin: 0 }}>{order.deliveryFeeSek ? `${order.deliveryFeeSek} kr` : "—"}</dd>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0 0", borderTop: "1px solid var(--border)", marginTop: 6, fontWeight: 700 }}>
                <dt>Betalt</dt><dd style={{ margin: 0 }}>{(order.priceSek + order.deliveryFeeSek).toLocaleString("sv-SE")} kr</dd>
              </div>
            </dl>
          </section>

          {order.status === "paid" && slots.length > 0 && (
            <section className="butik-explainer" style={{ padding: 18 }}>
              <h2 style={{ fontSize: 18 }}>Välj leveranstid</h2>
              <p style={{ marginBottom: 14 }}>Vi bär in möbeln till dörren. Välj en tid som passar — vi bekräftar den via SMS.</p>
              <div className="butik-field-row">
                {slots.map((s) => (
                  <button key={`${s.date}-${s.window}`} type="button" className="butik-chip" disabled={busy} onClick={() => book(s)}>
                    {s.label} {s.window}
                  </button>
                ))}
              </div>
            </section>
          )}

          {order.deliveryDate && (
            <section className="butik-explainer" style={{ padding: 18 }}>
              <h2 style={{ fontSize: 18 }}>Leverans bokad</h2>
              <p style={{ margin: 0 }}>
                {new Date(order.deliveryDate).toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long" })}, {order.deliveryWindow}.
                Vi hör av oss dagen innan.
              </p>
            </section>
          )}

          <section className="butik-explainer" style={{ padding: 18 }}>
            <h2 style={{ fontSize: 18 }}>Ångra köpet</h2>
            {order.status === "return_requested" ? (
              <p style={{ margin: 0 }}>Vi har tagit emot din returbegäran och hör av oss för att boka upphämtning.</p>
            ) : (
              <>
                {/* Ingen tidsgräns utlovad. Returen finns som funktion — villkoren för den sätts av
                    ops och ska inte uppfinnas i ett gränssnitt. */}
                <p style={{ marginBottom: 12 }}>Ångrar du dig hämtar vi möbeln. Hör av dig så bokar vi upphämtning.</p>
                <button
                  type="button"
                  className="btn btn-outline btn-small"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try { setOrder((await requestReturn(order.id)).order); }
                    catch (e) { setError(e instanceof Error ? e.message : "Kunde inte begära retur."); }
                    finally { setBusy(false); }
                  }}
                >
                  Begär retur
                </button>
              </>
            )}
          </section>
        </>
      )}

      {/* Efterköpet är säljslingans bästa ögonblick: möbeln som ersattes står ofta kvar i hallen. */}
      <SellCta
        categorySlug={product?.categorySlug}
        heading="Sålde du just din gamla soffa?"
        body="Nästa gång kan du sälja den här. Filma ett varv med mobilen så besiktigar, prissätter och lägger vi ut den åt dig."
      />
    </>
  );
}
