/**
 * Tre skäl, en rad var.
 *
 * SKRIVNA SOM VAD MAN SLIPPER, inte som vad vi gör. "AI-granskning innan du åker någonstans" är en
 * funktion; "slipp chansa" är anledningen någon skulle vilja ha den. Rubrikerna bär anledningen och
 * raden under bär funktionen — i den ordningen, för det är den ordningen en besökare läser i.
 */

const PUNKTER = [
  { rubrik: "Slipp chansa", rad: "AI-granskning innan du åker någonstans" },
  { rubrik: "Slipp släpet", rad: "Hemleverans, vi bär" },
  { rubrik: "Slipp bli blåst", rad: "Pengarna släpps först när du godkänt" },
];

export default function Saljpunkter() {
  return (
    <section className="punkter" aria-label="Därför Loopa">
      {PUNKTER.map((p) => (
        <div className="punkt" key={p.rubrik}>
          <h2>{p.rubrik}</h2>
          <p>{p.rad}</p>
        </div>
      ))}
    </section>
  );
}
