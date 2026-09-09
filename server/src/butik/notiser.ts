/**
 * Beskeden om ett köp: till köparen, till säljaren, och till oss.
 *
 * VARFÖR FILEN FINNS. Fram till nu hände ett köp helt tyst. Möbeln blev såld i lagret, ordern skrevs
 * till en JSON-fil, och sedan var det slut: köparen fick inget kvitto, säljaren fick aldrig veta att
 * deras soffa var borta, och ingen hos oss fick veta att en leverans skulle bokas. Första riktiga
 * ordern hade legat och tickat tills någon råkat öppna panelen.
 *
 * TRE MOTTAGARE, TRE OLIKA BESKED, och skillnaden mellan dem är hela poängen:
 *
 *   KÖPAREN  vill veta att betalningen gick igenom, vad den avsåg, och när möbeln kommer. Brevet är
 *            ett kvitto och ett löfte, och det bär ordernumret som är vägen tillbaka till sidan.
 *   SÄLJAREN vill veta att möbeln är såld, för hur mycket, och att de inte behöver göra något. De
 *            får ALDRIG köparens adress eller e-post — säljaren är inte part i leveransen.
 *   VI       vill veta att det finns en leverans att boka. Det brevet är en arbetsorder och får
 *            innehålla allt.
 *
 * BREVET FÅR ALDRIG FÄLLA KÖPET. Varje utskick är omslutet av `sendLetter`, som loggar och går
 * vidare. Ett köp som gick igenom men vars kvitto inte kom fram är ett problem; ett köp som rullas
 * tillbaka för att en SMTP-server var nere är ett större.
 *
 * KANALEN ÄR `EMAIL_PROVIDER`. Med `gmail` går breven på riktigt, med `file` hamnar de i /outbox och
 * går att läsa som text. Se notify/outbox.ts — samma avsändare som efterlysningarna använder.
 */

import { adminEmails } from "../admin.js";
import { getJob } from "../jobStore.js";
import { sendLetter } from "../efterlysning/notify.js";
import type { Order, OrderSlot } from "./orders.js";
import type { ButikRecord } from "./store.js";

/** Adressen till en sida i produkten. Tom bas ger en relativ text i stället för en trasig länk. */
function link(path: string): string | null {
  const base = (process.env.LOOPA_PUBLIC_URL ?? "").replace(/\/+$/, "");
  return base ? `${base}${path}` : null;
}

/** Vilka som får arbetsordern. Adminlistan, eller Gmail-kontot när ingen admin är satt. */
function opsAddresses(): string[] {
  const admins = adminEmails();
  if (admins.length) return admins;
  const fallback = process.env.TRADERA_MAIL_NOTIFY_TO?.trim() || process.env.GMAIL_USER?.trim();
  return fallback ? [fallback] : [];
}

function kr(n: number): string {
  return `${n.toLocaleString("sv-SE")} kr`;
}

function slotText(slot: OrderSlot): string {
  const d = new Date(`${slot.date}T12:00:00`);
  return `${d.toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long" })} ${slot.window}`;
}

function rader(...lines: Array<string | null>): string {
  return lines.filter((l): l is string => l !== null).join("\n");
}

/**
 * Säljarens adress för en såld möbel.
 *
 * Går via jobbet, som bär `ownerEmail` sedan den skrevs dit vid skapandet. Saknas den är säljaren en
 * gammal post från före det fältet, och då finns ingen väg till dem alls — vi säger det i
 * arbetsordern i stället för att tiga om det.
 */
async function sellerEmail(record: ButikRecord | null): Promise<string | null> {
  if (!record?.jobId) return null;
  const job = await getJob(record.jobId);
  return job?.ownerEmail?.trim() || null;
}

// ---------------------------------------------------------------------------
// Köpet
// ---------------------------------------------------------------------------

/**
 * Allt som ska sägas när en betalning gått igenom. Anropas från `fulfilPaidOrder`.
 *
 * Körs efter att möbeln faktiskt blivit såld, aldrig före: ett kvitto på ett köp som sedan visade
 * sig kollidera med en Tradera-försäljning är värre än inget kvitto.
 */
