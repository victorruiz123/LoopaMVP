import { useEffect, useRef, useState } from "react";
import { askTruthCard } from "../api";
import type { AnswerSource } from "../types";
import { SendIcon, SparkIcon } from "./icons";

/**
 * Chatten på truth-cardet.
 *
 * Kortet svarar redan på allt som står på det — men den som bara vill veta en sak läser inte ett helt
 * kort för att hitta den. Frågan "hur djup är repan på armstödet" ska gå att ställa rakt ut, och
 * svaret ska komma ur besiktningen och ingen annanstans ifrån.
 *
 * Två egenskaper gör den till en del av kortet och inte en pratbubbla ovanpå det:
 *
 * DEN SITTER I KORTET. Inte som en flytande knapp i hörnet, utan som ett block bland de andra, sist
 * efter underlaget. En flytande bubbla följer med hela sidan och tillhör sajten; det här blocket hör
 * till möbeln, och står där frågorna faktiskt uppstår — efter att man läst skicket.
 *
 * DEN SÄGER VARIFRÅN SVARET KOMMER. Servern märker varje svar med `source` (se cardChat.ts), och ett
 * svar som INTE står på kortet får en synlig notis. Utan den skillnaden vore chatten en andra källa
 * vid sidan av besiktningen, och då är även det som är belagt bara ett påstående till.
 *
 * Samma komponent på säljarens kort och det publika: båda slår mot Loopa-ID:t, och boten ser exakt
 * det en köpare kan läsa själv.
 */

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  source?: AnswerSource;
  failed?: boolean;
}

/** Samtalet överlever en omladdning, men inte mer än så — det är en läshjälp, inte en historik. */
const KEPT_MESSAGES = 12;

function storageKey(loopaId: string): string {
  return `loopa-card-chat:${loopaId}`;
}

function readStored(loopaId: string): ChatMessage[] {
  try {
    const raw = window.localStorage.getItem(storageKey(loopaId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is ChatMessage =>
        !!m && typeof m === "object" && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
    );
  } catch {
    // Privat läge, full disk, gammalt format — inget av det är värt att stoppa chatten för.
    return [];
  }
}

export default function TruthCardChat({
  loopaId,
  name,
  damageCount,
  specLabels,
  hasPrice,
}: {
  loopaId: string;
  /** Möbelns namn som kortet skriver det. Står i tomma läget, så frågan känns riktad. */
  name: string;
  damageCount: number;
  /** Etiketterna på kortets specifikationer. Styr bara vilka förslag som visas. */
  specLabels: string[];
  hasPrice: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => readStored(loopaId));
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Ett kort per ID. Byts kortet under samma montering (sökrutan på den publika sidan) ska samtalet
  // om den förra möbeln inte följa med.
  useEffect(() => {
    setMessages(readStored(loopaId));
    setInput("");
  }, [loopaId]);

  useEffect(() => {
    if (messages.length === 0) return;
    try {
      window.localStorage.setItem(storageKey(loopaId), JSON.stringify(messages.slice(-KEPT_MESSAGES)));
    } catch {
      // Se readStored: lagring som inte går är inte ett fel värt att visa.
    }
  }, [messages, loopaId]);

  // Rullar strömmen och inte sidan: blocket ligger mitt i kortet, och att kasta läsaren nedåt varje
  // gång ett svar kommer vore att flytta hela kortet under fingret.
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  async function ask(question: string) {
    const trimmed = question.trim();
    if (!trimmed || pending) return;

    // Historiken som skickas är den som fanns FÖRE frågan, och bara riktiga svar: ett felmeddelande
    // är vårt, inte botens, och ska inte läsas som något den sagt.
    const history = messages
      .filter((m) => !m.failed)
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    setInput("");
    setPending(true);
    try {
      const { answer, source } = await askTruthCard(loopaId, trimmed, history);
      setMessages((prev) => [...prev, { role: "assistant", content: answer, source }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: err instanceof Error ? err.message : String(err), failed: true },
      ]);
    } finally {
      setPending(false);
    }
  }

  const suggestions = suggestionsFor(damageCount, specLabels, hasPrice);

  return (
    <section className="listing-block card-chat">
      <h3>Fråga om möbeln</h3>

      {messages.length === 0 ? (
        <p className="card-chat-intro">
          Ställ en fråga om {name}. Svaren kommer ur besiktningen bakom det här kortet — måtten,
          skicket, varje anmärkning och priset.
        </p>
      ) : (
        <div className="card-chat-stream" ref={streamRef} role="log" aria-live="polite">
          {messages.map((m, i) => (
            <div key={i} className={`card-chat-turn card-chat-turn-${m.role}`}>
              <div className={`card-chat-bubble${m.failed ? " card-chat-bubble-failed" : ""}`}>{m.content}</div>
              {/* Notisen bara när svaret INTE står på kortet. Ett "belagt"-märke på varje rad blir
                  dekoration man slutar se; undantaget är det som betyder något. */}
              {m.role === "assistant" && !m.failed && m.source !== "card" && (
                <p className="card-chat-note">Allmän kunskap — inte besiktat för just den här möbeln.</p>
              )}
            </div>
          ))}
          {pending && (
            <div className="card-chat-turn card-chat-turn-assistant">
              <div className="card-chat-bubble card-chat-typing" aria-label="Skriver svar">
                <span />
                <span />
                <span />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Förslagen är byggda ur det kortet faktiskt bär, så den som trycker på ett får ett svar med
          källa i besiktningen — inte ett "det står inte på kortet" som första intryck. */}
      {messages.length === 0 && (
        <div className="card-chat-suggestions">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              className="card-chat-suggestion"
              disabled={pending}
              onClick={() => {
                void ask(s);
                inputRef.current?.focus();
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <form
        className="card-chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
      >
        <span className="card-chat-form-icon">
          <SparkIcon size={15} />
        </span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Skriv en fråga…"
          maxLength={500}
          disabled={pending}
          aria-label="Fråga om möbeln"
        />
        <button type="submit" className="card-chat-send" disabled={pending || !input.trim()} aria-label="Skicka frågan">
          <SendIcon size={16} />
        </button>
      </form>
    </section>
  );
}

/**
 * Vad man kan fråga om just det här kortet.
 *
 * Fasta frågor hade träffat fel på hälften av korten — "vilka mått har den?" på ett kort utan mått är
 * ett löfte som inte hålls. Varje förslag nedan väljs mot något kortet bär.
 */
function suggestionsFor(damageCount: number, specLabels: string[], hasPrice: boolean): string[] {
  const out: string[] = [];
  out.push(damageCount > 0 ? "Hur allvarliga är skadorna?" : "Har den några skador alls?");

  const specs = specLabels.map((l) => l.toLowerCase());
  if (specs.some((l) => /mått|bredd|höjd|djup|längd|sitthöjd/.test(l))) out.push("Vilka mått har den?");
  else if (specs.some((l) => /material|klädsel|tyg|träslag/.test(l))) out.push("Vad är den gjord av?");

  out.push(hasPrice ? "Varför just det priset?" : "Vad säger besiktningen om skicket?");
  return out;
}
