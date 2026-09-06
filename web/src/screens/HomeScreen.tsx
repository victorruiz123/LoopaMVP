import { useEffect, useMemo, useState } from "react";
import type { FurnitureIdentity } from "../types";
import { ChevronRight, SearchIcon, CloseIcon, UserIcon } from "../components/icons";
import { useAuth } from "../auth/AuthProvider";
import { KNOWN_BRANDS } from "../lib/brands";
import { LOOPA_PERCENT } from "../lib/fees";
import { POPULAR_BRANDS } from "../lib/brandSeed";
import { brandTheme } from "../lib/brandTheme";
import { brandLook, brandTypeStyle } from "../lib/brandLook";
import { usePageTitle } from "../lib/pageTitle";
import { useT } from "../lib/i18n";
// Mätningen av köp<->sälj-slingan bor i butikens Bits — samma funktion som räknar
// `sell_cta_click` åt andra hållet, så de två riktningarna blir jämförbara i analysen.
import { track } from "../butik/components/Bits";
// MARKNADSPLATSTESTET: köphalvan av startsidan. Allt nytt bor i ../marknad — se Upptack.tsx för
// varför, och för hur testet tas bort igen (de tre raderna här och mappen).
import Upptack, { MARKNADSPLATS, SaljHero } from "../marknad/Upptack";

