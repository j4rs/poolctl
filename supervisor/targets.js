import { HEATER_CAP, TARGET_MIN } from "../src/lib/sequences.js";

/**
 * Apply a target change and clamp it to the heater's own limits.
 *
 * This is ADR-4 in one function: targets are cutoffs, so they may end a heat
 * call early but must never ask for more than the heater allows. It lives
 * apart from the server so it can be tested directly — it was missing
 * entirely once, and only the mock's copy was enforcing the caps.
 *
 * `delta` is the stepper's form: relative changes accumulate correctly when
 * taps outrun the round trip, where absolutes would overwrite each other.
 */
export function applyTarget(current, body, { degrees, delta }) {
  if (!(body in HEATER_CAP)) throw new Error(`unknown body ${body}`);
  const raw = delta != null ? current + Number(delta) : Number(degrees);
  if (!Number.isFinite(raw)) throw new Error("target must be a number");
  return Math.min(HEATER_CAP[body], Math.max(TARGET_MIN[body], raw));
}
