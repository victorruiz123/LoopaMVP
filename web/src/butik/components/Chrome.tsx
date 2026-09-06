import { useRef, useState, type ReactNode } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { Link, SearchIcon, track } from "./Bits";
import { navigate, useButikRoute } from "../router";
import LoggaInGrind from "../../kop/components/LoggaInGrind";

/**
 * Ramen kring köpsidan: topprad, innehåll, sidfot.
 *
 * DELAD MELLAN /kop OCH /butik med flit. De två är två vyer av samma köpsida — den ena beskriver vad
 * man vill ha, den andra bläddrar i det vi har — och en egen ram per vy hade gjort dem till två
 * sajter för den som klickar mellan dem. Låg tidigare inuti ButikApp och flyttades ut när köpsidan
 * kom till; ingenting i den ändrades på vägen.
 */
export default function ButikChrome({ children }: { children: ReactNode }) {
  /*
   * `variant` fanns här för köpsidans skiss-läge ("butik-skiss": hela bredden, egen palett, en
   * topprad utan sökikon). Den sidan är borttagen och ingen annan vy satte propen, så ramen har
   * återigen bara ett utseende.
   */
  return (
    <div className="butik">
      <ButikBar />
      <main className="butik-main">{children}</main>
      <ButikFooter />
      {/*
        Inloggningsfrågan hör till RAMEN, inte till en sida.
        Toppradens "Logga in" står på varje sida under /kop och /butik och ber om inloggning med ett
        fönsterhändelse. Låg lyssnaren bara på köpsidans landningssida — som den gjorde — hände
        ingenting när knappen trycktes någon annanstans: klicket stoppades, och inget öppnades.
        Här finns den överallt där knappen finns.
      */}
      <LoggaInGrind />
    </div>
  );
}

function ButikBar() {
  const { route } = useButikRoute();
  const { user, profile } = useAuth();
  const [sokOppen, setSokOppen] = useState(false);
  const [q, setQ] = useState(route.name === "search" ? route.q : "");
  const faltet = useRef<HTMLInputElement>(null);

  const sok = () => {
    track("search", { q });
    navigate({ name: "search", q });
    setSokOppen(false);
  };

  return (
    <header className="butik-bar">
      {/* Ordmärket: orange, Poppins 800. Går till STARTSIDAN, inte till lagret. Ett ordmärke är
          vägen hem — samma sak som i Trygg affärs ram (affar/AffarApp.tsx) — och "hem" är sidan
          som säger vad Loopa är, inte en lista med alla möbler. Vill man se hela lagret finns
          sökningen bredvid. */}
      <a href="/" className="butik-logo">loopa<span>.</span></a>

      {/*
        SÖKNINGEN ÄR EN KNAPP, inte ett fält.
        Ett fullbrett fält i toppen sa att sidan handlar om att söka i vårt lager. Det gör den inte —
        den handlar om en möbel besökaren hittat någon annanstans, och den saken ska äga blicken.
        Fältet finns kvar, en knapptryckning bort.
      */}
      {sokOppen ? (
        <form
          className="butik-search butik-search-oppen"
          role="search"
          onSubmit={(e) => { e.preventDefault(); sok(); }}
        >
          <SearchIcon />
          <input
            ref={faltet}
            type="search"
            value={q}
            autoFocus
            onChange={(e) => setQ(e.target.value)}
            onBlur={() => { if (!q.trim()) setSokOppen(false); }}
            onKeyDown={(e) => { if (e.key === "Escape") setSokOppen(false); }}
            placeholder="Sök möbel, märke eller modell"
            aria-label="Sök i butiken"
          />
        </form>
      ) : (
        <button
          type="button"
          className="butik-bar-ikon"
          aria-label="Sök"
          onClick={() => { setSokOppen(true); requestAnimationFrame(() => faltet.current?.focus()); }}
        >
          <SearchIcon />
        </button>
      )}

      <span className="butik-bar-fyll" />

      {/*
        PROFILEN ÄR EN RUND KNAPP med bild eller initial — eller "LOGGA IN" när ingen är inloggad.
        Skillnaden är avsiktligt tydlig: en avatar säger "du är inne", en textknapp säger "du är
        inte". En generisk gubbe hade sagt ingetdera.
      */}
      {user ? (
        <Link to={{ name: "profile" }} className="butik-avatar" aria-label="Min profil">
          {profile?.avatar_url
            ? <img src={profile.avatar_url} alt="" />
            : <span>{initial(profile?.full_name || profile?.username || user.email)}</span>}
        </Link>
      ) : (
        <a className="butik-bar-logga-in" href="/butik?logga-in=1" onClick={(e) => {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("loopa:logga-in", { detail: { anledning: "header" } }));
        }}>
          Logga in
        </a>
      )}

      {/* Säljvägen finns i toppraden på VARJE sida — det är köp↔sälj-slingans stadigaste plats. */}
      <a className="butik-bar-sell" href="/" onClick={() => track("sell_cta_click", { from: "header" })}>
        <span className="butik-bar-sell-long">Sälj en möbel</span>
        <span className="butik-bar-sell-short">Sälj</span>
      </a>
    </header>
  );
}

/** Första bokstaven, versal. Namn före användarnamn före e-post — det mest personliga som finns. */
function initial(namn: string | null | undefined): string {
  return (namn ?? "?").trim().charAt(0).toUpperCase() || "?";
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
