import { useEffect, useRef, useState } from "react";
import HemFlikar, { gaTill } from "../components/HemFlikar";
import SprakKnapp from "../components/SprakKnapp";
import { useLang } from "../lib/i18n";
import { usePageTitle } from "../lib/pageTitle";
import "./om-oss.css";

/**
 * Om oss — grundarna, varför idén finns och vart vi är på väg.
 *
 * Texten är personbeskrivningen till UF till AB-stipendiet, nästan ordagrann. Den står här som ett
 * eget innehållsobjekt per språk i stället för genom `t()`: det är hela stycken, och en ordlista
 * nycklad på svenska stycken hade bara flyttat samma text till ett ställe där den är svårare att läsa.
 * Franskan faller tillbaka på engelskan.
 */

const BILD = "/app-assets/om-oss";

const GRUNDARE = [
  { name: "Isac Ekelund", photo: `${BILD}/isac.webp`, linkedin: "https://www.linkedin.com/in/isac-ekelund-450ba3316" },
  { name: "Victor Ruiz", photo: `${BILD}/victor.webp`, linkedin: "https://www.linkedin.com/in/victor-ruiz-6621b3360" },
  {
    name: "Benjamin Jonsson Östlund",
    photo: `${BILD}/benjamin.webp`,
    linkedin: "https://www.linkedin.com/in/benjamin-jonsson-östlund-2776692a7",
  },
];

const RADGIVARE = [
  { name: "David Edelsohn", photo: `${BILD}/david.webp`, linkedin: "https://www.linkedin.com/in/davidedelsohn", role: "Alliances Manager, NVIDIA" },
  {
    name: "Richard Jhang",
    photo: `${BILD}/richard.webp`,
    linkedin: "https://www.linkedin.com/in/richardjhang",
    role: "StratMinds · ex-CIO, IBM",
  },
  { name: "Peo Nilsson", photo: `${BILD}/peo.webp`, linkedin: "https://www.linkedin.com/in/peonilsson", role: "Booli · Sting" },
  { name: "Per Strömbäck", photo: `${BILD}/per.webp`, linkedin: "https://www.linkedin.com/in/perstroembaeck", role: "Läkare utan gränser" },
  { name: "Anthony Ford", photo: `${BILD}/anthony.webp`, linkedin: "https://www.linkedin.com/in/anthonydavidford", role: "PwC" },
  { name: "Karin Ruiz", photo: `${BILD}/karin.webp`, linkedin: "https://www.linkedin.com/in/karinruiz", role: "Sting" },
];

type Innehall = {
  title: string;
  eyebrow: string;
  titleLine1: string;
  titleAccent: string;
  intro: string;
  meetFounders: string;
  cta: string;
  stats: { value: string; label: string; icon: string }[];
  why: { heading: string; paragraphs: string[]; highlight: string; closing: string };
  founders: { heading: string; members: { role: string; bio: string; traits: string }[]; together: string };
  decision: { heading: string; paragraphs: string[]; lesson: string };
  vision: { heading: string; body: string };
  quoteLine1: string;
  quoteAccent: string;
  awards: { place: string; event: string; title: string }[];
  advisors: { heading: string; body: string };
};

