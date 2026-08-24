// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import { NjsPC } from "./njspc.js";

/**
 * The njsPC link, against a real socket on a real port.
 *
 * Everything here is about the two questions the supervisor asks of this
 * class and cannot answer any other way: is the link up, and what happened to
 * the request. Both are decided by network behaviour — a 500, a hang, a
 * connection refused — so they are exercised with a server that produces
 * those, not with a stubbed `fetch`.
 *
 * `start()` is deliberately never called: it opens a socket.io connection,
 * and none of the logic below depends on it. Reads happen through `refresh()`
 * whether they were triggered by an event or by the poll.
 */

let server;
let url;
let handler;
/** Every request the fake njsPC received, in order. */
let seen;

beforeEach(async () => {
  seen = [];
  handler = (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ temps: { waterSensor1: 71 } }));
  };
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen.push({
      method: req.method,
      path: req.url,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null,
    });
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
});

/** An NjsPC wired to recording callbacks. */
function link(overrides = {}) {
  const states = [];
  const links = [];
  const njs = new NjsPC({
    url,
    onState: (s) => states.push(s),
    onLink: (up, why) => links.push({ up, why }),
    ...overrides,
  });
  return { njs, states, links };
}

describe("reading state", () => {
  it("hands njsPC's body through untouched", async () => {
    const { njs, states } = link();
    await njs.refresh();
    /* This class does no mapping. Reshaping is map.js's job, and doing any of
       it here would put a second copy of njsPC's model in the transport. */
    expect(states).toEqual([{ temps: { waterSensor1: 71 } }]);
  });

  it("reports the link up after a successful read", async () => {
    const { njs, links } = link();
    await njs.refresh();
    expect(links).toEqual([{ up: true, why: undefined }]);
  });

  it("asks for /state/all, and only that", async () => {
    const { njs } = link();
    await njs.refresh();
    expect(seen).toEqual([{ method: "GET", path: "/state/all", body: null }]);
  });
});

describe("when njsPC is unwell", () => {
  it("reports the link down on a 500, with the status", async () => {
    handler = (req, res) => res.writeHead(500).end("boom");
    const { njs, links } = link();
    await njs.refresh();
    expect(links).toEqual([{ up: false, why: "state/all 500" }]);
  });

  it("publishes no state at all on a failed read", async () => {
    handler = (req, res) => res.writeHead(500).end("boom");
    const { njs, states } = link();
    await njs.refresh();
    /* Half a reading is worse than none: the UI would render it as current. */
    expect(states).toEqual([]);
  });

  it("reports the link down when the body is not JSON", async () => {
    handler = (req, res) => res.writeHead(200).end("<html>proxy error</html>");
    const { njs, states, links } = link();
    await njs.refresh();
    expect(states).toEqual([]);
    expect(links[0].up).toBe(false);
  });

  it("reports the link down when nothing is listening", async () => {
    await new Promise((r) => server.close(r));
    const { njs, links } = link();
    await njs.refresh();
    expect(links[0].up).toBe(false);
    expect(links[0].why).toBeTruthy();
    server = createServer(() => {});
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
  });

  it("gives up on a wedged njsPC rather than hanging forever", async () => {
    /* A Pi that has lost the network keeps the connection open and never
       answers. Without the abort signal the supervisor would stop refreshing
       state permanently and never say why. */
    handler = () => {};
    const { njs, links } = link();
    const started = Date.now();
    await njs.refresh();
    expect(links[0].up).toBe(false);
    expect(Date.now() - started).toBeLessThan(7000);
  }, 10000);

  it("comes back up when njsPC does", async () => {
    handler = (req, res) => res.writeHead(503).end("starting");
    const { njs, links } = link();
    await njs.refresh();

    handler = (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    };
    await njs.refresh();
    expect(links.map((l) => l.up)).toEqual([false, true]);
  });
});

