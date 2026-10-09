import { useEffect, useMemo, useState } from "react";
import { getMinAffiliate, getMinInbjudan, imageUrl, listJobs, loggaLankKopierad } from "../api";
import { useAuth } from "../auth/AuthProvider";
import GradeBadge from "../components/GradeBadge";
import { ArrowLeftIcon, CardIcon, CheckIcon, ChevronRight, CopyIcon, SendIcon, UsersIcon } from "../components/icons";
import { formatSek } from "../lib/price";
import type { JobSummary, MinAffiliate, MinInbjudan } from "../types";
import { usePageTitle } from "../lib/pageTitle";
import LegalLink from "../components/LegalLink";
import LanguagePicker from "../components/LanguagePicker";
import { reopenConsent } from "../lib/consent";
import { useLang, useT } from "../lib/i18n";
import { fetchMyDeals } from "../affar/api";
import { fetchMyOrders } from "../butik/api";
import type { DealView } from "../affar/types";
import type { Order } from "../butik/api";
import type { Product } from "../butik/types";
import { buyStats, CLOSED_DEAL_STATES, sellStats } from "../profil/stats";
import { DealRow, OrderRow } from "../profil/TradeSections";
import { formatOre } from "../components/Affiliate";

/**
 * Profilen: allt konto-innehavaren handlar med, sålt som köpt, på ett ställe.
 *
 * OMDESIGN (grenen ui/omdesign): samma information som förut, men ordnad bakom knappar i stället för
 * i en lång lista. Tre flikar — Säljer, Köper, Tjäna — och inom Säljer ett filter per läge. Siffrorna
 * står överst som en rad tal; texten är kortad till etiketter. På datorn ligger kontot och siffrorna i
 * en sidopanel och innehållet bredvid.
 *
 * TRE KÄLLOR, tre frågor (oförändrat):
 *
 *   GET /api/jobs           vad jag filmat och lagt ut       — med butikens läge per möbel
 *   GET /api/butik/order    vad jag köpt i butiken
 *   GET /api/affar          affärer där jag är köpare ELLER säljare, med läge, actions och kort
 *
 * Siffrorna räknas ur just de listorna (profil/stats.ts) och inte på servern.
 */
type Flik = "salj" | "kop" | "tjana";
type SaljFilter = "ute" | "salda" | "sparade" | "affarer";