const SV: Innehall = {
  title: "Om oss",
  eyebrow: "Om oss",
  titleLine1: "Vi gör det hållbara valet till",
  titleAccent: "det enkla valet.",
  intro:
    "Loopa började som Vips UF – tre gymnasieelever som ville förstå varför så mycket fullt brukbart aldrig säljs vidare. I dag är det en tjänst i drift: du fotograferar möbeln, AI gör resten.",
  meetFounders: "Möt grundarna",
  cta: "Kontakta oss",
  stats: [
    { value: "210", icon: "🚪", label: "dörrar vi knackade på i Nynäshamn" },
    { value: "10 Mt", icon: "🛋️", label: "möbler slängs i EU varje år" },
    { value: "2 × 2:a", icon: "🏆", label: "Årets UF-företag & Årets innovation, UF-SM" },
  ],
  why: {
    heading: "Varför just den här idén",
    paragraphs: [
      "Sommaren 2024 knackade Isac och Benjamin på 210 dörrar i Nynäshamn för att hjälpa folk sälja saker de inte använde. Nästan alla hade något de ville sälja, men nästan ingen gjorde det. Det var varken priset eller viljan som stoppade dem, utan tröskeln: fotografera, skriva annons, svara på frågor, låna släp och offra en helg.",
      "Värst är möblerna. Varje år slänger EU 10 miljoner ton, de flesta fullt brukbara – inte för att de är trasiga, utan för att det tar en hel helgs arbete att sälja dem. Vi tror inte att lösningen är att människor ska handla mindre, utan att göra det hållbara valet till det enkla valet.",
    ],
    highlight: "Du fotograferar möbeln, AI gör resten.",
    closing: "Det är problemet vi inte kan släppa.",
  },
  founders: {
    heading: "Tre grundare som kompletterar varandra",
    members: [
      {
        role: "VD",
        bio: "Sålde hemgjort godis, gav plugghjälp och startade ett klädmärke vid 14 med kunder i Tyskland, USA och Kanada. Sommaren 2024 knackade han och Benjamin på 210 dörrar i Nynäshamn och erbjöd sig att sälja folks oanvända saker åt dem – där föddes idén till Vips, UF-företaget som i dag är Loopa. I gymnasiearbetet undersökte han hur universums expansion varierar över stjärnhimlen och blev semifinalist i Unga Forskare.",
        traits: "Nyfiken och inspirerad av stora samhällsproblem – svår att stoppa när ett sådant står olöst. Ansvarar för vision, marknad och UX.",
      },
      {
        role: "CTO",
        bio: "Byggde Vips första produkt och sedan om den från grunden när vi gick från manuellt arbete till automatik: AI som skriver annonsen och bedömer möbelns skick, integrationer mot marknadsplatser som Blocket och Tradera, och transporter ihop med flyttjänsten Mooova. A i alla kurser utom två på naturvetenskapsprogrammet och semifinalist i Unga Forskare 2026.",
        traits: "Orädd och rak – säger vad han tycker, ringer hellre än mailar, och utgår från att ett test ger bättre svar än ännu en diskussion.",
      },
      {
        role: "CFO",
        bio: "Tog ekonomiansvaret utan förkunskaper och utsågs av sina lärare till skolans bästa ekonomielev trots att han läste naturvetenskap. I varje affär ska betalning, provision och utbetalning gå rätt mellan köpare, säljare och oss – en trepartsmodell som ingen vanlig bokföringsmall klarar. Han satte sig in i reglerna och löste det, programmerade våra nyckeltalsverktyg och pitchade Vips inför 1 400 personer på UF-SM.",
        traits: "Vetgirig och uppfinningsrik, och lugnast i rummet när något går fel.",
      },
    ],
    together:
      "Vi gör olika saker med samma problem: en vill förstå det, en vill testa sig fram till svaret, en hittar en väg runt när det inte finns någon. Det vi har gemensamt är att vi dras till problem som betyder något på riktigt. Möbler som slängs i stället för att säljas vidare är ett sådant.",
  },
  decision: {
    heading: "Beslutet som format oss",
    paragraphs: [
      "Under UF-året tog vi Vips UF från idé till fungerande tjänst och slutade tvåa i både Årets UF-företag och Årets innovation på SM. Vägen dit var full av omtag. Vi ändrade tjänsten flera gånger utifrån feedback från kunderna, och den största förändringen var att vi skrotade idén om ännu en marknadsplats. Folk ville inte ha fler ställen att sälja på – de ville bara sälja smidigare. Så vi byggde ett säljverktyg ovanpå de marknadsplatser som redan finns.",
      "Men nästan allt gjordes fortfarande för hand, och tjänsten kunde inte växa. Det hade varit lätt att hålla fast vid den, för den sålde ju. I stället fattade vi vårt svåraste beslut hittills: att pausa tjänsten och bygga om den från grunden. Det tog månader, men det befäste den viktigaste lärdomen vi tar med in i Loopa.",
    ],
    lesson:
      "Vår första lösning är bara en gissning, och det är marknaden som ger svaret. Vårt jobb är att lyssna på det svaret, inte att försvara gissningen.",
  },
  vision: {
    heading: "Framtidsvision",
    body: "Vi vill bygga bolag som gör det hållbara valet till det enkla valet, gång på gång, tills det blir standard. Loopa är vårt första bevis på att det går: om fem år vill vi äga standarden för skickbedömning och prisrekommendation – det som gör det lika tryggt och enkelt att handla begagnat som nytt.",
  },
  quoteLine1: "Framtiden finns inte i fler fabriker,",
  quoteAccent: "den finns i det vi redan har.",
  awards: [
    { place: "2:a plats", event: "UF SM", title: "Årets Innovation" },
    { place: "2:a plats", event: "UF SM", title: "Årets UF-företag" },
  ],
  advisors: {
    heading: "Rådgivare",
    body: "Vi har stöd av erfarna ledare inom AI, teknik, entreprenörskap, investeringar, varumärke och digitala industrier.",
  },
};

