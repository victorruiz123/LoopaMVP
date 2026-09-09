import { useEffect, useMemo, useState } from "react";
import type { FurnitureIdentity } from "../types";
import { SearchIcon, CloseIcon } from "../components/icons";
import Avatar from "../components/Avatar";
import { useAuth } from "../auth/AuthProvider";
import { KNOWN_BRANDS } from "../lib/brands";
import { LOOPA_FEE_CAP_SEK, LOOPA_PERCENT } from "../lib/fees";
import { formatSek } from "../lib/price";
import { POPULAR_BRANDS, VITRIN } from "../lib/brandSeed";
import { brandLook, brandTypeStyle, harEgenIdentitet } from "../lib/brandLook";
import HurFungerarDet from "../components/HurFungerarDet";
import { usePageTitle } from "../lib/pageTitle";
import { useT } from "../lib/i18n";

function fold(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

const POPULAR_SET = new Set(POPULAR_BRANDS.map(fold));

/**
 * Alla märken, i den ordning rutnätet ska MÖTA blicken.
 *
 * Tre lager, och ordningen är visuell och inte alfabetisk — rutnätet är en hylla med varumärken,
 * inte ett register:
 *
 *   1. Skyltningen (VITRIN): åtta hus med åtta olika ordbilder, valda för att visa vad brickorna är.
 *   2. Resten av märkena som har en egen husfärg och bokstavsform (brandLook.ts).
 *   3. Korpusen. Beigea neutraler, för om dem säger tabellen ingenting.
 *
 * Utan lager 1 och 2 öppnade listan med volymhandeln — fem snarlika röda och blå rutor — och man
 * missade att brickorna alls bär märkenas egen identitet.
 *
 * ORDNINGEN GÄLLER BARA DEN TOMMA RUTAN. Söker man något söks hela korpusen igenom, och hittas
 * märket ändå inte går det att skriva in. Listan är en genväg, inte en gräns.
 */
const ALL_BRANDS = (() => {
  const alla = [
    ...POPULAR_BRANDS,
    ...KNOWN_BRANDS.map((b) => b.name).filter((n) => !POPULAR_SET.has(fold(n))),
  ];
  const vitrin = new Set(VITRIN.map(fold));
  // Skyltningens egen ordning bevaras; namnen tas ur listan ovan så stavningen förblir korpusens.
  const forst = VITRIN.map((v) => alla.find((n) => fold(n) === fold(v))).filter((n): n is string => !!n);
  const ovriga = alla.filter((n) => !vitrin.has(fold(n)));
  return [
    ...forst,
    ...ovriga.filter((n) => harEgenIdentitet(n)),
    ...ovriga.filter((n) => !harEgenIdentitet(n)),
  ];
})();

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
  const [hurOppen, setHurOppen] = useState(false);

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
    <div className="screen screen-light home">
      {/*
        Topplisten: ordmärket till vänster, profilen till höger. Ingenting däremellan.

        Här stod en länk till butiken. Den är borta: raden är sidans enda vågräta yta, och den ska
        bära avsändaren och vägen till kontot — inget tredje. Vägen till butiken finns kvar i foten
        och i butikens egen topplist.
      */}
      <div className="home-bar">
        <span className="home-wordmark">loopa</span>
        {/* Ingen knapp alls medan sessionen läses: att gissa fel i en tiondels sekund byter ut
            brickan framför ögonen på den som just siktat in sig på den. */}
        {!loading && (
          <button
            className={`home-bar-profil ${user ? "home-bar-profil-inne" : ""}`}
            onClick={onOpenProfile}
            aria-label={user ? t("Din profil") : t("Logga in")}
            title={user ? shortName(profile?.full_name ?? profile?.username, user.email) : t("Logga in")}
          >
            <Avatar profile={profile} email={user?.email} inloggad={!!user} size={21} />
          </button>
        )}
      </div>

      {/*
        HERON.

        Rubriken säger vad man kan få gjort åt sig, inte vad man ska göra: "Låt loopa sälja din möbel"
        i stället för "Sälj din möbel". Skillnaden är hela erbjudandet — den som står med en soffa hen
        inte orkar med behöver höra att någon annan tar över, inte få en uppmaning till.

        Ingressen bär invändningen direkt efter löftet. "Möt aldrig köparen" är det som avgör för
        många, och det ska inte ligga tre skärmar ned.
      */}
      <header className="home-hero">
        <h1 className="home-rubrik">
          {t("Låt")} <span className="home-rubrik-loopa">loopa</span> {t("sälja din möbel.")}
        </h1>
        <p className="home-ingress">
          {t("AI identifierar, granskar och säljer din möbel. Möt aldrig köparen!")}
        </p>
        {/* Vägen till förklaringen. En knapp och inte en textlänk: det är sidans andra handling
            efter att välja märke, och den som tvekar ska se att det finns någonstans att fråga. */}
        <button className="home-hur-knapp" onClick={() => setHurOppen(true)}>
          {t("Hur fungerar det?")}
        </button>
      </header>

      <section className="home-marken">
        <h2 className="home-marken-rubrik">{t("Vilket märke har din möbel?")}</h2>

        <div className="home-sok">
          <span className="home-sok-ikon">
            <SearchIcon />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Sök märke, t.ex. String eller HAY")}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label={t("Sök märke")}
          />
          {query && (
            <button type="button" className="home-sok-rensa" onClick={() => setQuery("")} aria-label={t("Rensa")}>
              <CloseIcon size={12} />
            </button>
          )}
        </div>

        {/*
          RUTAN RULLAR INUTI SIG SJÄLV, och det är avsiktligt.

          Märkena är tvåhundra. Lades de rakt på sidan blev startsidan en oändlig lista där priset och
          allt annat hamnade utom räckhåll — och den som inte hittade sitt märke på skärm ett visste
          inte om det fanns fler. Med en egen ram och en egen rullning är listan ett OBJEKT: den har
          en kant, den har ett slut, och raden under säger hur många som ligger i den.
        */}
        <div className="home-marken-ram">
          <div className="home-marken-rutnat">
            {shown.map((name) => {
              const look = brandLook(name);
              // Märkets egen stavning när den skiljer sig från korpusens — se `wordmark`.
              const ordbild = look.wordmark ?? name;
              return (
                <button
                  key={name}
                  className="home-marke"
                  style={{
                    background: look.bg,
                    color: look.fg,
                    boxShadow: look.ring ? "inset 0 0 0 1px hsl(34 18% 7% / 0.13)" : "none",
                  }}
                  onClick={() => onStartScan({ brand: name, model: "" })}
                >
                  <span
                    /* Långa namn får ett steg mindre. "CARL HANSEN & SØN" bryter annars mitt i
                       ordet på en tvåspaltig telefon, och ett märke man inte kan läsa på en rad är
                       ett märke man inte känner igen — vilket är hela skälet brickorna finns. */
                    className={`home-marke-namn ${ordbild.length > 13 ? "home-marke-namn-lang" : ""}`}
                    style={{
                      ...brandTypeStyle(look.type),
                      // Spärren skjuter texten åt höger; halva spärren tillbaka centrerar ordet.
                      textIndent: look.type === "wide" || look.type === "lower" ? "0.16em" : undefined,
                    }}
                  >
                    {ordbild}
                  </span>
                </button>
              );
            })}

            {typed && !exact && (
              <button
                className="home-marke home-marke-eget"
                onClick={() => onStartScan({ brand: typed, model: "" })}
              >
                <span className="home-marke-namn">{t("Använd ”{namn}”", { namn: typed })}</span>
              </button>
            )}
          </div>
        </div>

        {/* Raden under ramen: hur många som ligger i den, och att den går att rulla. Den högra halvan
            försvinner när allt får plats — en uppmaning att skrolla i en lista utan mer under sig är
            en lögn man upptäcker direkt. */}
        <div className="home-marken-fot">
          <span>
            {query
              ? t("{antal} träffar", { antal: shown.length })
              : t("{antal} märken", { antal: shown.length })}
          </span>
          {shown.length > 8 && <span className="home-marken-mer">{t("Skrolla för fler ↓")}</span>}
        </div>
      </section>

      {/*
        Vad det kostar, och vad det inte kostar.

        Andelen stod förut som en rad i mängden. Den är istället sidans sista block och skriven som
        två meningar: vad vi tar, och att ett misslyckande är gratis. Den andra meningen är den som
        faktiskt sänker tröskeln — risken med att prova är noll, och det ska stå med lika stora
        bokstäver som avgiften.
      */}
      {/* TAKET STÅR MED HÄR OCH INTE BARA I SÄLJBEKRÄFTELSEN. Utan det läser raden som att en soffa
          för 12 000 kr kostar 2 400 kr att sälja — vilket är fel åt det håll som gör att man inte
          provar, och just på de möbler där det är mest värt att göra det. */}
      <section className="home-avgift">
        <span className="home-avgift-tal">{LOOPA_PERCENT} %</span>
        <p>
          {t(
            "av försäljningspriset går till Loopa, men aldrig mer än {tak}. Resten är ditt — och blir möbeln inte såld kostar det inget.",
            { tak: formatSek(LOOPA_FEE_CAP_SEK) },
          )}
        </p>
      </section>

      <footer className="home-fot">
        <span className="home-wordmark">loopa</span>
        <span className="home-fot-ort">{t("Loopa AI · Möbler i Stockholm")}</span>
      </footer>

      <HurFungerarDet open={hurOppen} onClose={() => setHurOppen(false)} />
    </div>
  );
}

/** Förnamnet räcker som titel på profilknappen; hela adressen är ingen etikett. */
function shortName(name: string | null | undefined, email: string | null | undefined): string {
  const source = name || email?.split("@")[0] || "Profil";
  return source.split(/\s+/)[0];
}
