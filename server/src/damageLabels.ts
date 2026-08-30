import type { DamageType } from "./types.js";

/**
 * Svenska etiketter för skadetyperna.
 *
 * Duplicerade från web/src/lib/labels.ts med samma motivering som types.ts bär: motorn är fristående
 * och importerar inte ur webbklienten. Inne i servern finns de däremot bara här — annonstexten och
 * kortets chatt ska aldrig kunna kalla samma skada två olika saker.
 */
export const TYPE_LABELS: Record<DamageType, string> = {
  scratch: "Repa", scuff: "Skrapmärke", abrasion: "Nötning", chip: "Flisa", dent: "Buckla",
  crack: "Spricka", tear: "Reva", hole: "Hål", stain: "Fläck", discoloration: "Missfärgning",
  fading: "Blekning", rust: "Rost", corrosion: "Korrosion", pilling: "Nopprighet",
  worn_material: "Slitet material", fraying: "Fransning", compressed_upholstery: "Nertryckt stoppning",
  peeling_flaking: "Flagnande yta", deformation: "Deformation", loose_component: "Lös komponent",
  broken_component: "Trasig komponent", missing_part: "Saknad del", sagging: "Nedsjunken",
  structural_damage: "Strukturell skada", general_wear: "Allmänt slitage", other: "Övrigt",
};
