import { MAX_MINUTES } from "../src/lib/programs.js";

/**
 * Binding a manual program to njsPC.
 *
 * A program is a name, a speed and an expiry. njsPC expresses each of those,
 * but not in one place:
 *
 *   the name and the expiry live on a **circuit** (`name`, `eggTimer`)
 *   the speed lives on the **pump**, as an entry in `pump.circuits`
 *
 * So binding is two writes, and they are not symmetric. This module holds the
 * parts that are pure — building payloads, deciding what the pump's circuit
 * list should become, and refusing what njsPC would accept but should not.
 * `index.js` performs the writes; everything decided here can be argued with
 * directly in a test.
 *
 * Read against njsPC 10.0.1. Line references are to that tag.
 */

/**
 * njsPC circuit function 0 — "Generic". Deliberately not Pool (12) or Spa
 * (13): those carry a body and would make a skim cycle switch the pool over.
 * A program drives the pump and nothing else.
 */
export const GENERIC_CIRCUIT = 0;

/** njsPC's pump speed units: 0 is RPM. */
export const RPM_UNITS = 0;

/**
 * `eggTimer: 1440` is not "24 hours" to njsPC — `NixieBoard.setCircuitAsync`
 * reads it as `dontStop`, and the circuit then never expires on its own. A
 * program is temporary by definition, so this value is refused rather than
 * passed through. `MAX_MINUTES` (720) already keeps us clear of it; this is
 * the backstop for when that changes.
 */
export const DONT_STOP_MINUTES = 1440;

/** The circuit body for `PUT /config/circuit`. */
export function circuitConfig(program) {
  return {
    /* 0 asks njsPC to allocate. It picks the next free id and explicitly
       skips 1 and 6 — Spa and Pool — so this cannot land on a body circuit.
       An existing id updates that circuit in place instead. */
    id: program.circuit ?? 0,
    name: program.name,
    type: GENERIC_CIRCUIT,
    eggTimer: program.minutes,
    /* The programs live on our Pump screen, not in dashPanel's feature list. */
    showInFeatures: false,
    freeze: false,
  };
}

/**
 * Why this program cannot be bound, or null.
 *
 * Speed is checked against the pump's own advertised range rather than a
 * constant here. njsPC does not do it: `NixiePumpVS.setTargetSpeed` computes
 * `Math.min(Math.max(minSpeed, target), maxSpeed)` and then throws the result
 * away without assigning it, so an out-of-range speed reaches the pump
 * unclamped. Ours is the only check there is.
 */
export function whyNotBindable(program, limits) {
  if (!limits) return "no pump is configured in njsPC";
  if (!Number.isFinite(program.rpm)) return "the program has no speed";
  if (program.rpm < limits.minSpeed || program.rpm > limits.maxSpeed) {
    return `${program.rpm} rpm is outside the pump's ${limits.minSpeed}–${limits.maxSpeed} range`;
  }
  if (!Number.isFinite(program.minutes) || program.minutes <= 0) {
    return "the program has no expiry";
  }
  if (program.minutes >= DONT_STOP_MINUTES) {
    return `${DONT_STOP_MINUTES} minutes or more means never stop, to njsPC`;
  }
  if (program.minutes > MAX_MINUTES) return `longest run is ${MAX_MINUTES} minutes`;
  if (!program.name?.trim()) return "the program has no name";
  return null;
}

/**
 * The pump's complete circuit list with this program's speed added or
 * updated.
 *
 * Complete is the whole point. `PUT /config/pump` hands the body to
 * `NixiePump.setPumpAsync`, which does `this.pump.set(data)` — a replace, not
 * a merge — and sets `data.circuits = []` when the key is missing at all. So
 * a partial write silently deletes the speeds the schedules run on. Callers
 * pass the pump exactly as njsPC gave it, and send back what this returns.
 */
export function withPumpCircuit(pump, { circuit, speed }, limits) {
  const circuits = (pump?.circuits ?? []).map((c) => ({ ...c }));
  const existing = circuits.find((c) => c.circuit === circuit);
  if (existing) {
    existing.speed = speed;
    existing.units = RPM_UNITS;
    return circuits;
  }
  const max = limits?.maxCircuits;
  if (max && circuits.length >= max) {
    throw new Error(
      `the pump holds ${max} circuits and all ${max} are in use — free one before binding another program`,
    );
  }
  return [...circuits, { circuit, speed, units: RPM_UNITS }];
}

/** The pump's complete circuit list with this circuit removed. */
export function withoutPumpCircuit(pump, circuit) {
  return (pump?.circuits ?? []).filter((c) => c.circuit !== circuit).map((c) => ({ ...c }));
}

/**
 * The pump njsPC would drive, and what it will accept.
 *
 * Derived from `/state/all`, which the supervisor already polls: each pump
 * there carries its own speed range and its fully expanded type, including
 * `maxCircuits`. Nothing extra is fetched to know this, so the limits shown
 * in the UI can never be staler than the rest of the screen.
 *
 * Returns null when njsPC has no pump — which is not an error. Until the
 * hardware is commissioned there is genuinely nothing to bind to, and saying
 * so beats inventing a range.
 */
export function pumpLimits(njs) {
  const pump = (njs?.pumps ?? []).find((p) => p.isActive !== false);
  if (!pump) return null;
  const type = pump.type && typeof pump.type === "object" ? pump.type : null;
  return {
    pumpId: pump.id,
    /* The pump's own fields first, its type's second. Both read 450/3450
       here, but they are not interchangeable: `NixiePumpVS.setTargetSpeed`
       clamps against `this.pump.minSpeed`, so the pump's copy is the one that
       would apply — if that clamp were not discarded. Either way it is the
       instance we should measure against, not the class. */
    minSpeed: pump.minSpeed ?? type?.minSpeed ?? null,
    maxSpeed: pump.maxSpeed ?? type?.maxSpeed ?? null,
    /* Only the type knows this one. */
    maxCircuits: type?.maxCircuits ?? null,
    used: (pump.circuits ?? []).length,
  };
}

/** Free circuit slots on the pump, or null when that cannot be known. */
export function freeSlots(limits) {
  if (!limits?.maxCircuits) return null;
  return Math.max(0, limits.maxCircuits - limits.used);
}
