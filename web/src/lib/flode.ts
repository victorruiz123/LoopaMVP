/**
 * Flödesmätningen i webbläsaren: vilket steg säljaren står i, hur länge, och var de försvinner.
 *
 * VARFÖR DEN INTE ÄR `track()` I BUTIKENS Bits.tsx. Den mäter annonsen och skickar till /api/analys
 * med annonsens id som nyckel. Här finns ingen annons — halva flödet sker innan jobbet ens skapats —
 * och nyckeln är i stället en flödessession som lever från märkesvalet till det intygade kortet. Två
 * frågor, två nycklar, två vägar in. Se server/src/data/flode.ts för andra halvan.
 *
 * SESSIONEN LIGGER I sessionStorage och inte i localStorage. Ett flöde är ett besök: den som kommer
 * tillbaka en vecka senare och filmar en till möbel är ett nytt flöde, inte en fortsättning på det
 * gamla. sessionStorage tömmer sig själv när fliken stängs, vilket är precis den livslängden.
 *
 * SÄLJAREN KNYTS PÅ NÄR DEN FINNS. Här stod tidigare "ingen identitet, någonsin", och flödet var
 * därför oläsbart på den enda fråga som spelar roll för intaget: vem av VÅRA säljare fastnade var.
 * Ett slumpat sessions-id svarar på hur tratten ser ut i stort, men aldrig på om det är samma person
 * som påbörjat fyra annonser och släppt alla fyra på modellvalet. Kontots id skickas med så fort
 * inloggningen finns (`knytTillSaljare`), och stegen FÖRE den knyts på i efterhand genom sessionen.
 *
 * Id:t är kontots, inte ett spår vid sidan av det: det står redan på varje annons säljaren lagt upp.
 * Anonymt är fortfarande normalläget — den som bara tittar på startsidan har inget konto att bära.
 *
 * FRÅGORNAS TEXT går numera också in, men INTE härifrån: "Hur fungerar det?"-samtalen sparas på
 * servern där de ändå passerar (server/src/data/samtal.ts). Den här filen bär fortfarande bara
 * kategorin, så att en fråga som ställdes i ett steg går att räkna utan att texten dubbellagras.
 */

const NYCKEL = "loopa.flode.sess";

function slumpId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Sessionen, skapad vid första behovet. Faller tillbaka på ett id i minnet i privat läge. */
let iMinnet: string | null = null;
function sess(): string {
  if (iMinnet) return iMinnet;
  try {
    const fanns = sessionStorage.getItem(NYCKEL);
    if (fanns) {
      iMinnet = fanns;
      return fanns;
    }
    const ny = slumpId();
    sessionStorage.setItem(NYCKEL, ny);
    iMinnet = ny;
    return ny;
  } catch {
    // Privat läge kan kasta. Ett id i minnet mäter fortfarande hela besöket i den här fliken.
    iMinnet ??= slumpId();
    return iMinnet;
  }
}

/**
 * Jobbet, när det finns.
 *
 * Sätts av flödet så fort uppladdningen gett ett id och följer sedan med varje rad. Det är den som
 * knyter ihop de steg som skedde FÖRE jobbet med möbeln de handlade om — servern gör hopkopplingen
 * på sessionen, men behöver se id:t på minst en rad för att kunna göra den.
 */
let jobbet: string | null = null;

export function knytTillJobb(jobId: string | null): void {
  if (!jobId || jobbet === jobId) return;
  jobbet = jobId;
  // En rad med bara kopplingen, så att sessionen får sitt jobb även om inget steg lämnas efteråt.
  skicka("steg", { steg: aktivt ?? undefined, ms: 0 });
}

/**
 * Säljaren, när inloggningen finns.
 *
 * Sätts av App.tsx så fort ett konto är känt och följer sedan med varje rad. Stegen som hann ske
 * INNAN inloggningen bär den inte — märkesvalet och filmningen sker före grinden — men de hör till
 * samma `sess`, och servern knyter dem till kontot på sessionen precis som den gör med jobbet.
 *
 * Raden som skickas här är därför inte överflödig: utan den hade ett flöde som loggade in och sedan
 * stängde fliken saknat sitt konto helt.
 */
let saljaren: string | null = null;

export function knytTillSaljare(uid: string | null): void {
  if (!uid || saljaren === uid) return;
  saljaren = uid;
  skicka("saljare", { steg: aktivt ?? undefined });
}

/** Flödessessionen. Chattarna märker sina samtal med den, så att ett samtal går att läsa i sitt steg. */
export function sessionId(): string {
  return sess();
}

