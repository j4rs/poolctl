/**
 * njsPC schedules, translated.
 *
 * njsPC owns schedules outright (ADR-11) — it evaluates them on its own
 * timers and will switch a body without asking. So this is translation, not
 * ownership: the supervisor reads njsPC's schedules, writes changes back, and
 * never keeps a copy that could disagree.
 *
 * Two things about njsPC's model shape everything here.
 *
 * **A schedule runs a circuit, not a speed.** Same as a manual program, and
 * for the same reason: there is no runtime pump-speed endpoint, so speed is
 * expressed by which circuit runs. The rpm a schedule shows is read back from
 * the pump's entry for that circuit, never stored alongside the schedule.
 *
 * **Days are a bitmask, and its bit order is not `Date#getDay`.** Nixie puts
 * Monday at bit 0 and Sunday at bit 6; `Date#getDay` puts Sunday at 0. Get
 * that wrong and every schedule silently runs a day out — which is why the
 * conversion lives here, in one direction-tested pair of functions, rather
 * than inline at a call site.
 *
 * Read against njsPC 10.0.1.
 */

/** njsPC's "repeats on these days", as opposed to 0, "run once". */
export const REPEATS = 128;

/**
 * njsPC's heat source meaning "leave the heater alone".
 *
 * Not optional, and not only a preference. `setScheduleAsync` validates
 * `heatSource` against its value map and inherits it from the stored
 * schedule when absent — so an *existing* schedule saves without one and a
 * *new* one is rejected outright with "Invalid heat source: undefined". That
 * asymmetry is why creating a schedule failed while editing worked.
 *
 * The value we want is the one that changes nothing. A schedule can
 * otherwise carry a setpoint and impose it when it fires, which would put a
 * second authority on the heater and walk straight through ADR-4.
 *
 * **The number is not a constant, and assuming it was cost a live 400.**
 * `NixieBoard`'s constructor builds the map with `32 = nochange`, which is
 * where 32 came from and it was true when it was written. But
 * `updateHeaterServices()` rebuilds that map from the installed heater types
 * and merges `[0, nochange]` at the end — so on a running system with a heat
 * pump the valid set is `{0 nochange, 1 off, 9 heatpump}` and 32 is rejected
 * with "Invalid heat source: 32".
 *
 * So resolve it by *name* from njsPC's own options, and treat 32 only as the
 * last-resort default for a board that has never rebuilt its map.
 */
export const HEAT_NO_CHANGE_FALLBACK = 32;

/**
 * Pick the "no change" value out of njsPC's `heatSources` options.
 *
 * Tolerates the two shapes njsPC serialises value maps in — a bare array of
 * `{val,name}` and an object keyed by value — because the state and config
 * routes have disagreed on exactly this before.
 */
export function noChangeHeatSource(heatSources) {
  const entries = Array.isArray(heatSources)
    ? heatSources
    : Object.entries(heatSources ?? {}).map(([val, v]) => ({ val: Number(val), ...v }));
  const found = entries.find((e) => e && e.name === "nochange");
  return found && Number.isFinite(Number(found.val))
    ? Number(found.val)
    : HEAT_NO_CHANGE_FALLBACK;
}

/**
 * Bit position for a `Date#getDay` index, per `NixieBoard`'s scheduleDays
 * map: Monday is val 1 at bit 0, Sunday is val 7 at bit 6.
 *
 * Note the base `SystemBoard` map is a different order entirely (Saturday
 * first, no bitvals). Nixie overrides it, and Nixie is what we run.
 */
const BIT_FOR_DOW = { 0: 6, 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5 };

/** `[0, 6]` (Sunday, Saturday) -> the byte njsPC stores. */
export function daysToMask(days) {
  let mask = 0;
  for (const d of days ?? []) {
    const bit = BIT_FOR_DOW[d];
    if (bit === undefined) throw new Error(`not a day of the week: ${d}`);
    mask |= 1 << bit;
  }
  return mask;
}

/** The byte njsPC stores -> `[0, 6]`, ascending and `Date#getDay`-indexed. */
export function maskToDays(mask) {
  const byte = Number(val(mask)) || 0;
  const days = [];
  for (const dow of [0, 1, 2, 3, 4, 5, 6]) {
    if (byte & (1 << BIT_FOR_DOW[dow])) days.push(dow);
  }
  return days;
}

