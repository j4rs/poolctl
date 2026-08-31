import { describe, it, expect } from "vitest";
import { applyTarget, ceilingFor, applySetpoint } from "./targets.js";
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

/**
 * The heater's own setpoint is a second, lower ceiling.
 *
 * A target above it is inert: the water stops at whichever cutoff comes
 * first, and the heater's always wins. The stepper used to offer those
 * degrees anyway, with nothing to say they did nothing — the 3-wire carries
 * no reading back, so the UI could not have known unless someone told it.
 */
describe("the ceiling a stated heater setpoint imposes", () => {
  it("falls back to the firmware cap when nobody has stated one", () => {
    /* `Number(null)` is 0, so a careless implementation returns the floor
       here and pins every target to 70. That shipped for about four
       minutes. */
    expect(ceilingFor("pool", null)).toBe(HEATER_CAP.pool);
    expect(ceilingFor("spa", undefined)).toBe(HEATER_CAP.spa);
  });

  it("takes the setpoint when it is lower than the cap", () => {
    expect(ceilingFor("pool", 90)).toBe(90);
    expect(ceilingFor("spa", 100)).toBe(100);
  });

  it("never lets a stated setpoint exceed the firmware cap", () => {
    /* Someone mistyping 105 does not raise what the heater will do. */
    expect(ceilingFor("pool", 120)).toBe(HEATER_CAP.pool);
    expect(applySetpoint("spa", 200)).toBe(HEATER_CAP.spa);
  });

  it("clamps a target to the setpoint, not just to the cap", () => {
    /* The live rig on 30 August: pool setpoint 90, so 95 is unreachable. */
    expect(applyTarget(88, "pool", { degrees: 95 }, 90)).toBe(90);
    let v = 88;
    for (let i = 0; i < 20; i++) v = applyTarget(v, "pool", { delta: +1 }, 90);
    expect(v).toBe(90);
  });

  it("still honours the floor when a setpoint is stated", () => {
    expect(applyTarget(75, "pool", { degrees: 40 }, 90)).toBe(TARGET_MIN.pool);
  });

  it("clears back to unstated", () => {
    expect(applySetpoint("pool", null)).toBeNull();
    expect(ceilingFor("pool", applySetpoint("pool", null))).toBe(HEATER_CAP.pool);
  });

  it("rejects a non-number rather than storing it", () => {
    expect(() => applySetpoint("pool", "warm")).toThrow();
    expect(() => applySetpoint("hottub", 90)).toThrow(/unknown body/);
  });
});