const EN: Innehall = {
  title: "About us",
  eyebrow: "About us",
  titleLine1: "We make the sustainable choice",
  titleAccent: "the easy choice.",
  intro:
    "Loopa started as Vips UF – three high-school students who wanted to understand why so much perfectly usable stuff never gets resold. Today it is a live service: you photograph the furniture, AI does the rest.",
  meetFounders: "Meet the founders",
  cta: "Contact us",
  stats: [
    { value: "210", icon: "🚪", label: "doors we knocked on in Nynäshamn" },
    { value: "10 Mt", icon: "🛋️", label: "of furniture thrown away in the EU every year" },
    { value: "2 × 2nd", icon: "🏆", label: "UF Company & Innovation of the Year, UF national finals" },
  ],
  why: {
    heading: "Why this idea",
    paragraphs: [
      "In the summer of 2024, Isac and Benjamin knocked on 210 doors in Nynäshamn to help people sell things they no longer used. Almost everyone had something they wanted to sell, yet almost no one did. It wasn’t the price or the will that stopped them – it was the hassle: taking photos, writing a listing, answering questions, borrowing a trailer and giving up a weekend.",
      "Furniture is the worst. Every year the EU throws away 10 million tonnes, most of it perfectly usable – not because it’s broken, but because selling it takes a whole weekend. We don’t think the answer is for people to buy less, but to make the sustainable choice the easy choice.",
    ],
    highlight: "You photograph the furniture, AI does the rest.",
    closing: "That’s the problem we can’t let go of.",
  },
  founders: {
    heading: "Three founders who complement each other",
    members: [
      {
        role: "CEO",
        bio: "Sold homemade candy, tutored, and started a clothing brand at 14 with customers in Germany, the US and Canada. In the summer of 2024 he and Benjamin knocked on 210 doors in Nynäshamn offering to sell people’s unused things for them – the origin of Vips, the UF company that is Loopa today. His thesis on how the expansion of the universe varies across the sky made him a semifinalist in Unga Forskare (Young Scientists).",
        traits: "Curious and driven by big societal problems – hard to stop while one remains unsolved. Responsible for vision, market and UX.",
      },
      {
        role: "CTO",
        bio: "Built Vips’ first product, then rebuilt it from scratch when we moved from manual work to automation: AI that writes the listing and assesses the furniture’s condition, integrations with marketplaces like Blocket and Tradera, and transport together with the moving service Mooova. Top grades in all but two courses in the natural science programme and a semifinalist in Unga Forskare 2026.",
        traits: "Fearless and direct – says what he thinks, would rather call than email, and assumes a test gives a better answer than another discussion.",
      },
      {
        role: "CFO",
        bio: "Took on finance with no prior experience and was named the school’s best economics student by his teachers despite studying natural science. In every deal, payment, commission and payout must flow correctly between buyer, seller and us – a three-party model no standard accounting template handles. He learned the rules and solved it, programmed our KPI tools and pitched Vips to 1,400 people at the UF national finals.",
        traits: "Inquisitive and inventive, and the calmest person in the room when something goes wrong.",
      },
    ],
    together:
      "We do different things with the same problem: one wants to understand it, one wants to test his way to the answer, one finds a way around when there isn’t one. What we share is that we’re drawn to problems that really matter. Furniture thrown away instead of resold is one of them.",
  },
  decision: {
    heading: "The decision that shaped us",
    paragraphs: [
      "During our UF year we took Vips UF from idea to a working service and finished second in both UF Company of the Year and Innovation of the Year at the national finals. The road there was full of do-overs. We changed the service several times based on customer feedback, and the biggest change was scrapping the idea of yet another marketplace. People didn’t want more places to sell – they just wanted selling to be smoother. So we built a selling tool on top of the marketplaces that already exist.",
      "But almost everything was still done by hand, and the service couldn’t grow. It would have been easy to hold on to it – it was selling, after all. Instead we made our hardest decision yet: to pause the service and rebuild it from the ground up. It took months, but it cemented the most important lesson we bring into Loopa.",
    ],
    lesson:
      "Our first solution is just a guess, and the market gives the answer. Our job is to listen to that answer, not to defend the guess.",
  },
  vision: {
    heading: "Vision",
    body: "We want to build companies that make the sustainable choice the easy choice, again and again, until it becomes the norm. Loopa is our first proof that it can be done: in five years we want to own the standard for condition grading and price recommendation – what makes buying secondhand as safe and simple as buying new.",
  },
  quoteLine1: "The future isn’t in more factories,",
  quoteAccent: "it’s in what we already have.",
  awards: [
    { place: "2nd place", event: "UF national finals", title: "Innovation of the Year" },
    { place: "2nd place", event: "UF national finals", title: "UF Company of the Year" },
  ],
  advisors: {
    heading: "Advisors",
    body: "We are supported by experienced leaders in AI, technology, entrepreneurship, investing, brand and digital industries.",
  },
};

