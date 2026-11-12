import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import HemFlikar, { gaTill } from "../components/HemFlikar";
import AuthScreen from "./AuthScreen";
import { formatOre } from "../components/Affiliate";
import { getMinAffiliate } from "../api";
import { useAuth } from "../auth/AuthProvider";
import { useLang } from "../lib/i18n";
import { usePageTitle } from "../lib/pageTitle";
import type { MinAffiliate } from "../types";
import "./om-oss.css";
import "./affiliate.css";

/**
 * Tjäna — affiliate-programmets marknadssida, startsidans tredje flik (/affiliate).
 *
 * LOVAR EXAKT DET SERVERN GÖR, inget mer: server/src/affiliate/regler.ts. 5 % av försäljningspriset
 * (AFFILIATE_ANDEL) på varje annons en värvad användare säljer, när säljarens pengar betalats ut;
 * kontot ska vara högst 30 dagar gammalt och sakna annonser (NYTT_KONTO_DAGAR); länken minns 30 dagar
 * (lib/affiliate.ts); första koden gäller; en retur annullerar provisionen. Ändras reglerna där ska
 * texten här ändras med dem.
 *
 * INGEN ANSÖKAN. Förlagan (en kreatörsprogram-sida) har ett ansökningsformulär; här finns länken redan
 * på varje konto, så sidans "ansök"-del är i stället länken själv — eller registreringen för den som
 * saknar konto.
 *
 * Samma upplägg som Om oss: text per språk som eget objekt, franskan faller tillbaka på engelskan,
 * och sidans byggklossar (oo-*) delas med den.
 */

const ANDEL = 0.05;

type Innehall = {
  title: string;
  eyebrow: string;
  h1a: string;
  h1b: string;
  intro: string;
  ctaLank: string;
  ctaHur: string;
  exempel: string;
  exempelRader: { mobel: string; pris: number }[];
  tillDig: string;
  saldNyss: string;
  band: string[];
  hur: { over: string; rubrik: string; steg: { rubrik: string; text: string }[] };
  kalk: {
    rubrik: string;
    text: string;
    vanner: string;
    mobler: string;
    snitt: string;
    resultat: string;
    not: string;
  };
  lank: {
    over: string;
    rubrik: string;
    utloggadText: string;
    skapa: string;
    loggaIn: string;
    inloggadText: string;
    din: string;
    kopiera: string;
    kopierad: string;
    dela: string;
    delaText: string;
    statRegistreringar: string;
    statAnnonser: string;
    statSalda: string;
    statVantande: string;
    statUtbetalt: string;
    fel: string;
  };
  faq: { over: string; mer: string; merLank: string; rubrik: string; fragor: { q: string; a: string }[] };
  slut: { rubrik: string; text: string; cta: string };
};

