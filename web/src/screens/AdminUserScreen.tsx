import { useEffect, useState } from "react";
import { hamtaKonto, imageUrl, listUserJobs } from "../api";
import GradeBadge from "../components/GradeBadge";
import { ArrowLeftIcon, CardIcon, ChevronRight } from "../components/icons";
import { formatSek } from "../lib/price";
import { displayName, formatDate, initials } from "./AdminScreen";
import type { AdminKontoDetalj, AdminUser, JobSummary } from "../types";
import { usePageTitle } from "../lib/pageTitle";
import { useT } from "../lib/i18n";

/**
 * ETT konto, sett av en admin: vem det är, och vad de lagt upp.
 *
 * TVÅ FLIKAR, för det är två frågor. "Konto" svarar på vem säljaren är — adressen budfirman kör
 * till, postnumret Blocket-annonsen läggs på, när de registrerade sig. "Annonser" svarar på vad de
 * lämnat in. Den som öppnar sidan från en annons kommer nästan alltid för den första frågan, och
 * den som kommer från användarlistan för den andra; därför bärs startfliken utifrån.
 *
 * ÖPPNAS PÅ ETT ID och inte på en färdig rad. Vägen hit går också från en annons, där allt som står
 * om ägaren är ett id och en adress — ingen rad ur användarlistan finns att skicka med. Finns raden
 * ändå används den som första bild, så sidan har ett namn att visa medan uppslaget hämtas.
 *
 * Läsning och ingenting annat: adminvägarna hit svarar bara på GET, så det finns ingen knapp här
 * som kan ändra i någon annans konto.
 */
export type AdminUserFlik = "konto" | "annonser";