/** Minutes past midnight -> "HH:MM". */
export function toClock(minutes) {
  if (!Number.isFinite(minutes)) return null;
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "HH:MM" -> minutes past midnight. */
export function toMinutes(clock) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(clock ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * njsPC reports the same field two ways.
 *
 * `/config/all` gives plain numbers; `/state/all` expands them into
 * `{ val, name, desc }` — and `scheduleDays` into `{ val, days: [...] }`.
 * The supervisor reads state, so everything here accepts both. Each of these
 * cost a live bug before it was written down: an expanded `scheduleDays`
 * read as 0 gave every schedule an empty day list.
 */
const val = (v) => (v && typeof v === "object" && "val" in v ? v.val : v);

/**
 * The circuit a schedule runs, or null.
 *
 * State expands this to the whole circuit object — and for njsPC's *empty*
 * schedule slots that object exists but carries no `id`. Truthiness is
 * therefore useless here, which is exactly how two blank slots reached the
 * screen looking like real schedules.
 */
const circuitIdOf = (c) => {
  const id = c && typeof c === "object" ? c.id : c;
  return Number.isFinite(id) ? id : null;
};

/**
 * njsPC's schedule -> the shape the Pump screen speaks.
 *
 * `speedFor` looks up what the pump runs that circuit at. Absent means the
 * circuit carries no speed, which is worth showing rather than hiding: a
 * schedule pointed at a circuit the pump does not know will run, and do
 * nothing to the pump.
 */
export function toUiSchedule(sched, { speedFor = () => null, nameFor = () => null } = {}) {
  const circuit = circuitIdOf(sched.circuit);
  return {
    id: sched.id,
    circuit,
    circuitName: nameFor(circuit),
    /* Read back from the pump, never stored on the schedule. */
    rpm: speedFor(circuit),
    start: toClock(sched.startTime),
    end: toClock(sched.endTime),
    days: maskToDays(sched.scheduleDays),
    /* njsPC separates "exists" from "switched off". `isActive` false means
       deleted; `disabled` is the toggle an operator flips. */
    enabled: !sched.disabled,
    /* Anything other than a plain clock time — sunrise, sunset — is not
       something this UI can edit yet, so it says so instead of mangling it. */
    clockOnly: (val(sched.startTimeType) ?? 0) === 0 && (val(sched.endTimeType) ?? 0) === 0,
    repeats: val(sched.scheduleType) === REPEATS,
  };
}

/**
 * Only real schedules. njsPC keeps its unused slots in the same array, and in
 * state they are indistinguishable by shape — same keys, same expanded
 * circuit object — except that nothing resolves to a circuit id.
 */
export function isRealSchedule(sched) {
  if (sched?.isActive === false) return false;
  return circuitIdOf(sched?.circuit) != null;
}

/** Why this schedule cannot be saved, or null. */
export function whyNotSchedulable(s) {
  if (s?.circuit == null) return "pick what it should run";
  if (toMinutes(s.start) == null) return "start time is not a time";
  if (toMinutes(s.end) == null) return "end time is not a time";
  if (toMinutes(s.start) === toMinutes(s.end)) return "it starts and ends at the same moment";
  if (!s.days?.length) return "pick at least one day";
  return null;
}

/**
 * The body for `PUT /config/schedule`.
 *
 * `changeHeatSetpoint: false` is sent explicitly rather than left to njsPC's
 * default. A schedule can carry a heat setpoint and impose it when it fires,
 * which would put a second authority on the heater and walk straight through
 * ADR-4. We never want that, and njsPC's own defaulting of this field is
 * written as `typeof (data.changeHeatSetpoint !== 'undefined') ? ... : false`
 * — a `typeof` around the comparison instead of the value, so the guard is
 * always truthy and the fallback never runs. Saying it outright costs one
 * line and does not depend on that being fixed.
 */
export function scheduleConfig(s, { heatSource = HEAT_NO_CHANGE_FALLBACK } = {}) {
  return {
    /* 0 asks njsPC for the next free slot. */
    id: s.id == null || String(s.id).startsWith("new-") ? 0 : s.id,
    circuit: s.circuit,
    startTime: toMinutes(s.start),
    endTime: toMinutes(s.end),
    scheduleDays: daysToMask(s.days),
    scheduleType: REPEATS,
    startTimeType: 0,
    endTimeType: 0,
    disabled: s.enabled === false,
    /* Both halves of "do not touch the heater" — the source that changes
       nothing, and the flag that stops a setpoint being imposed. */
    heatSource,
    changeHeatSetpoint: false,
  };
}
