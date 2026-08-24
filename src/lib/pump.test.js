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
