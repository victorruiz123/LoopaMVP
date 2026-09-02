import { useState, type ReactNode } from "react";
import { Link, SearchIcon, track } from "./Bits";
import { navigate, useButikRoute } from "../router";

/**
 * Ramen kring köpsidan: topprad, innehåll, sidfot.
 *
 * DELAD MELLAN /kop OCH /butik med flit. De två är två vyer av samma köpsida — den ena beskriver vad
 * man vill ha, den andra bläddrar i det vi har — och en egen ram per vy hade gjort dem till två
 * sajter för den som klickar mellan dem. Låg tidigare inuti ButikApp och flyttades ut när köpsidan
 * kom till; ingenting i den ändrades på vägen.
 */
export default function ButikChrome({ children }: { children: ReactNode }) {
  return (
    <div className="butik">
      <ButikBar />
      <main className="butik-main">{children}</main>
      <ButikFooter />
    </div>
  );
}

function ButikBar() {
  const { route } = useButikRoute();
  const [q, setQ] = useState(route.name === "search" ? route.q : "");

  return (
    <header className="butik-bar">
      {/* Loggan går till KÖPSIDAN, inte till butikens rot: roten 301:as dit ändå. */}
      <a href="/kop" className="butik-logo">loopa<span>.</span></a>
      <form
        className="butik-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          track("search", { q });
          navigate({ name: "search", q });
        }}
      >
        <SearchIcon />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Sök möbel, märke eller modell"
          aria-label="Sök i butiken"
        />
      </form>
      {/* Profilen ligger före säljknappen: den som redan handlat kommer tillbaka för att se sina
          köp och affärer, och den vägen fanns inte alls förut — en betald order gick bara att nå
          via adressen man fick efter kassan. */}
      <Link to={{ name: "profile" }} className="butik-bar-profile">
        <span className="butik-bar-sell-long">Min profil</span>
        <span className="butik-bar-sell-short">Profil</span>
      </Link>
      {/* Säljvägen finns i toppraden på VARJE butikssida — det är köp↔sälj-slingans stadigaste plats. */}
      <a className="butik-bar-sell" href="/" onClick={() => track("sell_cta_click", { from: "header" })}>
        <span className="butik-bar-sell-long">Sälj en möbel</span>
        <span className="butik-bar-sell-short">Sälj</span>
      </a>
    </header>
  );
}

function ButikFooter() {
  return (
    <footer className="butik-main" style={{ paddingTop: 30, paddingBottom: 40, borderTop: "1px solid var(--border)", marginTop: 40 }}>
      <p className="butik-card-meta" style={{ lineHeight: 1.6 }}>
        Loopa säljer begagnade möbler i Stockholm. Möbler märkta <strong>Loopa-granskad</strong> är besiktigade av oss,
        levereras hem av oss.
      </p>
      {/* Attribution enligt Traderas API-villkor. Står på varje sida där deras annonser kan visas. */}
      <p className="butik-card-meta" style={{ lineHeight: 1.6, marginTop: 8 }}>
        Annonser märkta ”Säljs via Tradera” kommer från Tradera och visas via Traderas öppna API. De är inte granskade av
        Loopa, och köpet sker hos Tradera.
      </p>
      <p className="butik-card-meta" style={{ marginTop: 12, gap: 14 }}>
        <a href="/villkor" target="_blank" rel="noopener">Villkor</a>
        <a href="/integritetspolicy" target="_blank" rel="noopener">Integritetspolicy</a>
        <a href="/cookies" target="_blank" rel="noopener">Cookies</a>
      </p>
    </footer>
  );
}