const SV: Innehall = {
  title: "Tjäna pengar",
  eyebrow: "Loopa Affiliate",
  h1a: "Dela Loopa.",
  h1b: "Tjäna pengar.",
  intro:
    "Få 5 % av försäljningspriset på varje möbel som någon du värvar säljer med Loopa. Länken är gratis, klar på en minut, och ingen ansökan behövs.",
  ctaLank: "Hämta din länk",
  ctaHur: "Så funkar det",
  exempel: "Exempel",
  exempelRader: [
    { mobel: "Soffa", pris: 4200 },
    { mobel: "Matbord", pris: 2800 },
    { mobel: "Fåtölj", pris: 1500 },
    { mobel: "Byrå", pris: 1200 },
    { mobel: "Bokhylla", pris: 900 },
    { mobel: "Sängram", pris: 2400 },
    { mobel: "Skrivbord", pris: 1100 },
    { mobel: "Matstolar, 4 st", pris: 1800 },
  ],
  tillDig: "till dig",
  saldNyss: "Såld",
  band: [
    "5 % på varje möbel",
    "Dela med vänner som flyttar",
    "Länken gäller i 30 dagar",
    "Länken klar på en minut",
    "Allt syns i profilen",
    "Varje möbel som säljs slängs inte",
  ],
  hur: {
    over: "Tre steg",
    rubrik: "Så funkar det",
    steg: [
      {
        rubrik: "Hämta din länk",
        text: "Skapa ett gratis konto. Din personliga länk – loopa.nu/p/DIN-KOD – finns direkt här på sidan och under Tjäna i din profil.",
      },
      {
        rubrik: "Dela den",
        text: "Skicka den till vänner som ska flytta, lägg den i bion, i en story eller i gruppchatten. Den som öppnar länken och skapar konto inom 30 dagar kopplas till dig.",
      },
      {
        rubrik: "Tjäna 5 %",
        text: "När någon du värvat säljer en möbel och affären är slutförd får du 5 % av försäljningspriset. På varje annons de säljer – inte bara den första.",
      },
    ],
  },
  kalk: {
    rubrik: "Räkna på det",
    text: "Dra i reglagen och se vad det kan bli.",
    vanner: "Vänner som säljer via din länk",
    mobler: "Möbler var",
    snitt: "Snittpris per möbel",
    resultat: "till dig",
    not: "Räkneexempel. Det du tjänar beror på vad de du värvar faktiskt säljer.",
  },
  lank: {
    over: "Kom igång",
    rubrik: "Hämta din länk",
    utloggadText: "Din länk är ett konto bort. Skapa ett gratis konto – eller logga in – så dyker den upp här direkt.",
    skapa: "Skapa konto gratis",
    loggaIn: "Jag har redan ett konto",
    inloggadText: "Det här är din personliga länk. Dela den, så kopplas den som skapar konto via den till dig.",
    din: "Din affiliate-länk",
    kopiera: "Kopiera länk",
    kopierad: "Kopierad ✓",
    dela: "Dela",
    delaText: "Sälj dina begagnade möbler med Loopa AI.",
    statRegistreringar: "Registreringar",
    statAnnonser: "Annonser",
    statSalda: "Sålda",
    statVantande: "Väntande",
    statUtbetalt: "Utbetalt",
    fel: "Länken gick inte att hämta just nu. Du hittar den också under Tjäna i din profil.",
  },
  faq: {
    over: "Frågor och svar",
    mer: "Hittar du inte svaret?",
    merLank: "Läs villkoren",
    rubrik: "Vanliga frågor",
    fragor: [
      {
        q: "Hur mycket kan jag tjäna?",
        a: "5 % av försäljningspriset på varje möbel en värvad användare säljer. En soffa som säljs för 4 000 kr ger dig 200 kr. Det finns ingen övre gräns – provisionen gäller varje annons de säljer, inte bara den första.",
      },
      {
        q: "När räknas någon som värvad av mig?",
        a: "När hen öppnar din länk och skapar ett nytt konto inom 30 dagar. Kontot ska vara nytt och sakna annonser hos Loopa – en befintlig säljare som klickar på din länk blir inte värvad. Har någon öppnat flera länkar gäller den första.",
      },
      {
        q: "När och hur får jag betalt?",
        a: "Provisionen tjänas in när affären är slutförd, alltså när säljaren fått betalt – blir köpet avbrutet eller returnerat blir det ingen. Intjänad provision syns som väntande under Tjäna i din profil. Vi betalar ut den och kontaktar dig via e-postadressen på ditt konto – håll den uppdaterad. När beloppet betalats ut flyttas det till utbetalt.",
      },
      {
        q: "Kan jag värva mig själv?",
        a: "Nej. Din egen länk fungerar inte på ditt eget konto, och ett konto som redan har annonser kan inte värvas.",
      },
      {
        q: "Behöver jag märka mina inlägg?",
        a: "Ja, om du delar länken offentligt, till exempel i sociala medier. Eftersom du får provision är det reklam enligt marknadsföringslagen – skriv till exempel ”reklam” eller ”affiliate-länk” tydligt i inlägget. I ett privat meddelande till en vän räcker det att vara ärlig om att du får en del.",
      },
    ],
  },
  slut: {
    rubrik: "Redo att dela Loopa?",
    text: "Hämta länken på en minut. Varje möbel som säljs i stället för att slängas är en vinst – nu även för dig.",
    cta: "Hämta din länk",
  },
};

