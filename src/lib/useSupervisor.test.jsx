import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSupervisor } from "./useSupervisor.js";

/**
 * The transport, tested where it actually broke.
 *
 * Every defect this layer put on a screen was about time or identity: a
 * staleness threshold shorter than the heartbeat it measured, and an ack
 * matched to the wrong request. Neither is reachable by testing a pure
 * function, because neither is one — so the socket is faked and the clock is
 * driven by hand.
 *
 * The numbers below are the supervisor's, restated. `supervisor/index.test.js`
 * measures what it really emits; if these two drift apart the pair fails,
 * which is the point of stating them in both places.
 */
const HEARTBEAT_MS = 5000;
const STALE_MS = HEARTBEAT_MS * 3;
const ACK_TIMEOUT_MS = 10000;

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static live = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.CONNECTING;
    this.sent = [];
    FakeSocket.live.push(this);
  }

  send(raw) {
    this.sent.push(JSON.parse(raw));
  }

  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  /* ---- driven by the tests, not by the code under test ---- */
  accept() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  deliver(msg) {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }

  fail() {
    this.onerror?.();
  }
}

/** The most recently constructed socket — reconnects make new ones. */
const sock = () => FakeSocket.live.at(-1);

const frame = (state = {}) => ({
  type: "state",
  state: { connected: true, mode: "pool", ...state },
});

/** Render, open the socket, and deliver one state frame. */
async function online(state) {
  const view = renderHook(() => useSupervisor());
  await act(async () => sock().accept());
  await act(async () => sock().deliver(frame(state)));
  return view;
}

