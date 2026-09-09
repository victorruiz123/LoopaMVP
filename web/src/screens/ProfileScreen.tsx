import { useEffect, useState } from "react";
import { imageUrl, listJobs } from "../api";
import { useAuth } from "../auth/AuthProvider";
import GradeBadge from "../components/GradeBadge";
import { ArrowLeftIcon, CardIcon, ChevronRight, UsersIcon } from "../components/icons";
import { formatSek } from "../lib/price";
import type { JobSummary } from "../types";
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
import { buyStats, CLOSED_DEAL_STATES, plural, sellStats } from "../profil/stats";
import { DealRow, OrderRow, StatGrid } from "../profil/TradeSections";

/**
 * Profilen: allt konto-innehavaren handlar med, sålt som köpt, på ett ställe.
 *
 * EN SKÄRM FÖR BÅDA SIDORNA, och det är inte en layoutfråga. Samma person filmar en soffa på
 * förmiddagen och köper ett matbord på kvällen; två profiler hade tvingat dem att veta vilken av
 * sina roller de var i innan de kunde leta. Skärmen nås därför både ur säljverktyget och ur butiken
 * (/butik/profil) och visar samma sak på båda ställena.
 *
 * TRE KÄLLOR, tre frågor:
 *
 *   GET /api/jobs           vad jag filmat och lagt ut       — med butikens läge per möbel
 *   GET /api/butik/order    vad jag köpt i butiken
 *   GET /api/affar          affärer där jag är köpare ELLER säljare, med läge, actions och kort
 *
 * Siffrorna räknas ur just de listorna (profil/stats.ts) och inte på servern: ett fjärde svar som
 * räknade samma sak hade kunnat säga något annat än raderna under det.
 */