const EN: Innehall = {
  title: "Earn money",
  eyebrow: "Loopa Affiliate",
  h1a: "Share Loopa.",
  h1b: "Get paid.",
  intro:
    "Earn 5% of the sale price on every piece of furniture someone you refer sells with Loopa. The link is free, ready in a minute, and there is no application.",
  ctaLank: "Get your link",
  ctaHur: "How it works",
  exempel: "Example",
  exempelRader: [
    { mobel: "Sofa", pris: 4200 },
    { mobel: "Dining table", pris: 2800 },
    { mobel: "Armchair", pris: 1500 },
    { mobel: "Chest of drawers", pris: 1200 },
    { mobel: "Bookshelf", pris: 900 },
    { mobel: "Bed frame", pris: 2400 },
    { mobel: "Desk", pris: 1100 },
    { mobel: "Dining chairs, 4", pris: 1800 },
  ],
  tillDig: "to you",
  saldNyss: "Sold",
  band: [
    "5% on every item",
    "Share with friends who are moving",
    "Your link counts for 30 days",
    "Link ready in a minute",
    "Everything in your profile",
    "Every item sold is one not thrown away",
  ],
  hur: {
    over: "Three steps",
    rubrik: "How it works",
    steg: [
      {
        rubrik: "Get your link",
        text: "Create a free account. Your personal link – loopa.nu/p/YOUR-CODE – appears right here on this page and under Earn in your profile.",
      },
      {
        rubrik: "Share it",
        text: "Send it to friends who are moving, put it in your bio, a story or the group chat. Anyone who opens the link and creates an account within 30 days is linked to you.",
      },
      {
        rubrik: "Earn 5%",
        text: "When someone you referred sells a piece of furniture and the deal is complete, you get 5% of the sale price. On every listing they sell – not just the first.",
      },
    ],
  },
  kalk: {
    rubrik: "Do the math",
    text: "Move the sliders and see what it could add up to.",
    vanner: "Friends selling via your link",
    mobler: "Items each",
    snitt: "Average price per item",
    resultat: "to you",
    not: "Example calculation. What you earn depends on what the people you refer actually sell.",
  },
  lank: {
    over: "Get started",
    rubrik: "Get your link",
    utloggadText: "Your link is one account away. Create a free account – or log in – and it shows up here right away.",
    skapa: "Create a free account",
    loggaIn: "I already have an account",
    inloggadText: "This is your personal link. Share it, and anyone who creates an account through it is linked to you.",
    din: "Your affiliate link",
    kopiera: "Copy link",
    kopierad: "Copied ✓",
    dela: "Share",
    delaText: "Sell your second-hand furniture with Loopa AI.",
    statRegistreringar: "Sign-ups",
    statAnnonser: "Listings",
    statSalda: "Sold",
    statVantande: "Pending",
    statUtbetalt: "Paid out",
    fel: "Your link couldn’t be loaded right now. You can also find it under Earn in your profile.",
  },
  faq: {
    over: "Questions",
    mer: "Can't find the answer?",
    merLank: "Read the terms",
    rubrik: "FAQ",
    fragor: [
      {
        q: "How much can I earn?",
        a: "5% of the sale price on every item a referred user sells. A sofa sold for 4,000 kr earns you 200 kr. There is no upper limit – the commission applies to every listing they sell, not just the first.",
      },
      {
        q: "When does someone count as referred by me?",
        a: "When they open your link and create a new account within 30 days. The account must be new and have no listings on Loopa – an existing seller who clicks your link is not referred. If someone opened several links, the first one counts.",
      },
      {
        q: "When and how do I get paid?",
        a: "Commission is earned when the deal is complete, meaning the seller has been paid – if the purchase is cancelled or returned, there is none. Earned commission shows as pending under Earn in your profile. We pay it out and contact you via the email address on your account – keep it up to date. Once paid, the amount moves to paid out.",
      },
      {
        q: "Can I refer myself?",
        a: "No. Your own link doesn’t work on your own account, and an account that already has listings can’t be referred.",
      },
      {
        q: "Do I need to label my posts?",
        a: "Yes, if you share the link publicly, for example on social media. Because you earn a commission it counts as advertising – mark the post clearly, e.g. “ad” or “affiliate link”. In a private message to a friend, just be honest that you get a share.",
      },
    ],
  },
  slut: {
    rubrik: "Ready to share Loopa?",
    text: "Get your link in a minute. Every item sold instead of thrown away is a win – now for you too.",
    cta: "Get your link",
  },
};

/** Kronor med mellanslag som tusentalsavgränsare: "4 200 kr". */
function kr(n: number): string {
  return `${Math.round(n).toLocaleString("sv-SE")} kr`;
}

