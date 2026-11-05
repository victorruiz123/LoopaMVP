import { useEffect } from "react";
import { mikro, type Mikrosteg } from "../lib/flode";

/**
 * Markerar ett mikrosteg när det visas. Ritar ingenting.
 *
 * FINNS FÖR GRINDARNA i App.tsx: väntan på modellen, frågorna, varianten och väntan på annonsen
 * ritas alla av samma skärm i flödet, och det enda som skiljer dem åt är vilken komponent som
 * syns. En rad bredvid komponenten är lättare att se än en effekt inuti varje grind.
 */
export default function Mikro({ namn }: { namn: Mikrosteg }) {
  useEffect(() => {
    mikro(namn);
  }, [namn]);
  return null;
}