export default function AdminUserScreen({
  userId,
  user: initialUser,
  flik: initialFlik = "annonser",
  backLabel,
  onBack,
  onOpenJob,
}: {
  userId: string;
  /** Raden ur användarlistan, när sidan öppnades därifrån. Bara en första bild — uppslaget vinner. */
  user?: AdminUser;
  flik?: AdminUserFlik;
  /** Vad vägen tillbaka leder till. Knappen heter det den gör, och det beror på var man kom ifrån. */
  backLabel?: string;
  onBack: () => void;
  onOpenJob: (jobId: string) => void;
}) {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [konto, setKonto] = useState<AdminKontoDetalj | null>(null);
  /** null = uppslaget pågår. false = det gick igenom. true = det föll, och sidan säger det. */
  const [kontoFel, setKontoFel] = useState<boolean | null>(null);
  const [flik, setFlik] = useState<AdminUserFlik>(initialFlik);
  const t = useT();
  /**
   * Kontot först, listraden som reserv. Uppslaget bär namnet ur Auth och kan därför säga mer än
   * raden — men innan det kommit ska rubriken inte vara tom.
   */
  const user: AdminUser = konto ?? initialUser ?? tomtKonto(userId);
  usePageTitle(displayName(user));

  useEffect(() => {
    listUserJobs(userId)
      .then(setJobs)
      .catch(() => setJobs([]));
  }, [userId]);

  useEffect(() => {
    setKontoFel(null);
    hamtaKonto(userId)
      .then((k) => {
        setKonto(k);
        setKontoFel(false);
      })
      .catch(() => setKontoFel(true));
  }, [userId]);

  const cards = (jobs ?? []).filter((j) => j.hasListing);
  const rest = (jobs ?? []).filter((j) => !j.hasListing);
  const valued = cards.filter((j) => j.price?.status === "ok" && j.price.default !== null);
  const totalValue = valued.reduce((sum, j) => sum + (j.price?.default ?? 0), 0);
  const name = displayName(user);

  return (
    <div className="screen screen-light profile admin">
      <button className="btn btn-text btn-back" onClick={onBack}>
        <ArrowLeftIcon /> {backLabel ?? t("Alla användare")}
      </button>

      <section className="profile-head">
        <div className="profile-avatar" aria-hidden>
          {user.avatarUrl ? <img className="admin-avatar-img" src={user.avatarUrl} alt="" /> : initials(name)}
        </div>
        <div className="profile-identity">
          <h1 className="profile-name">{name}</h1>
          <p className="profile-email">{user.email ?? user.id}</p>
        </div>
      </section>

      <section className="profile-stats">
        <div className="profile-stat">
          <div className="profile-stat-value">{jobs === null ? "—" : cards.length}</div>
          <div className="profile-stat-label">{t("Annonser")}</div>
        </div>
        <div className="profile-stat">
          <div className="profile-stat-value">{valued.length ? formatSek(totalValue) : "—"}</div>
          <div className="profile-stat-label">{t("Samlat värde")}</div>
        </div>
      </section>

      <div className="admin-flikar admin-underflikar" role="tablist" aria-label={t("Säljaren")}>
        <button
          role="tab"
          aria-selected={flik === "konto"}
          className={`admin-flik-knapp${flik === "konto" ? " vald" : ""}`}
          onClick={() => setFlik("konto")}
        >
          {t("Konto")}
        </button>
        <button
          role="tab"
          aria-selected={flik === "annonser"}
          className={`admin-flik-knapp${flik === "annonser" ? " vald" : ""}`}
          onClick={() => setFlik("annonser")}
        >
          {t("Annonser")}
          {jobs !== null && <span className="admin-flik-antal">{cards.length}</span>}
        </button>
      </div>

      {flik === "konto" && <KontoFlik konto={konto} fel={kontoFel} userId={userId} />}

      {flik === "annonser" && (
      <>
      <h2 className="profile-section-title">{t("Annonser")}</h2>

      {jobs === null ? (
        <div className="profile-loading">
          <div className="spinner" />
        </div>
      ) : cards.length === 0 ? (
        <div className="profile-empty">
          <span className="profile-empty-mark">
            <CardIcon size={22} />
          </span>
          <p className="profile-empty-title">{t("Inga annonser")}</p>
          <p className="profile-empty-hint">
            {t("Kontot har inte fått någon besiktning hela vägen till en annons.")}
          </p>
        </div>
      ) : (
        <ul className="card-list">
          {cards.map((j) => (
            <li key={j.id}>
              <button className="card-row" onClick={() => onOpenJob(j.id)}>
                <img
                  className="card-row-thumb"
                  src={j.coverImageUrl ?? (j.thumbnailImageId ? imageUrl(j.id, j.thumbnailImageId) : undefined)}
                  alt=""
                />
                <span className="card-row-body">
                  <span className="card-row-title">{describe(j)}</span>
                  <span className="card-row-meta">
                    {j.loopaId} · {formatDate(j.createdAt)}
                    {j.price?.status === "ok" ? ` · ${formatSek(j.price.default)}` : ""}
                  </span>
                </span>
                {j.grade && <GradeBadge grade={j.grade.grade} size={32} />}
                <span className="card-row-chevron">
                  <ChevronRight size={16} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Jobb som aldrig blev kort står med, men som text och utan väg vidare: det finns inget kort
          att öppna, och varför det saknas är det enda intressanta med raden. */}
      {rest.length > 0 && (
        <>
          <h2 className="profile-section-title">{t("Utan annons")}</h2>
          <ul className="admin-stub-list">
            {rest.map((j) => (
              <li key={j.id} className="admin-stub">
                <span className="admin-stub-title">{describe(j)}</span>
                <span className="admin-stub-meta">
                  {formatDate(j.createdAt)} · {j.error ?? j.progress.message}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      </>
      )}
    </div>
  );
}

function describe(job: JobSummary): string {
  const name = [job.identity?.brand, job.identity?.model].filter(Boolean).join(" ");
  return job.listingTitle || name || "Möbel";
}

/** En sida som ännu inte fått sitt uppslag. Bara id:t är känt, och det räcker för att rita rubriken. */
function tomtKonto(id: string): AdminUser {
  return {
    id,
    email: null,
    name: null,
    avatarUrl: null,
    isAdmin: false,
    jobCount: 0,
    cardCount: 0,
    totalValue: 0,
    telefon: null,
    lastActivity: null,
    signedUpAt: null,
    signupApproximate: false,
  };
}

/**
 * Kontot: vem säljaren är, och var möbeln står.
 *
 * ETT FÄLT SOM SAKNAS SKRIVS UT SOM SAKNAT, inte som en tom rad. Skillnaden mellan "säljaren har
 * inte angett något postnummer" och "vi kunde inte läsa kontot" avgör vad adminen ska göra härnäst —
 * fylla i det för hand i annonsen, eller laga vägen till Supabase — och en tom ruta svarar inte på
 * någon av dem.
 */
function KontoFlik({ konto, fel, userId }: { konto: AdminKontoDetalj | null; fel: boolean | null; userId: string }) {
  const t = useT();

  if (fel === null && !konto) {
    return (
      <div className="profile-loading">
        <div className="spinner" />
      </div>
    );
  }

  if (!konto) {
    return (
      <div className="profile-empty">
        <p className="profile-empty-title">{t("Kontot gick inte att läsa")}</p>
        <p className="profile-empty-hint">
          {t("Uppslaget mot Supabase svarade inte. Annonserna i fliken bredvid kommer ur jobben och står kvar.")}
        </p>
      </div>
    );
  }

  const a = konto.adress;
  return (
    <>
      {/* Uppgifterna kom ur jobben och inte ur kontot: allt nedan är då tomt av EN anledning, och
          den ska stå utskriven i stället för att adminen läser tomheten som ett svar. */}
      {konto.kalla === "jobb" && (
        <p className="admin-notis">
          {t("Supabase svarade inte på uppslaget, så adressen och inloggningarna saknas här. Siffrorna kommer ur jobben.")}
        </p>
      )}

      <h2 className="profile-section-title">{t("Adress")}</h2>
      {a ? (
        <dl className="admin-faktalista">
          <Fakta etikett={t("Gatuadress")} varde={a.gatuadress} />
          <Fakta etikett={t("Postnummer")} varde={a.postnummer} />
          <Fakta etikett={t("Ort")} varde={a.ort} />
          <Fakta etikett={t("Boende")} varde={a.boende === "hus" ? t("Hus") : a.boende === "lagenhet" ? t("Lägenhet") : a.boende} />
          <Fakta etikett={t("Portkod")} varde={a.portkod} />
          {/* Varifrån adressen kom. En adress ur Vips-profilen är lämnad till någon annan tjänst, och
              den skillnaden ska synas innan någon kör en budbil dit. */}
          <Fakta
            etikett={t("Källa")}
            varde={konto.adressKalla === "registrering" ? t("Registreringen hos Loopa") : t("Profilen i Vips")}
          />
          {/* Våningen frågas bara i lägenhet — i ett hus är den inte tom, den finns inte. */}
          {a.boende !== "hus" && <Fakta etikett={t("Våning")} varde={a.vaning} />}
        </dl>
      ) : (
        <p className="admin-tomt">
          {konto.kalla === "auth"
            ? t("Säljaren har inte angett någon adress. Postnumret måste då fyllas i på annonsen för att den ska kunna läggas på Blocket.")
            : t("Adressen gick inte att läsa.")}
        </p>
      )}

      <h2 className="profile-section-title">{t("Kontot")}</h2>
      <dl className="admin-faktalista">
        <Fakta etikett={t("E-post")} varde={konto.email} />
        <Fakta etikett={t("Telefon")} varde={konto.telefon} />
        <Fakta etikett={t("Användarnamn")} varde={konto.anvandarnamn} />
        <Fakta
          etikett={t("Registrerad")}
          varde={konto.signedUpAt ? formatDate(konto.signedUpAt) : null}
          /* Datumet är kontots första jobb och inte registreringen — samma förbehåll som listan gör. */
          notis={konto.signupApproximate ? t("ungefärligt — första jobbet") : undefined}
        />
        <Fakta etikett={t("Senast inloggad")} varde={konto.senastInloggad ? formatDate(konto.senastInloggad) : null} />
        <Fakta
          etikett={t("E-post bekräftad")}
          varde={konto.epostBekraftad ? formatDate(konto.epostBekraftad) : konto.kalla === "auth" ? t("Nej") : null}
        />
        <Fakta etikett={t("Loggar in med")} varde={konto.inloggningssatt.join(", ") || null} />
        <Fakta etikett={t("Roll")} varde={konto.isAdmin ? t("Admin") : t("Säljare")} />
        <Fakta etikett={t("Konto-id")} varde={userId} />
      </dl>

      {/* Presentationen står som säljarens egna ord och inte som en faktarad: den är skriven av en
          människa om sig själv, och elva av tvåhundrasjuttio konton har en. */}
      {konto.bio && (
        <>
          <h2 className="profile-section-title">{t("Presentation")}</h2>
          <p className="admin-bio">{konto.bio}</p>
        </>
      )}

      <h2 className="profile-section-title">{t("Siffror")}</h2>
      <dl className="admin-faktalista">
        <Fakta etikett={t("Inlämnat")} varde={String(konto.jobCount)} />
        <Fakta etikett={t("Blev annonser")} varde={String(konto.cardCount)} />
        <Fakta etikett={t("Samlat värde")} varde={konto.totalValue ? formatSek(konto.totalValue) : null} />
        <Fakta etikett={t("Senaste jobbet")} varde={konto.lastActivity ? formatDate(konto.lastActivity) : null} />
      </dl>
    </>
  );
}

/** En rad i faktalistan. Saknas värdet står ett streck — raden finns, uppgiften gör det inte. */
function Fakta({ etikett, varde, notis }: { etikett: string; varde: string | null; notis?: string }) {
  return (
    <div className="admin-fakta">
      <dt className="admin-fakta-etikett">{etikett}</dt>
      <dd className="admin-fakta-varde">
        {varde ?? <span className="admin-fakta-tomt">—</span>}
        {notis && <span className="admin-fakta-notis">{notis}</span>}
      </dd>
    </div>
  );
}
