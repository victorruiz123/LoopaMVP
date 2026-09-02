import { useEffect, useState } from "react";
import { efterfragan } from "../api";

/**
 * Säljarkroken: "2 köpare i Stockholm har efterlyst en sådan."
 *
 * VISAR ETT ANTAL OCH INGENTING ANNAT. Ingen köparidentitet, ingen spec, inget område, inget
 * pristak. En säljare som fick veta "någon i Vasastan söker en grön sammetssoffa max 6 000" vet
 * både var köparen bor och vad de har råd med — det är en förhandlingsposition vi gett bort gratis,
 * och den köparen bad aldrig om att bli representerad så.
 *
 * DÖLJER SIG VID NOLL. Ett "0 köpare har efterlyst detta" är sant men är precis den sortens siffra
 * som gör en säljare mindre benägen att lägga ut. Antingen finns efterfrågan att berätta om, eller
 * så säger vi ingenting.
 */
export default function DemandHook({
  kategori, marke, pris,
}: {
  kategori: string | null;
  marke: string | null;
  /** Säljarens tänkta pris. En efterlysning med lägre tak räknas inte. */
  pris: number | null;
}) {
  const [antal, setAntal] = useState(0);

  useEffect(() => {
    if (!kategori) return;
    efterfragan({ kategori, marke, pris }).then((r) => setAntal(r.antal)).catch(() => setAntal(0));
  }, [kategori, marke, pris]);

  if (antal < 1) return null;

  return (
    <p className="demand-hook">
      <strong>{antal} {antal === 1 ? "köpare" : "köpare"} i Stockholm</strong>{" "}
      {antal === 1 ? "har efterlyst en sådan här möbel" : "har efterlyst en sådan här möbel"} — den kan sälja snabbt.
    </p>
  );
}
