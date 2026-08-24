import { describe, it, expect } from "vitest";
import {
  SEQUENCES, INVARIANTS, isSkipped, stepsFor, HEATER_CAP, TARGET_MIN,
  HEATER_MIN_RPM, VALVE_RPM, ABORTABLE,
} from "./sequences";

/**
 * This file is the spec the supervisor must implement, so these tests are
 * less about catching typos than about pinning the properties other code
 * relies on — and failing loudly if a step list is edited in a way that
 * breaks them.
 */
const ctx = (over = {}) => ({
  valves: { intake: "pool", returns: "split", bypass: "around" },
  pumpRpm: 1600, poolHeatDemand: false, compressorIdleMin: Infinity, ...over,
});

describe("sequence structure", () => {
  it("defines the five named sequences", () => {
    expect(Object.keys(SEQUENCES).sort())
      .toEqual(["boot", "heatEngage", "heatRelease", "pool", "spa"]);
  });

  it("gives every step an id, a label and a duration", () => {
    for (const [name, steps] of Object.entries(SEQUENCES)) {
      for (const s of steps) {
        expect(s.id, `${name} step missing id`).toBeTruthy();
        expect(s.label, `${name}/${s.id} missing label`).toBeTruthy();
        expect(typeof s.ms, `${name}/${s.id} missing ms`).toBe("number");
      }
    }
  });

  it("never moves two valves in the same step", () => {
    const valveStep = /^(intake|returns|bypass)-/;
    for (const [name, steps] of Object.entries(SEQUENCES)) {
      const moves = steps.filter((s) => valveStep.test(s.id));
      expect(new Set(moves.map((s) => s.id)).size, `${name} repeats a valve move`)
        .toBe(moves.length);
    }
  });
});

describe("skip conditions", () => {
  it("skips the purge when the compressor has been idle", () => {
    const purge = SEQUENCES.spa.find((s) => s.id === "purge");
    expect(isSkipped(purge, ctx({ compressorIdleMin: 30 }))).toBe(true);
    expect(isSkipped(purge, ctx({ compressorIdleMin: 0 }))).toBe(false);
  });

  it("skips a valve move that is already in position", () => {
    const toFlow = SEQUENCES.spa.find((s) => s.id === "bypass-flow");
    expect(isSkipped(toFlow, ctx({ valves: { bypass: "flow" } }))).toBe(true);
    expect(isSkipped(toFlow, ctx())).toBe(false);
  });

  it("keeps the bypass open when pool heat is demanded", () => {
    const around = SEQUENCES.pool.find((s) => s.id === "bypass-around");
    expect(isSkipped(around, ctx({ poolHeatDemand: true }))).toBe(true);
  });

  it("re-drives everything on boot, skipping nothing", () => {
    /* The whole point of the boot sequence: dead-reckoned position is not
       trusted across a restart, so no step may be optimised away. */
    for (const s of stepsFor("boot", ctx({ valves: { intake: "pool", returns: "split", bypass: "around" } }))) {
      expect(s.skipped, `boot step ${s.id} was skipped`).toBe(false);
    }
  });
});

describe("spec invariants", () => {
  it("states both directions of the bypass rule", () => {
    const text = INVARIANTS.join(" | ");
    expect(text).toMatch(/heaterCall !== 'off' implies valves\.bypass === 'flow'/);
    expect(text).toMatch(/valves\.bypass === 'around' implies heaterCall === 'off'/);
  });

  it("keeps the heater caps at the heater's own firmware limits", () => {
    /* ADR-4. If these ever move, the clamp moves with them, and that is a
       decision rather than an edit. */
    expect(HEATER_CAP).toEqual({ pool: 95, spa: 104 });
    expect(TARGET_MIN.spa).toBeLessThan(HEATER_CAP.spa);
    expect(TARGET_MIN.pool).toBeLessThan(HEATER_CAP.pool);
  });

  it("moves valves below the heater's minimum flow", () => {
    expect(VALVE_RPM).toBeLessThan(HEATER_MIN_RPM);
  });

  it("does not permit aborting a transition", () => {
    expect(ABORTABLE).toBe(false);
  });
});
