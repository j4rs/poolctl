import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import HoldButton from "./HoldButton";
import Toggle from "./Toggle";
import Toast from "./Toast";
import Stat from "./Stat";
import TargetTemp from "./TargetTemp";
import { HEATER_CAP, TARGET_MIN } from "../lib/sequences";

afterEach(cleanup);

/* Short holds keep these fast without faking timers, which would mean also
   faking rAF and performance.now that HoldButton drives progress from. */
const hold = (el, ms) =>
  new Promise((r) => { fireEvent.pointerDown(el, { pointerId: 1 }); setTimeout(r, ms); });

describe("HoldButton", () => {
  it("does nothing on a plain tap", () => {
    const onConfirm = vi.fn();
    render(<HoldButton label="Spa" holdMs={200} onConfirm={onConfirm} />);
    const b = screen.getByRole("button");
    fireEvent.pointerDown(b, { pointerId: 1 });
    fireEvent.pointerUp(b, { pointerId: 1 });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("confirms once the hold completes", async () => {
    const onConfirm = vi.fn();
    render(<HoldButton label="Spa" holdMs={120} onConfirm={onConfirm} />);
    await hold(screen.getByRole("button"), 300);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("cancels when the finger lifts early", async () => {
    const onConfirm = vi.fn();
    render(<HoldButton label="Spa" holdMs={400} onConfirm={onConfirm} />);
    const b = screen.getByRole("button");
    await hold(b, 80);
    fireEvent.pointerUp(b, { pointerId: 1 });
    await new Promise((r) => setTimeout(r, 450));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("cancels if the pointer leaves the button", async () => {
    const onConfirm = vi.fn();
    render(<HoldButton label="Spa" holdMs={400} onConfirm={onConfirm} />);
    const b = screen.getByRole("button");
    await hold(b, 80);
    fireEvent.pointerLeave(b);
    await new Promise((r) => setTimeout(r, 450));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows progress while held and reverts after release", async () => {
    render(<HoldButton label="Spa" holdMs={400} onConfirm={vi.fn()} />);
    const b = screen.getByRole("button");
    await hold(b, 150);
    await waitFor(() => expect(b.textContent).toMatch(/keep holding/));
    fireEvent.pointerUp(b, { pointerId: 1 });
    await waitFor(() => expect(b.textContent).toMatch(/hold to switch/));
  });

  it("ignores a hold on the mode already active", async () => {
    const onConfirm = vi.fn();
    render(<HoldButton label="Pool" active holdMs={100} onConfirm={onConfirm} />);
    await hold(screen.getByRole("button"), 250);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button").textContent).toMatch(/current/);
  });

  it("ignores a hold while disabled", async () => {
    const onConfirm = vi.fn();
    render(<HoldButton label="Spa" disabled holdMs={100} onConfirm={onConfirm} />);
    await hold(screen.getByRole("button"), 250);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("Toggle", () => {
  it("reports its pressed state to assistive tech", () => {
    render(<Toggle label="Light" on onClick={vi.fn()} />);
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("true");
  });

  it("shows the reason on screen when disabled, not in a tooltip", () => {
    /* Phone-first: hover does not exist, and a title would also replace the
       accessible name — which it once did. */
    render(<Toggle label="Blower" disabled reason="Available in spa mode" onClick={vi.fn()} />);
    const b = screen.getByRole("button");
    expect(b.textContent).toMatch(/Available in spa mode/);
    expect(b.getAttribute("title")).toBeNull();
    expect(b.getAttribute("aria-label")).toMatch(/^Blower/);
  });

  it("does not fire while disabled", () => {
    const onClick = vi.fn();
    render(<Toggle label="Blower" disabled reason="nope" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("fires when enabled", () => {
    const onClick = vi.fn();
    render(<Toggle label="Light" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("Stat", () => {
  it("renders a value with its unit", () => {
    const { container } = render(<Stat label="Pump" value={1600} unit="rpm" />);
    expect(container.textContent).toContain("1600");
    expect(container.textContent).toContain("rpm");
  });
  it("renders a dash and drops the unit when unknown", () => {
    const { container } = render(<Stat label="Pump" value={null} unit="rpm" />);
    expect(container.textContent).toContain("—");
    expect(container.textContent).not.toContain("rpm");
  });
  it("treats a real zero as a value, not as unknown", () => {
    const { container } = render(<Stat label="Pump" value={0} unit="rpm" />);
    expect(container.textContent).toContain("0");
    expect(container.textContent).toContain("rpm");
  });
});

describe("Toast", () => {
  it("renders nothing when there is no problem", () => {
    const { container } = render(<Toast problem={null} onDismiss={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
  it("shows the refusal", () => {
    render(<Toast problem={{ text: "Pool heat — not implemented", at: 1 }} onDismiss={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toMatch(/Pool heat/);
  });
  it("can be dismissed by hand", () => {
    const onDismiss = vi.fn();
    render(<Toast problem={{ text: "x", at: 1 }} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(onDismiss).toHaveBeenCalled();
  });
  it("dismisses itself", async () => {
    const onDismiss = vi.fn();
    render(<Toast problem={{ text: "x", at: 1 }} onDismiss={onDismiss} ms={60} />);
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
  });
  it("restarts its timer for a second refusal", async () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<Toast problem={{ text: "a", at: 1 }} onDismiss={onDismiss} ms={80} />);
    rerender(<Toast problem={{ text: "b", at: 2 }} onDismiss={onDismiss} ms={80} />);
    /* The second notice gets its own full window rather than inheriting the
       remainder of the first one's. */
    await new Promise((r) => setTimeout(r, 40));
    expect(onDismiss).not.toHaveBeenCalled();
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
  });
});

describe("TargetTemp", () => {
  const targets = { pool: 88, spa: 102 };

  it("emits a relative change, never an absolute or a function", () => {
    /* An updater once crossed JSON as undefined and blanked the reading. */
    const onAdjust = vi.fn();
    render(<TargetTemp targets={targets} activeCall="off" onAdjust={onAdjust} />);
    fireEvent.click(screen.getByLabelText("Raise Spa target"));
    expect(onAdjust).toHaveBeenCalledWith("spa", 1);
    fireEvent.click(screen.getByLabelText("Lower Pool target"));
    expect(onAdjust).toHaveBeenCalledWith("pool", -1);
  });

  it("stops at the heater's cap", () => {
    render(<TargetTemp targets={{ ...targets, spa: HEATER_CAP.spa }} activeCall="off" onAdjust={vi.fn()} />);
    expect(screen.getByLabelText("Raise Spa target").disabled).toBe(true);
    expect(screen.getByLabelText("Lower Spa target").disabled).toBe(false);
  });

  it("stops at the floor", () => {
    render(<TargetTemp targets={{ ...targets, pool: TARGET_MIN.pool }} activeCall="off" onAdjust={vi.fn()} />);
    expect(screen.getByLabelText("Lower Pool target").disabled).toBe(true);
  });

  it("says the targets cannot raise the heater's limit", () => {
    const { container } = render(<TargetTemp targets={targets} activeCall="off" onAdjust={vi.fn()} />);
    expect(container.textContent).toMatch(/cannot raise the limit/i);
  });

  it("marks the body currently calling for heat", () => {
    const { container } = render(<TargetTemp targets={targets} activeCall="spa" onAdjust={vi.fn()} />);
    expect(container.textContent).toMatch(/Calling for heat/);
  });
});
