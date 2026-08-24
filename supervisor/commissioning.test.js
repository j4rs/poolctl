// @vitest-environment node
import { describe, it, expect } from "vitest";
import { checkCommissioning, NJSPC_DEFAULT_EGG_TIMER } from "./commissioning.js";
import { SPA_TIMEOUT_MIN } from "../src/lib/sequences.js";

/**
 * The checks that make a silent commissioning fault audible.
 *
 * Written after a spa reverted one minute into a session: the egg timer had
 * been left at a test value, and the screen reported the resulting countdown
 * perfectly accurately without ever suggesting anything was wrong.
 */

const spa = (over) => ({ id: 1, name: "Spa", eggTimer: SPA_TIMEOUT_MIN, dontStop: false, ...over });

describe("the spa egg timer", () => {
  it("says nothing when it matches", () => {
    expect(checkCommissioning({ spaCircuit: spa() })).toEqual([]);
  });

  it("catches the value that caused this", () => {
    const [f] = checkCommissioning({ spaCircuit: spa({ eggTimer: 1 }) });
    expect(f.id).toBe("spa-egg-tiny");
    expect(f.severity).toBe("warn");
    expect(f.what).toMatch(/Spa sessions end after 1 minute/);
    expect(f.detail).toMatch(String(SPA_TIMEOUT_MIN));
  });

  it("talks about the setting, not about what is happening now", () => {
    /* "The spa reverts after 1 minute", read while sitting in pool mode,
       sounds like a live countdown for something nobody started. */
    const [f] = checkCommissioning({ spaCircuit: spa({ eggTimer: 1 }) });
    expect(f.what).toMatch(/^Spa sessions/);
    expect(f.what).not.toMatch(/^The spa reverts/);
  });

  it("gets the plural right, because it will be read by a person", () => {
    const [f] = checkCommissioning({ spaCircuit: spa({ eggTimer: 3 }) });
    expect(f.what).toMatch(/Spa sessions end after 3 minutes/);
  });

  it("catches njsPC's untouched default", () => {
    /* Twelve hours is not a spa session, it is a forgotten one. */
    const [f] = checkCommissioning({ spaCircuit: spa({ eggTimer: NJSPC_DEFAULT_EGG_TIMER }) });
    expect(f.id).toBe("spa-egg-default");
    expect(f.what).toMatch(/12 hours/);
  });

  it("catches a spa set never to stop", () => {
    /* njsPC reads 1440 as `dontStop`, not as twenty-four hours. */
    const [f] = checkCommissioning({ spaCircuit: spa({ eggTimer: 1440 }) });
    expect(f.id).toBe("spa-egg-never");
    expect(f.what).toMatch(/never/);
  });

  it("catches the flag as well as the number", () => {
    const [f] = checkCommissioning({ spaCircuit: spa({ dontStop: true }) });
    expect(f.id).toBe("spa-egg-never");
  });

  it("notes a deliberate-looking difference without calling it wrong", () => {
    /* 90 minutes is a plausible choice. The point is that two numbers now
       describe one fact, and njsPC's is the one that runs. */
    const [f] = checkCommissioning({ spaCircuit: spa({ eggTimer: 90 }) });
    expect(f.id).toBe("spa-egg-differs");
    expect(f.severity).toBe("note");
    expect(f.detail).toMatch(/SPA_TIMEOUT_MIN/);
  });

  it("reports one finding at a time, the most serious", () => {
    /* Three notices about the same setting is noise, and the operator only
       has one thing to change. */
    expect(checkCommissioning({ spaCircuit: spa({ eggTimer: 1440 }) })).toHaveLength(1);
    expect(checkCommissioning({ spaCircuit: spa({ eggTimer: 1 }) })).toHaveLength(1);
  });

  it("says nothing when njsPC could not be read", () => {
    /* Not knowing is not the same as knowing something is wrong. */
    expect(checkCommissioning({})).toEqual([]);
    expect(checkCommissioning({ spaCircuit: null })).toEqual([]);
    expect(checkCommissioning()).toEqual([]);
  });

  it("says nothing about a circuit with no egg timer reported", () => {
    expect(checkCommissioning({ spaCircuit: spa({ eggTimer: undefined }) })).toEqual([]);
  });
});