const KONTAKT = "mailto:info@loopa.nu";

/** Räknar upp det inledande heltalet i `value` första gången rutan syns; resten ("Mt", "× 2:a") står kvar. */
function CountUp({ value }: { value: string }) {
  const match = value.match(/^(\d+)(.*)$/);
  const target = match ? Number(match[1]) : 0;
  const hasNumber = match !== null;
  const ref = useRef<HTMLSpanElement>(null);
  const [n, setN] = useState(target);

  useEffect(() => {
    const el = ref.current;
    if (!hasNumber || !el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setN(0);
    let frame = 0;
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      io.disconnect();
      const start = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - start) / 1200);
        setN(Math.round(target * (1 - Math.pow(1 - p, 3))));
        if (p < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [target, hasNumber]);

  if (!match) return <>{value}</>;
  return (
    <span ref={ref} className="oo-tabular">
      {n}
      {match[2]}
    </span>
  );
}

export default function OmOssScreen() {
  const { lang } = useLang();
  const a = lang === "sv" ? SV : EN;
  usePageTitle(a.title);

  return (
    <div className="om-oss">
      {/* Språkknappen ovanför raden på telefonen, i raden på bredare skärmar. Se components/SprakKnapp. */}
      <div className="oo-wrap sprak-rad sprak-rad-oo">
        <SprakKnapp variant="ovanfor" />
      </div>
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
        <HemFlikar aktiv="om-oss" />
        <SprakKnapp variant="rad" />
      </div>

      {/* Hero */}
      <section className="oo-hero">
        <div aria-hidden className="oo-blob oo-blob-hero" />
        <div aria-hidden className="oo-ring oo-ring-hero oo-float" />

        <div className="oo-wrap oo-hero-grid">
          <div className="oo-rise">
            <span className="oo-eyebrow">
              <span className="oo-pulse" />
              {a.eyebrow}
            </span>
            <h1 className="oo-h1">
              {a.titleLine1}{" "}
              <span className="oo-accent oo-underline-wrap">
                {a.titleAccent}
                <svg aria-hidden viewBox="0 0 300 20" preserveAspectRatio="none" className="oo-underline">
                  <path d="M3 14 C 80 3, 200 3, 297 12" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" className="oo-draw" />
                </svg>
              </span>
            </h1>
            <p className="oo-intro">{a.intro}</p>
            <div className="oo-actions">
              <a href="#team" className="oo-btn oo-btn-primary">
                {a.meetFounders} <span className="oo-arrow-down">↓</span>
              </a>
              <a href={KONTAKT} className="oo-btn oo-btn-ghost">
                {a.cta}
              </a>
            </div>
          </div>

          <div className="oo-collage">
            {GRUNDARE.map((p, i) => (
              <img
                key={p.name}
                src={p.photo}
                alt={p.name}
                style={{ animationDelay: `${150 + i * 140}ms` }}
                className={`oo-rise oo-collage-img oo-collage-${i}`}
              />
            ))}
            <div style={{ animationDelay: "600ms" }} className="oo-rise oo-collage-pill">
              📸 → ✨ {a.why.highlight}
            </div>
          </div>
        </div>

        <div className="oo-wrap oo-stats">
          {a.stats.map((s, i) => (
            <div
              key={s.label}
              style={{ animationDelay: `${300 + i * 120}ms` }}
              className={`oo-rise oo-stat ${i === 1 ? "oo-stat-accent" : ""}`}
            >
              <span aria-hidden className="oo-stat-bg">
                {s.icon}
              </span>
              <div className="oo-stat-top">
                <p className="oo-stat-value">
                  <CountUp value={s.value} />
                </p>
                <span aria-hidden style={{ animationDelay: `${i * 0.6}s` }} className="oo-bob">
                  <span className="oo-stat-icon">{s.icon}</span>
                </span>
              </div>
              <p className="oo-stat-label">{s.label}</p>
              <span aria-hidden className="oo-sweep" />
            </div>
          ))}
        </div>
      </section>

      {/* Varför */}
      <section className="oo-why">
        <div className="oo-wrap oo-why-grid">
          <h2 className="oo-h2">{a.why.heading}</h2>
          <div className="oo-prose">
            {a.why.paragraphs.map((p) => (
              <p key={p}>{p}</p>
            ))}
            <p className="oo-why-punch">
              <span className="oo-accent">{a.why.highlight}</span> {a.why.closing}
            </p>
          </div>
        </div>
      </section>

      {/* Grundarna */}
      <section id="team" className="oo-founders">
        <div className="oo-wrap">
          <h2 className="oo-h2 oo-h2-light">{a.founders.heading}</h2>
          <div className="oo-founder-grid">
            {a.founders.members.map((m, i) => {
              const p = GRUNDARE[i];
              return (
                <article key={p.name} className="oo-founder">
                  <img src={p.photo} alt={p.name} className="oo-founder-img" />
                  <h3 className="oo-founder-name">{p.name}</h3>
                  <p className="oo-founder-role">{m.role}</p>
                  <p className="oo-founder-bio">{m.bio}</p>
                  <p className="oo-founder-traits">{m.traits}</p>
                  <a href={p.linkedin} target="_blank" rel="noopener noreferrer" className="oo-link">
                    LinkedIn
                  </a>
                </article>
              );
            })}
          </div>
          <p className="oo-together">{a.founders.together}</p>
        </div>
      </section>

      {/* Beslutet + vision */}
      <section className="oo-section">
        <div className="oo-wrap oo-two-col">
          <div>
            <h2 className="oo-h2 oo-h2-sm">{a.decision.heading}</h2>
            <div className="oo-prose oo-mt">
              {a.decision.paragraphs.map((p) => (
                <p key={p}>{p}</p>
              ))}
            </div>
            <blockquote className="oo-lesson">{a.decision.lesson}</blockquote>
          </div>

          <div>
            <h2 className="oo-h2 oo-h2-sm">{a.vision.heading}</h2>
            <p className="oo-prose oo-mt">{a.vision.body}</p>

            <div className="oo-quote">
              <div aria-hidden className="oo-blob oo-blob-quote" />
              <div aria-hidden className="oo-ring oo-ring-quote oo-float" />
              <span aria-hidden className="oo-bob oo-quote-emoji">
                ♻️
              </span>
              <div className="oo-quote-inner">
                <span aria-hidden className="oo-quote-mark">
                  &ldquo;
                </span>
                <p className="oo-quote-text">
                  {a.quoteLine1} <span className="oo-accent">{a.quoteAccent}</span>
                </p>
                <div className="oo-quote-foot">
                  <a href={KONTAKT} className="oo-btn oo-btn-white">
                    {a.cta} <span className="oo-arrow-right">→</span>
                  </a>
                  <span className="oo-quote-brand">
                    loopa<span className="oo-accent">.</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* UF-framgångarna */}
      <section className="oo-wrap oo-awards">
        {a.awards.map((aw, i) => (
          <div key={aw.title} className="oo-award">
            <span aria-hidden className="oo-award-bg">
              🏆
            </span>
            <span aria-hidden style={{ animationDelay: `${i * 0.7}s` }} className="oo-bob">
              <span className="oo-medal">🥈</span>
            </span>
            <div className="oo-award-text">
              <p className="oo-award-meta">
                {aw.place} · {aw.event}
              </p>
              <p className="oo-award-title">{aw.title}</p>
            </div>
            <span aria-hidden className="oo-sweep" />
          </div>
        ))}
      </section>

      {/* Rådgivare */}
      <section className="oo-advisors">
        <div className="oo-wrap">
          <h2 className="oo-h2">{a.advisors.heading}</h2>
          <p className="oo-prose oo-mt oo-advisors-body">{a.advisors.body}</p>
          <div className="oo-advisor-grid">
            {RADGIVARE.map((r) => (
              <a key={r.name} href={r.linkedin} target="_blank" rel="noopener noreferrer" className="oo-advisor">
                <img src={r.photo} alt={r.name} className="oo-advisor-img" />
                <div>
                  <p className="oo-advisor-name">{r.name}</p>
                  <p className="oo-advisor-role">{r.role}</p>
                </div>
              </a>
            ))}
          </div>
        </div>
      </section>

      <footer className="oo-footer">© {new Date().getFullYear()} Loopa</footer>
    </div>
  );
}