async function kopiera(lank: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(lank);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Rörelse. Allt här stängs av för den som bett om minskad rörelse.
// ---------------------------------------------------------------------------

function minskadRorelse(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Ett tal som glider till sitt nya värde i stället för att hoppa. */
function AnimeratTal({ varde, format = kr, ms = 700 }: { varde: number; format?: (n: number) => string; ms?: number }) {
  const [visat, setVisat] = useState(varde);
  const fran = useRef(varde);
  useEffect(() => {
    if (minskadRorelse()) {
      fran.current = varde;
      setVisat(varde);
      return;
    }
    const start = performance.now();
    const a = fran.current;
    let frame = 0;
    const tick = (nu: number) => {
      const p = Math.min(1, (nu - start) / ms);
      const v = a + (varde - a) * (1 - Math.pow(1 - p, 3));
      fran.current = v;
      setVisat(v);
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [varde, ms]);
  return <>{format(visat)}</>;
}

/**
 * Tonar in allt med `.af-reveal` när det kommer in i bild. En observatör för hela sidan; klassen
 * `af-syns` sätts en gång och tas aldrig bort, så ingenting blinkar när man scrollar tillbaka.
 */
function useReveal(rot: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = rot.current;
    if (!el) return;
    const mal = Array.from(el.querySelectorAll<HTMLElement>(".af-reveal"));
    if (minskadRorelse() || typeof IntersectionObserver === "undefined") {
      mal.forEach((m) => m.classList.add("af-syns"));
      return;
    }
    const io = new IntersectionObserver(
      (poster) => {
        for (const p of poster) {
          if (!p.isIntersecting) continue;
          p.target.classList.add("af-syns");
          io.unobserve(p.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.12 },
    );
    mal.forEach((m) => io.observe(m));
    return () => io.disconnect();
  }, [rot]);
}

/** Kortet lutar sig mot pekaren. Bara med mus — på pekskärm finns ingen pekare att följa. */
function Tilt({ className, style, children }: { className: string; style?: CSSProperties; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  function flytta(e: ReactPointerEvent<HTMLElement>) {
    if (e.pointerType !== "mouse" || minskadRorelse()) return;
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    el.style.setProperty("--af-rx", `${(-y * 8).toFixed(2)}deg`);
    el.style.setProperty("--af-ry", `${(x * 10).toFixed(2)}deg`);
    el.style.setProperty("--af-gx", `${((x + 0.5) * 100).toFixed(1)}%`);
    el.style.setProperty("--af-gy", `${((y + 0.5) * 100).toFixed(1)}%`);
  }
  function lamna() {
    const el = ref.current!;
    el.style.setProperty("--af-rx", "0deg");
    el.style.setProperty("--af-ry", "0deg");
  }
  return (
    <article ref={ref} className={`af-tilt ${className}`} style={style} onPointerMove={flytta} onPointerLeave={lamna}>
      {children}
    </article>
  );
}

/**
 * Herons exempelkort, levande: en ny exempelförsäljning glider in med jämna mellanrum och summan
 * räknas upp. Rubriken säger "Exempel" hela tiden — det här är räkning på 5 %, inte riktiga affärer.
 */
function LivExempel({ a }: { a: Innehall }) {
  const rader = a.exempelRader;
  const [n, setN] = useState(3);
  const [puff, setPuff] = useState<{ id: number; belopp: number } | null>(null);

  useEffect(() => {
    if (minskadRorelse()) return;
    const id = window.setInterval(() => {
      setN((x) => x + 1);
    }, 2800);
    return () => window.clearInterval(id);
  }, []);

  // Senaste överst. Index löper runt listan, nyckeln gör att varje ny rad animerar in.
  const synliga = [0, 1, 2].map((k) => {
    const i = n - 1 - k;
    return { key: i, ...rader[((i % rader.length) + rader.length) % rader.length] };
  });
  let summa = 0;
  for (let i = 0; i < n; i++) summa += rader[i % rader.length].pris * ANDEL;

  const senaste = synliga[0];
  useEffect(() => {
    if (n <= 3) return;
    setPuff({ id: n, belopp: senaste.pris * ANDEL });
    const t = window.setTimeout(() => setPuff(null), 1400);
    return () => window.clearTimeout(t);
  }, [n]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="af-exempel-scen">
      <Collage />
      <span aria-hidden className="af-flyt af-flyt-1">🛋️</span>
      <span aria-hidden className="af-flyt af-flyt-2">💸</span>
      <span aria-hidden className="af-flyt af-flyt-3">🪑</span>
      <span aria-hidden className="af-flyt af-flyt-4">✨</span>
      <span aria-hidden className="af-flyt af-flyt-5">🪙</span>

      <div className="af-exempel oo-rise" aria-label={a.exempel}>
        <div className="af-exempel-topp">
          <span className="af-exempel-tagg">{a.exempel}</span>
          <span className="af-live">
            <span className="af-live-prick" /> live
          </span>
        </div>
        <div className="af-exempel-lista">
          {synliga.map((r, k) => (
            <div key={r.key} className={`af-exempel-rad ${k === 0 && n > 3 ? "af-ny" : ""}`} style={{ opacity: 1 - k * 0.18 }}>
              <span className="af-exempel-ikon" aria-hidden>
                ✓
              </span>
              <span className="af-exempel-mobel">
                <strong>{r.mobel}</strong>
                <span className="oo-tabular">
                  {a.saldNyss} · {kr(r.pris)}
                </span>
              </span>
              <span className="af-exempel-plus oo-tabular">+{kr(r.pris * ANDEL)}</span>
            </div>
          ))}
        </div>
        <div className="af-exempel-summa">
          {puff && (
            <span key={puff.id} aria-hidden className="af-puff oo-tabular">
              +{kr(puff.belopp)}
            </span>
          )}
          <span className="oo-tabular af-exempel-summa-tal">
            +<AnimeratTal varde={summa} />
          </span>{" "}
          {a.tillDig}
        </div>
      </div>
    </div>
  );
}

/**
 * Bildcollaget bakom exempelkortet: två snedställda kolumner möbelbilder som glider åt var sitt
 * håll. Bilderna är landningssidans egna annonsbilder (loopa-landing-page-main/public/assets),
 * nedskalade till /app-assets/affiliate. Varje kolumn står två gånger för en skarvlös slinga.
 */
const STEG_IKONER = ["🔗", "📣", "💸"];

const BILD = "/app-assets/affiliate";
const KOLUMNER = [
  ["m1", "m6", "m3", "m8"],
  ["m4", "m2", "m7", "m5"],
  ["m3", "m8", "m5", "m1"],
];

function Collage() {
  return (
    <div aria-hidden className="af-collage">
      {KOLUMNER.map((kol, k) => (
        <div key={k} className={`af-collage-kol af-collage-kol-${k}`}>
          {[...kol, ...kol].map((b, i) => (
            <img key={i} src={`${BILD}/${b}.webp`} alt="" loading={i < 4 ? "eager" : "lazy"} decoding="async" className="af-collage-bild" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Det rullande bandet. Listan står två gånger så att slingan går runt utan skarv. */
function Band({ ord }: { ord: string[] }) {
  const rad = [...ord, ...ord];
  return (
    <div className="af-band" aria-hidden>
      <div className="af-band-spar">
        {rad.map((o, i) => (
          <span key={i} className="af-band-ord">
            {o}
            <span className="af-band-prick">✦</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** En konfettiskur från knappen. Bitarna slumpas en gång per skur. */
function Konfetti({ skur }: { skur: number }) {
  const [bitar, setBitar] = useState<{ id: string; style: CSSProperties }[]>([]);
  useEffect(() => {
    if (skur === 0 || minskadRorelse()) return;
    const farger = ["var(--accent)", "#f4b740", "var(--green)", "#14110d", "#fbe9e2"];
    setBitar(
      Array.from({ length: 28 }, (_, i) => {
        const vinkel = Math.random() * Math.PI * 2;
        const langd = 60 + Math.random() * 90;
        return {
          id: `${skur}-${i}`,
          style: {
            "--af-dx": `${Math.cos(vinkel) * langd}px`,
            "--af-dy": `${Math.sin(vinkel) * langd - 40}px`,
            "--af-rot": `${Math.random() * 720 - 360}deg`,
            background: farger[i % farger.length],
            animationDelay: `${Math.random() * 80}ms`,
          } as CSSProperties,
        };
      }),
    );
    const t = window.setTimeout(() => setBitar([]), 1100);
    return () => window.clearTimeout(t);
  }, [skur]);
  return (
    <span aria-hidden className="af-konfetti">
      {bitar.map((b) => (
        <span key={b.id} className="af-konfetti-bit" style={b.style} />
      ))}
    </span>
  );
}

/** Hoppar till länkdelen. Ett vanligt ankare räcker inte: sidan saknar router som scrollar åt oss. */
function tillLanken(e: React.MouseEvent) {
  e.preventDefault();
  document.getElementById("lank")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function Kalkylator({ k }: { k: Innehall["kalk"] }) {
  const [vanner, setVanner] = useState(5);
  const [mobler, setMobler] = useState(3);
  const [snitt, setSnitt] = useState(2000);
  const summa = vanner * mobler * snitt * ANDEL;

  return (
    <div className="af-kalk">
      <div className="af-kalk-reglage af-reveal">
        <Reglage etikett={k.vanner} varde={vanner} visa={String(vanner)} min={1} max={50} steg={1} onChange={setVanner} />
        <Reglage etikett={k.mobler} varde={mobler} visa={String(mobler)} min={1} max={10} steg={1} onChange={setMobler} />
        <Reglage etikett={k.snitt} varde={snitt} visa={kr(snitt)} min={500} max={10000} steg={100} onChange={setSnitt} />
      </div>
      <div className="af-kalk-resultat af-reveal">
        <div aria-hidden className="oo-blob af-blob-kalk" />
        <span key={summa} aria-hidden className="af-kalk-mynt">
          🪙
        </span>
        <p className="af-kalk-summa oo-tabular" aria-live="polite">
          <AnimeratTal varde={summa} ms={500} />
        </p>
        <p className="af-kalk-till">{k.resultat}</p>
        <p className="af-kalk-formel oo-tabular">
          {vanner} × {mobler} × {kr(snitt)} × 5 %
        </p>
      </div>
      <p className="af-kalk-not">{k.not}</p>
    </div>
  );
}

function Reglage(props: {
  etikett: string;
  varde: number;
  visa: string;
  min: number;
  max: number;
  steg: number;
  onChange: (v: number) => void;
}) {
  const pct = ((props.varde - props.min) / (props.max - props.min)) * 100;
  return (
    <label className="af-reglage">
      <span className="af-reglage-topp">
        <span>{props.etikett}</span>
        <strong className="oo-tabular">{props.visa}</strong>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.steg}
        value={props.varde}
        onChange={(e) => props.onChange(Number(e.target.value))}
        style={{ "--af-pct": `${pct}%` } as React.CSSProperties}
      />
    </label>
  );
}

/** Länkdelen: länken och siffrorna för den inloggade, registreringen för den som saknar konto. */
function DinLank({ l }: { l: Innehall["lank"] }) {
  const { user, loading } = useAuth();
  const [data, setData] = useState<MinAffiliate | null>(null);
  const [fel, setFel] = useState(false);
  const [kopierad, setKopierad] = useState(false);
  const [visaLank, setVisaLank] = useState(false);
  const [skur, setSkur] = useState(0);
  /** Registreringen visas först när besökaren bett om den — annars tar den en hel skärm. */
  const [flik, setFlik] = useState<"signup" | "signin" | null>(null);

  useEffect(() => {
    if (!user) {
      setData(null);
      return;
    }
    let aktiv = true;
    setFel(false);
    getMinAffiliate()
      .then((d) => aktiv && setData(d))
      .catch(() => aktiv && setFel(true));
    return () => {
      aktiv = false;
    };
  }, [user?.id]);

  async function onKopiera() {
    if (!data) return;
    const ok = await kopiera(data.lank);
    setVisaLank(!ok);
    if (ok) {
      setKopierad(true);
      setSkur((s) => s + 1);
      window.setTimeout(() => setKopierad(false), 3000);
    }
  }

  async function onDela() {
    if (!data) return;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "Loopa AI", text: l.delaText, url: data.lank });
      } catch {
        // Stängd delningsmeny.
      }
      return;
    }
    await onKopiera();
  }

  if (loading) return <div className="af-lank-kort af-skeleton" />;

  if (!user) {
    return (
      <div className="af-lank-kort af-lank-utloggad">
        <div className="af-lank-forhand" aria-hidden>
          <span className="af-lank-forhand-url">loopa.nu/p/••••-••••</span>
          <span className="af-lank-las">🔒</span>
        </div>
        <p className="oo-prose af-lank-text">{l.utloggadText}</p>
        {flik === null ? (
          <div className="af-lank-knappar">
            <button type="button" className="oo-btn oo-btn-primary" onClick={() => setFlik("signup")}>
              {l.skapa} <span className="oo-arrow-right">→</span>
            </button>
            <button type="button" className="oo-btn oo-btn-ghost" onClick={() => setFlik("signin")}>
              {l.loggaIn}
            </button>
          </div>
        ) : (
          <div className="af-auth af-utfall">
            <AuthScreen key={flik} inbaddad intent="account" initialTab={flik} onDone={() => undefined} />
          </div>
        )}
      </div>
    );
  }

  if (fel) return <p className="af-lank-kort oo-prose">{l.fel}</p>;
  if (!data) return <div className="af-lank-kort af-skeleton" />;

  return (
    <div className="af-lank-kort">
      <p className="oo-prose">{l.inloggadText}</p>
      <p className="af-lank-etikett">{l.din}</p>
      <div className="af-lank-rad">
        <code className="af-lank-url">{data.lank.replace(/^https?:\/\//, "")}</code>
        <div className="af-lank-knappar">
          <span className="af-konfetti-ankare">
            <button type="button" className="oo-btn oo-btn-primary" onClick={() => void onKopiera()}>
              {kopierad ? l.kopierad : l.kopiera}
            </button>
            <Konfetti skur={skur} />
          </span>
          <button type="button" className="oo-btn oo-btn-ghost" onClick={() => void onDela()}>
            {l.dela}
          </button>
        </div>
      </div>
      {visaLank && (
        <input className="af-lank-input" readOnly value={data.lank} onFocus={(e) => e.currentTarget.select()} aria-label={l.din} />
      )}
      <div className="af-lank-stats">
        {[
          { label: l.statRegistreringar, value: String(data.registreringar) },
          { label: l.statAnnonser, value: String(data.annonser) },
          { label: l.statSalda, value: String(data.salda) },
          { label: l.statVantande, value: formatOre(data.vantandeOre) },
          { label: l.statUtbetalt, value: formatOre(data.utbetaltOre) },
        ].map((s) => (
          <div key={s.label} className="af-lank-stat">
            <p className="af-lank-stat-varde oo-tabular">{s.value}</p>
            <p className="af-lank-stat-etikett">{s.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AffiliateScreen() {
  const { lang } = useLang();
  const a = lang === "sv" ? SV : EN;
  usePageTitle(a.title);
  const rot = useRef<HTMLDivElement>(null);
  // Ljuskäglan i heron följer pekaren (bara mus, inte touch).
  const folj = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType !== "mouse") return;
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--af-mx", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--af-my", `${e.clientY - r.top}px`);
  };
  useReveal(rot);

  return (
    <div ref={rot} className="om-oss af">
      <div className="oo-wrap oo-bar">
        <a
          href="/"
          className="home-wordmark oo-wordmark"
          onClick={(e) => {
            e.preventDefault();
            gaTill("/");
          }}
        >
          loopa
        </a>
        <HemFlikar aktiv="affiliate" />
      </div>

      {/* Hero */}
      <section className="oo-hero" onPointerMove={folj}>
        <div aria-hidden className="af-hero-spot" />
        <div aria-hidden className="oo-blob oo-blob-hero" />
        <div aria-hidden className="af-hero-prickar" />

        <div className="oo-wrap oo-hero-grid">
          <div className="oo-rise">
            <span className="oo-eyebrow">
              <span className="oo-pulse" />
              {a.eyebrow}
            </span>
            <h1 className="oo-h1">
              {a.h1a}{" "}
              <span className="oo-underline-wrap oo-accent af-skimmer">
                {a.h1b}
                <svg viewBox="0 0 300 16" preserveAspectRatio="none" aria-hidden className="oo-underline">
                  <path d="M3 14 C 80 3, 200 3, 297 12" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" className="oo-draw" />
                </svg>
              </span>
            </h1>
            <p className="oo-intro">{a.intro}</p>
            <div className="oo-actions">
              <a href="#lank" onClick={tillLanken} className="oo-btn oo-btn-primary">
                {a.ctaLank} <span className="oo-arrow-down">↓</span>
              </a>
              <a
                href="#sa-funkar"
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById("sa-funkar")?.scrollIntoView({ behavior: "smooth" });
                }}
                className="oo-btn oo-btn-ghost"
              >
                {a.ctaHur}
              </a>
            </div>
          </div>

          {/* Exemplet: sålda möbler och vad de ger. Riktig räkning, 5 % av priset. */}
          <LivExempel a={a} />
        </div>

      </section>

      <Band ord={a.band} />

      {/* Så funkar det */}
      <section id="sa-funkar" className="oo-why af-anchor">
        <div className="oo-wrap">
          <p className="af-overrubrik af-reveal">{a.hur.over}</p>
          <h2 className="oo-h2 af-reveal">{a.hur.rubrik}</h2>
          <ol className="af-steg af-reveal">
            {a.hur.steg.map((s, i) => (
              <li key={s.rubrik} className="af-steg-kort" style={{ "--af-fordrojning": `${200 + i * 180}ms` } as CSSProperties}>
                <Tilt className="af-steg-inre">
                  <span aria-hidden className="af-kort-glans" />
                  <span aria-hidden className="af-steg-vatten oo-tabular">{String(i + 1).padStart(2, "0")}</span>
                  <span aria-hidden className="af-steg-ikon">{STEG_IKONER[i]}</span>
                  <h3 className="af-steg-rubrik">{s.rubrik}</h3>
                  <p className="af-steg-text">{s.text}</p>
                </Tilt>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Räkna på det — sidans mörka mitt */}
      <section className="af-kalk-sektion">
        <div aria-hidden className="af-kalk-glod" />
        <div className="oo-wrap af-kalk-wrap">
          <p className="af-overrubrik af-reveal">{a.eyebrow}</p>
          <h2 className="oo-h2 oo-h2-light af-reveal">{a.kalk.rubrik}</h2>
          <p className="af-kalk-ingress af-reveal">{a.kalk.text}</p>
          <Kalkylator k={a.kalk} />
        </div>
      </section>

      {/* Hämta din länk */}
      <section id="lank" className="oo-section af-anchor">
        <div className="oo-wrap">
          <p className="af-overrubrik af-reveal">{a.lank.over}</p>
          <h2 className="oo-h2 af-reveal">{a.lank.rubrik}</h2>
          <div className="oo-mt af-reveal af-lank-scen">
            <div aria-hidden className="af-lank-halo" />
            <div className="af-lank-ram">
              <DinLank l={a.lank} />
            </div>
          </div>
        </div>
      </section>

      {/* Vanliga frågor */}
      <section className="oo-section af-faq-sektion">
        <div className="oo-wrap af-faq-wrap">
          <div className="af-faq-huvud af-reveal">
            <p className="af-overrubrik">{a.faq.over}</p>
            <h2 className="oo-h2">{a.faq.rubrik}</h2>
            <p className="af-faq-mer">
              {a.faq.mer}{" "}
              <a href="/villkor">{a.faq.merLank} →</a>
            </p>
          </div>
          <div className="af-faq af-reveal">
            {a.faq.fragor.map((f) => (
              <details key={f.q} className="af-faq-rad">
                <summary>
                  <span>{f.q}</span>
                  <span aria-hidden className="af-faq-plus">
                    +
                  </span>
                </summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Avslutning */}
      <section className="oo-wrap af-slut-wrap">
        <div className="oo-quote af-slut af-reveal">
          <span aria-hidden className="af-slut-bild" style={{ backgroundImage: `url(${BILD}/slut.webp)` }} />
          <span aria-hidden className="af-slut-glod" />
          <div aria-hidden className="oo-blob oo-blob-quote" />
          <div aria-hidden className="oo-ring oo-ring-quote oo-float" />
          <div className="oo-quote-inner">
            <p className="oo-quote-text af-slut-rubrik">{a.slut.rubrik}</p>
            <p className="af-slut-text">{a.slut.text}</p>
            <div className="oo-quote-foot">
              <a href="#lank" onClick={tillLanken} className="oo-btn oo-btn-white">
                {a.slut.cta} <span className="oo-arrow-right">→</span>
              </a>
              <span className="oo-quote-brand">
                loopa<span className="oo-accent">.</span>
              </span>
            </div>
          </div>
        </div>
      </section>

      <footer className="oo-footer">
        © {new Date().getFullYear()} Loopa ·{" "}
        <a href="/villkor" className="af-footer-lank">
          {lang === "sv" ? "Villkor" : "Terms"}
        </a>
      </footer>
    </div>
  );
}
