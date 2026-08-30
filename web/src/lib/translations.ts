import { COMMON } from "./translations/common";
import { FLOW } from "./translations/flow";
import { LISTING } from "./translations/listing";
import { LEGAL } from "./translations/legal";

/**
 * Ordlistan: svensk mening in, engelsk och fransk ut.
 *
 * Delad i fyra filer efter var i appen texten står, inte efter ordklass — den som ändrar en mening
 * på prisskärmen ska hitta dess två översättningar utan att läsa förbi tusen andra. Nycklarna är
 * de svenska meningarna exakt som de står i koden; en nyckel som inte matchar visar svenska, och
 * det är avsiktligt (se lib/i18n.tsx).
 */
export interface Translation {
  en: string;
  fr: string;
}

export const TRANSLATIONS: Record<string, Translation> = {
  ...COMMON,
  ...FLOW,
  ...LISTING,
  ...LEGAL,
};
