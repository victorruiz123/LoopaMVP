/**
 * Bryggen till appskalet (PROTOTYP, scripts/loopa-app-prototype/). I den vanliga webben finns den inte och ingenting här gör något.
 *
 * Skalet exponerar `window.loopaApp` när Loopa körs i ett Electron-fönster. Det har två dolda webbvyer mot Google (de syns bara när Google ber om en människa): en för AI-läget,
 * en för bildsök. Resten — att göra kandidater, mått och bilder av det som kommer tillbaka — gör servern (POST /api/jobs/:id/external-*), så att webbvyn aldrig är en sanning
 * om något: allt som kommer därifrån kontrolleras av vår kod.
 */

/** En miniatyr ur Googles bildsök: adress, titeln på sidan den kommer från, och storlek. Servern väljer och kontrollerar. */
export interface GoogleImageRow {
  src: string;
  alt: string;
  w: number;
  h: number;
  /** Sajtens namn och sidan bilden sitter på. Bara SerpApi-flödet har dem (skalets rader saknar dem). */
  source?: string;
  page?: string;
}

export interface LoopaAppBridge {
  /**
   * Skalets egna flaggor (main.js, app:flags). onlyIdentifySpecs: testläget som bara prövar modellidentifieringen och måttsökningen — ingen skickbedömning, inget pris, ingen annons.
   * allImages: skicka omslaget och alla videoramar till AI-läget i stället för bara omslaget (LOOPA_AIMODE_ALL_IMAGES=1).
   */
  flags?: {
    onlyIdentifySpecs: boolean;
    allImages?: boolean;
    /** SerpApi-flödets bildkedja (A produktlänk → C bildsök → B Gemini med webbsök, alla på servern): bildsökningen körs EN gång och är slutgiltig, ingen andra sökning med "produktbild". */
    referenceChain?: boolean;
  };
  /** Laddar AI-läget och lägger in bilderna (utan att fråga något). Görs medan webben läser möbeltypen ur fotot, så att den tiden ligger bakom uppladdningen. */
  prepare(input: { images: string[] }): Promise<{ ok: true }>;
  /** Frågan om vilken modell det är, med möbeltypen i ("vilka Sits fåtöljer kan det vara?"). Svarar med AI-lägets text och länkarna på sidan. Samtalet ligger kvar i webbvyn för `askSpecs`. */
  identify(input: { brand: string; furnitureType: string | null }): Promise<{ answer: string; links: string[] }>;
  /**
   * Uppföljningsfrågan i samma samtal, ställd EFTER att säljaren valt modell: vilken exakt variant det är (ur bilderna), och mått, material och nypris för just den.
   * `furnitureType`: möbeltypen på svenska ("stol"), så att frågan kan säga vad det är.
   */
  askSpecs(input: { brand: string; model: string; furnitureType: string | null }): Promise<{ answer: string; links: string[] }>;
  /** Googles bildsök, en fråga per modell, i den andra dolda webbvyn. Svarar med rådata per modell. */
  findImages(input: { brand: string; queries: Array<{ model: string; productType: string | null; undertyp?: string | null; retry?: boolean }> }): Promise<Array<{ model: string; rows: GoogleImageRow[] }>>;
  /**
   * Flödet är slut ("Klart — börja om", eller säljaren går hem): skalet döljer statusraden och Googles panel. Fram till dess ligger "Visa Googles vy" kvar, så att frågorna till AI-läget
   * och svaren går att granska under hela flödet och efteråt. Valfri: ett äldre skal som kör sedan innan saknar den.
   */
  endFlow?(): void;
}

declare global {
  interface Window {
    loopaApp?: LoopaAppBridge;
  }
}

export const inApp = (): boolean => typeof window !== "undefined" && !!window.loopaApp;

/** Testläget i appskalet: bara identifiering och måttsökning (se flags ovan). Aldrig sant i den vanliga webben. */
export const onlyIdentifySpecs = (): boolean => inApp() && window.loopaApp?.flags?.onlyIdentifySpecs === true;

/** Skicka alla bilder (omslaget och videoramarna) till AI-läget. Standard nej: se startAiModeInApp i App.tsx. */
export const sendAllImages = (): boolean => inApp() && window.loopaApp?.flags?.allImages === true;
