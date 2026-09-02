import { useState } from "react";
import { navigate } from "../router";
import { track } from "./Bits";

/**
 * "Beskriv vad du söker" — butikens ena ingång.
 *
 * Skild från sökrutan i topplisten, och skillnaden är vad man får skriva. Topplisten matchar ORD mot
 * titlar: skriver du "soffa max 2 meter" letar den efter möbler som heter så, och hittar inget. Den
 * här tar en MENING och låter servern översätta den till ett filter — kategori, pristak, mått,
 * material (se server/src/butik/aiSearch.ts).
 *
 * Rutan lovar därför inte "sök" utan "beskriv". Exempelfraserna under är inte dekoration: de visar
 * vilken sorts mening som funkar, vilket är det enda sättet att lära någon att en sökruta plötsligt
 * tål hela meningar.
 */

const EXAMPLES = [
  "en soffa till ett litet vardagsrum, max 5 000",
  "svart barstol i trä under 1 000 kr",
  "matbord i ek för sex personer",
  "IKEA-fåtölj i nyskick",
];

export default function AiSearch() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const go = (question: string) => {
    const q = question.trim();
    if (!q) return;
    setBusy(true);
    track("ai_search", { q });
    // Frågan följer med i adressen och tolkas av sökskärmen. Att tolka HÄR och skicka ett färdigt
    // filter hade gjort länken oläslig och omöjlig att dela.
    navigate({ name: "search", q });
  };

  return (
    <section className="butik-ai">
      <label className="butik-ai-label" htmlFor="butik-ai-input">Beskriv vad du söker</label>
      <form
        className="butik-ai-form"
        onSubmit={(e) => {
          e.preventDefault();
          go(text);
        }}
      >
        <input
          id="butik-ai-input"
          className="butik-ai-input"
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="T.ex. en soffa till ett litet vardagsrum, max 5 000 kr"
          autoComplete="off"
        />
        <button type="submit" className="butik-ai-go" disabled={busy || !text.trim()}>
          {busy ? "Söker…" : "Hitta"}
        </button>
      </form>
      <div className="butik-ai-examples">
        {EXAMPLES.map((e) => (
          <button key={e} type="button" className="butik-ai-example" onClick={() => { setText(e); go(e); }}>
            {e}
          </button>
        ))}
      </div>
    </section>
  );
}
