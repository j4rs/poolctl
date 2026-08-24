import { CELL_MIN_RPM, HEATER_MIN_RPM } from "./sequences";

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

/** Offered on a fresh install. Both are real activities, not demonstrations. */
export const DEFAULT_PROGRAMS = [
  { id: "filtration", name: "Filtration", rpm: 1600, minutes: 60 },
  { id: "skimming", name: "Skimming", rpm: 2100, minutes: 30 },
];

/** Minutes, because a skim is 15–45 of them. Hours would make 60 the floor. */
export const DURATIONS = [
  { minutes: 15, label: "15 min" },
  { minutes: 30, label: "30 min" },
  { minutes: 60, label: "1 h" },
  { minutes: 120, label: "2 h" },
  { minutes: 240, label: "4 h" },
];

export const MAX_MINUTES = 720;

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
  isNew: true,
});

/** A program needs a name, a plausible speed and a bounded run. */
export function validate(p) {
  if (!p.name.trim()) return "Give it a name.";
  if (!Number.isFinite(p.rpm) || p.rpm <= 0) return "Pick a speed.";
  if (!Number.isFinite(p.minutes) || p.minutes <= 0) return "Pick how long it runs.";
  if (p.minutes > MAX_MINUTES) return `Longest run is ${MAX_MINUTES / 60} hours.`;
  return null;
}

/** Remaining milliseconds on a running program, or null. */
export const remaining = (active) =>
  active?.endsAt ? Math.max(0, active.endsAt - Date.now()) : null;