function fold(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

const POPULAR_SET = new Set(POPULAR_BRANDS.map(fold));
/** Startlistans stavning vinner, resten av korpusen följer efter — samma union som sökarket hade. */
const ALL_BRANDS = [
  ...POPULAR_BRANDS,
  ...KNOWN_BRANDS.map((b) => b.name).filter((n) => !POPULAR_SET.has(fold(n))),
];

/**
 * Märket väljs direkt ur listan — inget ark, ingen bekräftelseknapp.
 *
 * Att välja märke ÄR att börja: det finns inget andra beslut på den här skärmen att vänta in, så en
 * "fortsätt"-knapp hade bara varit ett extra tryck för att bekräfta något som redan var sagt. Vägen
 * tillbaka finns på nästa skärm.
 */
export default function HomeScreen({
  onStartScan,
  onOpenProfile,
  dealId,
}: {
  onStartScan: (identity: FurnitureIdentity) => void;
  onOpenProfile: () => void;
  /**
   * Affären säljaren kom hit från (Trygg affär), när de klickat "Filma möbeln" i sitt affärsrum.
   *
   * Startsidan hämtar då förifyllningen och hoppar över märkesvalet: säljaren har redan skrivit
   * märket i sin egen annons, och att be dem göra om det är att be dem bevisa något de just visat.
   */
  dealId?: string | null;
}) {
  const t = useT();
  const { profile, user, loading } = useAuth();
  usePageTitle(null);
  const [query, setQuery] = useState("");

  /**
   * Förifyllningen från affären, hämtad en gång.
   *
   * Går rakt in i filmningen när märket är känt: säljaren kom hit för att filma sin möbel, inte för
   * att välja märke ur en lista. Faller anropet står startsidan kvar som vanligt — förifyllningen är
   * en genväg, inte en grind.
   */
  useEffect(() => {
    if (!dealId || loading || !user) return;
    let live = true;
    void import("../affar/api")
      .then(({ fetchDeal }) => fetchDeal(dealId))
      .then((r) => {
        if (!live) return;
        const p = r.prefill;
        if (p?.brand) onStartScan({ brand: p.brand, model: p.model ?? "" });
      })
      .catch(() => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId, loading, user]);

  const shown = useMemo(() => {
    const q = fold(query);
    if (!q) return ALL_BRANDS;
    const hits = ALL_BRANDS.filter((n) => fold(n).includes(q));
    hits.sort((a, b) => Number(!fold(a).startsWith(q)) - Number(!fold(b).startsWith(q)));
    return hits;
  }, [query]);

  const typed = query.trim();
  const exact = shown.some((n) => fold(n) === fold(typed));

  return (
    /* `home-marknad` gör startsidan scrollbar — se marknad.css. Klassen är testets enda
       ingrepp i befintlig layout, och den försvinner med flaggan. */
    <div className={MARKNADSPLATS ? "screen screen-light home home-marknad" : "screen screen-light home"}>
      {/* Loopa-ordmärket i vänsterkant, uppslaget och profilen i höger. */}
      <div className="app-bar">
        <span className="app-wordmark">Loopa</span>
        <div className="app-bar-actions">
          {/*
            VÄGEN ÖVER TILL KÖPSIDAN. Motsvarigheten till "Sälj en möbel" i köpsidans topprad
            (butik/components/Chrome.tsx) — slingan köp<->sälj gick hittills bara åt ena hållet:
            därifrån hit, aldrig härifrån dit. Den som landat på säljstartsidan och egentligen ville
            handla hade ingen väg vidare än att gissa en adress.

            DÄMPAD, inte en fylld knapp som säljuppmaningen på andra sidan. Där är sälj målet med
            sidan; här ÄR sälj sidan, och en orange knapp bredvid märkeslistan hade tävlat med det
            enda den skärmen ber om — att välja ett märke och börja filma. Samma sänkta pillerform
            som profilknappen: en väg ut, inte ett rop.

            Placerad FÖRE profilen så att kontot får ligga kvar längst till höger, där det stått och
            där en avatar hör hemma. Länken byter app, inte skärm, så det är ett vanligt <a> med en
            riktig adress — den ska gå att öppna i en ny flik och att dela.
          */}
          <a
            className="app-bar-buy"
            href="/butik"
            onClick={() => track("buy_cta_click", { from: "header" })}
          >
            {t("Köp")}
          </a>
          {/* Ingen knapp alls medan sessionen läses: valet står mellan ett namn och "Logga in", och
              att gissa fel i en tiondels sekund byter ut texten framför ögonen på den som läser den. */}
          {!loading && (
            <button
              className="app-bar-profile"
              onClick={onOpenProfile}
              aria-label={user ? t("Din profil") : t("Logga in")}
            >
              <UserIcon size={17} />
              <span className="app-bar-profile-name">
                {user ? shortName(profile?.full_name ?? profile?.username, user.email) : t("Logga in")}
              </span>
            </button>
          )}
        </div>
      </div>

      {/*
        HERON I TVÅ UPPLAGOR. Testets version säger "Sälj din möbel" och har frågan om märket som
        andra rad; den ursprungliga frågar rakt av. Båda står kvar i koden med flit — det är så
        testet går att ångra utan att någon behöver komma ihåg vad det stod förut.
      */}
      {MARKNADSPLATS && <SaljHero />}
      {!MARKNADSPLATS && (
        <header className="home-header">
          <span className="brand-pill">
            <span className="brand-dot" /> {t("SÄLJ MED LOOPA")}
          </span>
          {/* Rubriken bryts i två rader, och brytpunkten är olika på olika språk: "Vilket märke"
              väger jämnt mot "är möbeln?", men "What brand" mot "is the furniture?" gör det inte.
              Därför är raderna två egna meningar i ordlistan och inte en med ett radbrott i. */}
          <h1 className="home-title">
            {t("Vilket märke")}
            <br />
            <span className="accent">{t("är möbeln?")}</span>
          </h1>
          {/* Löftet står FÖRE första trycket, på varje skärmstorlek. Det som stod här hette
              "AI-granskning" och lovade "en färdig annons" — och den som läste det trodde sig ha
              beställt ett dokument. Erbjudandet är att möbeln blir såld; det får inte vara något
              man upptäcker först på sista skärmen. Två rader räcker på telefonen, där listan är
              resten av skärmen — stegen under är fortfarande datorvyns, som har plats för dem. */}
          <p className="home-lede">{t("Vi gör annonsen, säljer möbeln och hör av oss när den är såld.")}</p>
          <ol className="home-steps desktop-only">
            <li>{t("Välj märket")}</li>
            <li>{t("Filma ett varv")}</li>
            <li>{t("Vi säljer den åt dig")}</li>
          </ol>
        </header>
      )}

      <div className="brand-search">
        <span className="brand-search-icon">
          <SearchIcon />
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("Sök märke")}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label={t("Sök märke")}
        />
        {query && (
          <button type="button" className="brand-search-clear" onClick={() => setQuery("")} aria-label={t("Rensa")}>
            <CloseIcon size={12} />
          </button>
        )}
      </div>

      {/* Rullande lista, inte ett ark. Märkena är många nog att man bläddrar, få nog att man hittar. */}
      <div className="brand-scroll">
        {shown.map((name) => {
          const t = brandTheme(name);
          return (
            <button
              key={name}
              className={`brand-tile brand-font-${t.font}`}
              style={{ background: t.bg, color: t.ink }}
              onClick={() => onStartScan({ brand: name, model: "" })}
            >
              {/* Storleken kommer ur brand-font-klassen, resten — familj, vikt, spärr, versaler —
                  ur märkets eget tonfall. Samma regel som brickorna i butiken. */}
              <span className="brand-tile-name" style={brandTypeStyle(brandLook(name).type)}>{name}</span>
              <span className="brand-tile-go" style={{ color: t.accent }}>
                <ChevronRight size={18} />
              </span>
            </button>
          );
        })}

        {typed && !exact && (
          <button className="brand-tile brand-tile-custom" onClick={() => onStartScan({ brand: typed, model: "" })}>
            <span className="brand-tile-name">{t("Använd ”{namn}”", { namn: typed })}</span>
            <span className="brand-tile-go">
              <ChevronRight size={18} />
            </span>
          </button>
        )}
        {shown.length === 0 && !typed && <p className="muted small">{t("Inga märken.")}</p>}
      </div>

      {/* Vad det kostar, i en rad. Priset på tjänsten stod förut ingenstans i appen — säljaren
          filmade, granskade och tryckte på "Sälj med Loopa" utan att ha fått veta vad Loopa tar för
          det. Raden ligger sist på sidan, ovanför köphalvan. */}
      <p className="home-fee-line">{t("Loopa tar {andel} % av försäljningspriset", { andel: LOOPA_PERCENT })}</p>

      {/* Köphalvan, sist på sidan: först när man sagt nej till att sälja är man en köpare. */}
      {MARKNADSPLATS && <Upptack />}
    </div>
  );
}

/** Förnamnet räcker i topplisten; hela adressen gör knappen bredare än rubriken under den. */
function shortName(name: string | null | undefined, email: string | null | undefined): string {
  const source = name || email?.split("@")[0] || "Profil";
  return source.split(/\s+/)[0];
}
