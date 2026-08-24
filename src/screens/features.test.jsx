import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import PoolSpaControl from "./PoolSpaControl";
import PumpControl from "./PumpControl";
import HeatControl from "./HeatControl";
import ScheduleEditor from "../components/ScheduleEditor";
import { SEQUENCES, HEATER_MIN_RPM } from "../lib/sequences";

afterEach(cleanup);

const EVERY = [0, 1, 2, 3, 4, 5, 6];

/** A believable full state. Overridden per scenario. */
const makeState = (over = {}) => ({
  mode: "pool", target: null, activeSequence: null, step: null, stepIndex: 0, steps: [],
  valves: { intake: "pool", returns: "split", bypass: "around" },
  pumpRpm: 1600, pumpHold: null, waterTemp: 84.2, airTemp: 88,
  setpoint: null, heaterCall: "off", targets: { pool: 88, spa: 102 },
  poolHeatDemand: false, blower: false, light: false,
  saltPpm: 3150, cellOutput: 45, connected: true, lastSeen: Date.now(),
  spaExpiresAt: null, preheat: null, ...over,
});

const makeController = (over = {}, fns = {}) => ({
  state: makeState(over),
  setMode: vi.fn(), setRpm: vi.fn(), setTarget: vi.fn(), adjustTarget: vi.fn(),
  setPoolHeat: vi.fn(), toggle: vi.fn(), holdPump: vi.fn(), releasePump: vi.fn(),
  extendSpa: vi.fn(), schedulePreheat: vi.fn(), cancelPreheat: vi.fn(),
  simulateOutage: vi.fn(), problem: null, dismissProblem: vi.fn(), ...fns,
});

const water = (c) => render(<PoolSpaControl controller={c} themeControl={null} onOpenHeat={vi.fn()} />);
const pump = (c) => render(<PumpControl controller={c} themeControl={null} />);

/* ---------------------------------------------------------------- water */

describe("Water — blower gate", () => {
  it("is disabled outside spa mode, with the reason", () => {
    const c = makeController();
    water(c);
    const b = screen.getByText("Blower").closest("button");
    expect(b.disabled).toBe(true);
    expect(b.textContent).toMatch(/spa mode/i);
    fireEvent.click(b);
    expect(c.toggle).not.toHaveBeenCalled();
  });

  it("is available in spa mode", () => {
    const c = makeController({ mode: "spa", valves: { intake: "spa", returns: "spa", bypass: "flow" } });
    water(c);
    const b = screen.getByText("Blower").closest("button");
    expect(b.disabled).toBe(false);
    fireEvent.click(b);
    expect(c.toggle).toHaveBeenCalledWith("blower");
  });

  it("never renders as on while unreachable", () => {
    /* The stranded-blower bug: on and disabled at the same time. */
    const c = makeController({ blower: true });
    water(c);
    const b = screen.getByText("Blower").closest("button");
    expect(b.getAttribute("aria-pressed")).toBe("true");
    expect(b.disabled, "a running blower must stay stoppable").toBe(false);
    fireEvent.click(b);
    expect(c.toggle).toHaveBeenCalledWith("blower");
  });
});

describe("Water — light", () => {
  it("toggles", () => {
    const c = makeController();
    water(c);
    fireEvent.click(screen.getByText("Light").closest("button"));
    expect(c.toggle).toHaveBeenCalledWith("light");
  });
});

describe("Water — offline", () => {
  const offline = () => makeController({ connected: false, lastSeen: Date.now() - 40000 });

  it("warns that what is shown may be stale", () => {
    water(offline());
    expect(screen.getAllByText(/Not connected/).length).toBeGreaterThan(0);
  });
  it("disables mode changes", () => {
    water(offline());
    for (const label of ["Pool", "Spa"]) {
      const btn = screen.getAllByRole("button")
        .find((b) => b.textContent.startsWith(label));
      expect(btn.disabled, `${label} must be disabled offline`).toBe(true);
    }
  });
  it("says how old the reading is", () => {
    water(offline());
    expect(screen.getByText(/last seen/i)).toBeDefined();
  });
});

describe("Water — spa auto-revert", () => {
  it("shows a countdown and offers an extension", () => {
    const c = makeController({ mode: "spa", spaExpiresAt: Date.now() + 20 * 60000 });
    water(c);
    expect(screen.getByText(/Reverts to pool/)).toBeDefined();
    fireEvent.click(screen.getByText("Extend"));
    expect(c.extendSpa).toHaveBeenCalled();
  });
  it("is absent in pool mode", () => {
    water(makeController());
    expect(screen.queryByText(/Reverts to pool/)).toBeNull();
  });
});

