import { useEffect, useState } from "react";
import { angraKopet, fetchOrder, requestSlots, type DeliverySlot, type Order } from "../api";
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
  /**
   * Tiderna köparen kryssat i, i den ordning de kryssades.
   *
   * ORDNINGEN ÄR INFORMATION och inte en slump: den första är förstahandsvalet, och det är den vi
   * försöker boka först. En `Set` hade tappat det.
   */
  const [valda, setValda] = useState<DeliverySlot[]>([]);
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
        // Tiderna följer med ordern — de räknas ur KÖPETS datum, inte ur dagens. Se fetchOrder.
        setSlots(r.slots ?? []);
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

  /**
   * Fyra steg, inte tre.
   *
   * "Vi bokar frakt" är ett eget steg för att det är ett eget tillstånd i verkligheten: köparen har
   * sagt när de kan, och vi ringer en budfirma. Utan steget står köparen med ett betalt köp och en
   * sida som inte rört sig sedan i förrgår, och den tystnaden tolkas alltid som att något gått fel.
   */
  const steps: Array<{ key: Order["status"][]; label: string }> = [
    { key: ["paid", "booking", "scheduled", "delivered", "return_requested", "returned"], label: "Bekräftad" },
    { key: ["booking", "scheduled", "delivered", "return_requested", "returned"], label: "Vi bokar frakt" },
    { key: ["scheduled", "delivered", "return_requested", "returned"], label: "Frakt bokad" },
    { key: ["delivered", "return_requested", "returned"], label: "Levererad" },
  ];

  /** Köpet är betalt och tiderna ovalda: DET är sidans ärende, och rubriken ska säga så. */
  const vantarPaTider = order.status === "paid" && slots.length > 0;

  /**
   * Går köpet fortfarande att ångra?
   *
   * Samma regel som servern håller (se `gårAttAngra` i butik/routes.ts) och samma gräns: fram till
   * dagen innan leveransen. Skrivs här också därför att en knapp som finns men svarar 409 är ett
   * sämre besked än en knapp som aldrig visas — servern är spärren, det här är beskedet.
   */
  const idagISO = new Date().toLocaleDateString("sv-SE");
  const angerbart =
    (order.status === "paid" || order.status === "booking" || order.status === "scheduled") &&
    (!order.deliveryDate || idagISO < order.deliveryDate);

  const isVald = (s: DeliverySlot) => valda.some((v) => v.date === s.date && v.window === s.window);

  const toggle = (slot: DeliverySlot) => {
    setValda((nu) => {
      const finns = nu.some((v) => v.date === slot.date && v.window === slot.window);
      if (finns) return nu.filter((v) => !(v.date === slot.date && v.window === slot.window));
      // Taket är tre. Ett fjärde kryss ersätter det äldsta i stället för att bara nekas tyst.
      return nu.length >= 3 ? [...nu.slice(1), slot] : [...nu, slot];
    });
  };

  const skickaTider = async () => {
    if (valda.length === 0) return;
    setBusy(true);
    try {
      const r = await requestSlots(order.id, valda.map((v) => ({ date: v.date, window: v.window })));
      setOrder(r.order);
      setValda([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kunde inte skicka tiderna.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="butik-hero" style={{ paddingBottom: 14 }}>
        <span className="butik-geo">Order {order.reference}</span>
        {/*
          RUBRIKEN SÄGER VAD SOM SKA GÖRAS, inte vad som hänt.

          "Tack för ditt köp!" var sant och slutgiltigt på samma gång: sidan såg ut som ett kvitto,
          och tidvalet — det enda köparen måste göra för att möbeln ska komma fram — låg som ett
          stycke bland andra långt ner. Tacket står kvar som en rad ovanför, där det hör hemma.
        */}
        {vantarPaTider && <p className="butik-order-tack">Tack för ditt köp!</p>}
        <h1 style={{ fontSize: "clamp(24px, 5.5vw, 34px)" }}>
          {order.status === "pending"
            ? "Vi behandlar din betalning"
            : order.status === "cancelled"
              ? "Köpet gick inte igenom"
              : vantarPaTider
                ? "Välj leveranstid!"
                : "Tack för ditt köp!"}
        </h1>
        {vantarPaTider && (
          <p style={{ marginTop: 6 }}>
            Möbeln är din. Det enda som återstår är att säga när vi får komma — välj nedan, så bokar vi frakten.
          </p>
        )}
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

          {order.status === "paid" && slots.length > 0 && (
            <section className="butik-explainer" style={{ padding: 18 }}>
              <h2 style={{ fontSize: 18 }}>När passar det att vi kommer?</h2>
              <p style={{ marginBottom: 14 }}>
                Förmiddag 08–12 eller eftermiddag 12–18, de fem närmaste arbetsdagarna. Välj upp till tre tider — vi
                bokar budfirman och återkommer med den som gäller, och försöker med din första hand först. Vi bär in
                möbeln till dörren.
              </p>
              <div className="butik-field-row">
                {slots.map((s) => (
                  <button
                    key={`${s.date}-${s.window}`}
                    type="button"
                    className="butik-chip"
                    aria-pressed={isVald(s)}
                    style={isVald(s) ? { borderColor: "var(--accent)", background: "var(--accent-light)", color: "var(--accent)" } : undefined}
                    disabled={busy}
                    onClick={() => toggle(s)}
                  >
                    {isVald(s) ? `${valda.findIndex((v) => v.date === s.date && v.window === s.window) + 1}. ` : ""}
                    {s.label} {s.window}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="btn btn-small"
                style={{ marginTop: 14 }}
                disabled={busy || valda.length === 0}
                onClick={skickaTider}
              >
                {valda.length === 0 ? "Välj minst en tid" : `Skicka ${valda.length} ${valda.length === 1 ? "tid" : "tider"}`}
              </button>
            </section>
          )}

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

          {order.status === "booking" && (
            <section className="butik-explainer" style={{ padding: 18 }}>
              <h2 style={{ fontSize: 18 }}>Vi bokar frakt</h2>
              <p style={{ marginBottom: 10 }}>
                Tack! Vi försöker med {order.requestedSlots.length === 1 ? "tiden" : "de här tiderna"} och hör av oss så
                snart budfirman bekräftat. Du behöver inte göra något så länge.
              </p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {order.requestedSlots.map((s, i) => (
                  <li key={`${s.date}-${s.window}`}>
                    {i === 0 ? <strong>{slotLabel(s.date)} {s.window}</strong> : <>{slotLabel(s.date)} {s.window}</>}
                    {i === 0 ? " (förstahandsval)" : ""}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {order.deliveryDate && (
            <section className="butik-explainer" style={{ padding: 18 }}>
              <h2 style={{ fontSize: 18 }}>Frakt bokad</h2>
              <p style={{ margin: 0 }}>
                <strong>{slotLabel(order.deliveryDate)}, {order.deliveryWindow}.</strong> Vi hör av oss dagen innan.
              </p>
            </section>
          )}

          {/* Historiken. Den svarar på "vad har hänt sedan jag betalade" utan att någon behöver fråga. */}
          {(order.events?.length ?? 0) > 0 && (
            <section className="butik-explainer" style={{ padding: 18 }}>
              <h2 style={{ fontSize: 18 }}>Vad som hänt</h2>
              <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                {[...(order.events ?? [])].reverse().map((e, i) => (
                  <li key={`${e.at}-${i}`} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                    <span style={{ color: "var(--muted-soft)", fontSize: "var(--fs-xs)", whiteSpace: "nowrap", minWidth: 92 }}>
                      {new Date(e.at).toLocaleDateString("sv-SE", { day: "numeric", month: "short" })}{" "}
                      {new Date(e.at).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <span>{e.note}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {/*
            ÅNGRA ÄR ATT STOPPA EN LEVERANS, INTE ATT HÄMTA TILLBAKA EN MÖBEL.

            Rutan lovade tidigare "Ångrar du dig hämtar vi möbeln" i varje läge — även efter att den
            burits in. Det är ett åtagande till: en budfirma till, en bärning till, och en möbel som
            ska tillbaka till lagret. Ångerrätten gäller därför medan möbeln fortfarande står hos
            oss. Är frakten bokad går det fram till dagen innan, för då är bilen bokad och en
            avbeställning på morgonen stoppar ingen som redan lastat.

            Efter leverans står här ingen knapp utan en väg till en människa. Det som händer sedan är
            en förhandling om en möbel någon har hemma, och den kan ingen knapp avgöra.
          */}
          <section className="butik-explainer" style={{ padding: 18 }}>
            <h2 style={{ fontSize: 18 }}>Ångra köpet</h2>
            {order.status === "cancel_requested" ? (
              <p style={{ margin: 0 }}>
                Vi har tagit emot din ångerbegäran, stoppar leveransen och betalar tillbaka hela beloppet — möbeln och
                frakten. Pengarna är hos dig inom några bankdagar.
              </p>
            ) : angerbart ? (
              <>
                <p style={{ marginBottom: 12 }}>
                  {order.deliveryDate ? (
                    <>
                      Leveransen är bokad till <strong>{slotLabel(order.deliveryDate)}</strong>. Du kan ångra köpet fram
                      till och med dagen innan — då stoppar vi frakten och betalar tillbaka hela beloppet.
                    </>
                  ) : (
                    <>
                      Möbeln står hos oss tills den körs ut, och fram till dagen innan leveransen kan du ångra dig. Vi
                      betalar då tillbaka hela beloppet, både möbeln och frakten.
                    </>
                  )}
                </p>
                <button
                  type="button"
                  className="btn btn-outline btn-small"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try { setOrder((await angraKopet(order.id)).order); }
                    catch (e) { setError(e instanceof Error ? e.message : "Kunde inte ångra köpet."); }
                    finally { setBusy(false); }
                  }}
                >
                  Ångra köpet
                </button>
              </>
            ) : (
              <p style={{ margin: 0 }}>
                {order.status === "delivered" || order.status === "return_requested" || order.status === "returned"
                  ? "Möbeln är levererad, så köpet går inte att ångra här. Hör av dig till oss med ordernumret så tittar vi på det tillsammans."
                  : "Leveransen är i morgon eller närmare och går inte att stoppa härifrån. Hör av dig till oss med ordernumret."}
              </p>
            )}
          </section>

        </>
      )}

      {/*
        Efterköpet är säljslingans bästa ögonblick: möbeln som ersattes står ofta kvar i hallen.

        RUBRIKEN NÄMNER INGEN MÖBELTYP, och det är ett rättat fel. Här stod "Sålde du just din gamla
        soffa?" — som var fel två gånger på samma rad: köparen hade nyss KÖPT, inte sålt, och möbeln
        var en stol. Typen finns inte att gissa från här heller: den härleds på servern
        (butik/catalog.ts `resolveTypeSlug`) och följer inte med varan ut, och en klientkopia av den
        katalogen vore en dubblett som glider isär för en rubriks skull. En fråga som är sann om
        varje möbel är bättre än en som är träffande om en av dem.
      */}
      <SellCta
        categorySlug={product?.categorySlug}
        heading="Blev en möbel över?"
        body="Den du ersatte kan du sälja här. Filma ett varv med mobilen så besiktigar, prissätter och lägger vi ut den åt dig."
      />
    </>
  );
}

/** "onsdag 9 september". Ett ISO-datum säger ingenting för den som ska vara hemma. */
function slotLabel(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long" });
}