export default function ProfileScreen({
  onBack,
  onOpenJob,
  isAdmin = false,
  onOpenAdmin,
}: {
  onBack: () => void;
  /**
   * Öppna ett annonskort.
   *
   * Tar HELA raden, inte bara id:t. Säljverktyget öppnar sin egen kortvy på `id`; butiken har ingen
   * sådan vy och går till det publika kortet, som slås upp på `loopaId`. Att skicka med bara det ena
   * hade tvingat den andra ingången att slå upp resten en gång till.
   */
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

  /**
   * Tre hämtningar, var och en med sitt eget fall.
   *
   * Ingen `Promise.all`: en säljare utan ett enda köp ska inte få en tom profil för att orderlistan
   * svarade 401, och en köpare utan annonser ska se sina köp även om jobblistan faller. Delarna är
   * oberoende och laddas som det.
   */
  useEffect(() => {
    listJobs().then(setJobs).catch(() => setJobs([]));
    fetchMyOrders().then((r) => setOrders(r.orders)).catch(() => setOrders([]));
    fetchMyDeals().then((r) => setDeals(r.deals)).catch(() => setDeals([]));
  }, []);

  const cards = (jobs ?? []).filter((j) => j.hasListing);
  const valued = cards.filter((j) => j.price?.status === "ok" && j.price.default !== null);
  const totalValue = valued.reduce((sum, j) => sum + (j.price?.default ?? 0), 0);

  /**
   * Två listor, inte en.
   *
   * En annons som ligger ute hos köparna är inte samma sak som en sparad: den arbetar, den kan bli
   * såld i natt, och den är det säljaren öppnar profilen för att titta till. Därför står de först,
   * under egen rubrik. Ett misslyckat försök hör inte hit — den möbeln är fortfarande bara sparad,
   * och raden säger varför i stället för att låtsas att den är ute.
   */
  /**
   * Vad som ligger ute — oavsett var.
   *
   * `sale` känner bara Tradera; `shop` är Loopa Butik. En möbel som ligger i vår egen butik utan att
   * ha lagts ut på en marknadsplats är lika mycket till salu, och stod förut under "Sparade
   * annonser" som om ingen kunde köpa den.
   */
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
  /** Öppna affärer först: en avslutad affär är historik, en pågående väntar på någon. */
  const byOpen = (a: DealView, b: DealView) =>
    Number(CLOSED_DEAL_STATES.includes(a.state)) - Number(CLOSED_DEAL_STATES.includes(b.state));
  const hasBuying = buy.orders > 0 || buyerDeals.length > 0;

  return (
    <div className="screen screen-light profile">
      <button className="btn btn-text btn-back" onClick={onBack}>
        <ArrowLeftIcon /> {t("Tillbaka")}
      </button>

      <section className="profile-head">
        <div className="profile-avatar" aria-hidden>
          {initials(displayName)}
        </div>
        <div className="profile-identity">
          <h1 className="profile-name">{displayName}</h1>
          <p className="profile-email">{user?.email}</p>
        </div>
        {/* Språket byts här, bredvid namnet: det är en inställning för kontot, inte för en skärm. */}
        <LanguagePicker />
      </section>

      {/*
        Siffrorna över allt: sålt OCH köpt.
        Rutan visade förut två tal om säljandet. Den som köper en möbel har lika mycket rätt till ett
        svar på "hur mycket och vad väntar", och den som gör båda ska se dem bredvid varandra.
      */}
      <StatGrid
        items={[
          { label: t("Annonser"), value: String(sell.cards), hint: sell.live ? `${sell.live} till salu` : undefined },
          { label: t("Sålt"), value: sell.sold ? formatSek(sell.earned) : "—", hint: sell.sold ? plural(sell.sold, "möbel", "möbler") : undefined },
          { label: t("Samlat värde"), value: valued.length ? formatSek(totalValue) : "—", hint: sell.liveValue ? `${formatSek(sell.liveValue)} ute` : undefined },
          { label: t("Köpt"), value: buy.completed ? formatSek(buy.spent) : "—", hint: buy.completed ? plural(buy.completed, "köp", "köp") : undefined },
          { label: t("Pågående affärer"), value: String(buy.openDeals + sellerDeals.filter((d) => !CLOSED_DEAL_STATES.includes(d.state)).length), hint: buy.committed ? formatSek(buy.committed) : undefined },
          { label: t("Väntar på dig"), value: String(buy.needsMe + sell.needsMe) },
        ]}
      />

      {jobs === null || cards.length === 0 ? (
        <>
          <h2 className="profile-section-title">{t("Sparade annonser")}</h2>
          {jobs === null ? (
            <div className="profile-loading">
              <div className="spinner" />
            </div>
          ) : (
            <div className="profile-empty">
              <span className="profile-empty-mark">
                <CardIcon size={22} />
              </span>
              <p className="profile-empty-title">{t("Inga annonser än")}</p>
              <p className="profile-empty-hint">
                {t("Varje möbel du säljer med Loopa hamnar här — med skick, pris och annons.")}
              </p>
            </div>
          )}
        </>
      ) : (
        <>
          {selling.length > 0 && (
            <>
              <h2 className="profile-section-title">{t("Till salu")}</h2>
              <CardList jobs={selling} onOpenJob={onOpenJob} lang={lang} />
            </>
          )}
          {soldCards.length > 0 && (
            <>
              <h2 className="profile-section-title">{t("Sålda")}</h2>
              <CardList jobs={soldCards} onOpenJob={onOpenJob} lang={lang} />
            </>
          )}
          {saved.length > 0 && (
            <>
              <h2 className="profile-section-title">{t("Sparade annonser")}</h2>
              <CardList jobs={saved} onOpenJob={onOpenJob} lang={lang} />
            </>
          )}
        </>
      )}

      {/* ── Affärer där jag är säljaren ───────────────────────────────────
          Egen avdelning och inte blandad med annonserna: en Trygg affär är en köpare som redan
          finns, med ett pris som ska svaras på. Den kan inte ligga i samma lista som en annons som
          väntar på att någon ska höra av sig. */}
      {sellerDeals.length > 0 && (
        <>
          <h2 className="profile-section-title">{t("Affärer där du säljer")}</h2>
          <ul className="trade-list">
            {[...sellerDeals].sort(byOpen).map((d) => <DealRow key={d.id} deal={d} />)}
          </ul>
        </>
      )}

      {/* ── Köpsidan ─────────────────────────────────────────────────────── */}
      {hasBuying && (
        <>
          <h2 className="profile-section-title">{t("Du köper")}</h2>
          {buyerDeals.length > 0 && (
            <ul className="trade-list">
              {[...buyerDeals].sort(byOpen).map((d) => <DealRow key={d.id} deal={d} />)}
            </ul>
          )}
          {(orders ?? []).length > 0 && (
            <ul className="trade-list">
              {(orders ?? []).map(({ order, product }) => (
                <OrderRow key={order.id} order={order} product={product} />
              ))}
            </ul>
          )}
        </>
      )}

      {/* Har man aldrig köpt något sägs det en gång, i stället för två tomma listor. */}
      {orders !== null && deals !== null && !hasBuying && (
        <>
          <h2 className="profile-section-title">{t("Du köper")}</h2>
          <div className="profile-empty">
            <span className="profile-empty-mark"><CardIcon size={22} /></span>
            <p className="profile-empty-title">{t("Inga köp än")}</p>
            <p className="profile-empty-hint">
              {t("Möbler du köper i butiken och affärer du startar från en annan annons hamnar här.")}
            </p>
          </div>
        </>
      )}

      {isAdmin && onOpenAdmin && (
        <button className="btn profile-admin-link" onClick={onOpenAdmin}>
          <UsersIcon /> {t("Adminpanel")}
        </button>
      )}

      <button className="btn btn-text profile-signout" onClick={() => void signOut()}>
        {t("Logga ut")}
      </button>

      {/* Samtycket måste gå att ta tillbaka lika lätt som det gavs, och profilen är stället man
          letar på. Knappen glömmer valet, vilket får cookierutan att komma tillbaka — se
          lib/consent.ts. */}
      <footer className="legal-footer">
        <LegalLink doc="privacy" />
        <LegalLink doc="cookies" />
        <LegalLink doc="terms" />
        <button className="legal-link legal-link-button" onClick={reopenConsent}>
          {t("Cookieinställningar")}
        </button>
      </footer>
    </div>
  );
}

/**
 * Vad de tre lägena heter för säljaren.
 *
 * Marknadsplatsen nämns inte: det är Loopa som säljer möbeln, och var annonsen råkar ligga är hur vi
 * gör det. Ett misslyckat försök står kvar som text i stället för att försvinna — annars ser kortet
 * ut som vilken sparad annons som helst, och säljaren väntar på ett besked som aldrig kommer.
 */
/**
 * Butikens lägen, som säljaren läser dem.
 *
 * `draft` står medvetet tom: möbeln är inlagd men inte utlagd, och det är precis vad "Sparad" redan
 * betyder — en etikett till hade sagt samma sak två gånger.
 */
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

/** Listraden, delad av båda avdelningarna — samma miniatyr, samma betyg, samma väg in i kortet. */
function CardList({
  jobs,
  onOpenJob,
  lang,
}: {
  jobs: JobSummary[];
  onOpenJob: (job: JobSummary) => void;
  /** Datumen skrivs på skärmens språk: "3 sep", "3 Sep", "3 sept.". */
  lang: string;
}) {
  const t = useT();
  return (
    <ul className="card-list">
      {jobs.map((j) => (
        <li key={j.id}>
          <button className="card-row" onClick={() => onOpenJob(j)}>
            <img
              className="card-row-thumb"
              src={j.coverImageUrl ?? (j.thumbnailImageId ? imageUrl(j.id, j.thumbnailImageId) : undefined)}
              alt=""
            />
            <span className="card-row-body">
              <span className="card-row-title">{describe(j, t)}</span>
              <span className="card-row-meta">
                {formatDate(j.createdAt, lang)}
                {j.price?.status === "ok" ? ` · ${formatSek(j.price.default)}` : ""}
              </span>
              {/* Butikens läge går före marknadsplatsens: säljs möbeln hos oss är det det svaret
                  säljaren vill ha, och `sale` säger bara om den dessutom ligger på Tradera. */}
              {j.shop && SHOP_LABEL[j.shop.state] ? (
                <span className={`card-row-sale card-row-sale-shop-${j.shop.state}`}>
                  {t(SHOP_LABEL[j.shop.state]!)}
                  {j.shop.soldChannel === "tradera" ? t(" på Tradera") : ""}
                </span>
              ) : (
                j.sale && (
                  <span className={`card-row-sale card-row-sale-${j.sale.status}`}>{t(SALE_LABEL[j.sale.status])}</span>
                )
              )}
              {/*
                Vad som HÄNT med annonsen, på en rad.
                
                Ligger den ute visas visningar och klick — säljaren ska kunna skilja "ingen har sett
                den" från "många har sett den och ingen köpt". Är den såld visas i stället var köpet
                står, för då är intresset historia och leveransen det enda som gäller.
              */}
              {j.order ? (
                <span className="card-row-meta" style={{ color: "var(--accent)" }}>
                  {ORDER_STEG[j.order.status]}
                  {j.order.deliveryDate ? ` · ${leveransDatum(j.order.deliveryDate)} ${j.order.deliveryWindow ?? ""}` : ""}
                </span>
              ) : (
                j.shop?.state === "live" && j.statistik && j.statistik.visningar > 0 && (
                  <span className="card-row-meta">
                    {t("{antal} visningar", { antal: j.statistik.visningar })}
                    {j.statistik.klick > 0 ? ` · ${t("{antal} klick", { antal: j.statistik.klick })}` : ""}
                    {j.shop.listedAt ? ` · ${dagarUppe(j.shop.listedAt, t)}` : ""}
                  </span>
                )
              )}
            </span>
            {j.grade && <GradeBadge grade={j.grade.grade} size={32} />}
            <span className="card-row-chevron">
              <ChevronRight size={16} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

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

/** Var köpet står, sagt för SÄLJAREN. Köparens adress och tider nämns aldrig. */
const ORDER_STEG: Record<NonNullable<JobSummary["order"]>["status"], string> = {
  paid: "Såld — köparen väljer leveranstid",
  booking: "Såld — vi bokar frakt",
  scheduled: "Såld — frakt bokad",
  delivered: "Levererad till köparen",
  return_requested: "Retur begärd",
  returned: "Returnerad",
};

function leveransDatum(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
}

/**
 * Hur länge annonsen legat ute.
 *
 * Dagar och inte datum: "utlagd 12 augusti" kräver att man räknar själv, och frågan säljaren
 * faktiskt ställer är "hur länge har den legat".
 */
function dagarUppe(listedAt: string, t: (sv: string, vars?: Record<string, string | number>) => string): string {
  const dagar = Math.max(0, Math.floor((Date.now() - new Date(listedAt).getTime()) / 86_400_000));
  if (dagar === 0) return t("utlagd i dag");
  if (dagar === 1) return t("uppe 1 dag");
  return t("uppe {antal} dagar", { antal: dagar });
}
