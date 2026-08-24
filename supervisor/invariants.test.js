// @vitest-environment node
import { describe, it, expect } from "vitest";
import { checkInvariants } from "./invariants.js";
import { HEATER_MIN_RPM } from "../src/lib/sequences.js";

/**
 * Half of these assert that nothing is reported. That is the point: a monitor
 * that cries on absent data is noise within a day, and noise is how a safety
 * display teaches people to ignore it.
 */

const ok = {
  mode: "pool",
  heaterCall: "off",
  pumpRpm: 1600,
  pumpHeldOff: false,
  blower: false,
  spaExpiresAt: null,
  valves: { intake: "pool", returns: "split", bypass: "around" },
};

const ids = (s) => checkInvariants(s).map((v) => v.id);

describe("a system behaving itself", () => {
  it("says nothing", () => {
    expect(checkInvariants(ok)).toEqual([]);
  });

  it("says nothing about a healthy heat call", () => {
    expect(checkInvariants({
      ...ok, heaterCall: "pool", pumpRpm: 2400,
      valves: { ...ok.valves, bypass: "flow" },
    })).toEqual([]);
  });

  it("says nothing when handed nothing", () => {
    expect(checkInvariants(null)).toEqual([]);
    expect(checkInvariants(undefined)).toEqual([]);
  });
});

describe("heat without flow", () => {
  it("catches a call below the heater's minimum", () => {
    const v = checkInvariants({
      ...ok, heaterCall: "pool", pumpRpm: HEATER_MIN_RPM - 1,
      valves: { ...ok.valves, bypass: "flow" },
    });
    expect(v.map((x) => x.id)).toContain("heat-below-floor");
    expect(v[0].detail).toContain(String(HEATER_MIN_RPM));
  });

  it("accepts exactly the minimum", () => {
    expect(ids({
      ...ok, heaterCall: "pool", pumpRpm: HEATER_MIN_RPM,
      valves: { ...ok.valves, bypass: "flow" },
    })).toEqual([]);
  });

  it("says nothing when the pump is not reporting a speed", () => {
    /* Null is a pump we cannot hear from, not a pump running slowly. This is
       the state the whole rig is in today, so getting it wrong would mean a
       permanent false alarm. */
    expect(ids({
      ...ok, heaterCall: "pool", pumpRpm: null,
      valves: { ...ok.valves, bypass: "flow" },
    })).toEqual([]);
  });

  it("says nothing while njsPC is holding the pump off on purpose", () => {
    /* A valve delay stops the pump by design. Reporting that as a breach
       would fire on every single mode change. */
    expect(ids({
      ...ok, heaterCall: "pool", pumpRpm: 0, pumpHeldOff: true,
      valves: { ...ok.valves, bypass: "flow" },
    })).toEqual([]);
  });
});

describe("heat into a bypassed exchanger", () => {
  it("catches a call with the bypass around", () => {
    expect(ids({ ...ok, heaterCall: "pool", pumpRpm: 2400 })).toContain("heat-into-bypass");
  });

  it("catches it in spa mode too", () => {
    expect(ids({
      ...ok, mode: "spa", heaterCall: "spa", pumpRpm: 2800,
      spaExpiresAt: Date.now() + 3600e3,
    })).toContain("heat-into-bypass");
  });

  it("says nothing once the bypass is in flow", () => {
    expect(ids({
      ...ok, heaterCall: "pool", pumpRpm: 2400,
      valves: { ...ok.valves, bypass: "flow" },
    })).toEqual([]);
  });

  it("says nothing about a bypassed exchanger with no call", () => {
    /* Bypassed and idle is the normal resting state of this pool. */
    expect(ids(ok)).toEqual([]);
  });
});

describe("the stranded blower", () => {
  it("catches a blower running in pool mode", () => {
    /* Preference, not safety — but its switch only exists in spa mode, so
       nothing on the screen can reach it. */
    expect(ids({ ...ok, blower: true })).toContain("blower-outside-spa");
  });

  it("says nothing about a blower in spa mode", () => {
    expect(ids({
      ...ok, mode: "spa", blower: true, spaExpiresAt: Date.now() + 3600e3,
    })).toEqual([]);
  });
});

describe("a spa session with no end", () => {
  it("catches spa mode with no expiry reported", () => {
    expect(ids({ ...ok, mode: "spa" })).toContain("spa-without-expiry");
  });

  it("says nothing when njsPC reports an end time", () => {
    expect(ids({ ...ok, mode: "spa", spaExpiresAt: Date.now() + 3600e3 })).toEqual([]);
  });
});

describe("reporting several at once", () => {
  it("does not stop at the first", () => {
    /* Heat called, into a bypass, below the floor, with a stranded blower.
       An operator needs all of it, not the alphabetically first. */
    const v = ids({ ...ok, heaterCall: "pool", pumpRpm: 800, blower: true });
    expect(v).toEqual(
      expect.arrayContaining(["heat-below-floor", "heat-into-bypass", "blower-outside-spa"]),
    );
  });

  it("marks everything it finds as an alarm", () => {
    /* Distinct from commissioning findings: those describe a setting, these
       describe equipment misbehaving now. */
    const v = checkInvariants({ ...ok, heaterCall: "pool", pumpRpm: 800 });
    expect(v.every((x) => x.severity === "alarm")).toBe(true);
  });
});
