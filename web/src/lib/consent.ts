import { useSyncExternalStore } from "react";

/**
 * Samtycket till lagring i webbläsaren.
 *
 * Rutan finns för att lagen kräver den, men innehållet i den bestäms av vad appen FAKTISKT lägger i
 * webbläsaren — inte av vad en mall brukar räkna upp. Loopa har ingen analys, ingen mätpixel och
 * ingen annonsör, så det finns ingen "marknadsföring"-kryssruta här. Att rita en hade varit att be
 * om samtycke till något vi inte gör, vilket gör hela rutan mindre trovärdig och därmed sämre.
 *
 * Kvar blir två sorter, och gränsen mellan dem är den ePrivacy drar (LEK 6 kap. 18 §):
 *
 *   NÖDVÄNDIG   Utan den finns inte tjänsten säljaren bett om. Bildkakan `loopa_media` som låter
 *               <img> hämta jobbets bildrutor, Supabase inloggningstoken, och valet nedan självt.
 *               Kräver inget samtycke — den som loggar in har bett om att vara inloggad.
 *
 *   FUNKTIONELL Bekvämlighet som tjänsten klarar sig utan. I dag exakt en sak: chatthistoriken på
 *               det publika kortet, som överlever en omladdning. Kräver samtycke.
 *
 * Att det bara är en sak är själva poängen med att gränsen går att hålla. Kommer det en till hamnar
 * den här, och rutan behöver inte skrivas om.
 */

/** Höjs när kategorierna ändras — inte när texten justeras. Ett höjt tal frågar alla på nytt. */
export const CONSENT_VERSION = 1;

const STORAGE_KEY = "loopa.consent";

export interface Consent {
  version: number;
  /** Vilken dag valet gjordes. Måste kunna visas upp: samtycke ska gå att bevisa, inte bara påstås. */
  decidedAt: string;
  functional: boolean;
}

/**
 * Nycklar som funktionellt samtycke bär ansvaret för.
 *
 * Prefix och inte exakta namn: chatten lagrar en nyckel per Loopa-ID, och antalet är okänt här.
 *
 * Listan har ett andra jobb utöver att beskriva. Den som tar TILLBAKA sitt samtycke ska inte bara
 * sluta få nya rader lagrade — det som redan ligger där ska bort, annars är återkallandet ett löfte
 * om framtiden i stället för en åtgärd. Se purge nedan.
 */
const FUNCTIONAL_PREFIXES = ["loopa-card-chat:"];

function read(): Consent | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Consent>;
    // Ett äldre val gäller inte en nyare uppsättning kategorier — då frågar vi om.
    if (parsed.version !== CONSENT_VERSION) return null;
    if (typeof parsed.functional !== "boolean") return null;
    return { version: CONSENT_VERSION, decidedAt: parsed.decidedAt ?? "", functional: parsed.functional };
  } catch {
    // Privat läge kan kasta på localStorage. Ett val som inte går att läsa är inget val — rutan
    // kommer tillbaka, och inget funktionellt lagras under tiden. Det är rätt håll att falla åt.
    return null;
  }
}

/**
 * Cachat i en modulvariabel, inte läst ur localStorage vid varje anrop.
 *
 * `useSyncExternalStore` kräver att getSnapshot returnerar samma referens så länge inget ändrats;
 * ett JSON.parse per anrop hade gett ett nytt objekt varje gång och renderat i all oändlighet.
 */
let current: Consent | null = read();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function getConsent(): Consent | null {
  return current;
}

/** Har läsaren sagt ja till den här sortens lagring? Obesvarad ruta betyder nej. */
export function hasConsent(category: "functional"): boolean {
  return current?.[category] === true;
}

/**
 * Städar bort det som lagrats under ett samtycke som inte längre finns.
 *
 * Tyst om något går fel: den som nekar lagring ska inte mötas av ett felmeddelande om lagring.
 */
function purgeFunctional() {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && FUNCTIONAL_PREFIXES.some((p) => key.startsWith(p))) doomed.push(key);
    }
    doomed.forEach((key) => localStorage.removeItem(key));
  } catch {
    /* se read() */
  }
}

export function decide(functional: boolean): void {
  current = { version: CONSENT_VERSION, decidedAt: new Date().toISOString(), functional };
  if (!functional) purgeFunctional();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Valet gäller i den här fliken även om det inte gick att spara — annars hade rutan blivit
    // omöjlig att trycka bort i privat läge.
  }
  emit();
}

/**
 * Glömmer valet så rutan kommer tillbaka. Vägen ur "Cookieinställningar".
 *
 * Städar INTE: den som vill ändra sig ska få se rutan igen, och det som ligger lagrat avgörs av vad
 * de svarar den här gången — inte av att de öppnade den.
 */
export function reopenConsent(): void {
  current = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* se read() */
  }
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** null = frågan är obesvarad, och rutan ska visas. */
export function useConsent(): Consent | null {
  return useSyncExternalStore(subscribe, getConsent, () => null);
}
