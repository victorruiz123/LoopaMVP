import { useEffect, useState } from "react";
import { hamtaKonto, hamtaRaderingsunderlag, imageUrl, listUserJobs, raderaKonto } from "../api";
import GradeBadge from "../components/GradeBadge";
import { ArrowLeftIcon, CardIcon, ChevronRight } from "../components/icons";
import { formatSek } from "../lib/price";
import { displayName, formatDate, initials } from "./AdminScreen";
import type { AdminKontoDetalj, AdminUser, JobSummary, RaderingsResultat, RaderingsUnderlag } from "../types";
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
 * Läsning, med ETT undantag: "Radera användare & innehåll" längst ner i kontofliken. Den kräver
 * fyra tryck och kontots e-postadress inskriven för hand — se RaderaKonto nedan och raderaKonto.ts
 * på servern.
 */
export type AdminUserFlik = "konto" | "annonser";

export default function AdminUserScreen({
  userId,
  user: initialUser,
  flik: initialFlik = "annonser",
  backLabel,
  onBack,
  onOpenJob,
  onRaderad,
}: {
  userId: string;
  /** Raden ur användarlistan, när sidan öppnades därifrån. Bara en första bild — uppslaget vinner. */
  user?: AdminUser;
  flik?: AdminUserFlik;
  /** Vad vägen tillbaka leder till. Knappen heter det den gör, och det beror på var man kom ifrån. */
  backLabel?: string;
  onBack: () => void;
  onOpenJob: (jobId: string) => void;
  /** Kontot är raderat. Sidan har inget kvar att visa, så vägen leder tillbaka till listan. */
  onRaderad?: () => void;
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

      {flik === "konto" && (
        <>
          <KontoFlik konto={konto} fel={kontoFel} userId={userId} />
          {/* Inte medan kontot laddas: knappen ska stå under uppgifterna om vem den raderar. */}
          {kontoFel !== null && <RaderaKonto userId={userId} onKlar={onRaderad ?? onBack} />}
        </>
      )}

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

/**
 * Radera användare & innehåll.
 *
 * FYRA TRYCK, och vart och ett säger något nytt — inte samma fråga fyra gånger. Ett: vad som
 * försvinner, och vad som stoppar. Två: att det inte går att ångra, och vad som ändå står kvar för
 * bokföringen. Tre: att inloggningen delas med Vips och försvinner där också. Fyra: e-postadressen,
 * inskriven för hand — det enda av trycken som når servern, och det som gör att ett felklick på fel
 * konto inte kan radera någon.
 *
 * Underlaget hämtas först i steg ett och inte när sidan öppnas: det läser hela lagret, och de flesta
 * som öppnar ett konto kommer inte för att radera det.
 */
type RaderingsSteg = 0 | 1 | 2 | 3 | 4 | "raderar" | "klar";

function RaderaKonto({ userId, onKlar }: { userId: string; onKlar: () => void }) {
  const t = useT();
  const [steg, setSteg] = useState<RaderingsSteg>(0);
  const [underlag, setUnderlag] = useState<RaderingsUnderlag | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [bekraftelse, setBekraftelse] = useState("");
  const [resultat, setResultat] = useState<RaderingsResultat | null>(null);

  const avbryt = () => {
    setSteg(0);
    setFel(null);
    setBekraftelse("");
  };

  const borja = () => {
    setSteg(1);
    setFel(null);
    setUnderlag(null);
    hamtaRaderingsunderlag(userId)
      .then(setUnderlag)
      .catch((e: Error) => setFel(e.message));
  };

  const forvantat = underlag ? (underlag.email ?? underlag.userId) : "";
  const stammer = !!forvantat && bekraftelse.trim().toLowerCase() === forvantat.toLowerCase();

  const radera = () => {
    if (!stammer) return;
    setSteg("raderar");
    setFel(null);
    raderaKonto(userId, bekraftelse.trim())
      .then((r) => {
        setResultat(r);
        setSteg("klar");
      })
      .catch((e: Error) => {
        setFel(e.message);
        setSteg(4);
      });
  };

  if (steg === 0) {
    return (
      <section className="admin-radera">
        <h2 className="profile-section-title">{t("Radera")}</h2>
        <p className="admin-tomt">
          {t("Tar bort personen ur Loopa: annonser, bilder, bevakningar, efterlysningar, loggar och inloggningen.")}
        </p>
        <button className="btn-danger" onClick={borja}>
          {t("Radera användare & innehåll")}
        </button>
      </section>
    );
  }

  if (steg === "klar" && resultat) {
    return (
      <section className="admin-radera admin-radera-ruta">
        <h2 className="profile-section-title">{t("Kontot är raderat")}</h2>
        <ul className="admin-radera-lista">
          {Object.entries(resultat.raderat)
            .filter(([, n]) => n > 0)
            .map(([vad, n]) => (
              <li key={vad}>
                {RADERAT_ETIKETT[vad] ?? vad}: {n}
              </li>
            ))}
          <li>{resultat.inloggning.raderad ? t("Inloggningen: raderad") : t("Inloggningen: INTE raderad")}</li>
        </ul>
        {resultat.inloggning.fel && (
          <p className="admin-radera-varning">
            {t("Loopa-datan är borta, men inloggningen står kvar:")} {resultat.inloggning.fel}{" "}
            {t("Öppna kontot igen och tryck en gång till.")}
          </p>
        )}
        {resultat.forHand.length > 0 && <ForHand rader={resultat.forHand} />}
        <button className="btn btn-outline btn-small" onClick={onKlar}>
          {t("Tillbaka till användarna")}
        </button>
      </section>
    );
  }

  const nummer = typeof steg === "number" ? steg : 4;
  return (
    <section className="admin-radera admin-radera-ruta" aria-live="polite">
      <p className="admin-radera-steg">{t("Steg {n} av 4", { n: nummer })}</p>

      {steg === 1 && (
        <>
          <h2 className="profile-section-title">{t("Är du säker?")}</h2>
          {!underlag && !fel && (
            <div className="profile-loading">
              <div className="spinner" />
            </div>
          )}
          {underlag && (
            <>
              <p className="admin-tomt">
                {t("Det här raderas för {vem}:", { vem: underlag.email ?? underlag.namn ?? underlag.userId })}
              </p>
              <ul className="admin-radera-lista">
                <li>{t("{n} inlämnade möbler, varav {a} annonser — med alla bilder", { n: underlag.jobb, a: underlag.annonser })}</li>
                {underlag.uteNu > 0 && <li>{t("{n} annonser som ligger ute nu tas ner (butiken och Tradera)", { n: underlag.uteNu })}</li>}
                <li>{t("{n} bevakningar och {e} efterlysningar", { n: underlag.bevakningar, e: underlag.efterlysningar })}</li>
                {underlag.omdomen > 0 && <li>{t("{n} omdömen", { n: underlag.omdomen })}</li>}
                <li>{t("Chattloggar, notiser och utskick till adressen")}</li>
                <li>{t("Inloggningen och profilen i Supabase")}</li>
              </ul>
              {underlag.hinder.length > 0 && (
                <div className="admin-radera-varning">
                  <p>{t("Kontot kan inte raderas än. Lös det här först:")}</p>
                  <ul>
                    {underlag.hinder.map((h) => (
                      <li key={h}>{h}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </>
      )}

      {steg === 2 && underlag && (
        <>
          <h2 className="profile-section-title">{t("Det går inte att ångra")}</h2>
          <p className="admin-tomt">
            {t("Bilder, annonser och historik försvinner för gott. Det finns ingen papperskorg och ingen kopia att återställa från.")}
          </p>
          {(underlag.ordrar > 0 || underlag.affarer > 0) && (
            <p className="admin-tomt">
              {t("{o} ordrar och {a} affärer behålls för bokföringen, men utan personens namn, e-post och postnummer.", {
                o: underlag.ordrar,
                a: underlag.affarer,
              })}
            </p>
          )}
          {underlag.forHand.length > 0 && <ForHand rader={underlag.forHand} />}
        </>
      )}

      {steg === 3 && (
        <>
          <h2 className="profile-section-title">{t("Inloggningen raderas också")}</h2>
          <p className="admin-radera-varning">
            {t("Loopa och Vips delar samma inloggning. Personen försvinner därför även från Vips och kan inte logga in någonstans efteråt.")}
          </p>
        </>
      )}

      {(steg === 4 || steg === "raderar") && underlag && (
        <>
          <h2 className="profile-section-title">{t("Sista bekräftelsen")}</h2>
          <label className="admin-radera-falt">
            <span>
              {underlag.email
                ? t("Skriv kontots e-postadress, {adress}, för att radera:", { adress: underlag.email })
                : t("Skriv kontots id, {id}, för att radera:", { id: underlag.userId })}
            </span>
            <input
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={bekraftelse}
              disabled={steg === "raderar"}
              onChange={(e) => setBekraftelse(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && radera()}
            />
          </label>
        </>
      )}

      {fel && <p className="admin-radera-varning admin-radera-fel">{fel}</p>}

      <div className="admin-radera-knappar">
        {steg === 1 && (
          <button className="btn-danger" disabled={!underlag || underlag.hinder.length > 0} onClick={() => setSteg(2)}>
            {t("Ja, radera")}
          </button>
        )}
        {steg === 2 && (
          <button className="btn-danger" onClick={() => setSteg(3)}>
            {t("Ja, radera")}
          </button>
        )}
        {steg === 3 && (
          <button className="btn-danger" onClick={() => setSteg(4)}>
            {t("Ja, radera")}
          </button>
        )}
        {(steg === 4 || steg === "raderar") && (
          <button className="btn-danger" disabled={!stammer || steg === "raderar"} onClick={radera}>
            {steg === "raderar" ? t("Raderar…") : t("Ja, radera för gott")}
          </button>
        )}
        <button className="btn btn-outline btn-small" disabled={steg === "raderar"} onClick={avbryt}>
          {t("Avbryt")}
        </button>
      </div>
    </section>
  );
}

/** Det som ligger ute hos Facebook och Blocket. Ingen av dem har en väg att avpublicera härifrån. */
function ForHand({ rader }: { rader: string[] }) {
  const t = useT();
  return (
    <div className="admin-radera-varning">
      <p>{t("Det här måste tas ner för hand — Loopa kan inte avpublicera där:")}</p>
      <ul>
        {rader.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

const RADERAT_ETIKETT: Record<string, string> = {
  jobb: "Möbler med bilder",
  bevakningar: "Bevakningar",
  efterlysningar: "Efterlysningar",
  forturer: "Förturer",
  notiser: "Notiser",
  ordrarAvidentifierade: "Ordrar avidentifierade",
  affarerAvidentifierade: "Affärer avidentifierade",
  inbjudningsprofil: "Inbjudningsprofil rensad",
  krediterAvslutade: "Krediter avslutade",
  omdomen: "Omdömen",
  chattsamtal: "Chattsamtal",
  flodessessioner: "Flödesloggar",
  utskicksrader: "Utskicksrader",
  sparadeBrev: "Sparade brev",
};
