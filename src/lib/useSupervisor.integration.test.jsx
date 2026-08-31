import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { WebSocket as NodeWebSocket } from "ws";
import { start } from "../../supervisor/harness.test-utils.js";
import { useSupervisor } from "./useSupervisor.js";

/**
 * The client against a real supervisor.
 *
 * `useSupervisor.test.jsx` stubs a `FakeSocket` and exercises the hook's own
 * logic — reconnection, staleness, the sign-in dance. Thorough, and it has
 * never once spoken to the thing it is a client for. Every field the UI reads
 * is a contract nobody checks: `purgeUntil` was added on 29 August and
 * nothing anywhere asserted the client could see it.
 *
 * Two shims, and it is worth being plain about what they cost.
 *
 * In production the client is *served by* the supervisor, so `location.host`
 * is the supervisor and relative `/auth/*` fetches reach it. jsdom fixes its
 * URL when the environment is created, before a test knows which port was
 * free — so the socket uses the `VITE_SUPERVISOR` override, which is a real
 * code path used in development, and `fetch` is rewritten to resolve relative
 * paths against the supervisor's origin, which is what a browser does when
 * the page came from there.
 *
 * What that leaves untested is the `location.host` derivation itself. Small,
 * and named here rather than quietly skipped.
 */

/* Everything the screens destructure out of `state`. The point of the list is
   that it is hand-written: a field the server stops sending, or renames,
   fails here rather than rendering as `undefined` on somebody's phone. */
const FIELDS_THE_UI_READS = [
  "mode", "target", "activeSequence", "stepIndex", "valves", "pumpRpm",
  "pumpCommandedRpm", "waterTemp", "targets", "setpoint", "heaterCall",
  "blower", "light", "saltPpm", "cellOutput", "connected", "lastSeen",
  "spaExpiresAt", "preheat", "delays", "poolHeatDemand", "purgeUntil",
  "programs", "schedules", "violations", "commissioning", "pumpRunning",
  "panelMode", "pumpLimits", "pumpCircuits", "activeProgram", "lastCutoff",
  "heaterSetpoint",
];

describe("the client, talking to a supervisor that is really running", () => {
  let sup;

  beforeAll(async () => {
    sup = await start({ card: true });
    vi.stubEnv("VITE_SUPERVISOR", `http://127.0.0.1:${sup.port}`);
    vi.stubGlobal("WebSocket", NodeWebSocket);

    /* Relative paths against the supervisor, as a page served from it. */
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (input, init) => {
      const url = typeof input === "string" && input.startsWith("/")
        ? `http://127.0.0.1:${sup.port}${input}`
        : input;
      return real(url, init);
    });
  }, 40000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await sup?.stop();
  });

  const connected = async () => {
    const view = renderHook(() => useSupervisor());
    await waitFor(() => expect(view.result.current.state).not.toBeNull(), { timeout: 15000 });
    return view;
  };

  it("says which link is down, not merely that something is", async () => {
    /* Three things have to be true before the app claims it is live: the
       socket is up, the state is fresh, and the *supervisor* can reach njsPC.
       This harness points njsPC at a dead port — the rig's own state today —
       so the honest answer is connected: false with a reason naming njsPC,
       and reaching that answer proves the socket is working.
     *
     * A single boolean here would be the ADR-7 failure in miniature: the
     * phone showing OFFLINE while the equipment is fine, or LIVE beside
     * frozen state, with nothing to tell them apart. */
    const view = await connected();
    expect(view.result.current.linkError, "the socket itself is fine").toBeFalsy();
    expect(view.result.current.state.connected).toBe(false);
    expect(view.result.current.state.offlineReason).toBe("Controller cannot reach njsPC");
    view.unmount();
  }, 30000);

  it("receives every field the screens read", async () => {
    /* The contract, checked rather than assumed. A `undefined` here is a
       screen rendering a blank where a reading should be — which is exactly
       the failure ADR-7 says must never be silent. */
    const view = await connected();
    const state = view.result.current.state;
    const missing = FIELDS_THE_UI_READS.filter((k) => !(k in state));
    expect(missing, `the supervisor no longer sends: ${missing.join(", ")}`).toEqual([]);
    view.unmount();
  }, 30000);

  it("carries an intent to the equipment and the result back", async () => {
    /* The whole loop in one assertion: the hook sends, the supervisor acts,
       the relay moves, and the new state arrives unprompted on the socket.
       0x08 is CH7, the light — the one intent that needs no njsPC. */
    const view = await connected();
    await act(async () => { view.result.current.toggle("light"); });
    await waitFor(() => expect(view.result.current.state.light).toBe(true), { timeout: 10000 });
    await waitFor(async () => expect(await sup.card.byte()).toBe(0x08), { timeout: 10000 });

    await act(async () => { view.result.current.toggle("light"); });
    await waitFor(() => expect(view.result.current.state.light).toBe(false), { timeout: 10000 });
    view.unmount();
  }, 30000);

  it("surfaces a refusal instead of swallowing it", async () => {
    /* A refused intent that left no trace would be indistinguishable from a
       dead button, which on a controller is the worst outcome — you believe
       the equipment moved. `setRpm` always refuses: pump speed needs a
       dedicated njsPC circuit, and saying so is the point. */
    const view = await connected();
    await act(async () => { view.result.current.setRpm(2000); });
    await waitFor(() => expect(view.result.current.problem).toBeTruthy(), { timeout: 10000 });
    expect(view.result.current.problem.text).toMatch(/circuit/i);
    view.unmount();
  }, 30000);
});