describe("Water — preheat", () => {
  it("is offered when a temperature is known", () => {
    water(makeController());
    expect(screen.getByText(/Have the spa ready/).closest("button").disabled).toBe(false);
  });
  it("is refused without a temperature to work back from", () => {
    water(makeController({ waterTemp: null }));
    expect(screen.getByText(/Have the spa ready/).closest("button").disabled).toBe(true);
  });
  it("is refused while offline", () => {
    water(makeController({ connected: false }));
    expect(screen.getByText(/Have the spa ready/).closest("button").disabled).toBe(true);
  });
  it("shows a scheduled preheat and lets it be cancelled", () => {
    const c = makeController({ preheat: { readyAt: Date.now() + 3600e3, startsAt: Date.now() + 1800e3 } });
    water(c);
    fireEvent.click(screen.getByText("Cancel"));
    expect(c.cancelPreheat).toHaveBeenCalled();
  });
});

describe("Water — transition step list", () => {
  const steps = SEQUENCES.spa.map((s, i) => ({ ...s, skipped: s.id === "purge" }));

  it("strikes a skipped step through rather than hiding it", () => {
    /* The short and long paths must look like the same sequence. */
    const c = makeController({ activeSequence: "spa", target: "spa", steps, stepIndex: 2 });
    const { container } = water(c);
    expect(container.textContent).toMatch(/skipped/);
    expect(container.textContent).toMatch(/Purging exchanger/);
  });

  it("says the transition cannot be cancelled", () => {
    const c = makeController({ activeSequence: "spa", target: "spa", steps, stepIndex: 1 });
    const { container } = water(c);
    expect(container.textContent).toMatch(/cannot be cancelled/i);
  });
});

/* ----------------------------------------------------------------- pump */

describe("Pump — presets", () => {
  it("commands the preset speed", () => {
    const c = makeController();
    pump(c);
    fireEvent.click(screen.getByText("Spa jets").closest("button"));
    expect(c.setRpm).toHaveBeenCalledWith(2800);
  });
  it("marks the preset matching the current speed", () => {
    const { container } = pump(makeController({ pumpRpm: 2100 }));
    expect(container.textContent).toContain("Skimming");
  });
});

describe("Pump — heat interlock", () => {
  it("explains the floor while heat is calling", () => {
    const { container } = pump(makeController({ heaterCall: "spa", mode: "spa", pumpRpm: 2800 }));
    expect(container.textContent).toMatch(new RegExp(`Floored at ${HEATER_MIN_RPM}`));
  });
  it("warns below the thresholds when no heat is called", () => {
    const { container } = pump(makeController({ pumpRpm: 800 }));
    expect(container.textContent).toMatch(/will not fire|will not generate/);
  });
});

describe("Pump — manual hold", () => {
  it("pins the current speed", () => {
    const c = makeController();
    pump(c);
    fireEvent.click(screen.getByText(/^Hold 1600 rpm$/));
    expect(c.holdPump).toHaveBeenCalled();
  });
  it("shows the hold and offers release", () => {
    const c = makeController({ pumpHold: { rpm: 2400, startedAt: Date.now(), expiresAt: null } });
    pump(c);
    expect(screen.getByText(/Holding 2400 rpm/)).toBeDefined();
    fireEvent.click(screen.getByText("Release"));
    expect(c.releasePump).toHaveBeenCalled();
  });
  it("is unavailable in spa mode, which owns the pump", () => {
    const c = makeController({ mode: "spa" });
    pump(c);
    expect(screen.getByText(/^Hold \d+ rpm$/).closest("button").disabled).toBe(true);
  });
  it("offers an open-ended hold and timed ones", () => {
    pump(makeController());
    for (const label of ["Until I stop it", "1 h", "4 h"]) {
      expect(screen.getByText(label)).toBeDefined();
    }
  });
});

describe("Pump — who is driving", () => {
  const badge = (over) => pump(makeController(over)).container.textContent;
  it("names spa mode", () => expect(badge({ mode: "spa" })).toMatch(/Spa mode/));
  it("names a hold", () =>
    expect(badge({ pumpHold: { rpm: 1600, startedAt: 1, expiresAt: null } })).toMatch(/Held/));
  it("names manual when nothing else claims it", () =>
    expect(badge({})).toMatch(/Manual|Schedule/));
});

