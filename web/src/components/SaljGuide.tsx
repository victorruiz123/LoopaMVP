import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { angraGuideAndring, askGuide, type GuideAndring } from "../api";
import { sessionId } from "../lib/flode";
import { useAuth } from "../auth/AuthProvider";
import { ArrowUpIcon, CheckIcon, CloseIcon, SparkIcon } from "./icons";
import { useT } from "../lib/i18n";

/**
 * Säljguiden: en fråga, på varje steg i säljflödet.
 *
 * Startsidan har sitt ark ("Hur fungerar det?", HurFungerarDet.tsx) för den som funderar. Guiden är
 * samma ark — samma form, samma klasser — men följer med genom resten av flödet och vet två saker
 * till: vilket steg säljaren står på, och, när möbeln väl finns, vilken möbel det är. Servern svarar
 * om möbeln bara för dess ägare (server/src/saljGuide.ts).
 *
 * KNAPPEN UPPE TILL HÖGER, inte nere. Flödets steg har sina stora knappar längst ner, där tummen är;
 * en flytande knapp där hade legat över "Fortsätt". Uppe till höger står den bredvid tillbakaknappen,
 * där man letar efter hjälp, och tar ingen tryckyta från steget.
 *
 * VARJE STEG HAR SIN ÖPPNING OCH SINA FÖRSLAG. Öppningen är skriven, inte hämtad — den står där direkt,
 * utan väntan, och säger vad steget går ut på. Förslagen är de frågor som faktiskt dyker upp just där.
 * Samtalet nollställs när steget byts: en fråga om filmningen hör inte hemma bredvid skickbetyget.
 *
 * GUIDEN KAN ÄNDRA ANNONSEN — mått, beskrivning och pris — när säljaren ber om det ("höjden är 80 cm").
 * Servern gör ändringen med samma funktioner som säljarens egna rutor och svarar med vad som ändrats;
 * här blir det ett kvitto under svaret, med Ångra. Steget bakom ritas om (`onAndrat`), så att det
 * säljaren ser är det som nu står i annonsen.
 */

export type GuideSteg = "capture" | "signup" | "identify" | "specs" | "price" | "analysis" | "result" | "listing";

const STEG: Record<GuideSteg, { oppning: string; forslag: string[] }> = {
  capture: {
    oppning: "Filma ett lugnt varv runt möbeln och ta sist en bild rakt framifrån. Ljust rum, hela möbeln i bild — och gå gärna nära där det finns skador.",
    forslag: ["Hur filmar jag bäst?", "Ska kuddarna vara med?", "Vad händer med filmen?"],
  },
  signup: {
    oppning: "Möbeln är filmad. Med ett konto kan vi spara den, höra av oss när den säljs och betala ut till dig. Kontot är gratis.",
    forslag: ["Varför behöver jag ett konto?", "Kostar det något?", "Vad händer med mina uppgifter?"],
  },
  identify: {
    oppning: "Välj modellen som stämmer med din möbel. Rätt modell ger ett säkrare pris, eftersom vi jämför med samma modell.",
    forslag: ["Min modell finns inte med", "Vad händer om jag väljer fel?", "Hur vet ni vilken modell det är?"],
  },
  specs: {
    oppning: "Kontrollera måtten och uppgifterna. De står i annonsen och avgör om möbeln passar hos köparen.",
    forslag: ["Var mäter jag?", "Jag vet inte måtten", "Varför behövs måtten?"],
  },
  price: {
    oppning: "Välj pris. Vi föreslår ett startpris ur marknadsvärdet för just det här skicket, och du bestämmer hur lågt det får gå.",
    forslag: ["Hur räknas priset?", "Vad är ett bra golvpris?", "Vad händer om den inte säljs?"],
  },
  analysis: {
    oppning: "AI:n granskar skicket och prismotorn räknar. Det tar oftast någon minut — du kan lämna skärmen, inget går förlorat.",
    forslag: ["Vad tittar AI:n på?", "Hur lång tid tar det?"],
  },
  result: {
    oppning: "Här är skicket så som AI:n såg det, med varje skada och var den sitter. Stämmer något inte kan du invända mot det.",
    forslag: ["Varför fick den det här betyget?", "Påverkar skadorna priset?", "Kan jag invända mot en skada?"],
  },
  listing: {
    oppning: "Så här ser annonsen ut för köpare. Trycker du på Sälj med Loopa lägger vi ut den och sköter resten.",
    forslag: ["Vad får jag ut?", "Var läggs annonsen ut?", "Vad händer när den säljs?"],
  },
};

