import { describe, it, expect } from "vitest";
import {
  floorRpm, bypassFor, mayCallForHeat, mayToggleBlower, shouldStopHeat, needsPurge,
} from "./interlocks.js";
import { HEATER_MIN_RPM } from "../src/lib/sequences.js";

describe("pump floor under a live heat call", () => {
  it("raises a too-slow request to the heater's minimum", () => {
    expect(floorRpm(900, "spa")).toEqual({ rpm: HEATER_MIN_RPM, clamped: true });
  });
  it("leaves an adequate speed alone", () => {
    expect(floorRpm(2800, "spa")).toEqual({ rpm: 2800, clamped: false });
  });
  it("imposes no floor when no heat is called", () => {
    expect(floorRpm(900, "off")).toEqual({ rpm: 900, clamped: false });
  });
  it("clamps rather than dropping the heat call", () => {
    /* The alternative — honouring the speed and stopping the heat — is the
       worse surprise, and the UI is built on this choice. */
    expect(floorRpm(450, "pool").rpm).toBe(HEATER_MIN_RPM);
  });
  it("rejects a non-number", () => {
    expect(() => floorRpm(undefined, "off")).toThrow();
  });
});

describe("bypass policy", () => {
  it("flows in spa mode", () => expect(bypassFor("spa", false)).toBe("flow"));
  it("is around in pool mode at rest", () => expect(bypassFor("pool", false)).toBe("around"));
  it("flows when pool heat is demanded", () => expect(bypassFor("pool", true)).toBe("flow"));
  it("stays flowing in spa regardless of pool demand", () =>
    expect(bypassFor("spa", true)).toBe("flow"));
});

describe("heat call requires flow through the exchanger", () => {
  it("permits a call when the bypass is open", () => expect(mayCallForHeat("flow")).toBe(true));
  it("refuses a call into a bypassed exchanger", () => {
    /* Binary valve: 'around' is zero flow, not reduced flow. */
    expect(mayCallForHeat("around")).toBe(false);
  });
});

describe("blower gate", () => {
  it("refuses to start the blower outside spa mode", () =>
    expect(mayToggleBlower({ turningOn: true, mode: "pool" })).toBe(false));
  it("allows it in spa mode", () =>
    expect(mayToggleBlower({ turningOn: true, mode: "spa" })).toBe(true));
  it("always allows stopping it, whatever the mode", () => {
    /* On and unreachable is the state the project rules out. */
    expect(mayToggleBlower({ turningOn: false, mode: "pool" })).toBe(true);
    expect(mayToggleBlower({ turningOn: false, mode: "spa" })).toBe(true);
  });
});

describe("targets as cutoffs", () => {
  it("stops the call at the target", () =>
    expect(shouldStopHeat({ waterTemp: 102, target: 102 })).toBe(true));
  it("keeps calling below it", () =>
    expect(shouldStopHeat({ waterTemp: 99.5, target: 102 })).toBe(false));
  it("never cuts heat on an unknown temperature", () => {
    /* The heater is still governing itself against its own sensor; guessing
       here would stop heat for a reading we never had. */
    expect(shouldStopHeat({ waterTemp: null, target: 102 })).toBe(false);
    expect(shouldStopHeat({ waterTemp: 90, target: null })).toBe(false);
  });
});

describe("conditional purge", () => {
  it("purges when the compressor has just run", () =>
    expect(needsPurge({ compressorIdleMin: 0 })).toBe(true));
  it("skips it once the compressor has been idle", () =>
    expect(needsPurge({ compressorIdleMin: 30 })).toBe(false));
  it("purges when it cannot tell", () => {
    /* Unknown means purge: the cost is three minutes, the risk is pushing
       hot water through a stopped exchanger. */
    expect(needsPurge({ compressorIdleMin: null })).toBe(true);
  });
});