export async function notifyPurchase(order: Order, record: ButikRecord | null, title: string): Promise<void> {
  const total = order.priceSek + order.deliveryFeeSek;
  const orderLink = link(`/butik/order/${order.id}`);

  if (order.email) {
    await sendLetter({
      to: order.email,
      subject: `Tack för ditt köp — ${title}`,
      kind: "kop-bekraftelse",
      body: rader(
        `Tack för ditt köp!`,
        "",
        `${title}`,
        `Ordernummer: ${order.reference}`,
        "",
        `Möbeln: ${kr(order.priceSek)}`,
        `Hemleverans: ${order.deliveryFeeSek ? kr(order.deliveryFeeSek) : "—"}`,
        `Betalt: ${kr(total)}`,
        "",
        "NÄSTA STEG: säg vilka tider som passar dig, så bokar vi frakten.",
        "Du väljer upp till tre tider och vi återkommer med den som budfirman kan ta.",
        orderLink ? `Din order: ${orderLink}` : null,
        "",
        "Möbeln är begagnad och unik. Vi bär in den till dörren.",
      ),
    });
  }

  const seller = await sellerEmail(record);
  if (seller) {
    await sendLetter({
      to: seller,
      subject: `Din möbel är såld — ${title}`,
      kind: "saljare-sald",
      body: rader(
        `Din möbel är såld.`,
        "",
        `${title}`,
        `Pris: ${kr(order.priceSek)}`,
        `Såld i: Loopa Butik`,
        "",
        "Du behöver inte göra något. Vi sköter leveransen till köparen och hör av oss om något",
        "behöver stämmas av. Annonsen är samtidigt nedtagen från våra andra kanaler.",
        link("/") ? `Följ läget i din profil: ${link("/")}` : null,
      ),
    });
  }

  for (const to of opsAddresses()) {
    await sendLetter({
      to,
      subject: `SÅLD i butiken: ${title} (${order.reference})`,
      kind: "ops-kop",
      body: rader(
        `Ett köp har gått igenom och en leverans ska bokas.`,
        "",
        `Möbel: ${title} (${order.productId})`,
        `Order: ${order.reference}`,
        `Belopp: ${kr(total)} varav frakt ${kr(order.deliveryFeeSek)}`,
        `Köpare: ${order.email ?? "adress saknas"}`,
        `Postnummer: ${order.postalCode ?? "—"} (${order.deliveryZone ?? "zon okänd"})`,
        "",
        seller ? `Säljaren är underrättad på ${seller}.` : "SÄLJAREN KUNDE INTE NÅS — jobbet saknar e-post. Hör av dig manuellt.",
        "",
        "Köparen ombeds nu lämna upp till tre tider. Boka frakten i panelens orderflik.",
        link("/?admin=1") ? `Panelen: ${link("/?admin=1")}` : null,
      ),
    });
  }
}

// ---------------------------------------------------------------------------
// Frakten
// ---------------------------------------------------------------------------

/** Köparen har lämnat sina tider. Nu är det vi som är sena, inte de. */
export async function notifySlotsRequested(order: Order, title: string): Promise<void> {
  const tider = order.requestedSlots.map((s) => `  • ${slotText(s)}`).join("\n");
  for (const to of opsAddresses()) {
    await sendLetter({
      to,
      subject: `BOKA FRAKT: ${title} (${order.reference})`,
      kind: "ops-frakt",
      body: rader(
        `Köparen har lämnat sina tider. Frakten ska bokas.`,
        "",
        `Möbel: ${title}`,
        `Order: ${order.reference}`,
        `Till: ${order.postalCode ?? "—"} (${order.deliveryZone ?? "zon okänd"})`,
        `Köpare: ${order.email ?? "adress saknas"}`,
        "",
        "Önskade tider, i den ordning köparen angav dem:",
        tider || "  (inga tider angivna)",
        "",
        link("/?admin=1") ? `Bekräfta i panelen: ${link("/?admin=1")}` : null,
      ),
    });
  }
  if (order.email) {
    await sendLetter({
      to: order.email,
      subject: `Vi bokar frakt — ${title}`,
      kind: "kop-bokar-frakt",
      body: rader(
        `Tack! Vi bokar frakten nu.`,
        "",
        "Vi försöker med de tider du angav:",
        tider || "  (inga tider angivna)",
        "",
        "Så snart budfirman bekräftat hör vi av oss med den tid som gäller. Du behöver inte göra",
        "något mer så länge.",
        link(`/butik/order/${order.id}`) ? `Din order: ${link(`/butik/order/${order.id}`)}` : null,
      ),
    });
  }
}

