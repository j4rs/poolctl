import { describe, it, expect } from "vitest";
import { watts, hoursBetween, overlaps, activeSchedule, clockAt, RPM_MIN, RPM_MAX } from "./pump";

const every = [0, 1, 2, 3, 4, 5, 6];

describe("affinity law", () => {
  it("scales with the cube of speed, not linearly", () => {
    /* PR-5's whole argument: halving the speed is not halving the cost. */
    expect(watts(RPM_MAX)).toBeGreaterThan(watts(RPM_MAX / 2) * 4);
  });
  it("is zero at rest and monotonic", () => {
    expect(watts(0)).toBe(0);
    expect(watts(1600)).toBeLessThan(watts(2600));
  });
});

describe("schedule spans", () => {
  it("measures a normal window", () => {
    expect(hoursBetween("08:00", "18:00")).toBe(10);
  });
  it("handles a window crossing midnight", () => {
    expect(hoursBetween("22:00", "01:30")).toBe(3.5);
  });
  it("detects an overlap only when days actually coincide", () => {
    const a = { start: "08:00", end: "12:00", days: every };
    const b = { start: "11:00", end: "14:00", days: every };
    const weekend = { start: "11:00", end: "14:00", days: [0, 6] };
    expect(overlaps(a, b)).toBe(true);
    expect(overlaps({ ...a, days: [1] }, weekend)).toBe(false);
  });
});

describe("active schedule", () => {
  const at = (h, m = 0) => new Date(2026, 7, 24, h, m);
  const list = [{ id: 1, start: "08:00", end: "18:00", rpm: 1600, days: every, on: true }];

  it("finds the window in force", () => {
    expect(activeSchedule(list, at(10))?.id).toBe(1);
  });
  it("returns nothing outside every window", () => {
    expect(activeSchedule(list, at(20))).toBeNull();
  });
  it("ignores a disabled window", () => {
    expect(activeSchedule([{ ...list[0], on: false }], at(10))).toBeNull();
  });
  it("lets the later window win where two overlap", () => {
    const two = [list[0], { id: 2, start: "09:00", end: "11:00", rpm: 2600, days: every, on: true }];
    expect(activeSchedule(two, at(10))?.id).toBe(2);
  });
  it("formats a clock time zero-padded", () => {
    expect(clockAt(at(9, 5).getTime())).toBe("09:05");
  });
});

/* ---------------------------------------------------------------------- */

import { validate, speedNotes, blankProgram, remaining, DURATIONS, MAX_MINUTES } from "./programs";
import { CELL_MIN_RPM, HEATER_MIN_RPM } from "./sequences";

describe("program validation", () => {
  const ok = { name: "Skim", rpm: 2100, minutes: 30 };
  it("accepts a complete program", () => expect(validate(ok)).toBeNull());
  it("requires a name", () => expect(validate({ ...ok, name: "  " })).toMatch(/name/i));
  it("requires a speed", () => expect(validate({ ...ok, rpm: 0 })).toMatch(/speed/i));
  it("requires a duration", () => expect(validate({ ...ok, minutes: 0 })).toMatch(/how long/i));
  it("caps the run length", () => {
    /* Unbounded is what njsPC's 720-minute default would give us. */
    expect(validate({ ...ok, minutes: MAX_MINUTES + 1 })).toMatch(/Longest run/);
  });
  it("gives a new program a usable default duration", () => {
    expect(validate(blankProgram())).toMatch(/name/i);
    expect(blankProgram().minutes).toBeGreaterThan(0);
  });
});

describe("speed notes", () => {
  it("warns below chlorinator flow", () =>
    expect(speedNotes(CELL_MIN_RPM - 100).join()).toMatch(/cell will not generate/));
  it("warns below the heater minimum", () =>
    expect(speedNotes(HEATER_MIN_RPM - 100).join()).toMatch(/heater will not fire/));
  it("says nothing at a speed that satisfies both", () =>
    expect(speedNotes(HEATER_MIN_RPM + 100)).toEqual([]));
});

describe("remaining time", () => {
  it("counts down", () => {
    expect(remaining({ endsAt: Date.now() + 60000 })).toBeGreaterThan(50000);
  });
  it("never goes negative", () => {
    expect(remaining({ endsAt: Date.now() - 60000 })).toBe(0);
  });
  it("is null when nothing is running", () => expect(remaining(null)).toBeNull());
});

describe("durations offered", () => {
  it("starts below an hour, because a skim is not an hour", () => {
    expect(Math.min(...DURATIONS.map((d) => d.minutes))).toBeLessThan(60);
  });
  it("stays within the cap", () => {
    expect(Math.max(...DURATIONS.map((d) => d.minutes))).toBeLessThanOrEqual(MAX_MINUTES);
  });
});
