/* Explicit .js: this module is imported by the supervisor, which runs on
   Node's ESM loader rather than through Vite. Vite resolves extensionless
   specifiers; Node does not, and the failure is at startup. */
import { CELL_MIN_RPM, HEATER_MIN_RPM } from "./sequences.js";

/**
 * Manual pump programs.
 *
 * A program is a named speed you run on purpose, for a while: skim the
 * surface, clear the water after service, run filtration on a warm evening
 * outside the schedule window. njsPC expresses exactly this as a circuit with
 * a pump speed and an `eggTimer`, so each program maps to one circuit and
 * nothing here is invented.
 *
 * Every program has an expiry, and it is not optional. A manual run is
 * inherently temporary, and njsPC's default egg timer is 720 minutes — so
 * leaving it unset means a twelve-hour skim that nobody asked for.
 *
 * This replaced a free rpm slider. Arbitrary rpm had no user and no home in
 * njsPC's model, which drives the pump from circuits rather than from
 * setpoints; a slider could also never carry an expiry, because "1837 rpm"
 * is not a thing with a lifetime.
 */

/** Offered on a fresh install. Both are real activities, not demonstrations.
    Unbound: the supervisor creates the njsPC circuit on first save. */
export const DEFAULT_PROGRAMS = [
  { id: "filtration", name: "Filtration", rpm: 1600, minutes: 60, circuit: null },
  { id: "skimming", name: "Skimming", rpm: 2100, minutes: 30, circuit: null },
];

/**
 * Minutes, because a skim is 15–45 of them. Hours would make 60 the floor.
 *
 * The long end exists for recovery, not for routine: brushing a green pool
 * after a fortnight away and then running high speed for most of a day is a
 * real job, and having to re-trigger it at hour twelve is not a safety
 * feature. Owner's account, August 2026.
 */
export const DURATIONS = [
  { minutes: 15, label: "15 min" },
  { minutes: 30, label: "30 min" },
  { minutes: 60, label: "1 h" },
  { minutes: 120, label: "2 h" },
  { minutes: 240, label: "4 h" },
  { minutes: 480, label: "8 h" },
  { minutes: 720, label: "12 h" },
  { minutes: 1080, label: "18 h" },
];

/**
 * The longest run njsPC can express, in minutes.
 *
 * 1440 is not twenty-four hours to njsPC — `NixieBoard.setCircuitAsync`
 * reads it as `dontStop` and the circuit then never expires on its own. So
 * 1439 is the ceiling, and it is a real boundary rather than a chosen one.
 *
 * This was 720. That number was not arbitrary either — Pentair's manual, as
 * quoted inside njsPC's own scheduler, caps a manual override at "12 hours
 * or whatever that circuit Egg Timer is set to". But it is *their* default
 * for a different feature, not a limit on the egg timer, and it turned a
 * legitimate all-day recovery run into a chore.
 */
export const MAX_MINUTES = 1439;

/**
 * What a given speed means for the other equipment.
 *
 * These are the threshold markers that used to sit under the live slider,
 * where they decorated a control nobody should have been using. Here they
 * inform an actual decision: this is the speed the program will hold for its
 * whole run.
 */
export function speedNotes(rpm) {
  const notes = [];
  if (rpm < CELL_MIN_RPM) notes.push("below chlorinator flow — the cell will not generate");
  if (rpm < HEATER_MIN_RPM) notes.push("below heater minimum — the heater will not fire");
  return notes;
}

export const blankProgram = () => ({
  id: `new-${Math.random().toString(36).slice(2, 8)}`,
  name: "",
  rpm: 1800,
  minutes: 30,
  /* The njsPC circuit that carries this program's speed and egg timer.
     Null until the supervisor binds it, which it attempts on every save. A
     program can be written and edited before there is a pump to run it on;
     only running it needs the binding. */
  circuit: null,
  isNew: true,
});

/**
 * A program needs a name, a plausible speed and a bounded run.
 *
 * `limits` is the pump as njsPC describes it — `{ minSpeed, maxSpeed }` — and
 * is optional because a program can be written before there is a pump to run
 * it on. When it is present it is the authority, not the constants in
 * `pump.js`: a different pump is a different range. njsPC will not do this
 * for us — its own clamp in `setTargetSpeed` computes a bounded speed and
 * then discards it without assigning — so an out-of-range speed reaches the
 * equipment exactly as typed.
 */
export function validate(p, limits) {
  if (!p.name.trim()) return "Give it a name.";
  if (!Number.isFinite(p.rpm) || p.rpm <= 0) return "Pick a speed.";
  if (limits?.minSpeed != null && p.rpm < limits.minSpeed) {
    return `The pump will not run below ${limits.minSpeed} rpm.`;
  }
  if (limits?.maxSpeed != null && p.rpm > limits.maxSpeed) {
    return `The pump will not run above ${limits.maxSpeed} rpm.`;
  }
  if (!Number.isFinite(p.minutes) || p.minutes <= 0) return "Pick how long it runs.";
  if (p.minutes > MAX_MINUTES) {
    /* Not "24 hours": to njsPC that value means never stop, so the ceiling
       is a minute below it and the message says the real number. */
    return "Longest run is 23 h 59 — a full day means never stopping.";
  }
  return null;
}

/** Remaining milliseconds on a running program, or null. */
export const remaining = (active) =>
  active?.endsAt ? Math.max(0, active.endsAt - Date.now()) : null;