export default function ProfileScreen({
  onBack,
  onOpenJob,
  isAdmin = false,
  onOpenAdmin,
}: {
  onBack: () => void;
  /** Öppna ett annonskort. Tar hela raden: den bär både `id` och `loopaId`. */
  onOpenJob: (job: JobSummary) => void;
  /** Serverns besked ur inloggningen. Ingången ritas bara då — och prövas igen bakom varje adminväg. */
  isAdmin?: boolean;
  onOpenAdmin?: () => void;
}) {
  const t = useT();
  const { lang } = useLang();
  const { user, profile, signOut } = useAuth();
  usePageTitle("Din profil");
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [orders, setOrders] = useState<Array<{ order: Order; product: Product | null }> | null>(null);
  const [deals, setDeals] = useState<DealView[] | null>(null);
  const [flik, setFlik] = useState<Flik | null>(null);
  const [filter, setFilter] = useState<SaljFilter | null>(null);

  /** Tre hämtningar, var och en med sitt eget fall — en lista som faller tömmer inte de andra. */
  useEffect(() => {
    listJobs().then(setJobs).catch(() => setJobs([]));
    fetchMyOrders().then((r) => setOrders(r.orders)).catch(() => setOrders([]));
    fetchMyDeals().then((r) => setDeals(r.deals)).catch(() => setDeals([]));
  }, []);

  const cards = (jobs ?? []).filter((j) => j.hasListing);
  const valued = cards.filter((j) => j.price?.status === "ok" && j.price.default !== null);
  const totalValue = valued.reduce((sum, j) => sum + (j.price?.default ?? 0), 0);

  /** Vad som ligger ute — oavsett var. Butiken räknas lika mycket som Tradera. */
  const selling = cards.filter(
    (j) =>
      j.sale?.status === "published" ||
      j.sale?.status === "publishing" ||
      j.sale?.status === "pending" ||
      j.shop?.state === "live" ||
      j.shop?.state === "reserved",
  );
  const soldCards = cards.filter((j) => j.shop?.state === "sold" || j.shop?.state === "delivered");
  const saved = cards.filter((j) => !selling.includes(j) && !soldCards.includes(j));

  const displayName = profile?.full_name || profile?.username || user?.email?.split("@")[0] || t("Säljare");

  const sell = sellStats(jobs ?? [], deals ?? []);
  const buy = buyStats(orders ?? [], deals ?? []);
  const sellerDeals = (deals ?? []).filter((d) => d.role === "seller");
  const buyerDeals = (deals ?? []).filter((d) => d.role === "buyer");
  const byOpen = (a: DealView, b: DealView) =>
    Number(CLOSED_DEAL_STATES.includes(a.state)) - Number(CLOSED_DEAL_STATES.includes(b.state));
  const oppnaAffarer = buy.openDeals + sellerDeals.filter((d) => !CLOSED_DEAL_STATES.includes(d.state)).length;
  const vantar = buy.needsMe + sell.needsMe;
  const kopAntal = buyerDeals.length + (orders ?? []).length;

  /**
   * Fliken man landar på: den där något finns. Den som bara köpt ska inte mötas av en tom säljlista.
   * Ett eget val vinner alltid.
   */
  const aktivFlik: Flik = flik ?? (cards.length === 0 && sellerDeals.length === 0 && kopAntal > 0 ? "kop" : "salj");
  const filterAntal: Record<SaljFilter, number> = {
    ute: selling.length,
    salda: soldCards.length,
    sparade: saved.length,
    affarer: sellerDeals.length,
  };
  const aktivtFilter: SaljFilter =
    filter ?? ((["ute", "salda", "sparade", "affarer"] as SaljFilter[]).find((f) => filterAntal[f] > 0) ?? "ute");
  const filterJobb: Record<Exclude<SaljFilter, "affarer">, JobSummary[]> = { ute: selling, salda: soldCards, sparade: saved };

  return (
    <div className="screen screen-light profile pf">
      <button className="btn btn-text btn-back" onClick={onBack}>
        <ArrowLeftIcon /> {t("Tillbaka")}
      </button>

      <div className="pf-layout">
        {/* ── Sidopanelen: vem, siffrorna, kontot ─────────────────────────── */}
        <aside className="pf-sida">
          <section className="pf-jag">
            <div className="pf-avatar" aria-hidden>
              {initials(displayName)}
            </div>
            <div className="pf-jag-text">
              <h1 className="pf-namn">{displayName}</h1>
              <p className="pf-epost">{user?.email}</p>
            </div>
          </section>

          <dl className="pf-tal">
            <Tal etikett={t("Annonser")} varde={String(sell.cards)} under={sell.live ? t("{antal} ute", { antal: sell.live }) : undefined} />
            <Tal etikett={t("Sålt")} varde={sell.sold ? formatSek(sell.earned) : "—"} under={sell.sold ? t("{antal} st", { antal: sell.sold }) : undefined} />
            <Tal etikett={t("Värde")} varde={valued.length ? formatSek(totalValue) : "—"} under={sell.liveValue ? t("{belopp} ute", { belopp: formatSek(sell.liveValue) }) : undefined} />
            <Tal etikett={t("Köpt")} varde={buy.completed ? formatSek(buy.spent) : "—"} under={buy.completed ? t("{antal} st", { antal: buy.completed }) : undefined} />
            <Tal etikett={t("Affärer")} varde={String(oppnaAffarer)} under={buy.committed ? formatSek(buy.committed) : undefined} />
            <Tal etikett={t("Din tur")} varde={String(vantar)} under={vantar > 0 ? t("väntar på dig") : undefined} lyser={vantar > 0} />
          </dl>

          <nav className="pf-konto" aria-label={t("Konto")}>
            {/* Språket är en kontoinställning — här, inte bredvid namnet, där det tog namnets plats. */}
            <div className="pf-konto-rad pf-konto-sprak">
              <LanguagePicker />
            </div>
            {isAdmin && onOpenAdmin && (
              <button className="pf-konto-rad" onClick={onOpenAdmin}>
                <UsersIcon size={18} /> <span>{t("Adminpanel")}</span> <ChevronRight size={16} />
              </button>
            )}
            <button className="pf-konto-rad" onClick={reopenConsent}>
              <span>{t("Cookieinställningar")}</span> <ChevronRight size={16} />
            </button>
            <button className="pf-konto-rad pf-loggaut" onClick={() => void signOut()}>
              <span>{t("Logga ut")}</span>
            </button>
          </nav>
          <footer className="pf-juridik">
            <LegalLink doc="privacy" />
            <LegalLink doc="cookies" />
            <LegalLink doc="terms" />
          </footer>
        </aside>

        {/* ── Innehållet: tre flikar ──────────────────────────────────────── */}
        <main className="pf-huvud">
          <div className="pf-flikar" role="tablist" aria-label={t("Profil")}>
            <FlikKnapp vald={aktivFlik === "salj"} onClick={() => setFlik("salj")} etikett={t("Säljer")} antal={cards.length + sellerDeals.length} />
            <FlikKnapp vald={aktivFlik === "kop"} onClick={() => setFlik("kop")} etikett={t("Köper")} antal={kopAntal} />
            <FlikKnapp vald={aktivFlik === "tjana"} onClick={() => setFlik("tjana")} etikett={t("Tjäna")} />
          </div>

          {aktivFlik === "salj" &&
            (jobs === null ? (
              <Laddar />
            ) : cards.length === 0 && sellerDeals.length === 0 ? (
              <Tomt rubrik={t("Inga annonser än")} />
            ) : (
              <>
                <div className="pf-filter" role="tablist" aria-label={t("Visa")}>
                  {(
                    [
                      ["ute", t("Till salu")],
                      ["salda", t("Sålda")],
                      ["sparade", t("Sparade")],
                      ["affarer", t("Affärer")],
                    ] as Array<[SaljFilter, string]>
                  )
                    .filter(([f]) => filterAntal[f] > 0 || f === "ute")
                    .map(([f, etikett]) => (
                      <button
                        key={f}
                        type="button"
                        role="tab"
                        aria-selected={aktivtFilter === f}
                        className={`pf-chip${aktivtFilter === f ? " vald" : ""}`}
                        onClick={() => setFilter(f)}
                      >
                        {etikett} <span className="pf-chip-antal">{filterAntal[f]}</span>
                      </button>
                    ))}
                </div>
                {aktivtFilter === "affarer" ? (
                  <ul className="trade-list pf-rader">
                    {[...sellerDeals].sort(byOpen).map((d) => <DealRow key={d.id} deal={d} />)}
                  </ul>
                ) : filterJobb[aktivtFilter].length === 0 ? (
                  <Tomt rubrik={t("Inget här just nu")} />
                ) : (
                  <ul className="pf-kort">
                    {filterJobb[aktivtFilter].map((j) => (
                      <AnnonsKort key={j.id} job={j} lang={lang} onOpen={() => onOpenJob(j)} />
                    ))}
                  </ul>
                )}
              </>
            ))}

          {aktivFlik === "kop" &&
            (orders === null || deals === null ? (
              <Laddar />
            ) : kopAntal === 0 ? (
              <Tomt rubrik={t("Inga köp än")} />
            ) : (
              <ul className="trade-list pf-rader">
                {[...buyerDeals].sort(byOpen).map((d) => <DealRow key={d.id} deal={d} />)}
                {(orders ?? []).map(({ order, product }) => (
                  <OrderRow key={order.id} order={order} product={product} />
                ))}
              </ul>
            ))}

          {aktivFlik === "tjana" && <Tjana />}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Små byggstenar
// ---------------------------------------------------------------------------

function Tal({ etikett, varde, under, lyser = false }: { etikett: string; varde: string; under?: string; lyser?: boolean }) {
  return (
    <div className={`pf-tal-ruta${lyser ? " lyser" : ""}`}>
      <dt>{etikett}</dt>
      <dd>
        <span className="pf-tal-varde">{varde}</span>
        {under && <span className="pf-tal-under">{under}</span>}
      </dd>
    </div>
  );
}

function FlikKnapp({ vald, onClick, etikett, antal }: { vald: boolean; onClick: () => void; etikett: string; antal?: number }) {
  return (
    <button type="button" role="tab" aria-selected={vald} className={`pf-flik${vald ? " vald" : ""}`} onClick={onClick}>
      {etikett}
      {antal !== undefined && antal > 0 && <span className="pf-flik-antal">{antal}</span>}
    </button>
  );
}

function Laddar() {
  return (
    <div className="profile-loading">
      <div className="spinner" />
    </div>
  );
}

function Tomt({ rubrik }: { rubrik: string }) {
  return (
    <div className="pf-tomt">
      <CardIcon size={22} />
      <p>{rubrik}</p>
    </div>
  );
}

/**
 * Ett annonskort: bild, rubrik, pris och EN etikett för läget. Det som tidigare stod som rader under
 * — visningar, leveranssteg, utbetalning — står kvar, men som en enda kort rad.
 */
function AnnonsKort({ job: j, lang, onOpen }: { job: JobSummary; lang: string; onOpen: () => void }) {
  const t = useT();
  const bild = j.coverImageUrl ?? (j.thumbnailImageId ? imageUrl(j.id, j.thumbnailImageId) : undefined);

  /** Etiketten: köpets steg går före butikens läge, som går före marknadsplatsens. */
  const lage: { text: string; ton: string } | null = j.order
    ? { text: t(ORDER_STEG[j.order.status]), ton: "accent" }
    : j.shop && SHOP_LABEL[j.shop.state]
      ? { text: t(SHOP_LABEL[j.shop.state]!) + (j.shop.soldChannel === "tradera" ? t(" på Tradera") : ""), ton: j.shop.state }
      : j.sale
        ? { text: t(SALE_LABEL[j.sale.status]), ton: j.sale.status }
        : null;

  const rad = j.shop?.utbetalning
    ? t("Utbetalt {belopp}", { belopp: formatSek(j.shop.utbetalning.saljarenSek) }) +
      (j.shop.utbetalning.andel === 0 ? ` · ${t("gratisförsäljning")}` : "")
    : j.order?.deliveryDate
      ? `${leveransDatum(j.order.deliveryDate)} ${j.order.deliveryWindow ?? ""}`
      : j.shop?.state === "live" && j.statistik && j.statistik.visningar > 0
        ? [
            t("{antal} visningar", { antal: j.statistik.visningar }),
            j.statistik.klick > 0 ? t("{antal} klick", { antal: j.statistik.klick }) : null,
            j.shop.listedAt ? dagarUppe(j.shop.listedAt, t) : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : formatDate(j.createdAt, lang);

  return (
    <li>
      <button className="pf-annons" onClick={onOpen}>
        <span className="pf-annons-bild">
          {bild ? <img src={bild} alt="" /> : <CardIcon size={22} />}
          {j.grade && (
            <span className="pf-annons-betyg">
              <GradeBadge grade={j.grade.grade} size={26} />
            </span>
          )}
          {/* Läget ligger på bilden: det är det första ögat söker, och texten under blir kortare. */}
          {lage && <span className={`pf-lage pf-lage-pa-bild pf-lage-${lage.ton}`}>{lage.text}</span>}
        </span>
        <span className="pf-annons-text">
          <span className="pf-annons-pris">{j.price?.status === "ok" ? formatSek(j.price.default) : "—"}</span>
          <span className="pf-annons-titel">{describe(j, t)}</span>
          <span className="pf-annons-rad">{rad}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * Tjäna: inbjudan och affiliate som två kort. Samma data som tidigare (BjudIn.tsx, Affiliate.tsx),
 * men knapparna först och förklaringen kortad till en rad.
 */
function Tjana() {
  const t = useT();
  const { lang } = useLang();
  const [inbjudan, setInbjudan] = useState<MinInbjudan | null>(null);
  const [affiliate, setAffiliate] = useState<MinAffiliate | null>(null);
  const [laddat, setLaddat] = useState(false);

  useEffect(() => {
    let aktiv = true;
    void Promise.allSettled([getMinInbjudan(), getMinAffiliate()]).then(([i, a]) => {
      if (!aktiv) return;
      if (i.status === "fulfilled") setInbjudan(i.value);
      if (a.status === "fulfilled") setAffiliate(a.value);
      setLaddat(true);
    });
    return () => {
      aktiv = false;
    };
  }, []);

  const inbjudanLank = useMemo(
    () => (inbjudan ? (inbjudan.lank ?? `${window.location.origin}/?ref=${encodeURIComponent(inbjudan.kod)}`) : null),
    [inbjudan],
  );

  if (!laddat) return <Laddar />;
  if (!inbjudan && !affiliate) return <Tomt rubrik={t("Inget att visa just nu")} />;

  const tillgangliga = inbjudan?.krediter.filter((k) => k.status === "available") ?? [];
  const datum = (iso: string) => new Date(iso).toLocaleDateString(lang, { day: "numeric", month: "short" });

  return (
    <div className="pf-tjana">
      {inbjudan && inbjudanLank && (
        <section className="pf-tjana-kort">
          <p className="pf-tjana-etikett">{t("Bjud in")}</p>
          <h2 className="pf-tjana-rubrik">{t("Nästa försäljning gratis")}</h2>
          <p className="pf-tjana-not">{t("När en vän lagt upp sin första annons.")}</p>
          <DelaKnappar lank={inbjudanLank} text={t("Jag säljer mina möbler med Loopa AI. Du filmar, de sköter resten.")} onDelat={loggaLankKopierad} />
          <div className="pf-tjana-tal">
            <span><strong>{tillgangliga.length}</strong> {t("gratis")}</span>
            <span><strong>{inbjudan.inbjudna.length}</strong> {t("inbjudna")}</span>
          </div>
          {tillgangliga.length > 0 && (
            <p className="pf-tjana-not">{tillgangliga.map((k) => t("Gäller till {datum}", { datum: datum(k.gar_ut) })).join(" · ")}</p>
          )}
          {inbjudan.inbjudna.length > 0 && (
            <ul className="pf-tjana-lista">
              {inbjudan.inbjudna.map((p, i) => (
                <li key={i}>
                  <span>{p.email ?? t("En vän")}</span>
                  <span className={`pf-lage ${p.status === "annons" ? "pf-lage-live" : ""}`}>
                    {p.status === "annons" ? t("Annons uppe") : t("Registrerad")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {affiliate && (
        <section className="pf-tjana-kort">
          <p className="pf-tjana-etikett">{t("Affiliate")}</p>
          <h2 className="pf-tjana-rubrik">{t("5 % på allt de säljer")}</h2>
          <p className="pf-tjana-not">{t("För varje såld annons från någon som registrerat sig via din länk.")}</p>
          <DelaKnappar lank={affiliate.lank} text={t("Sälj dina begagnade möbler med Loopa AI.")} />
          <div className="pf-tjana-tal pf-tjana-tal-fem">
            <span><strong>{affiliate.registreringar}</strong> {t("registrerade")}</span>
            <span><strong>{affiliate.annonser}</strong> {t("annonser")}</span>
            <span><strong>{affiliate.salda}</strong> {t("sålda")}</span>
            <span><strong>{formatOre(affiliate.vantandeOre)}</strong> {t("väntande")}</span>
            <span><strong>{formatOre(affiliate.utbetaltOre)}</strong> {t("utbetalt")}</span>
          </div>
        </section>
      )}
    </div>
  );
}

/** Kopiera och Dela. Faller urklippet visas länken markerbar. */
function DelaKnappar({ lank, text, onDelat }: { lank: string; text: string; onDelat?: (kanal: "kopiera" | "dela") => void }) {
  const t = useT();
  const [kopierad, setKopierad] = useState(false);
  const [visaLank, setVisaLank] = useState(false);

  async function kopiera() {
    try {
      await navigator.clipboard.writeText(lank);
      setKopierad(true);
      setVisaLank(false);
      window.setTimeout(() => setKopierad(false), 2500);
      onDelat?.("kopiera");
    } catch {
      setVisaLank(true);
    }
  }

  async function dela() {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "Loopa AI", text, url: lank });
        onDelat?.("dela");
      } catch {
        // Stängd delningsmeny.
      }
      return;
    }
    await kopiera();
  }

  return (
    <>
      <div className="pf-dela">
        <button type="button" className="btn btn-primary pf-dela-knapp" onClick={() => void kopiera()}>
          {kopierad ? <CheckIcon size={16} /> : <CopyIcon size={16} />} {kopierad ? t("Kopierad") : t("Kopiera")}
        </button>
        <button type="button" className="btn btn-outline pf-dela-knapp" onClick={() => void dela()}>
          <SendIcon size={16} /> {t("Dela")}
        </button>
      </div>
      {visaLank && <input className="bjudin-lank" readOnly value={lank} onFocus={(e) => e.currentTarget.select()} aria-label={t("Länk")} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Etiketter och format (oförändrade)
// ---------------------------------------------------------------------------

/** Butikens lägen, som säljaren läser dem. `draft` står medvetet tom — "Sparad" säger redan det. */
const SHOP_LABEL: Partial<Record<NonNullable<JobSummary["shop"]>["state"], string>> = {
  live: "Till salu i butiken",
  reserved: "Reserverad av en köpare",
  sold: "Såld",
  delivered: "Levererad",
  returned: "Returnerad",
};

const SALE_LABEL = {
  pending: "Granskas av Loopa",
  publishing: "Läggs ut…",
  published: "Till salu",
  error: "Kunde inte läggas ut",
} as const;

/** Var köpet står, sagt för SÄLJAREN. Köparens adress och tider nämns aldrig. */
const ORDER_STEG: Record<NonNullable<JobSummary["order"]>["status"], string> = {
  paid: "Såld — köparen väljer leveranstid",
  booking: "Såld — vi bokar frakt",
  scheduled: "Såld — frakt bokad",
  delivered: "Levererad till köparen",
  cancel_requested: "Köparen ångrade sig — möbeln läggs ut igen",
  return_requested: "Retur begärd",
  returned: "Returnerad",
};

function describe(job: JobSummary, t: (sv: string) => string): string {
  const name = [job.identity?.brand, job.identity?.model].filter(Boolean).join(" ");
  return job.listingTitle || name || t("Möbel");
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function formatDate(iso: string, lang: string): string {
  return new Date(iso).toLocaleDateString(lang, { day: "numeric", month: "short" });
}

function leveransDatum(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
}

/** Hur länge annonsen legat ute — i dagar, för det är frågan säljaren ställer. */
function dagarUppe(listedAt: string, t: (sv: string, vars?: Record<string, string | number>) => string): string {
  const dagar = Math.max(0, Math.floor((Date.now() - new Date(listedAt).getTime()) / 86_400_000));
  if (dagar === 0) return t("utlagd i dag");
  if (dagar === 1) return t("uppe 1 dag");
  return t("uppe {antal} dagar", { antal: dagar });
}
