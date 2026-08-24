import { describe, it, expect } from "vitest";
import { applyTarget } from "./targets.js";
import { HEATER_CAP, TARGET_MIN } from "../src/lib/sequences.js";

/**
 * ADR-4's guarantee. This clamp was absent from the supervisor entirely —
 * only the mock enforced it, so the live path would have accepted 200 °F.
 * These are the cases that would have caught that.
 */
describe("target clamping", () => {
  it("never exceeds the heater's cap, however many raises arrive", () => {
    let v = 102;
    for (let i = 0; i < 50; i++) v = applyTarget(v, "spa", { delta: +1 });
    expect(v).toBe(HEATER_CAP.spa);
  });

  it("never falls below the floor", () => {
    let v = 88;
    for (let i = 0; i < 50; i++) v = applyTarget(v, "pool", { delta: -1 });
    expect(v).toBe(TARGET_MIN.pool);
  });

  it("clamps an absolute set, not just deltas", () => {
    expect(applyTarget(102, "spa", { degrees: 200 })).toBe(HEATER_CAP.spa);
    expect(applyTarget(88, "pool", { degrees: -40 })).toBe(TARGET_MIN.pool);
  });

  it("accumulates deltas rather than losing them", () => {
    let v = 90;
    for (const d of [+1, +1, +1, -1]) v = applyTarget(v, "pool", { delta: d });
    expect(v).toBe(92);
  });

  it("rejects a non-number instead of storing it", () => {
    /* The exact regression: an updater function crossed JSON as undefined,
       was stored, and blanked the reading. */
    expect(() => applyTarget(102, "spa", { degrees: undefined })).toThrow();
    expect(() => applyTarget(102, "spa", { degrees: NaN })).toThrow();
  });

  it("rejects an unknown body", () => {
    expect(() => applyTarget(90, "hottub", { delta: 1 })).toThrow(/unknown body/);
  });
});
