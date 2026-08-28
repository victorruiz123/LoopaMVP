import type { ShotPlanShot } from './types'

/** The always-first shot — a fixed product rule, never AI-planned. See ShotPlan's doc comment in types.ts. */
export const FRONTAL_SHOT: ShotPlanShot = {
  id: 'frontal',
  title: 'Rakt framifrån',
  instruction: 'Få med hela produkten, rakt framifrån.',
  purpose: 'primary identification + overall condition view',
  required: true,
}
