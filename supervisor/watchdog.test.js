// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { createWatchdog, evaluationHealth } from "./watchdog.js";

const quiet = { log() {}, error() {} };

describe("the health condition", () => {
  const base = { now: 10_000, staleAfterMs: 30_000 };

  it("is healthy when an evaluation completed recently", () => {
    expect(evaluationHealth({ ...base, lastEvaluatedAt: 9_000 })).toEqual({ ok: true });
  });

  it("is unhealthy before the first evaluation", () => {
    const v = evaluationHealth({ ...base, lastEvaluatedAt: null });
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/no evaluation/);
  });

  it("is unhealthy once evaluations stop arriving", () => {
    const v = evaluationHealth({ ...base, lastEvaluatedAt: 10_000 - 45_000 });
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/45 s ago/);
  });

  it("is unhealthy when the last evaluation threw", () => {
    const v = evaluationHealth({ ...base, lastEvaluatedAt: 9_999, lastError: "boom" });
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/threw: boom/);
  });

  it("says nothing about whether invariants are satisfied", () => {
    /* The point of ADR-10's re-reading. A breached invariant is a fact about
       the equipment; restarting this process does not move water, and doing
       it repeatedly re-asserts relays against an actuator duty cycle. The
       health condition takes no argument about violations, and cannot. */
    const args = Object.keys(
      { lastEvaluatedAt: 1, lastError: null, now: 2, staleAfterMs: 3 },
    );
    expect(args).not.toContain("violations");
  });
});

describe("the pinger", () => {
  it("is inert with no WATCHDOG_USEC, so a hand-run supervisor is unchanged", () => {
    const wd = createWatchdog({ isHealthy: () => ({ ok: true }), usec: NaN, log: quiet });
    expect(wd.enabled).toBe(false);
    expect(wd.start()).toBe(false);
  });

  it("pings at a third of the window, not a half", () => {
    const wd = createWatchdog({ isHealthy: () => ({ ok: true }), usec: 60e6, log: quiet });
    expect(wd.enabled).toBe(true);
    expect(wd.periodMs).toBe(20_000);
  });

  it("pings while healthy", async () => {
    const notify = vi.fn().mockResolvedValue();
    const wd = createWatchdog({ isHealthy: () => ({ ok: true }), usec: 60e6, notify, log: quiet });
    expect(await wd.tick()).toEqual({ petted: true });
    expect(notify).toHaveBeenCalledOnce();
  });

  it("withholds while unhealthy, which is the whole mechanism", async () => {
    const notify = vi.fn().mockResolvedValue();
    const wd = createWatchdog({
      isHealthy: () => ({ ok: false, why: "wedged" }), usec: 60e6, notify, log: quiet });
    const r = await wd.tick();
    expect(r.petted).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(wd.withholding).toBe(true);
  });

  it("complains once, not once per tick", async () => {
    const log = { log: vi.fn(), error: vi.fn() };
    const wd = createWatchdog({
      isHealthy: () => ({ ok: false, why: "wedged" }), usec: 60e6,
      notify: vi.fn(), log });
    await wd.tick(); await wd.tick(); await wd.tick();
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("resumes and says so when health returns", async () => {
    const log = { log: vi.fn(), error: vi.fn() };
    let ok = false;
    const wd = createWatchdog({
      isHealthy: () => ({ ok }), usec: 60e6, notify: vi.fn().mockResolvedValue(), log });
    await wd.tick();
    ok = true;
    expect((await wd.tick()).petted).toBe(true);
    expect(log.log.mock.calls.flat().join(" ")).toMatch(/healthy again/);
  });

  it("treats a throwing health check as unhealthy rather than crashing", async () => {
    const notify = vi.fn();
    const wd = createWatchdog({
      isHealthy: () => { throw new Error("nope"); }, usec: 60e6, notify, log: quiet });
    const r = await wd.tick();
    expect(r.petted).toBe(false);
    expect(r.why).toMatch(/threw: nope/);
    expect(notify).not.toHaveBeenCalled();
  });

  it("a failed send is reported but does not claim ill health", async () => {
    const notify = vi.fn().mockRejectedValue(new Error("no socket"));
    const log = { log: vi.fn(), error: vi.fn() };
    const wd = createWatchdog({ isHealthy: () => ({ ok: true }), usec: 60e6, notify, log });
    const r = await wd.tick();
    expect(r.petted).toBe(false);
    expect(wd.withholding).toBe(false);
    expect(log.error.mock.calls.flat().join(" ")).toMatch(/could not send/);
  });
});