/** Let the clock run without leaving React mid-update. */
async function tick(ms) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  FakeSocket.live = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("connecting", () => {
  it("opens one socket, as a ws:// URL on the serving origin", () => {
    renderHook(() => useSupervisor());
    expect(FakeSocket.live).toHaveLength(1);
    expect(sock().url).toMatch(/^ws:\/\//);
  });

  it("reports no state at all until the first frame arrives", () => {
    const view = renderHook(() => useSupervisor());
    /* Not an empty object: the screens distinguish "nothing known yet" from
       "known to be empty", and rendering defaults would invent readings. */
    expect(view.result.current.state).toBeNull();
  });

  it("adopts the supervisor's state once a frame arrives", async () => {
    const view = await online({ waterTemp: 71 });
    expect(view.result.current.state.waterTemp).toBe(71);
    expect(view.result.current.state.connected).toBe(true);
  });

  it("sends the connection's own state frame straight through", async () => {
    const view = await online();
    expect(view.result.current.state.mode).toBe("pool");
  });
});

describe("reconnecting", () => {
  it("opens a new socket 2 s after the old one closes", async () => {
    await online();
    await act(async () => sock().close());
    expect(FakeSocket.live).toHaveLength(1);

    await tick(2000);
    expect(FakeSocket.live).toHaveLength(2);
  });

  it("keeps retrying while the supervisor stays down", async () => {
    await online();
    for (let i = 2; i <= 4; i++) {
      await act(async () => sock().close());
      await tick(2000);
      expect(FakeSocket.live).toHaveLength(i);
    }
  });

  it("closes the socket on error, which is what schedules the retry", async () => {
    await online();
    await act(async () => sock().fail());
    expect(sock().readyState).toBe(FakeSocket.CLOSED);
    await tick(2000);
    expect(FakeSocket.live).toHaveLength(2);
  });

  it("stops retrying once the component is gone", async () => {
    const view = await online();
    view.unmount();
    await tick(10000);
    /* Unmount closes the socket, and that close must not schedule a retry —
       otherwise a navigated-away tab reconnects forever. */
    expect(FakeSocket.live).toHaveLength(1);
  });

  it("recovers state after a reconnect", async () => {
    const view = await online({ waterTemp: 71 });
    await act(async () => sock().close());
    await tick(2000);
    await act(async () => sock().accept());
    await act(async () => sock().deliver(frame({ waterTemp: 74 })));
    expect(view.result.current.state.waterTemp).toBe(74);
    expect(view.result.current.state.connected).toBe(true);
  });
});

describe("staleness", () => {
  /**
   * The shipped bug: a 12 s threshold measuring a 15 s poll, so the banner
   * appeared in every quiet stretch. The rule that prevents it is that the
   * threshold must be a multiple of the heartbeat, never shorter than it.
   */
  it("never reports offline while frames arrive at the heartbeat rate", async () => {
    const view = await online();
    for (let beat = 1; beat <= 12; beat++) {
      await tick(HEARTBEAT_MS);
      await act(async () => sock().deliver(frame()));
      expect(view.result.current.state.connected, `beat ${beat}`).toBe(true);
    }
  });

  it("survives a single missed beat", async () => {
    const view = await online();
    await tick(HEARTBEAT_MS * 2);
    expect(view.result.current.state.connected).toBe(true);
  });

  it("goes offline once the frames genuinely stop", async () => {
    const view = await online();
    await tick(STALE_MS + 1000);
    expect(view.result.current.state.connected).toBe(false);
    expect(view.result.current.state.offlineReason).toBe("No update from the controller");
  });

  it("turns offline on its own clock, with no other render to prompt it", async () => {
    /* Freshness used to be derived only during render, so the transition
       landed whenever something unrelated happened to re-render. Nothing
       below touches the hook: the 1 s tick has to do it alone. */
    const view = await online();
    await tick(STALE_MS + 1000);
    expect(view.result.current.state.connected).toBe(false);
  });

  it("comes back the moment a frame lands", async () => {
    const view = await online();
    await tick(STALE_MS + 1000);
    expect(view.result.current.state.connected).toBe(false);

    await act(async () => sock().deliver(frame()));
    expect(view.result.current.state.connected).toBe(true);
    expect(view.result.current.state.offlineReason).toBeNull();
  });
});

describe("why we are offline", () => {
  it("names a dead socket", async () => {
    const view = await online();
    await act(async () => sock().close());
    expect(view.result.current.state.offlineReason).toBe("No link to the controller");
  });

  it("names a silent but living socket", async () => {
    const view = await online();
    await tick(STALE_MS + 1000);
    expect(view.result.current.state.offlineReason).toBe("No update from the controller");
  });

  it("distinguishes the supervisor losing njsPC from us losing the supervisor", async () => {
    /* Both mean the screen is not to be trusted, but they need different
       things done about them, so they must not collapse into one message. */
    const view = await online({ connected: false });
    expect(view.result.current.state.connected).toBe(false);
    expect(view.result.current.state.offlineReason).toBe("Controller cannot reach njsPC");
  });

  it("says nothing when everything is well", async () => {
    const view = await online();
    expect(view.result.current.state.offlineReason).toBeNull();
  });
});

describe("intents on the wire", () => {
  it("sends intent and args in the shape the supervisor parses", async () => {
    const view = await online();
    await act(async () => {
      view.result.current.setMode("spa");
    });
    expect(sock().sent[0]).toEqual({ reqId: 1, intent: "setMode", args: { mode: "spa" } });
  });

  it("nests args rather than spreading them", async () => {
    /* Spreading let an intent parameter called `id` overwrite the envelope's
       correlation id, so acks matched the wrong request — silently, and only
       for the intents that happen to take an id. */
    const view = await online();
    await act(async () => {
      view.result.current.startProgram("skimming");
    });
    expect(sock().sent[0]).toEqual({
      reqId: 1,
      intent: "startProgram",
      args: { id: "skimming" },
    });
  });

  it("sends a relative change for the stepper, not an absolute", async () => {
    /* Taps that outrun the round trip must accumulate; absolutes computed
       from a stale frame would lose all but one. */
    const view = await online();
    await act(async () => {
      view.result.current.adjustTarget("pool", -1);
    });
    expect(sock().sent[0].args).toEqual({ body: "pool", delta: -1 });
  });

  it("numbers requests monotonically", async () => {
    const view = await online();
    await act(async () => {
      view.result.current.setMode("spa");
      view.result.current.setPoolHeat(true);
      view.result.current.toggle("light");
    });
    expect(sock().sent.map((m) => m.reqId)).toEqual([1, 2, 3]);
  });
});

describe("acknowledgements", () => {
  it("settles the request its reqId names", async () => {
    const view = await online();
    let done = false;
    await act(async () => {
      view.result.current.setMode("spa").then(() => {
        done = true;
      });
    });
    await act(async () => sock().deliver({ type: "ack", reqId: 1, ok: true }));
    expect(done).toBe(true);
    expect(view.result.current.problem).toBeNull();
  });

  it("matches acks that come back out of order", async () => {
    const view = await online();
    await act(async () => {
      view.result.current.setMode("spa");
      view.result.current.setPoolHeat(true);
      view.result.current.toggle("light");
    });

    /* Third, first, second — and only the second is a refusal. */
    await act(async () => {
      sock().deliver({ type: "ack", reqId: 3, ok: true });
      sock().deliver({ type: "ack", reqId: 1, ok: true });
      sock().deliver({ type: "ack", reqId: 2, ok: false, error: "spa mode owns the heater" });
    });

    expect(view.result.current.problem.text).toBe("Pool heat — spa mode owns the heater");
  });

  it("correlates an intent whose own args contain an id", async () => {
    /* The collision, from the other end: the ack must find the request even
       though `args.id` is a different id entirely. */
    const view = await online();
    await act(async () => {
      view.result.current.startProgram("filtration");
    });
    await act(async () =>
      sock().deliver({
        type: "ack",
        reqId: 1,
        ok: false,
        error: "'Filtration' has no njsPC circuit yet — see commissioning",
      }),
    );
    expect(view.result.current.problem.text).toBe(
      "Run program — 'Filtration' has no njsPC circuit yet — see commissioning",
    );
  });

  it("ignores an ack for a request it never made", async () => {
    const view = await online();
    await act(async () => sock().deliver({ type: "ack", reqId: 99, ok: false, error: "nope" }));
    expect(view.result.current.problem).toBeNull();
  });

  it("does not reject a request that was already acknowledged", async () => {
    /* The pending entry must be dropped when the ack lands, not left for the
       timeout to sweep. Nothing downstream can see a late reject today, but
       the timeout is where "the link is degraded" logic would go, and it
       would fire on every successful request. */
    const view = await online();
    await act(async () => {
      view.result.current.setMode("spa");
    });
    await act(async () => sock().deliver({ type: "ack", reqId: 1, ok: true }));
    await tick(ACK_TIMEOUT_MS + 1000);
    expect(view.result.current.problem).toBeNull();
  });

  it("gives up on a request that is never acknowledged", async () => {
    const view = await online();
    await act(async () => {
      view.result.current.setMode("spa");
    });
    await tick(ACK_TIMEOUT_MS + 1000);
    expect(view.result.current.problem.text).toBe("Change mode — no acknowledgement");
  });
});

describe("refusals", () => {
  it("labels a refusal with the operator's word for it, not the intent name", async () => {
    const view = await online();
    await act(async () => {
      view.result.current.setPoolHeat(true);
    });
    await act(async () =>
      sock().deliver({ type: "ack", reqId: 1, ok: false, error: "bypass is not in flow position" }),
    );
    expect(view.result.current.problem.text).toBe("Pool heat — bypass is not in flow position");
  });

  it("strips the supervisor's intent prefix, which is redundant beside a label", async () => {
    const view = await online();
    await act(async () => {
      view.result.current.extendSpa(30);
    });
    await act(async () =>
      sock().deliver({
        type: "ack",
        reqId: 1,
        ok: false,
        error: "intent 'extendSpa' not implemented in v0",
      }),
    );
    expect(view.result.current.problem.text).toBe("Extend spa — not implemented in v0");
  });

  it("falls back to a bare error when the supervisor sends none", async () => {
    const view = await online();
    await act(async () => {
      view.result.current.toggle("blower");
    });
    await act(async () => sock().deliver({ type: "ack", reqId: 1, ok: false }));
    expect(view.result.current.problem.text).toBe("Switch — refused");
  });

  it("refuses rather than queues while the socket is down", async () => {
    /* Replaying a mode change after a reconnect could fire it minutes late,
       against state that has moved on. */
    const view = await online();
    await act(async () => sock().close());
    await act(async () => {
      view.result.current.setMode("spa");
    });
    expect(view.result.current.problem.text).toBe("Change mode — not connected");
  });

  it("never rejects at the call site — the refusal is already on screen", async () => {
    const view = await online();
    let rejected = false;
    await act(async () => {
      view.result.current.setMode("spa").catch(() => {
        rejected = true;
      });
    });
    await act(async () => sock().deliver({ type: "ack", reqId: 1, ok: false, error: "no" }));
    expect(rejected).toBe(false);
    expect(view.result.current.problem).not.toBeNull();
  });

  it("keeps only the latest refusal", async () => {
    const view = await online();
    await act(async () => {
      view.result.current.setMode("spa");
      view.result.current.setPoolHeat(true);
    });
    await act(async () => {
      sock().deliver({ type: "ack", reqId: 1, ok: false, error: "first" });
      sock().deliver({ type: "ack", reqId: 2, ok: false, error: "second" });
    });
    expect(view.result.current.problem.text).toBe("Pool heat — second");
  });

  it("clears on dismissal", async () => {
    const view = await online();
    await act(async () => {
      view.result.current.setMode("spa");
    });
    await act(async () => sock().deliver({ type: "ack", reqId: 1, ok: false, error: "no" }));
    expect(view.result.current.problem).not.toBeNull();

    await act(async () => view.result.current.dismissProblem());
    expect(view.result.current.problem).toBeNull();
  });
});

describe("hostile input on the wire", () => {
  it("ignores malformed JSON", async () => {
    const view = await online({ waterTemp: 71 });
    await act(async () => sock().deliver("{not json"));
    expect(view.result.current.state.waterTemp).toBe(71);
  });

  it("ignores a message type it does not know", async () => {
    const view = await online({ waterTemp: 71 });
    await act(async () => sock().deliver({ type: "something-new", state: { waterTemp: 0 } }));
    expect(view.result.current.state.waterTemp).toBe(71);
  });

  it("survives an error frame with no payload", async () => {
    const view = await online();
    await act(async () => sock().deliver({ type: "error", error: "bad json" }));
    expect(view.result.current.state.connected).toBe(true);
  });
});

describe("signing in", () => {
  /**
   * A browser cannot read the status of a failed WebSocket upgrade —
   * `onclose` carries no HTTP code — so a refused socket and a supervisor
   * that has stopped look identical from inside the callback. `/auth/status`
   * is the only thing that tells them apart.
   */

  const answerWith = (routes) =>
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const key = `${init?.method ?? "GET"} ${String(url)}`;
      const body = routes[key] ?? routes[String(url)];
      if (!body) throw new Error(`unstubbed ${key}`);
      return { ok: body.ok !== false, status: body.ok === false ? 401 : 200, json: async () => body };
    }));

  /** Open, then have the supervisor refuse the socket. */
  async function refused(status = { required: true, authenticated: false }) {
    answerWith({ "/auth/status": status });
    const view = renderHook(() => useSupervisor());
    await act(async () => sock().close());
    return view;
  }

  it("asks why the socket failed rather than assuming the worst", async () => {
    const view = await refused();
    expect(fetch).toHaveBeenCalledWith("/auth/status", expect.anything());
    expect(view.result.current.needsSignIn).toBe(true);
  });

  it("does not ask for a password when the socket is merely down", async () => {
    /* A supervisor that has stopped must not produce a login screen — the
       password would be rejected by nothing and the user would blame it. */
    const view = await refused({ required: true, authenticated: true });
    expect(view.result.current.needsSignIn).toBe(false);
  });

  it("says nothing about signing in while the answer is unknown", async () => {
    /* Before /auth/status returns, `needsSignIn` must be false rather than
       flashing a login screen at somebody who is already signed in. */
    answerWith({ "/auth/status": { required: true, authenticated: false } });
    const view = renderHook(() => useSupervisor());
    expect(view.result.current.needsSignIn).toBe(false);
  });

  it("reconnects at once on success, without waiting out the retry", async () => {
    /* The bug this pins: signing in cleared the pending retry and then
       called close() on a socket the server had already closed. No `onclose`
       fires for an already-closed socket, so nothing was ever scheduled —
       the app got past the login screen and sat on "Waiting for the
       controller" indefinitely. */
    const view = await refused();
    const before = FakeSocket.live.length;

    answerWith({ "POST /auth/login": { ok: true }, "/auth/status": { required: true, authenticated: true } });
    let why;
    await act(async () => {
      why = await view.result.current.signIn("a-password");
    });

    expect(why).toBeNull();
    expect(FakeSocket.live.length, "no new socket was opened").toBeGreaterThan(before);
    expect(view.result.current.needsSignIn).toBe(false);
  });

  it("returns the supervisor's own words when it refuses", async () => {
    /* "too many attempts, wait 32s" is the only clue that somebody else is
       trying, and a generic message would throw it away. */
    const view = await refused();
    answerWith({ "POST /auth/login": { ok: false, error: "too many attempts, wait 32s" } });
    let why;
    await act(async () => {
      why = await view.result.current.signIn("a-password");
    });
    expect(why).toBe("too many attempts, wait 32s");
    expect(view.result.current.needsSignIn).toBe(true);
  });

  it("stays on the login screen when the controller cannot be reached", async () => {
    const view = await refused();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    let why;
    await act(async () => {
      why = await view.result.current.signIn("a-password");
    });
    expect(why).toMatch(/Cannot reach the controller/);
  });
});
