import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { toUiState } from "../../supervisor/map.js";
import PoolSpaControl from "./PoolSpaControl";
import PumpControl from "./PumpControl";
import HeatControl from "./HeatControl";
import BusMonitor from "./BusMonitor";

/**
 * The regression class that produced four separate defects.
 *
 * The mock always supplied a value for everything, so no screen ever had to
 * consider absence — and the live transport delivers `null` for anything
 * njsPC cannot answer for. Rendering against a genuinely empty controller is
 * the single cheapest test in the suite: it would have caught the preheat
 * crash, the `waterTemp.toFixed` crash and the pump readout together.
 *
 * The fixture is built by `toUiState` from an empty njsPC payload rather than
 * hand-written, so it cannot drift away from what the supervisor really sends.
 */
const emptyState = toUiState({}, {
  bypass: "around",
  targets: { pool: 88, spa: 102 },
  poolHeatDemand: false,
  connected: true,
  lastSeen: Date.now(),
});

const controller = {
  state: emptyState,
  setMode: vi.fn(), setRpm: vi.fn(), setTarget: vi.fn(), adjustTarget: vi.fn(),
  setPoolHeat: vi.fn(), toggle: vi.fn(), holdPump: vi.fn(), releasePump: vi.fn(),
  extendSpa: vi.fn(), schedulePreheat: vi.fn(), cancelPreheat: vi.fn(),
  simulateOutage: vi.fn(), problem: null, dismissProblem: vi.fn(),
};

describe("screens render when nothing is known", () => {
  it("Water", () => {
    render(<PoolSpaControl controller={controller} themeControl={null} onOpenHeat={vi.fn()} />);
    /* Unique to this screen, and only present once it has rendered fully. */
    expect(screen.getByText(/Hold for 5 seconds/)).toBeDefined();
  });

  it("Pump", () => {
    render(<PumpControl controller={controller} themeControl={null} />);
    expect(screen.getByText("Speed")).toBeDefined();
  });

  it("Heat", () => {
    render(<HeatControl controller={controller} onBack={vi.fn()} />);
    expect(screen.getByText(/Spa target/)).toBeDefined();
  });

  it("Bus", () => {
    render(<BusMonitor themeControl={null} />);
    expect(screen.getByText("Bus")).toBeDefined();
  });
});

describe("unknown is shown as unknown, not as zero", () => {
  it("Water shows dashes rather than fabricated readings", () => {
    const { container } = render(
      <PoolSpaControl controller={controller} themeControl={null} onOpenHeat={vi.fn()} />);
    /* Water, Target and Pump all have nothing behind them. */
    expect(container.textContent).toContain("—");
    expect(container.textContent).not.toMatch(/0\s*rpm/);
  });

  it("Pump does not claim a speed or a running cost it cannot know", () => {
    const { container } = render(<PumpControl controller={controller} themeControl={null} />);
    expect(container.textContent).toContain("no reading from the pump");
    expect(container.textContent).not.toMatch(/\$0\.00\/day/);
  });

  it("preheat is refused, with the reason, rather than crashing", () => {
    render(<PoolSpaControl controller={controller} themeControl={null} onOpenHeat={vi.fn()} />);
    const btn = screen.getByText(/Have the spa ready/).closest("button");
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toMatch(/Needs a water temperature/);
  });
});
