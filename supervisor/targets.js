import { HEATER_CAP, TARGET_MIN } from "../src/lib/sequences.js";

/**
 * The highest target that can actually do anything, for one body.
 *
 * Two ceilings, and the lower one wins.
 *
 * `HEATER_CAP` is firmware: the top of the heater keypad's adjustable range,
 * 95 °F pool and 104 °F spa, which nothing in this repository can exceed.
 *
 * The heater's **setpoint** is lower still, and it is the one that bites.
 * Targets are cutoffs (ADR-4) — `evaluate()` uses them to end our own heat
 * call early — so the water stops at whichever comes first, ours or the
 * heater's. With the heater set to 90, a target of 95 is not ambitious, it
 * is inert: every degree above 90 does exactly nothing, and the 3-wire
 * interface carries no reading back that could ever say so.
 *
 * `setpoint` is therefore a **stated** value — what the owner says the heater
 * is set to, entered by hand because no wire can carry it. Null means nobody
 * has said, and then only the firmware cap applies: we do not invent one.
 */
export function ceilingFor(body, setpoint) {
  if (!(body in HEATER_CAP)) throw new Error(`unknown body ${body}`);
  /* Tested before `Number()`, because `Number(null)` is 0 rather than NaN —
     so a body nobody has stated a setpoint for would take the *floor* as its
     ceiling and pin every target to 70 °F. `hat.js` carries the same warning
     about `Number("")`; this file earned its own copy. */
  if (setpoint == null) return HEATER_CAP[body];
  const stated = Number(setpoint);
  return Number.isFinite(stated)
    ? Math.min(HEATER_CAP[body], Math.max(TARGET_MIN[body], stated))
    : HEATER_CAP[body];
}

/**
 * Apply a target change and clamp it to whatever is actually reachable.
 *
 * This is ADR-4 in one function: targets are cutoffs, so they may end a heat
 * call early but must never ask for more than the heater allows. It lives
 * apart from the server so it can be tested directly — it was missing
 * entirely once, and only the mock's copy was enforcing the caps.
 *
 * `delta` is the stepper's form: relative changes accumulate correctly when
 * taps outrun the round trip, where absolutes would overwrite each other.
 */
export function applyTarget(current, body, { degrees, delta }, setpoint = null) {
  const ceiling = ceilingFor(body, setpoint);
  const raw = delta != null ? current + Number(delta) : Number(degrees);
  if (!Number.isFinite(raw)) throw new Error("target must be a number");
  return Math.min(ceiling, Math.max(TARGET_MIN[body], raw));
}

/**
 * Record what the owner says the heater is set to.
 *
 * Clamped into the same range a target lives in, because a stated setpoint
 * outside it is a typo rather than a fact — and an unclamped one would move
 * the ceiling somewhere the stepper cannot follow. `null` clears it back to
 * "nobody has said".
 */
export function applySetpoint(body, degrees) {
  if (!(body in HEATER_CAP)) throw new Error(`unknown body ${body}`);
  if (degrees == null) return null;
  const n = Number(degrees);
  if (!Number.isFinite(n)) throw new Error("setpoint must be a number");
  return Math.min(HEATER_CAP[body], Math.max(TARGET_MIN[body], n));
}
