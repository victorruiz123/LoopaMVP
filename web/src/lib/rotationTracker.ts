// Tracks how far the phone has turned since recording started, so a walkaround can end itself when a
// full lap is done instead of on a timer.
//
// RELATIVE rotation, never the compass heading: absolute heading drifts, needs calibration, and behaves
// differently on iOS (webkitCompassHeading) than on Android. All we need is "how much have we turned
// since the start", which is a sum of small deltas and works the same everywhere.

/** alpha is 0-360 and wraps. A raw difference of -359 is really +1, so fold every delta into (-180, 180]. */
export function signedDelta(prev: number, next: number): number {
  let d = next - prev;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

/** Below this a delta is hand tremor, not walking. */
const NOISE_DEG = 0.4;
/** Above this between two samples the sensor glitched or jumped — walking cannot turn that fast. */
const GLITCH_DEG = 60;

export interface RotationTracker {
  stop(): void;
  /** Degrees turned so far, always positive, direction-agnostic. */
  total(): number;
}

export type PermissionOutcome = "granted" | "denied" | "unsupported";

/**
 * iOS requires requestPermission() and will only honour it from inside a user gesture, so this must be
 * called synchronously from the tap that starts recording — not after an await.
 */
export async function requestRotationPermission(): Promise<PermissionOutcome> {
  const D = (globalThis as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent as
    | { requestPermission?: () => Promise<"granted" | "denied"> }
    | undefined;
  if (!D) return "unsupported";
  if (typeof D.requestPermission !== "function") return "granted"; // Android and older iOS: no prompt
  try {
    return (await D.requestPermission()) === "granted" ? "granted" : "denied";
  } catch {
    return "denied";
  }
}

/**
 * Starts accumulating rotation. `onChange` fires with the running total in degrees.
 * Returns null when no usable orientation events arrive — the caller then falls back to manual stop.
 */
export function startRotationTracking(onChange: (degrees: number) => void): RotationTracker {
  let total = 0;
  let prev: number | null = null;

  const handler = (e: DeviceOrientationEvent) => {
    const alpha = e.alpha;
    if (alpha === null || alpha === undefined || Number.isNaN(alpha)) return;
    if (prev === null) {
      prev = alpha;
      return;
    }
    const d = signedDelta(prev, alpha);
    prev = alpha;
    const step = Math.abs(d);
    if (step < NOISE_DEG || step > GLITCH_DEG) return;
    // Direction-agnostic: turning either way counts towards the lap, and a seller who backtracks
    // slightly should not have their progress eaten by the wobble.
    total += step;
    onChange(total);
  };

  window.addEventListener("deviceorientation", handler, true);
  return {
    stop: () => window.removeEventListener("deviceorientation", handler, true),
    total: () => total,
  };
}
