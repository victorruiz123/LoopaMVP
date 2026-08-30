import { t } from "./i18n";
import type { DamageType, Impact, Severity, WearLevel } from "../types";

export const TYPE_LABELS: Record<DamageType, string> = {
  scratch: "Repa",
  scuff: "Skrapmärke",
  abrasion: "Nötning",
  chip: "Flisa",
  dent: "Buckla",
  crack: "Spricka",
  tear: "Reva",
  hole: "Hål",
  stain: "Fläck",
  discoloration: "Missfärgning",
  fading: "Blekning",
  rust: "Rost",
  corrosion: "Korrosion",
  pilling: "Nopprighet",
  worn_material: "Slitet material",
  fraying: "Fransning",
  compressed_upholstery: "Nertryckt stoppning",
  peeling_flaking: "Flagnande yta",
  deformation: "Deformation",
  loose_component: "Lös komponent",
  broken_component: "Trasig komponent",
  missing_part: "Saknad del",
  sagging: "Nedsjunken",
  structural_damage: "Strukturell skada",
  general_wear: "Allmänt slitage",
  other: "Övrigt",
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  S1: "Mindre",
  S2: "Måttlig",
  S3: "Stor",
  S4: "Kritisk",
};

export const IMPACT_LABELS: Record<Impact, string> = {
  cosmetic: "Kosmetisk",
  functional: "Funktionell",
  structural: "Strukturell",
};

export const WEAR_LEVEL_LABELS: Record<WearLevel, string> = {
  minimal: "Minimalt",
  light: "Lätt",
  moderate: "Måttligt",
  heavy: "Kraftigt",
  severe: "Mycket kraftigt",
};

export const DAMAGE_TYPE_OPTIONS = Object.keys(TYPE_LABELS) as DamageType[];
export const SEVERITY_OPTIONS = Object.keys(SEVERITY_LABELS) as Severity[];
export const IMPACT_OPTIONS = Object.keys(IMPACT_LABELS) as Impact[];

/**
 * Etiketterna, översatta.
 *
 * Tabellerna ovan står kvar på svenska och är NYCKLARNA — de är också det enda stället där en
 * skadetyp har ett namn, och det ska gå att läsa i koden. Funktionerna nedan är vägen dit texten
 * ska visas; ordlistan (lib/translations) bär engelskan och franskan.
 */
export const typeLabel = (type: DamageType): string => t(TYPE_LABELS[type] ?? type);
export const severityLabel = (severity: Severity): string => t(SEVERITY_LABELS[severity] ?? severity);
export const impactLabel = (impact: Impact): string => t(IMPACT_LABELS[impact] ?? impact);
export const wearLevelLabel = (level: WearLevel): string => t(WEAR_LEVEL_LABELS[level] ?? level);
