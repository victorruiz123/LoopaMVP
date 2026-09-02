/**
 * Händelser som uppstår på SERVERN.
 *
 * Klientens `track()` skriver till dataLayer i webbläsaren och når bara det användaren själv gör. Ett
 * brev som skickas klockan tre på natten, en förtur som reserveras av sveparen, ett köp som knyts
 * till en efterlysning — inget av det har en webbläsare att rapportera från, och utan dem går
 * norra stjärnan (köp per sparad efterlysning) inte att räkna alls.
 *
 * SKRIVS TILL EN LOGGRAD, inte till en analystjänst. Projektet har ingen sådan, och att välja en är
 * inte den här filens beslut — men formatet är en rad JSON per händelse, vilket vilken uppsamlare
 * som helst kan läsa. Alternativet, att inte mäta förrän någon valt verktyg, hade betytt att de
 * första månadernas data inte finns.
 */

export type ServerEvent =
  | "notification_sent"
  | "fortur_notified"
  | "fortur_reserved"
  | "purchase_from_efterlysning"
  | "pulse_sent"
  | "deadline_valve_sent"
  | "clearance_notice_sent"
  | "demand_ad_generated"
  | "demand_ad_approved";

/**
 * En rad per händelse, prefixad så den går att plocka ut ur en blandad logg.
 *
 * Ingen köparidentitet: `userId` är ett ogenomskinligt id och e-post skrivs aldrig. Analysen behöver
 * veta ATT ett brev gick, inte till vem.
 */
export function emit(event: ServerEvent, props: Record<string, string | number | boolean | null> = {}): void {
  try {
    console.info(`[analys] ${JSON.stringify({ event, at: new Date().toISOString(), ...props })}`);
  } catch {
    // En analysrad får aldrig fälla det den mäter.
  }
}
