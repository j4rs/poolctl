import { describe, it, expect } from "vitest";
import {
  floorRpm, bypassFor, mayCallForHeat, mayToggleBlower, shouldStopHeat,
  purgeRemainingMs, bypassHeld,
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

/**
 * The purge.
 *
 * The half of "bypass may only move when heaterCall === 'off' and purge has
 * elapsed" that nothing kept: releasing pool heat used to swing the bypass to
 * `around` in the same tick, closing a valve on an exchanger that had been
 * firing a moment earlier.
 */
describe("holding flow after a heat call", () => {
  const MIN = 60_000;
  const t0 = 1_700_000_000_000;

  it("holds for the full window after a call ends", () => {
    expect(purgeRemainingMs(t0, t0, 3)).toBe(3 * MIN);
    expect(purgeRemainingMs(t0, t0 + 1 * MIN, 3)).toBe(2 * MIN);
  });

  it("is done once the window has passed, and does not go negative", () => {
    expect(purgeRemainingMs(t0, t0 + 3 * MIN, 3)).toBe(0);
    expect(purgeRemainingMs(t0, t0 + 90 * MIN, 3)).toBe(0);
  });

  it("holds nothing when no call has ever ended", () => {
    /* Distinct from "the purge finished". A supervisor that has never called
       for heat has no exchanger to empty. */
    expect(purgeRemainingMs(null, t0, 3)).toBe(0);
    expect(purgeRemainingMs(undefined, t0, 3)).toBe(0);
  });

  it("subsumes the skip-when-idle condition rather than needing it", () => {
    /* PURGE_MIN is below PURGE_SKIP_AFTER_MIN by design: a call that ended
       more than five minutes ago also ended more than three minutes ago. The
       old needsPurge() boolean asked a question this already answers. */
    expect(purgeRemainingMs(t0, t0 + 5 * MIN, 3)).toBe(0);
  });
});

describe("the bypass position the purge permits", () => {
  it("delays isolating the exchanger while the purge holds", () => {
    expect(bypassHeld("around", true)).toBe("flow");
  });

  it("permits it once the purge is done", () => {
    expect(bypassHeld("around", false)).toBe("around");
  });

  it("never delays a move toward the heater", () => {
    /* The direction that matters. A heat call waiting three minutes for a
       valve it already needs would be a bug wearing an interlock's clothes. */
    expect(bypassHeld("flow", true)).toBe("flow");
    expect(bypassHeld("flow", false)).toBe("flow");
  });
});

