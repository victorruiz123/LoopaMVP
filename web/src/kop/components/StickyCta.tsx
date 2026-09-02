import { useEffect, useRef, useState } from "react";
import { track } from "../../butik/components/Bits";

/**
 * Mini-CTA:n som dyker upp när heron rullat förbi. Bara på telefon.
 *
 * BARA MOBIL, med flit. På en skärm får heron plats bredvid det man scrollat till, och en balk över
 * innehållet blir då en balk i vägen. På en telefon är heron borta så fort man börjat läsa, och då
 * är vägen tillbaka värd sin plats.
 *
 * OBSERVATÖR OCH INTE SCROLLPOSITION. En pixelgräns är fel så fort rubriken byter radbrytning eller
 * någon har större text — frågan är "syns heron?", och den frågan har webbläsaren redan ett svar på.
 */
export default function StickyCta({ malId = "hero-lank" }: { malId?: string }) {
  const [visa, setVisa] = useState(false);
  const harVisats = useRef(false);

  useEffect(() => {
    const hero = document.querySelector(".hero");
    if (!hero) return;
    const io = new IntersectionObserver(
      ([post]) => {
        const förbi = !post.isIntersecting && post.boundingClientRect.top < 0;
        setVisa(förbi);
        if (förbi) harVisats.current = true;
      },
      { threshold: 0 },
    );
    io.observe(hero);
    return () => io.disconnect();
  }, []);

  if (!visa) return null;

  return (
    <button
      type="button"
      className="sticky-cta"
      onClick={() => {
        track("sticky_cta_click", {});
        document.querySelector(".hero")?.scrollIntoView({ behavior: "smooth", block: "start" });
        // Fokus efter rullningen, annars hoppar sidan tillbaka innan den hunnit fram.
        setTimeout(() => document.getElementById(malId)?.focus(), 500);
      }}
    >
      Klistra in en annons ↑
    </button>
  );
}
