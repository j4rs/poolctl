/**
 * Pump math and schedule helpers.
 *
 * Separate from the screen so the schedule editor and the schedule list
 * share one definition, and so PumpControl exports a component and nothing
 * else — a mixed export breaks Fast Refresh.
 */

export const RPM_MIN = 450;
export const RPM_MAX = 3450;

const WATTS_MAX = 2400; // IntelliFlo VSF at full speed, approximate

/** Affinity law: power scales with the cube of speed. */
export const watts = (rpm) => Math.round(WATTS_MAX * Math.pow(rpm / RPM_MAX, 3));

/** 0 = Sunday, matching Date#getDay. */
export const DAYS = [
  { i: 0, short: "S", name: "Sun" },
  { i: 1, short: "M", name: "Mon" },
  { i: 2, short: "T", name: "Tue" },
  { i: 3, short: "W", name: "Wed" },
  { i: 4, short: "T", name: "Thu" },
  { i: 5, short: "F", name: "Fri" },
  { i: 6, short: "S", name: "Sat" },
];

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];
const sameSet = (a, b) => a.length === b.length && b.every((d) => a.includes(d));

export function daysLabel(days) {
  if (!days.length) return "Never";
  if (days.length === 7) return "Every day";
  if (sameSet(days, WEEKDAYS)) return "Weekdays";
  if (sameSet(days, WEEKEND)) return "Weekends";
  return DAYS.filter((d) => days.includes(d.i)).map((d) => d.name).join(", ");
}

const toMin = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

/** Duration in hours, wrapping past midnight. */
export function hoursBetween(a, b) {
  const h = (toMin(b) - toMin(a)) / 60;
  return h < 0 ? h + 24 : h;
}

/* A window that crosses midnight is treated as two same-day spans. Good
   enough for a warning; it does not model the run bleeding into the next
   day's day-of-week selection. */
const spans = (s) => {
  const a = toMin(s.start);
  const b = toMin(s.end);
  return b > a ? [[a, b]] : [[a, 1440], [0, b]];
};

export function overlaps(x, y) {
  if (!x.days.some((d) => y.days.includes(d))) return false;
  return spans(x).some(([a1, b1]) => spans(y).some(([a2, b2]) => a1 < b2 && a2 < b1));
}

/**
 * The schedule that would be driving the pump right now, or null.
 *
 * Where windows overlap the later one wins, matching what the editor warns.
 */
export function activeSchedule(schedules, date = new Date()) {
  const day = date.getDay();
  const mins = date.getHours() * 60 + date.getMinutes();
  const hits = schedules.filter(
    (s) => s.on && s.days.includes(day) && spans(s).some(([a, b]) => mins >= a && mins < b));
  return hits.length ? hits[hits.length - 1] : null;
}

/** 24h clock for a timestamp, matching the schedule fields. */
export const clockAt = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
