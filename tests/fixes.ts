/**
 * Which pipeline fixes have landed.
 *
 * Tests and fixtures that document a KNOWN-WRONG current behaviour assert their
 * `expected` (baseline) value until the fix is named here, then flip to
 * `intended`. That keeps phase 1's baseline honest — we record what the code
 * does today without blessing it as correct — and makes phase 2 a one-line
 * change here instead of a rewrite of every affected assertion.
 */
export const APPLIED_FIXES = new Set<string>([
  "2b", // dedup: semanticLocation ingår i sammanslagningsnyckeln
  // "4",   // coverage caps the achievable grade
]);