describe("Pump — schedules", () => {
  it("toggles a schedule", () => {
    const { container } = pump(makeController());
    /* Scoped to schedule rows: the hold-duration chips also use
       aria-pressed, and one of them is selected by default. */
    const rows = () => [...container.querySelectorAll("button[aria-pressed]")]
      .filter((b) => /^Enable schedule /.test(b.getAttribute("aria-label") || ""));
    const on = () => rows().filter((b) => b.getAttribute("aria-pressed") === "true").length;
    const before = on();
    expect(before).toBeGreaterThan(0);
    fireEvent.click(rows().find((b) => b.getAttribute("aria-pressed") === "true"));
    expect(on()).toBe(before - 1);
  });
  it("opens the editor from Add", () => {
    pump(makeController());
    fireEvent.click(screen.getByText("Add"));
    expect(screen.getByRole("dialog")).toBeDefined();
  });
  it("totals daily runtime and cost", () => {
    const { container } = pump(makeController());
    expect(container.textContent).toMatch(/h\/day runtime/);
    expect(container.textContent).toMatch(/kWh/);
  });
});

/* ----------------------------------------------------------------- heat */

describe("Heat screen", () => {
  it("calls for pool heat", () => {
    const c = makeController();
    render(<HeatControl controller={c} onBack={vi.fn()} />);
    fireEvent.click(screen.getByText(/Heat the pool/));
    expect(c.setPoolHeat).toHaveBeenCalledWith(true);
  });
  it("offers to stop once heat is demanded", () => {
    const c = makeController({ poolHeatDemand: true, heaterCall: "pool", valves: { intake: "pool", returns: "split", bypass: "flow" } });
    render(<HeatControl controller={c} onBack={vi.fn()} />);
    fireEvent.click(screen.getByText(/Pool heat is on/));
    expect(c.setPoolHeat).toHaveBeenCalledWith(false);
  });
  it("goes back", () => {
    const onBack = vi.fn();
    render(<HeatControl controller={makeController()} onBack={onBack} />);
    fireEvent.click(screen.getByText(/Back/));
    expect(onBack).toHaveBeenCalled();
  });
  it("explains that the bypass isolates the heater in pool mode", () => {
    const { container } = render(<HeatControl controller={makeController()} onBack={vi.fn()} />);
    expect(container.textContent).toMatch(/routes water around the heater/i);
  });
});

/* ------------------------------------------------------- schedule editor */

describe("Schedule editor", () => {
  const base = { id: 1, start: "08:00", end: "18:00", rpm: 1600, days: EVERY, on: true };
  const editor = (value, others = [], fns = {}) =>
    render(<ScheduleEditor value={value} others={others}
      onSave={fns.onSave || vi.fn()} onDelete={fns.onDelete || vi.fn()} onCancel={fns.onCancel || vi.fn()} />);

  it("saves a valid schedule", () => {
    const onSave = vi.fn();
    editor(base, [], { onSave });
    fireEvent.click(screen.getByText("Save"));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ start: "08:00", end: "18:00" }));
  });

  it("refuses a window with no days", () => {
    editor({ ...base, days: [] });
    expect(screen.getByText("Save").closest("button").disabled).toBe(true);
    expect(screen.getByText(/Pick at least one day/)).toBeDefined();
  });

  it("refuses a zero-length window", () => {
    editor({ ...base, end: base.start });
    expect(screen.getByText("Save").closest("button").disabled).toBe(true);
    expect(screen.getByText(/cannot match/)).toBeDefined();
  });

  it("warns about an overlap instead of blocking it", () => {
    const { container } = editor(base, [{ ...base, id: 2, start: "10:00", end: "12:00" }]);
    expect(container.textContent).toMatch(/overlap/i);
    expect(screen.getByText("Save").closest("button").disabled).toBe(false);
  });

  it("deletes an existing schedule", () => {
    const onDelete = vi.fn();
    editor(base, [], { onDelete });
    fireEvent.click(screen.getByText("Delete"));
    expect(onDelete).toHaveBeenCalledWith(base.id);
  });

  it("cancels without saving", () => {
    const onCancel = vi.fn(), onSave = vi.fn();
    editor(base, [], { onCancel, onSave });
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
