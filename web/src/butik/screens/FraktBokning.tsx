import { useMemo, useState } from "react";
import { requestFraktSlots, type DeliverySlot, type Order } from "../api";
import type { Product } from "../types";
import "./frakt.css";

/**
 * Fraktsidan för Tradera-köparen — den som kommer från SMS:et, utan konto.
 *
 * SIDAN HAR ETT ENDA ÄRENDE: välj när vi får komma. Allt annat (pris, historik, ordernummer)
 * ligger under, eller i en hopfälld ruta. Köparen ska förstå vad som ska göras på en blick, med
 * tummen, utan att läsa ett stycke först.
 */
export default function FraktBokning({
  token, order, product, slots, utanforZon, onOrder,
}: {
  token: string;
  order: Order;
  product: Product | null;
  slots: DeliverySlot[];
  utanforZon: boolean;
  onOrder: (o: Order) => void;
}) {
  /** Ordningen är förstahandsvalet först — se OrderScreen. */
  const [valda, setValda] = useState<DeliverySlot[]>([]);
  const [busy, setBusy] = useState(false);
  const [fel, setFel] = useState<string | null>(null);

  const dagar = useMemo(() => {
    const m = new Map<string, DeliverySlot[]>();
    for (const s of slots) m.set(s.date, [...(m.get(s.date) ?? []), s]);
    return [...m.entries()];
  }, [slots]);

  const plats = (s: DeliverySlot) => valda.findIndex((v) => v.date === s.date && v.window === s.window);
  const toggle = (s: DeliverySlot) =>
    setValda((nu) => (plats(s) >= 0 ? nu.filter((v) => !(v.date === s.date && v.window === s.window)) : nu.length >= 3 ? [...nu.slice(1), s] : [...nu, s]));

  const skicka = async () => {
    if (!valda.length) return;
    setBusy(true);
    setFel(null);
    try {
      const r = await requestFraktSlots(token, valda.map((v) => ({ date: v.date, window: v.window })));
      onOrder(r.order);
      setValda([]);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setFel(e instanceof Error ? e.message : "Kunde inte skicka tiderna. Försök igen.");
    } finally {
      setBusy(false);
    }
  };

  const adress = order.kopare
    ? [order.kopare.adress, [order.kopare.postnummer, order.kopare.ort].filter(Boolean).join(" ")].filter(Boolean).join(", ")
    : null;
  const valjer = order.status === "paid" && slots.length > 0 && !utanforZon;
  const steg = ["paid", "booking", "scheduled", "delivered"] as const;
  // Steget som är KLART. "paid" betyder att betalningen är klar och att tiderna är nästa sak att göra.
  const stegKlart = Math.max(0, steg.indexOf(order.status as (typeof steg)[number]));

  const Mobel = (
    <div className="fb-mobel">
      <div className="fb-bild">{product?.imageUrl ? <img src={product.imageUrl} alt="" /> : <span>🛋️</span>}</div>
      <div>
        <div className="fb-mobel-titel">{product?.title ?? "Din möbel"}</div>
        <div className="fb-mobel-meta">
          <span className="fb-betald">✓ Betald</span> Köpt på Tradera
        </div>
      </div>
    </div>
  );

  return (
    <div className="fb">
      <Progress klart={stegKlart} />

      <div className="fb-grid">
        <div className="fb-main">
          <div className="fb-bara-mobil">{Mobel}</div>

          {valjer && (
            <>
              <h1 className="fb-h1">När kan du ta emot den?</h1>
              <p className="fb-lead">Tryck på de tider du kan vara hemma. <b>Välj gärna 2–3</b>, så hittar vi en bil snabbare.</p>
              {adress && <Adress adress={adress} />}

              <div className="fb-dagar">
                {dagar.map(([datum, pass]) => (
                  <div className="fb-dag" key={datum}>
                    <div className="fb-dag-namn">
                      <b>{veckodag(datum)}</b>
                      <span>{dagMånad(datum)}</span>
                    </div>
                    <div className="fb-pass">
                      {pass.map((s) => {
                        const i = plats(s);
                        return (
                          <button key={s.window} type="button" className="fb-slot" aria-pressed={i >= 0} disabled={busy} onClick={() => toggle(s)}>
                            <span className="fb-slot-namn">{passNamn(s.window)}</span>
                            <span className="fb-slot-tid">{s.window}</span>
                            {i >= 0 && <span className="fb-nr">{i + 1}</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <p className="fb-not">Siffran visar ordningen — ditt förstaval försöker vi boka först. Max tre tider.</p>
            </>
          )}

          {order.status === "paid" && utanforZon && (
            <>
              <h1 className="fb-h1">Vi ordnar frakten åt dig</h1>
              {adress && <Adress adress={adress} />}
              <div className="fb-ruta">
                <p>Din adress ligger utanför områdena där vi kör själva. Du behöver inte göra något — vi hör av oss inom kort med hur och när möbeln kommer fram.</p>
              </div>
            </>
          )}

          {order.status === "booking" && (
            <>
              <div className="fb-klar-ikon">✓</div>
              <h1 className="fb-h1">Tack! Nu bokar vi bilen</h1>
              <p className="fb-lead">Vi hör av oss så snart budfirman bekräftat. Du behöver inte göra något mer.</p>
              <div className="fb-ruta">
                <div className="fb-ruta-rubrik">Dina tider</div>
                <ol className="fb-valda-lista">
                  {order.requestedSlots.map((s, i) => (
                    <li key={`${s.date}-${s.window}`}>
                      <span className="fb-nr fb-nr-statisk">{i + 1}</span>
                      <span>{veckodag(s.date)} {dagMånad(s.date)}</span>
                      <span className="fb-mute">{s.window}</span>
                    </li>
                  ))}
                </ol>
              </div>
              {adress && <Adress adress={adress} />}
            </>
          )}

          {order.status === "scheduled" && order.deliveryDate && (
            <>
              <h1 className="fb-h1">Leveransen är bokad</h1>
              <div className="fb-datum-stor">
                <span>{veckodag(order.deliveryDate)}</span>
                <b>{dagMånad(order.deliveryDate)}</b>
                <span>kl {order.deliveryWindow}</span>
              </div>
              <p className="fb-lead">Vi hör av oss dagen innan. Vi bär in möbeln till dörren.</p>
              {adress && <Adress adress={adress} />}
            </>
          )}

          {order.status === "delivered" && (
            <>
              <div className="fb-klar-ikon">✓</div>
              <h1 className="fb-h1">Levererad — mycket nöje!</h1>
            </>
          )}

          {fel && <p className="fb-fel">{fel}</p>}

          <details className="fb-detaljer">
            <summary>Kvitto och frågor</summary>
            <dl>
              <div><dt>Möbeln</dt><dd>{order.priceSek.toLocaleString("sv-SE")} kr</dd></div>
              <div><dt>Hemleverans</dt><dd>{order.deliveryFeeSek ? `${order.deliveryFeeSek} kr` : "Ingår"}</dd></div>
              <div className="fb-summa"><dt>Totalt betalt</dt><dd>{(order.priceSek + order.deliveryFeeSek).toLocaleString("sv-SE")} kr</dd></div>
            </dl>
            <p>
              Frågor? Mejla <a href="mailto:info@loopa.nu">info@loopa.nu</a> och ange order <b>{order.reference}</b>
              {order.tradera?.ordernummer ? <> (Tradera {order.tradera.ordernummer})</> : null}.
            </p>
            {(order.events?.length ?? 0) > 0 && (
              <ol className="fb-historik">
                {[...(order.events ?? [])].reverse().map((e, i) => (
                  <li key={`${e.at}-${i}`}>
                    <span>{new Date(e.at).toLocaleDateString("sv-SE", { day: "numeric", month: "short" })}</span>
                    {e.note}
                  </li>
                ))}
              </ol>
            )}
          </details>
        </div>

        {/* Datorn: möbeln och valen ligger kvar i sidled medan man väljer. */}
        <aside className="fb-sida">
          <div className="fb-kort">
            <div className="fb-bild fb-bild-stor">{product?.imageUrl ? <img src={product.imageUrl} alt="" /> : <span>🛋️</span>}</div>
            <div className="fb-mobel-titel">{product?.title ?? "Din möbel"}</div>
            <div className="fb-mobel-meta"><span className="fb-betald">✓ Betald</span> Köpt på Tradera</div>
            {valjer && (
              <>
                <hr />
                <div className="fb-ruta-rubrik">Dina val</div>
                {valda.length === 0 ? (
                  <p className="fb-mute">Inga tider valda än.</p>
                ) : (
                  <ol className="fb-valda-lista">
                    {valda.map((s, i) => (
                      <li key={`${s.date}-${s.window}`}>
                        <span className="fb-nr fb-nr-statisk">{i + 1}</span>
                        <span>{veckodag(s.date)} {dagMånad(s.date)}</span>
                        <span className="fb-mute">{s.window}</span>
                      </li>
                    ))}
                  </ol>
                )}
                <button type="button" className="fb-cta" disabled={busy || !valda.length} onClick={skicka}>
                  {ctaText(valda.length, busy)}
                </button>
              </>
            )}
          </div>
        </aside>
      </div>

      {/* Mobilen: knappen står alltid under tummen. */}
      {valjer && (
        <div className="fb-bar">
          <button type="button" className="fb-cta" disabled={busy || !valda.length} onClick={skicka}>
            {ctaText(valda.length, busy)}
          </button>
        </div>
      )}
    </div>
  );
}

function Progress({ klart }: { klart: number }) {
  const namn = ["Betald", "Tider valda", "Bil bokad", "Levererad"];
  return (
    <ol className="fb-progress">
      {namn.map((n, i) => (
        <li key={n} className={i <= klart ? "klar" : i === klart + 1 ? "nu" : ""}>
          <span className="fb-prick">{i <= klart ? "✓" : i + 1}</span>
          <span className="fb-progress-namn">{n}</span>
        </li>
      ))}
    </ol>
  );
}

function Adress({ adress }: { adress: string }) {
  return (
    <div className="fb-adress">
      <span className="fb-adress-ikon" aria-hidden>📍</span>
      <div>
        <div className="fb-mute fb-liten">Vi kör hem till</div>
        <div className="fb-adress-text">{adress}</div>
      </div>
    </div>
  );
}

function ctaText(n: number, busy: boolean) {
  if (busy) return "Skickar…";
  if (n === 0) return "Välj minst en tid";
  return `Boka ${n === 1 ? "tiden" : `${n} tider`} →`;
}

const dag = (d: string) => new Date(`${d}T12:00:00`);
const veckodag = (d: string) => { const s = dag(d).toLocaleDateString("sv-SE", { weekday: "long" }); return s[0].toUpperCase() + s.slice(1); };
const dagMånad = (d: string) => dag(d).toLocaleDateString("sv-SE", { day: "numeric", month: "short" }).replace(".", "");
const passNamn = (w: string) => (parseInt(w, 10) < 12 ? "Förmiddag" : "Eftermiddag");
