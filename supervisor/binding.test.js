// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  circuitConfig, echoCircuitConfig, whyNotBindable, withPumpCircuit,
  withoutPumpCircuit, pumpLimits, freeSlots, GENERIC_CIRCUIT, RPM_UNITS,
  DONT_STOP_MINUTES,
} from "./binding.js";

/**
 * The decisions behind binding a program, separated from the writes that
 * carry them out.
 *
 * Most of what is asserted here is a fact about njsPC rather than a
 * preference of ours, and each one was read out of njsPC 10.0.1 rather than
 * guessed. Where a test looks arbitrary the comment says which line of njsPC
 * makes it so.
 */

const limits = { pumpId: 50, minSpeed: 450, maxSpeed: 3450, maxCircuits: 8, used: 2 };
const program = { id: "skimming", name: "Skimming", rpm: 2100, minutes: 30, circuit: null };

describe("the circuit payload", () => {
  it("asks njsPC to allocate an id for an unbound program", () => {
    /* `NixieBoard.setCircuitAsync` treats id <= 0 as "pick one", and excludes
       1 and 6 explicitly — so this cannot land on the Spa or Pool circuit. */
    expect(circuitConfig(program).id).toBe(0);
  });

  it("updates in place once the program has one", () => {
    expect(circuitConfig({ ...program, circuit: 4 }).id).toBe(4);
  });

  it("carries the expiry as njsPC's egg timer", () => {
    expect(circuitConfig(program).eggTimer).toBe(30);
  });

  it("is a generic circuit, not a body", () => {
    /* Pool (12) and Spa (13) carry a body: a skim cycle would switch the
       pool over. A program drives the pump and nothing else. */
    expect(circuitConfig(program).type).toBe(GENERIC_CIRCUIT);
    expect(GENERIC_CIRCUIT).toBe(0);
  });

  it("stays out of the feature list", () => {
    expect(circuitConfig(program).showInFeatures).toBe(false);
  });
});

describe("what cannot be bound", () => {
  it("accepts a sound program", () => {
    expect(whyNotBindable(program, limits)).toBeNull();
  });

  it("refuses when njsPC has no pump", () => {
    /* Not an error — it is the state the system sits in until the hardware
       is commissioned, and the message is what the operator reads. */
    expect(whyNotBindable(program, null)).toMatch(/no pump/);
  });

  it("refuses a speed the pump cannot reach", () => {
    expect(whyNotBindable({ ...program, rpm: 5000 }, limits)).toMatch(/450–3450/);
    expect(whyNotBindable({ ...program, rpm: 100 }, limits)).toMatch(/450–3450/);
  });

  it("accepts the exact endpoints", () => {
    expect(whyNotBindable({ ...program, rpm: 450 }, limits)).toBeNull();
    expect(whyNotBindable({ ...program, rpm: 3450 }, limits)).toBeNull();
  });

  it("refuses an expiry njsPC reads as 'never stop'", () => {
    /* 1440 is not twenty-four hours to njsPC — `setCircuitAsync` sets
       `dontStop` from it, and the circuit then never expires on its own. A
       manual program that never stops is the thing the expiry exists to
       prevent. */
    expect(whyNotBindable({ ...program, minutes: DONT_STOP_MINUTES }, limits)).toMatch(
      /never stop/,
    );
  });

  it("refuses a program with no expiry at all", () => {
    expect(whyNotBindable({ ...program, minutes: 0 }, limits)).toMatch(/expiry/);
  });

  it("refuses a nameless program — the name is the circuit's name", () => {
    expect(whyNotBindable({ ...program, name: "  " }, limits)).toMatch(/name/);
  });

  it("refuses a program with no speed", () => {
    expect(whyNotBindable({ ...program, rpm: undefined }, limits)).toMatch(/speed/);
  });
});

describe("the pump's circuit list", () => {
  const pump = {
    id: 50,
    circuits: [
      { id: 1, circuit: 6, speed: 1600, units: 0 },
      { id: 2, circuit: 1, speed: 2800, units: 0 },
    ],
  };

  it("appends a new circuit", () => {
    const out = withPumpCircuit(pump, { circuit: 2, speed: 2100 }, limits);
    expect(out).toHaveLength(3);
    expect(out.at(-1)).toMatchObject({ circuit: 2, speed: 2100, units: RPM_UNITS });
  });

  it("keeps every circuit it was given", () => {
    /* The whole reason this returns a complete list: `NixiePump.setPumpAsync`
       assigns the body over the pump rather than merging, and blanks
       `circuits` outright when the key is missing. A partial write deletes
       the speeds the schedules run on. */
    const out = withPumpCircuit(pump, { circuit: 2, speed: 2100 }, limits);
    expect(out.map((c) => c.circuit)).toEqual([6, 1, 2]);
    expect(out.find((c) => c.circuit === 6).speed).toBe(1600);
    expect(out.find((c) => c.circuit === 1).speed).toBe(2800);
  });

  it("updates a circuit it already carries instead of duplicating it", () => {
    const once = withPumpCircuit(pump, { circuit: 6, speed: 1900 }, limits);
    expect(once).toHaveLength(2);
    expect(once.find((c) => c.circuit === 6).speed).toBe(1900);
  });

  it("does not mutate the pump it was handed", () => {
    /* The caller sends this object back to njsPC; editing it in place would
       make a failed write look like it had happened. */
    withPumpCircuit(pump, { circuit: 6, speed: 1900 }, limits);
    expect(pump.circuits.find((c) => c.circuit === 6).speed).toBe(1600);
  });

  it("refuses once the pump is full", () => {
    const full = { circuits: Array.from({ length: 8 }, (_, i) => ({ circuit: i + 10, speed: 1000 })) };
    expect(() => withPumpCircuit(full, { circuit: 99, speed: 2000 }, limits)).toThrow(/8/);
  });

  it("still updates an existing circuit on a full pump", () => {
    /* Capacity is about adding. Changing the speed of one already there
       costs nothing and must not be refused. */
    const full = { circuits: Array.from({ length: 8 }, (_, i) => ({ circuit: i + 10, speed: 1000 })) };
    expect(withPumpCircuit(full, { circuit: 12, speed: 2000 }, limits)).toHaveLength(8);
  });

  it("removes a circuit and leaves the rest", () => {
    const out = withoutPumpCircuit(pump, 6);
    expect(out.map((c) => c.circuit)).toEqual([1]);
  });

  it("is a no-op for a circuit the pump does not carry", () => {
    expect(withoutPumpCircuit(pump, 99)).toHaveLength(2);
  });

  it("copes with a pump that has no circuits at all", () => {
    expect(withPumpCircuit({}, { circuit: 2, speed: 2100 }, limits)).toHaveLength(1);
    expect(withoutPumpCircuit(undefined, 2)).toEqual([]);
  });
});

