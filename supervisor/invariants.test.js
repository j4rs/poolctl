// @vitest-environment node
import { describe, it, expect } from "vitest";
import { checkInvariants, driftBreaches } from "./invariants.js";
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

/**
 * The relay card not holding what it was told.
 *
 * This is the only fault in the system the supervisor both reports *and*
 * corrects. Re-asserting our own decision is not reaching into equipment on
 * the strength of a snapshot — it is making the card agree with a decision
 * already taken — but the reporting still has to survive the correction.
 */
describe("relay drift", () => {
  it("says nothing when the card has always agreed", () => {
    expect(driftBreaches(null, 0)).toEqual([]);
  });

  it("alarms, with both bytes, while the card disagrees", () => {
    const [v] = driftBreaches({ expected: 0x40, actual: 0x02 }, 1);
    expect(v.severity).toBe("alarm");
    expect(v.detail).toMatch(/0x02/);
    expect(v.detail).toMatch(/0x40/);
  });

  it("keeps saying so after the correction, which is the point", () => {
    /* Found by testing on the Pi: the alarm cleared on the next pass, so a
       self-healing fault showed for under five seconds and then vanished —
       indistinguishable from never having happened. */
    const [v] = driftBreaches(null, 1);
    expect(v).toBeTruthy();
    expect(v.id).toBe("relay-drift-history");
    expect(v.severity).toBe("warn");
    expect(v.what).toMatch(/once/);
  });

  it("counts repeats, because twice is a different problem from once", () => {
    expect(driftBreaches(null, 4)[0].what).toMatch(/4 times/);
  });

  it("prefers the live alarm over the history when both apply", () => {
    /* A card that is wrong right now is not a footnote about the past. */
    const out = driftBreaches({ expected: 0x00, actual: 0x80 }, 3);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("relay-drift");
  });
});