function skicka(event: string, props: Record<string, unknown>): void {
  try {
    const kropp = JSON.stringify({ sess: sess(), jobId: jobbet, uid: saljaren, event, props });
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/data/flode", new Blob([kropp], { type: "application/json" }));
    } else {
      void fetch("/api/data/flode", {
        method: "POST",
        body: kropp,
        headers: { "Content-Type": "application/json" },
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    // En mätning får aldrig fälla det den mäter.
  }
}

// ---------------------------------------------------------------------------
// Stegen
// ---------------------------------------------------------------------------

let aktivt: string | null = null;
let sedan = 0;

/**
 * Säljaren gick in i ett steg.
 *
 * Tiden i det FÖREGÅENDE steget skickas här och inte när steget lämnas, för det finns inget "lämna"
 * att haka på: skärmen byts genom ett tillståndsbyte i React, inte genom en navigering. Att mäta
 * bakåt betyder att varje avslutat steg får en sann tid, och att det pågående inte har någon — vilket
 * är rätt: ett steg man står i har ingen varaktighet än.
 */
export function stegIn(steg: string): void {
  const nu = Date.now();
  if (aktivt && aktivt !== steg) skicka("steg", { steg: aktivt, ms: nu - sedan });
  if (aktivt === steg) return;
  aktivt = steg;
  sedan = nu;
}

/** Flödet nådde ett intygat kort. Det är den enda raden som gör en session till ett fullföljt flöde. */
export function intygat(): void {
  skicka("intygat", { steg: aktivt ?? undefined });
}

/**
 * Fliken stängdes eller doldes.
 *
 * `pagehide` och `visibilitychange` båda: iOS Safari kör inte alltid den första, och en telefon som
 * låses är ett avhopp lika mycket som en stängd flik. Dubbla rader är ett mindre problem än ett
 * avhopp som aldrig mäts — servern räknar sista steget, inte antalet rader.
 */
export function startaAvhoppsvakt(): () => void {
  const vid = () => {
    if (document.visibilityState === "hidden" && aktivt) {
      skicka("steg", { steg: aktivt, ms: Date.now() - sedan });
      skicka("avhopp", { steg: aktivt });
      // Klockan startas om: kommer de tillbaka ska tiden i steget inte räknas som en enda lång vistelse.
      sedan = Date.now();
    }
  };
  window.addEventListener("pagehide", vid);
  document.addEventListener("visibilitychange", vid);
  return () => {
    window.removeEventListener("pagehide", vid);
    document.removeEventListener("visibilitychange", vid);
  };
}

// ---------------------------------------------------------------------------
// Resten
// ---------------------------------------------------------------------------

/**
 * En fråga till en av chattarna, som KATEGORI och aldrig som text.
 *
 * Kategoriseringen görs här i webbläsaren av samma skäl som servern gör sin: den ska inte kosta ett
 * modellanrop. Texten skickas aldrig vidare — se filens topp.
 */
export function guideFraga(chatt: "start" | "annons", text: string): void {
  skicka("guide_fraga", { steg: aktivt ?? undefined, chatt, kategori: kategori(text) });
}

export function chipTryckt(chatt: "start" | "annons", text: string): void {
  skicka("chip", { steg: aktivt ?? undefined, chatt, text: text.slice(0, 120) });
}

/**
 * "Berätta" slogs på.
 *
 * KNAPPEN FINNS INTE ÄN. Funktionen står här för att mätningen ska vara på plats den dag den byggs,
 * och för att panelen ska kunna skilja "ingen tryckte" från "det gick inte att trycka" — se LUCKOR i
 * server/src/data/dataset.ts. Den dagen är ett anrop härifrån allt som behövs.
 */
export function berattaPa(): void {
  skicka("beratta", { steg: aktivt ?? undefined });
}

/** Enheten, en gång per flöde. Säger om processen är för lång på telefon men inte på dator. */
export function enhet(vy: string): void {
  const grov = matchMedia("(pointer: fine) and (min-width: 900px)").matches ? "dator" : "mobil";
  skicka("enhet", {
    enhet: grov,
    plattform: (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "okänd",
    bredd: window.innerWidth,
    vy,
  });
}

/** Samma grova indelning som servern gör på köparfrågor. Håll de två i takt. */
function kategori(text: string): string {
  const t = text.toLowerCase();
  if (/frakt|leverans|hämta|hämtning|transport|bära|hiss|skicka/.test(t)) return "leverans";
  if (/mått|bredd|höjd|längd|cm\b|sitthöjd|storlek/.test(t)) return "mått";
  if (/skick|repa|fläck|slitage|skada|nött|trasig|lukt/.test(t)) return "skick";
  if (/pris|kostar|betalt|avgift|procent|rabatt|prut|tjänar/.test(t)) return "pris";
  if (/hur går|hur fungerar|steg|tid|lång tid|när/.test(t)) return "process";
  // Adjektiven sist, efter skicket: "är repan djup" är en fråga om skicket, inte om måtten.
  if (/\b(bred|hög|djup|lång)[at]?\b/.test(t)) return "mått";
  return "övrigt";
}
