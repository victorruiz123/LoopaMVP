import { useEffect, useState } from "react";
import "./butik.css";
import { navigate, useButikRoute } from "./router";
import LandingScreen from "./screens/LandingScreen";
import CategoryScreen from "./screens/CategoryScreen";
import BrandScreen from "./screens/BrandScreen";
import ProductScreen from "./screens/ProductScreen";
import SearchScreen from "./screens/SearchScreen";
import OrderScreen from "./screens/OrderScreen";
import ButikProfile from "./screens/ButikProfile";
import { Link, SearchIcon, track } from "./components/Bits";

/**
 * Butiken.
 *
 * Ligger bredvid säljflödet, inte inuti det: App.tsx väljer mellan dem på adressen, precis som den
 * redan gör med det publika kortet och de juridiska sidorna. Det är samma app och samma konto, men
 * två olika saker att göra — och säljflödets tillstånd (bildrutor i minnet, ett halvfärdigt jobb)
 * har ingenting i ett rutnät att göra.
 */
export default function ButikApp() {
  const { route } = useButikRoute();

  useEffect(() => {
    document.title = titleFor(route);
  }, [route]);

  return (
    <div className="butik">
      <ButikBar />
      <main className="butik-main">
        {route.name === "landing" && <LandingScreen />}
        {route.name === "category" && <CategoryScreen slug={route.slug} />}
        {route.name === "brand" && <BrandScreen slug={route.slug} />}
        {route.name === "product" && <ProductScreen id={route.id} />}
        {route.name === "search" && <SearchScreen q={route.q} />}
        {route.name === "order" && <OrderScreen id={route.id} />}
        {route.name === "profile" && <ButikProfile />}
      </main>
      <ButikFooter />
    </div>
  );
}

function titleFor(route: ReturnType<typeof useButikRoute>["route"]): string {
  switch (route.name) {
    case "category": return "Kategori – Loopa Butik";
    case "brand": return `${route.slug} secondhand – Loopa Butik`;
    case "product": return "Möbel – Loopa Butik";
    case "search": return route.q ? `${route.q} – Loopa Butik` : "Alla möbler – Loopa Butik";
    case "order": return "Din order – Loopa";
    case "profile": return "Din profil – Loopa";
    default: return "Loopa Butik – köp begagnat, handla som nytt";
  }
}

function ButikBar() {
  const { route } = useButikRoute();
  const [q, setQ] = useState(route.name === "search" ? route.q : "");

  return (
    <header className="butik-bar">
      <Link to={{ name: "landing" }} className="butik-logo">loopa<span>.</span></Link>
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