interface Meddelande {
  role: "user" | "assistant";
  content: string;
  failed?: boolean;
  /** Ändringen svaret gjorde, och om den ångrats sedan. */
  andring?: GuideAndring & { angrad?: boolean };
}

function samtalsId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function SaljGuide({
  steg,
  jobId,
  onAndrat,
}: {
  steg: GuideSteg;
  jobId: string | null;
  /** Något i annonsen ändrades (eller ångrades) — steget bakom ska läsa om jobbet. */
  onAndrat?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="guide-knapp" onClick={() => setOpen(true)} aria-label={t("Fråga guiden")}>
        <SparkIcon size={15} />
        <span>{t("Fråga")}</span>
      </button>
      {/* Nyckeln är steget: ett nytt steg är ett nytt samtal. */}
      <GuideArk key={steg} open={open} onClose={() => setOpen(false)} steg={steg} jobId={jobId} onAndrat={onAndrat} />
    </>
  );
}

function GuideArk({
  open,
  onClose,
  steg,
  jobId,
  onAndrat,
}: {
  open: boolean;
  onClose: () => void;
  steg: GuideSteg;
  jobId: string | null;
  onAndrat?: () => void;
}) {
  const t = useT();
  const { user } = useAuth();
  const samtal = useRef(samtalsId());
  const [meddelanden, setMeddelanden] = useState<Meddelande[]>([]);
  const [fraga, setFraga] = useState("");
  const [vantar, setVantar] = useState(false);
  const arkRef = useRef<HTMLDivElement>(null);
  const flodeRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const innehall = STEG[steg];

  // Escape stänger, och fokus hamnar i arket — samma som startsidans ark.
  useEffect(() => {
    if (!open) return;
    const vidTangent = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", vidTangent);
    arkRef.current?.querySelector<HTMLButtonElement>(".hur-stang")?.focus();
    return () => window.removeEventListener("keydown", vidTangent);
  }, [open, onClose]);

  // Sidan bakom ligger still medan arket är öppet (iOS rullar annars sidan under fingret).
  useEffect(() => {
    if (!open) return;
    const y = window.scrollY;
    const body = document.body;
    const fore = { position: body.style.position, top: body.style.top, width: body.style.width };
    body.style.position = "fixed";
    body.style.top = `-${y}px`;
    body.style.width = "100%";
    return () => {
      body.style.position = fore.position;
      body.style.top = fore.top;
      body.style.width = fore.width;
      window.scrollTo(0, y);
    };
  }, [open]);

  useEffect(() => {
    if (meddelanden.length === 0) return;
    flodeRef.current?.scrollTo({ top: flodeRef.current.scrollHeight, behavior: "smooth" });
  }, [meddelanden, vantar]);

  if (!open) return null;

  async function skicka(text: string) {
    const q = text.trim();
    if (!q || vantar) return;
    setFraga("");
    setVantar(true);
    const historik = meddelanden.filter((m) => !m.failed).map((m) => ({ role: m.role, content: m.content }));
    setMeddelanden((m) => [...m, { role: "user", content: q }]);
    try {
      const svar = await askGuide(q, historik, steg, jobId, { samtal: samtal.current, sess: sessionId(), uid: user?.id ?? null });
      setMeddelanden((m) => [...m, { role: "assistant", content: svar.answer, andring: svar.andring ?? undefined }]);
      if (svar.andring) onAndrat?.();
    } catch {
      setMeddelanden((m) => [...m, { role: "assistant", content: t("Jag kunde inte svara just nu. Försök igen om en stund."), failed: true }]);
    } finally {
      setVantar(false);
      inputRef.current?.focus();
    }
  }

  const tomt = meddelanden.length === 0;

  async function angra(index: number, angraId: string) {
    try {
      await angraGuideAndring(angraId);
      setMeddelanden((m) => m.map((x, i) => (i === index && x.andring ? { ...x, andring: { ...x.andring, angrad: true } } : x)));
      onAndrat?.();
    } catch {
      setMeddelanden((m) => [...m, { role: "assistant", content: t("Det gick inte att ångra längre. Ändra värdet igen i annonsen eller be mig."), failed: true }]);
    }
  }

  return createPortal(
    <div className="hur-overlay guide-overlay" role="presentation" onClick={onClose}>
      <div
        className="hur-ark guide-ark"
        ref={arkRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("Guiden")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="hur-topp">
          <h2>
            <span className="hur-prick" aria-hidden="true" />
            {t("Guiden")}
          </h2>
          <button className="hur-stang" onClick={onClose} aria-label={t("Stäng")}>
            <CloseIcon size={15} />
          </button>
        </header>

        <div className="hur-flode" ref={flodeRef}>
          <p className="hur-svar">{t(innehall.oppning)}</p>
          {meddelanden.map((m, i) =>
            m.role === "user" ? (
              <p key={i} className="hur-fraga">
                {m.content}
              </p>
            ) : (
              <div key={i}>
                <p className={`hur-svar ${m.failed ? "hur-svar-fel" : ""}`}>{m.content}</p>
                {/* Kvittot: vad som faktiskt ändrades i annonsen, så som servern gjorde det. */}
                {m.andring && (
                  <div className={`guide-kvitto${m.andring.angrad ? " angrad" : ""}`}>
                    <span className="guide-kvitto-ikon" aria-hidden="true">
                      <CheckIcon size={14} />
                    </span>
                    <span className="guide-kvitto-text">
                      <strong>{m.andring.angrad ? t("Ångrat") : t("Ändrat i annonsen")}</strong>
                      {m.andring.sammanfattning.map((rad) => (
                        <span key={rad}>{rad}</span>
                      ))}
                    </span>
                    {!m.andring.angrad && (
                      <button type="button" className="guide-kvitto-angra" onClick={() => void angra(i, m.andring!.angraId)}>
                        {t("Ångra")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ),
          )}
          {vantar && (
            <p className="hur-vantar" aria-live="polite">
              <span className="hur-puls" aria-hidden="true" />
              <span className="hur-vantar-text">{t("Tänker…")}</span>
            </p>
          )}
        </div>

        {tomt && (
          <div className="hur-forslag">
            {innehall.forslag.map((f) => (
              <button key={f} onClick={() => void skicka(t(f))} disabled={vantar}>
                {t(f)}
              </button>
            ))}
          </div>
        )}

        <form
          className="hur-skriv"
          onSubmit={(e) => {
            e.preventDefault();
            void skicka(fraga);
          }}
        >
          <textarea
            ref={inputRef}
            value={fraga}
            onChange={(e) => setFraga(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void skicka(fraga);
              }
            }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${el.scrollHeight}px`;
            }}
            rows={1}
            placeholder={jobId ? t("Fråga, eller be mig ändra något…") : t("Fråga om det här steget…")}
            aria-label={t("Fråga guiden")}
            maxLength={500}
          />
          <button type="submit" disabled={!fraga.trim() || vantar} aria-label={t("Skicka")}>
            <ArrowUpIcon size={18} />
          </button>
        </form>
      </div>
    </div>,
    document.body,
  );
}
