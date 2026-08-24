import { HEATER_MIN_RPM, HEATER_CAP, TARGET_MIN } from "../src/lib/sequences.js";

/**
 * The rules njsPC has no concept of.
 *
 * Deliberately pure. Interlocks that live inside request handlers can only be
 * tested by making requests; as functions they can be argued with directly,
 * which matters because these are the parts where being wrong has physical
 * consequences. `index.js` calls them, and never restates them.
 */

/**
 * Invariant 1 — a live heat call floors the pump at HEATER_MIN_RPM.
 *
 * Clamps rather than dropping the call. Silently stopping the heat because
 * someone dragged a slider is the worse surprise, and the heater's own flow
 * switch is a backstop rather than the primary control.
 */
export function floorRpm(rpm, heaterCall) {
  const wanted = Number(rpm);
  if (!Number.isFinite(wanted)) throw new Error("rpm must be a number");
  if (heaterCall && heaterCall !== "off") {
    return { rpm: Math.max(wanted, HEATER_MIN_RPM), clamped: wanted < HEATER_MIN_RPM };
  }
  return { rpm: wanted, clamped: false };
}

/**
 * ADR-9 — the bypass follows the mode, with a pool-heat override.
 *
 * Spa always heats, so spa implies flow. Pool rests with the exchanger
 * isolated unless pool heat has been asked for.
 */
export function bypassFor(mode, poolHeatDemand) {
  return mode === "spa" || poolHeatDemand ? "flow" : "around";
}

/**
 * Invariants 2 and 3, which are converses and both required.
 *
 * The valve is binary, so a heat call with the bypass around means zero flow
 * through the exchanger — not reduced flow. This is the one that stops it.
 */
export function mayCallForHeat(bypass) {
  return bypass === "flow";
}

/**
 * The blower gate, server-side this time.
 *
 * Refuses to switch the blower ON outside spa mode, never to switch it OFF.
 * A blower that is on and cannot be turned off is the one state the project
 * rules out, and the client enforcing this alone is the wrong side of the wire.
 */
export function mayToggleBlower({ turningOn, mode }) {
  return !turningOn || mode === "spa";
}

/**
 * Targets are cutoffs (ADR-4). This says when to stop calling for heat — it
 * can end a call early and can never extend one, because the heater's own
 * thermostat and hard caps sit underneath and are not ours to move.
 */
export function shouldStopHeat({ waterTemp, target }) {
  /* Unknown temperature must not end a call: the heater is still governing
     itself against its own sensor, and guessing here would cut heat off for
     a reading we never had. */
  if (typeof waterTemp !== "number" || typeof target !== "number") return false;
  return waterTemp >= target;
}

/**
 * The purge is conditional on the compressor actually having run. njsPC's
 * HeaterCooldownDelay is unconditional, so this is the part it lacks.
 */
export function needsPurge({ compressorIdleMin, skipAfterMin = 5 }) {
  if (typeof compressorIdleMin !== "number") return true;
  return compressorIdleMin < skipAfterMin;
}

/** Convenience for callers reporting a refusal with its reason. */
export function refuse(reason) {
  const err = new Error(reason);
  err.refused = true;
  return err;
}

export { HEATER_MIN_RPM, HEATER_CAP, TARGET_MIN };
