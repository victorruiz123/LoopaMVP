/**
 * Laddaren i modelletningen: en båge som går runt en rundad ruta, och soffan stilla i plattan.
 *
 * Formen följer skissen "Granskar 2a". Här studsade förut en soffa medan en ring fylldes på 24
 * sekunder och ett ord byttes var 1,5 sekund. Det är borta för att skärmen runt laddaren numera
 * säger vad som händer (se ModelSearchWait) — tre rörliga saker ovanför en text som växlar hade
 * tävlat om blicken. Bågen mäter ingen progress, servern rapporterar ingen under identifieringen;
 * den säger bara att något pågår. Skärmen byts när kandidaterna kommer.
 */
export default function ModelSearchLoader() {
  return (
    // Rent dekorativt: statusraden under laddaren är det som läses upp.
    <div className="vanta-loader" aria-hidden="true">
      <svg viewBox="0 0 140 140">
        <rect className="vanta-ring-track" x="1.5" y="1.5" width="137" height="137" rx="33.6" />
        {/* pathLength=100 gör dasharray till procent av varvet, oavsett rutans verkliga omkrets. */}
        <rect className="vanta-ring-arc" x="1.5" y="1.5" width="137" height="137" rx="33.6" pathLength={100} />
      </svg>
      <div className="vanta-tile">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 11V8a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v3" />
          <path d="M3 13a2 2 0 0 1 4 0v2h10v-2a2 2 0 0 1 4 0v4H3z" />
          <path d="M6 17v2M18 17v2" />
        </svg>
      </div>
    </div>
  );
}