describe("reading the pump's limits out of njsPC state", () => {
  const njs = {
    pumps: [{
      id: 50, isActive: true, minSpeed: 450, maxSpeed: 3450,
      type: { val: 4, name: "vsf", minSpeed: 450, maxSpeed: 3450, maxCircuits: 8 },
      circuits: [{ circuit: 6 }, { circuit: 1 }],
    }],
  };

  it("reports the pump, its range and its capacity", () => {
    expect(pumpLimits(njs)).toEqual({
      pumpId: 50, minSpeed: 450, maxSpeed: 3450, maxCircuits: 8, used: 2,
    });
  });

  it("prefers the pump's own range over its type's", () => {
    /* `NixiePumpVS.setTargetSpeed` clamps against `this.pump.minSpeed`, so
       the instance is what would apply. */
    const derated = structuredClone(njs);
    derated.pumps[0].minSpeed = 1000;
    expect(pumpLimits(derated).minSpeed).toBe(1000);
  });

  it("falls back to the type when the pump does not say", () => {
    const bare = structuredClone(njs);
    delete bare.pumps[0].minSpeed;
    delete bare.pumps[0].maxSpeed;
    expect(pumpLimits(bare)).toMatchObject({ minSpeed: 450, maxSpeed: 3450 });
  });

  it("reports nothing at all when njsPC has no pump", () => {
    /* Null, not zeroes. Before commissioning there is genuinely nothing to
       bind to, and a fabricated range would be worse than an absent one. */
    expect(pumpLimits({ pumps: [] })).toBeNull();
    expect(pumpLimits({})).toBeNull();
    expect(pumpLimits(undefined)).toBeNull();
  });

  it("ignores a pump njsPC has deactivated", () => {
    expect(pumpLimits({ pumps: [{ ...njs.pumps[0], isActive: false }] })).toBeNull();
  });

  it("survives a pump whose type has not been expanded", () => {
    const flat = structuredClone(njs);
    flat.pumps[0].type = 4;
    expect(pumpLimits(flat).maxCircuits).toBeNull();
  });

  it("counts free slots, and refuses to guess when it cannot", () => {
    expect(freeSlots(pumpLimits(njs))).toBe(6);
    expect(freeSlots({ maxCircuits: null, used: 2 })).toBeNull();
    expect(freeSlots(null)).toBeNull();
  });
});

describe("echoing a circuit's configuration back", () => {
  /**
   * The mechanism behind extending a spa session. Writing a circuit's config
   * back unchanged is the only way to make njsPC recompute a *running*
   * circuit's end time: `setEndTime` fires on an off→on transition or when
   * `bForce` is set, and a config write is the one caller that sets it.
   */
  const spa = { id: 1, name: "Spa", type: 13, eggTimer: 120, showInFeatures: false, freeze: false };

  it("sends the circuit back exactly as it was", () => {
    expect(echoCircuitConfig(spa)).toEqual(spa);
  });

  it("never omits showInFeatures", () => {
    /* njsPC's guard on this field is `typeof x !== 'undefined' || typeof x
       === 'undefined'` — always true — so the field is written from the
       request every time and omitting it silently sets it false. */
    expect(echoCircuitConfig(spa)).toHaveProperty("showInFeatures", false);
    expect(echoCircuitConfig({ ...spa, showInFeatures: true }).showInFeatures).toBe(true);
  });

  it("keeps the egg timer, which is the value the new end time is built from", () => {
    expect(echoCircuitConfig({ ...spa, eggTimer: 90 }).eggTimer).toBe(90);
  });

  it("unwraps an expanded type, which state sends and config does not", () => {
    expect(echoCircuitConfig({ ...spa, type: { val: 13, name: "spa" } }).type).toBe(13);
  });

  it("coerces absent flags rather than passing undefined through", () => {
    const out = echoCircuitConfig({ id: 1, name: "Spa", type: 13, eggTimer: 120 });
    expect(out.showInFeatures).toBe(false);
    expect(out.freeze).toBe(false);
  });
});
