import { HEATER_MIN_RPM, HEATER_CAP, TARGET_MIN, PURGE_MIN } from "../src/lib/sequences.js";

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
 * How much longer flow must be held through the exchanger, in ms.
 *
 * The invariant is *"bypass may only move when heaterCall === 'off' and purge
 * has elapsed"*. The first half was already enforced — `bypassFor` returns
 * flow whenever heat is called. This is the second half, and nothing kept it:
 * releasing pool heat swung the bypass to `around` in the same tick, which
 * strands whatever heat is left in the exchanger behind a closed valve.
 *
 * The compressor is unobservable — the 3-wire interface reports nothing — so
 * the end of *our* call stands in for the end of the compressor's run. That
 * is a safe substitution in the direction that matters: the compressor cannot
 * still be running after our call ended, so this can only ever over-estimate
 * how long the exchanger stays hot.
 */
export function purgeRemainingMs(heatEndedAt, now, purgeMin = PURGE_MIN) {
  if (!heatEndedAt) return 0;
  const left = heatEndedAt + purgeMin * 60_000 - now;
  return left > 0 ? left : 0;
}

/**
 * The bypass position, given whether the purge is still holding.
 *
 * A boolean rather than a clock, because the clock lives in the evaluation
 * loop and the position lives in `map.js` — which *derives* the bypass rather
 * than storing one. A stored position went stale the first time njsPC changed
 * the body by itself, leaving spa valves with the exchanger still bypassed.
 *
 * Only ever holds a move *toward* the heater's side. Moving to `flow` is
 * never delayed — that direction is the safe one, and a heat call that had to
 * wait three minutes for a valve it already needs would be a bug wearing an
 * interlock's clothes.
 */
export function bypassHeld(want, holding) {
  return want === "around" && holding ? "flow" : want;
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


/** Convenience for callers reporting a refusal with its reason. */
export function refuse(reason) {
  const err = new Error(reason);
  err.refused = true;
  return err;
}

export { HEATER_MIN_RPM, HEATER_CAP, TARGET_MIN };
