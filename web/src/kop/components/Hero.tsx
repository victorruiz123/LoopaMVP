import { useRef, useState } from "react";
import { track } from "../../butik/components/Bits";
import { useAuth } from "../../auth/AuthProvider";
import { fragaOmInloggning } from "./LoggaInGrind";

/**
 * Heron: en rad, ett fält, och vägen in i Trygg affär.
 *
 * SIDANS LCP. Ingen bild, ingen animation, inget nätverksanrop innan den ritas — rubriken och fältet
 * är det första som målas, och allt annat på sidan laddas efter. Det är därför animationen ligger
 * längre ned och startar först när den syns.
 *
 * FÄLTET TAR BÅDE LÄNK OCH SKÄRMBILDER, som Trygg affär-intaget redan gör. Går hämtningen inte
 * igenom ber nästa skärm om bilder i stället — och därför säger vi det redan här, i stället för att
 * låta någon upptäcka det efter ett misslyckat försök.
 *
 * FELET HJÄLPER, ALDRIG SKÄLLER. "Det där ser inte ut som en länk — klistra in adressen från
 * webbläsarens adressfält, eller ladda upp en skärmbild i stället" är en instruktion. "Ogiltig URL"
 * är en anklagelse.
 */

const KALLOR = ["Blocket", "Facebook Marketplace", "Tradera"];

export default function Hero() {
  const { user } = useAuth();
  const [lank, setLank] = useState("");
  const [fel, setFel] = useState<string | null>(null);
  const [harBorjat, setHarBorjat] = useState(false);
  const filer = useRef<HTMLInputElement>(null);

  const skicka = () => {
    const url = lank.trim();
    if (!url) {
      document.getElementById("hero-lank")?.focus();
      return;
    }
    if (!ärAdress(url)) {
      setFel(
        "Det där ser inte ut som en länk. Kopiera adressen från webbläsarens adressfält — " +
        "eller ladda upp skärmbilder av annonsen, det går lika bra.",
      );
      return;
    }
    track("hero_submit", { host: säkerVärd(url) });
    /**
     * Frågan om inloggning ställs HÄR, när avsikten är som starkast.
     *
     * Allt som följer — analysen, inbjudan, betalningen, leveransen — kräver ett konto ändå. Att
     * fråga nu är vänligare än att fråga tre steg senare när någon redan lagt tid på det. Är man
     * redan inne märks ingenting.
     */
    const ga = () => { window.location.href = `/kop/analysera?url=${encodeURIComponent(url)}`; };
    if (fragaOmInloggning(!!user, "lank", ga)) ga();
  };

  return (
    <section className="hero">
      <h1 className="hero-rubrik">
        Hittat en möbel?<br /><em>Köp den tryggt.</em>
      </h1>
      <p className="hero-sub">Vi granskar, betalar säkert och kör hem den.</p>

      <form className="hero-form" onSubmit={(e) => { e.preventDefault(); skicka(); }}>
        <div className={fel ? "hero-falt hero-falt-fel" : "hero-falt"}>
          <input
            id="hero-lank"
            type="text"
            inputMode="url"
            value={lank}
            onChange={(e) => {
              setLank(e.target.value);
              setFel(null);
              // En gång per besök: att någon börjat skriva är ett annat mått än att de skickat.
              if (!harBorjat && e.target.value.trim()) { setHarBorjat(true); track("hero_paste_start", {}); }
            }}
            placeholder="Klistra in länken till annonsen"
            aria-label="Klistra in länken till annonsen"
            aria-invalid={!!fel}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className="hero-go">Kolla annonsen</button>
        </div>

        {fel && <p className="hero-fel" role="status">{fel}</p>}

        <p className="hero-hjalp">
          Ingen länk?{" "}
          <button type="button" className="hero-lank-knapp" onClick={() => filer.current?.click()}>
            Ladda upp skärmbilder
          </button>{" "}
          av annonsen i stället.
        </p>
        <input
          ref={filer}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            // Bilderna bärs vidare av Trygg affär-intaget, som redan hanterar dem. Här öppnas bara
            // dörren dit — den här sidan äger inte uppladdningen.
            if (!e.target.files?.length) return;
            track("hero_submit", { host: null, via: "skarmbilder" });
            const ga = () => { window.location.href = "/kop/analysera?bilder=1"; };
            if (fragaOmInloggning(!!user, "skarmbilder", ga)) ga();
          }}
        />
      </form>

      {/* Källorna som ren igenkänning: text, inte deras varumärkesfiler. */}
      <ul className="hero-kallor" aria-label="Fungerar med">
        {KALLOR.map((k) => <li key={k}>{k}</li>)}
      </ul>

      {/*
        DEN ANDRA VÄGEN, tydligt underordnad den första.
        Sidan handlar om en möbel du hittat någon annanstans. Att vi också har ett eget lager är sant
        och värt att säga — men det är ett "eller", och ska se ut som ett.
      */}
      <p className="hero-eller">
        eller{" "}
        <a
          href="/butik/sok"
          onClick={(e) => {
            e.preventDefault();
            track("leta_bland_produkter", {});
            const ga = () => { window.location.href = "/butik/sok"; };
            if (fragaOmInloggning(!!user, "bladdra", ga)) ga();
          }}
        >
          leta bland produkter vi redan granskat →
        </a>
      </p>
    </section>
  );
}

/** Snäll adresskontroll: en punkt och ingen blanksteg räcker. Vi ska hjälpa, inte grinda. */
function ärAdress(v: string): boolean {
  const t = v.trim();
  if (/\s/.test(t)) return false;
  return /^https?:\/\/.+\..+/.test(t) || /^[\w-]+(\.[\w-]+)+\/.+/.test(t);
}

/** Bara värdnamnet till analysen — aldrig hela adressen, som kan bära vem annonsen tillhör. */
function säkerVärd(url: string): string | null {
  try { return new URL(url.startsWith("http") ? url : `https://${url}`).hostname; } catch { return null; }
}
