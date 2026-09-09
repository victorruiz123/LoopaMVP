/**
 * Handeln i profilen: det man säljer, det man köper, och var varje sak står.
 *
 * EN SANNING OM LÄGET. `statusLine` är affärsrummets egen mening om vad som händer just nu, och den
 * återanvänds rakt av här. En egen formulering i listan hade blivit ett andra ställe där en affär
 * kan beskrivas — och den dagen de två sa olika saker hade ingen vetat vilken som gällde.
 *
 * VAD SOM ÄR EN RAD OCH INTE. Affären visar kortet när det finns: efter att säljaren filmat är
 * betyget och det granskade priset det enda som betyder något, och att gömma dem bakom ett klick
 * hade gjort listan till en innehållsförteckning. Före filmningen finns inget kort, och då står det
 * ingenting — vi gissar inte om en möbel ingen sett.
 */

import type { DealView } from "../affar/types";
import { statusLine } from "../affar/components/Timeline";
import { affarHref } from "../affar/router";
import type { Order } from "../butik/api";
import type { Product } from "../butik/types";
import { butikHref } from "../butik/router";
import { formatSek } from "../lib/price";
import { plural } from "./stats";

const SEK = (n: number | null | undefined) => (n === null || n === undefined ? "—" : formatSek(n));

/** Vad en order heter för den som köpt. Marknadsplatsen nämns inte — det är Loopa man köpt av. */
const ORDER_LABEL: Record<Order["status"], string> = {
  pending: "Kassan är påbörjad",
  paid: "Betald",
  booking: "Vi bokar frakt",
  scheduled: "Frakt bokad",
  delivered: "Levererad",
  return_requested: "Retur begärd",
  returned: "Returnerad",
  cancelled: "Avbruten",
};

/**
 * Brickan säger vad som väntar på KÖPAREN — inte vad ordern heter.
 *
 * Först upprepade den statusraden ordagrant ("Leverans bokad" två gånger på samma rad), vilket är
 * två sätt att säga samma sak och noll sätt att säga vad man ska göra. Nu bär den bara de lägen där
 * något faktiskt ligger och väntar; resten står i statusraden och behöver ingen andra röst.
 */
const ORDER_TODO: Partial<Record<Order["status"], string>> = {
  pending: "Slutför köpet",
  paid: "Välj tider för leveransen",
  return_requested: "Retur pågår",
};

export function DealRow({ deal }: { deal: DealView }) {
  const dead = deal.state === "declined" || deal.state === "expired";
  const waiting = deal.awaiting === deal.role;
  const price = deal.agreedPriceSek ?? deal.askingPriceSek;

  return (
    <li>
      <a className="trade-row" href={affarHref({ name: "deal", id: deal.id })}>
        <span className="trade-row-body">
          <span className="trade-row-title">
            {deal.card ? [deal.card.brand, deal.card.model].filter(Boolean).join(" ") || deal.what : deal.what}
          </span>
          <span className="trade-row-status">{statusLine(deal)}</span>

          {/* Kortet, när säljaren filmat. Betyget och det granskade priset — inget mer: raden ska
              gå att läsa, och resten står i affärsrummet. */}
          {deal.card && (
            <span className="trade-row-card">
              {deal.card.gradeLabel && <span className="trade-chip trade-chip-grade">{deal.card.gradeLabel}</span>}
              {deal.card.suggestedPriceSek !== null && (
                <span className="trade-chip">Granskat pris {SEK(deal.card.suggestedPriceSek)}</span>
              )}
              {deal.card.defects.length > 0 && (
                <span className="trade-chip">{plural(deal.card.defects.length, "anmärkning", "anmärkningar")}</span>
              )}
            </span>
          )}

          {/* Vad man får göra. Samma svar som knapparna i affärsrummet ger — se actionsFor. */}
          {!dead && deal.actions && (deal.actions.canAccept || deal.actions.canCounter) && (
            <span className="trade-row-actions">
              {deal.actions.canAccept && <span className="trade-chip trade-chip-do">Svara på priset</span>}
              {deal.actions.canCounter && <span className="trade-chip">Motbud möjligt</span>}
              {deal.actions.hasAccepted && <span className="trade-chip">Du har accepterat</span>}
            </span>
          )}
        </span>

        <span className="trade-row-side">
          <span className="trade-row-amount">{SEK(price)}</span>
          {waiting && !dead && <span className="trade-badge trade-badge-vantar">Din tur</span>}
          {dead && <span className="trade-badge trade-badge-dod">Avslutad</span>}
        </span>
      </a>
    </li>
  );
}

export function OrderRow({ order, product }: { order: Order; product: Product | null }) {
  const todo = ORDER_TODO[order.status];
  return (
    <li>
      <a className="trade-row" href={butikHref({ name: "order", id: order.id })}>
        {product?.imageUrl && <img className="trade-row-thumb" src={product.imageUrl} alt="" />}
        <span className="trade-row-body">
          <span className="trade-row-title">{product?.title ?? `Order ${order.reference}`}</span>
          <span className="trade-row-status">
            {ORDER_LABEL[order.status]}
            {order.deliveryDate ? ` · ${order.deliveryDate} ${order.deliveryWindow ?? ""}` : ""}
          </span>
          <span className="trade-row-meta">
            {order.reference}
            {order.deliveryFeeSek ? ` · frakt ${SEK(order.deliveryFeeSek)}` : ""}
          </span>
        </span>
        <span className="trade-row-side">
          <span className="trade-row-amount">{SEK(order.priceSek + order.deliveryFeeSek)}</span>
          {todo && <span className="trade-badge trade-badge-vantar">{todo}</span>}
        </span>
      </a>
    </li>
  );
}

/** Siffrorna över en avdelning. Tomma tal visas inte — en nolla utan innehåll är brus. */
export function StatGrid({ items }: { items: Array<{ label: string; value: string; hint?: string }> }) {
  return (
    <div className="trade-stats">
      {items.map((s) => (
        <div className="trade-stat" key={s.label}>
          <div className="trade-stat-value">{s.value}</div>
          <div className="trade-stat-label">{s.label}</div>
          {s.hint && <div className="trade-stat-hint">{s.hint}</div>}
        </div>
      ))}
    </div>
  );
}
