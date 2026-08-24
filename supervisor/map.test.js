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

  it("maps valve positions and keeps bypass supervisor-owned", () => {
    const ui = toUiState({
      valveMode: { name: "spa" },
      valves: [
        { id: 1, isIntake: true, isDiverted: true },
        { id: 2, isReturn: true, isDiverted: true },
      ],
    }, own);
    expect(ui.mode).toBe("spa");
    expect(ui.valves).toEqual({ intake: "spa", returns: "spa", bypass: "around" });
  });

  it("does not report a heat call while the heater is cooling down", () => {
    const ui = toUiState({
      valveMode: { name: "spa" },
      temps: { bodies: [{ id: 1, isOn: true, heatStatus: { name: "cooldown" } }] },
    }, own);
    expect(ui.heaterCall).toBe("off");
  });
});