/** Frakten är bokad. EN tid gäller, och det är den enda som nämns. */
export async function notifyDeliveryBooked(order: Order, record: ButikRecord | null, title: string): Promise<void> {
  const when = order.deliveryDate ? slotText({ date: order.deliveryDate, window: order.deliveryWindow ?? "" }) : "tid saknas";
  if (order.email) {
    await sendLetter({
      to: order.email,
      subject: `Frakt bokad: ${when} — ${title}`,
      kind: "kop-frakt-bokad",
      body: rader(
        `Frakten är bokad.`,
        "",
        `${title}`,
        `Din tid: ${when}`,
        `Order: ${order.reference}`,
        "",
        "Vi bär in möbeln till dörren. Se till att vägen in är framkomlig, och hör av dig om något",
        "ändras.",
        link(`/butik/order/${order.id}`) ? `Din order: ${link(`/butik/order/${order.id}`)}` : null,
      ),
    });
  }
  const seller = await sellerEmail(record);
  if (seller) {
    await sendLetter({
      to: seller,
      subject: `Leveransen är bokad — ${title}`,
      kind: "saljare-frakt-bokad",
      body: rader(
        `Möbeln du sålde levereras ${when}.`,
        "",
        "Du behöver inte göra något. Beskedet kommer för att du ska kunna följa affären hela vägen.",
      ),
    });
  }
}

/** Levererad. Sista beskedet i kedjan, och det som avslutar affären för båda parter. */
export async function notifyDelivered(order: Order, record: ButikRecord | null, title: string): Promise<void> {
  if (order.email) {
    await sendLetter({
      to: order.email,
      subject: `Levererad — ${title}`,
      kind: "kop-levererad",
      body: rader(
        `Möbeln är levererad. Hoppas den kommer till nytta.`,
        "",
        `${title}`,
        `Order: ${order.reference}`,
        "",
        "Är något inte som du väntade dig, hör av dig så löser vi det.",
        link(`/butik/order/${order.id}`) ? `Din order: ${link(`/butik/order/${order.id}`)}` : null,
      ),
    });
  }
  const seller = await sellerEmail(record);
  if (seller) {
    await sendLetter({
      to: seller,
      subject: `Affären är klar — ${title}`,
      kind: "saljare-levererad",
      body: rader(`Möbeln du sålde är levererad till köparen. Affären är avslutad.`),
    });
  }
}

/**
 * Larmet: betalt, men möbeln var redan såld.
 *
 * Egen funktion och inte en rad i loggen, för att det här är det enda fallet i hela butiken där
 * pengar är dragna utan att någon vara bytt ägare. Både köparen och vi måste veta det inom minuter.
 * Köparens brev lovar återbetalning utan att be dem göra något — felet är vårt.
 */
export async function notifyDoubleSaleLetter(order: Order, title: string): Promise<void> {
  for (const to of opsAddresses()) {
    await sendLetter({
      to,
      subject: `ÅTERBETALNING KRÄVS: ${order.reference} (${title})`,
      kind: "ops-dubbelforsaljning",
      body: rader(
        `Ett kort har dragits för en möbel som redan var såld.`,
        "",
        `Order: ${order.reference}`,
        `Möbel: ${title} (${order.productId})`,
        `Belopp: ${kr(order.priceSek + order.deliveryFeeSek)}`,
        `Köpare: ${order.email ?? "adress saknas"}`,
        `Stripe-session: ${order.stripeSessionId ?? "—"}`,
        "",
        "ÅTERBETALA I STRIPE och hör av dig till köparen. Ordern är markerad avbruten.",
      ),
    });
  }
  if (order.email) {
    await sendLetter({
      to: order.email,
      subject: `Vi kunde inte fullfölja ditt köp — ${order.reference}`,
      kind: "kop-avbrutet",
      body: rader(
        `Tyvärr hann möbeln bli såld i en annan kanal medan din betalning behandlades.`,
        "",
        `Order: ${order.reference}`,
        "",
        "Hela beloppet betalas tillbaka. Du behöver inte göra något — vi hör av oss så snart",
        "återbetalningen är gjord. Vi beklagar verkligen.",
      ),
    });
  }
}