describe("not stampeding njsPC", () => {
  it("lets one read at a time reach the wire", async () => {
    /* njsPC on a Pi answers /state/all slowly enough that a burst of socket
       events would otherwise queue several full fetches behind each other. */
    let release;
    handler = (req, res) => {
      release = () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      };
    };
    const { njs } = link();
    const first = njs.refresh();
    await new Promise((r) => setTimeout(r, 20));
    await njs.refresh();
    await njs.refresh();
    expect(seen).toHaveLength(1);

    release();
    await first;
  });

  it("accepts the next read once the previous one lands", async () => {
    const { njs } = link();
    await njs.refresh();
    await njs.refresh();
    expect(seen).toHaveLength(2);
  });

  it("clears the guard even when the read failed", async () => {
    handler = (req, res) => res.writeHead(500).end("boom");
    const { njs } = link();
    await njs.refresh();

    handler = (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    };
    await njs.refresh();
    expect(seen).toHaveLength(2);
  });

  it("collapses a burst of events into a single read", async () => {
    const { njs } = link();
    for (let i = 0; i < 20; i++) njs.schedule();
    expect(seen).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 250));
    expect(seen).toHaveLength(1);
    njs.stop();
  });
});

describe("writing", () => {
  it("returns njsPC's parsed answer", async () => {
    handler = (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: 6, isOn: true }));
    };
    const { njs } = link();
    expect(await njs.setCircuit(6, true)).toEqual({ id: 6, isOn: true });
  });

  it("tolerates an empty 200", async () => {
    handler = (req, res) => res.writeHead(200).end();
    const { njs } = link();
    expect(await njs.setCircuit(6, true)).toBeNull();
  });

  it("throws with the path, the status and njsPC's own words", async () => {
    /* This message is what the operator eventually reads in a toast, so it
       has to carry the reason rather than just the failure. */
    handler = (req, res) => res.writeHead(400).end("Invalid circuit id 99");
    const { njs } = link();
    await expect(njs.setCircuit(99, true)).rejects.toThrow(
      "/state/circuit/setState 400: Invalid circuit id 99",
    );
  });

  it("truncates a runaway error body", async () => {
    handler = (req, res) => res.writeHead(500).end("x".repeat(5000));
    const { njs } = link();
    const err = await njs.setCircuit(6, true).catch((e) => e);
    expect(err.message.length).toBeLessThan(300);
  });

  it("sends the circuit call njsPC documents", async () => {
    const { njs } = link();
    await njs.setCircuit(6, true);
    expect(seen[0]).toEqual({
      method: "PUT",
      path: "/state/circuit/setState",
      body: { id: 6, state: true },
    });
  });

  it("sends a heat mode change against a body, not a circuit", async () => {
    const { njs } = link();
    await njs.setHeatMode(1, "heater");
    expect(seen[0]).toEqual({
      method: "PUT",
      path: "/state/body/heatMode",
      body: { id: 1, mode: "heater" },
    });
  });

  it("sends a setpoint against a body", async () => {
    const { njs } = link();
    await njs.setSetPoint(1, 88);
    expect(seen[0]).toEqual({
      method: "PUT",
      path: "/state/body/setPoint",
      body: { id: 1, setPoint: 88 },
    });
  });

  it("suspends schedules through njsPC's own manual priority", async () => {
    /* Not our own timer: njsPC owns schedules, so the stand-down has to be
       expressed in njsPC's terms or its next boundary will simply undo it. */
    const { njs } = link();
    await njs.setManualPriority(6);
    expect(seen[0]).toEqual({
      method: "PUT",
      path: "/state/manualOperationPriority",
      body: { id: 6 },
    });
  });
});

describe("shutting down", () => {
  it("is safe to stop a link that was never started", () => {
    const { njs } = link();
    expect(() => njs.stop()).not.toThrow();
  });

  it("cancels a scheduled read", async () => {
    const { njs } = link();
    njs.schedule();
    njs.stop();
    await new Promise((r) => setTimeout(r, 250));
    expect(seen).toHaveLength(0);
  });
});
