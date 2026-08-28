import { describe, it, expect } from "vitest";
import { toUiState } from "./map.js";

const own = {
  bypass: "around", targets: { pool: 88, spa: 102 }, poolHeatDemand: false,
  connected: true, lastSeen: Date.now(),
};

/**
 * The translation layer, where every unknown-vs-zero bug has lived.
 *
 * A pump at 0 rpm is stopped. A pump we cannot hear from might be doing
 * anything. Collapsing the two here makes the difference unrecoverable
 * everywhere above, so these assertions are about `null` specifically.
 */
describe("njsPC -> UI state", () => {
  it("reports unknown as null when njsPC has no hardware to answer for", () => {
    const ui = toUiState({}, own);
    for (const k of ["pumpRpm", "pumpWatts", "waterTemp", "airTemp", "saltPpm", "cellOutput", "setpoint"]) {
      expect(ui[k], `${k} must be null, not a fabricated reading`).toBeNull();
    }
  });

  it("does not turn an absent pump into a stopped one", () => {
    expect(toUiState({ pumps: [{ id: 1 }] }, own).pumpRpm).toBeNull();
  });

  it("passes a real zero through as a real zero", () => {
    /* Once a pump answers, 0 rpm is a fact and must survive. */
    expect(toUiState({ pumps: [{ id: 1, rpm: 0 }] }, own).pumpRpm).toBe(0);
  });

  it("treats njsPC's setPoint of 0 as unset", () => {
    const ui = toUiState({ temps: { bodies: [{ id: 1, isOn: true, setPoint: 0 }] } }, own);
    expect(ui.setpoint).toBeNull();
  });

  it("separates what the pump reports from what it was asked for", () => {
    /* njsPC puts telemetry in `rpm` and nothing else. A commanded speed with
       no reading is a pump that is not answering — a wiring fault — and must
       not look the same as an idle pump. */
    const ui = toUiState({
      pumps: [{ id: 1, circuits: [{ speed: 1600, circuit: { id: 6, isOn: true } }] }],
    }, own);
    expect(ui.pumpRpm).toBeNull();
    expect(ui.pumpCommandedRpm).toBe(1600);
  });

  it("commands nothing when no pump circuit is on", () => {
    const ui = toUiState({
      pumps: [{ id: 1, circuits: [{ speed: 1600, circuit: { id: 6, isOn: false } }] }],
    }, own);
    expect(ui.pumpCommandedRpm).toBeNull();
  });

  it("maps valve positions and derives the bypass from the mode", () => {
    /* `own.bypass` here is "around" — pool's resting position — and must not
       survive into spa. ADR-9: the bypass follows the mode. */
    const ui = toUiState({
      valveMode: { name: "spa" },
      valves: [
        { id: 1, isIntake: true, isDiverted: true },
        { id: 2, isReturn: true, isDiverted: true },
      ],
    }, own);
    expect(ui.mode).toBe("spa");
    expect(ui.valves).toEqual({ intake: "spa", returns: "spa", bypass: "flow" });
  });

  it("follows a body change njsPC made on its own", () => {
    /* The bug this replaced, measured on the card: the spa circuit was driven
       straight through njsPC's API, so no intent of ours ran, the stored
       bypass stayed at "around", and the byte came out 0x65 — spa valves, spa
       heat call, and the exchanger bypassed. A heat call at zero flow.

       A schedule or an egg timer does exactly what that API call did, so this
       is not a test-only path. */
    const ui = toUiState({ valveMode: { name: "spa" } }, { ...own, bypass: "around" });
    expect(ui.valves.bypass).toBe("flow");
    expect(ui.heaterCall).toBe("spa");
  });

  it("keeps the exchanger isolated in pool with no call", () => {
    const ui = toUiState({ valveMode: { name: "pool" } }, { ...own, bypass: "flow" });
    expect(ui.valves.bypass).toBe("around");
    expect(ui.heaterCall).toBe("off");
  });

  it("opens the bypass for a pool heat call", () => {
    const ui = toUiState({ valveMode: { name: "pool" } },
      { ...own, poolHeatDemand: true, bypass: "around" });
    expect(ui.valves.bypass).toBe("flow");
    expect(ui.heaterCall).toBe("pool");
  });

});

/**
 * `heaterCall` is what the heat contacts follow, so it has to describe what
 * this process is commanding — not what njsPC believes.
 *
 * njsPC's heater has no device binding, so it actuates nothing; its
 * `heatStatus` is an opinion about a heater it cannot reach. These tests pin
 * that the opinion never reaches a relay.
 */
describe("who owns the heat call", () => {
  const heating = { temps: { bodies: [{ id: 1, isOn: true, heatStatus: { name: "heater" } }] } };

  it("calls for spa whenever the spa is the active body", () => {
    /* The contact carries no temperature. It says "you may heat toward the
       spa setpoint"; the Raypak regulates and caps at 104 (ADR-4). */
    expect(toUiState({ valveMode: { name: "spa" } }, own).heaterCall).toBe("spa");
  });

  it("calls for pool only when somebody asked", () => {
    expect(toUiState({ valveMode: { name: "pool" } }, own).heaterCall).toBe("off");
    expect(toUiState({ valveMode: { name: "pool" } },
      { ...own, poolHeatDemand: true }).heaterCall).toBe("pool");
  });

  it("ignores njsPC claiming to heat when nobody asked", () => {
    /* The case that would close a contact on somebody else's authority. */
    expect(toUiState({ valveMode: { name: "pool" }, ...heating }, own).heaterCall).toBe("off");
  });

  it("still reports njsPC's own status alongside it", () => {
    /* Kept for the Heat screen and for diagnostics — it is just not wired to
       anything that moves. */
    const ui = toUiState({ valveMode: { name: "pool" }, ...heating }, own);
    expect(ui.heatStatus).toBe("heater");
    expect(ui.heaterCall).toBe("off");
  });
});
