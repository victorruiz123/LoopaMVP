/**
 * Vem får röra ett jobb över /api/jobs/:id/... — prövat på ett ställe, före varje jobbväg.
 *
 *   Ägaren       allt.
 *   Admin        LÄSA vilket jobb som helst, och rätta annonsens uppgifter (POST /jobs/:id/listing):
 *                samma rättelse som admin redan gör i panelen, nu också från annonsvyn, och den förs
 *                ut till marknadsplatserna som säljarens egen.
 *   Alla andra   ingenting — och svaret är 404, inte 403: ett 403 vore ett besked om att jobbet finns.
 *
 * Övriga skrivningar (publicera, ta bort, filma om) är säljarens sak. Gränsen står här i stället för
 * att lita på att panelen aldrig råkar skicka en POST.
 */

import { ownerIdOf } from "./jobStore.js";

export function maRoraJobb(
  job: { ownerId?: string | null } | null | undefined,
  identity: { id: string; isAdmin: boolean },
  method: string | undefined,
  segments: readonly string[],
): boolean {
  if (!job) return false;
  const owner = ownerIdOf(job);
  if (owner !== null && owner === identity.id) return true;
  if (!identity.isAdmin) return false;
  if (method === "GET") return true;
  return method === "POST" && segments.length === 4 && segments[3] === "listing";
}
