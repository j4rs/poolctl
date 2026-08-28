// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, connect } from "./harness.test-utils.js";

/**
 * The supervisor as it actually ships: spawned with `node index.js`, talked
 * to over a real socket.
 *
 * Nothing is imported from `index.js` here, and that is the point. It has
 * top-level side effects — it loads the store, opens the njsPC link, starts
 * the heartbeat and binds the port — and those are exactly the things that
 * have gone wrong. Importing it would test a module; spawning it tests the
 * artifact the Pi runs.
 *
 * njsPC is pointed at a dead port throughout. That is not a limitation: it is
 * the state the system is in today, and it is also every restart, every
 * network blip and every njsPC upgrade. What matters is that the supervisor
 * stays useful and says so — refusals still arrive, preferences still change,
 * the heartbeat still beats. `binding.integration.test.js` is the other half,
 * with an njsPC that answers.
 */

/* Restated from index.js. `src/lib/useSupervisor.test.jsx` restates the
   client's tolerance against the same number; if either drifts, the pair
   fails, which is the whole defence against the threshold-shorter-than-the-
   heartbeat bug that shipped once already. */
const HEARTBEAT_MS = 5000;

/* ---- one long-lived supervisor for everything that does not mutate ----- */

describe("a supervisor that cannot reach njsPC", () => {
  let sup;
  let client;

  beforeAll(async () => {
    sup = await start();
    client = await connect(sup.port);
  }, 20000);

  afterAll(async () => {
    await client?.close();
    await sup?.stop();
  });

  describe("http surface", () => {
    it("answers /health while njsPC is down", async () => {
      /* The health check must describe the supervisor, not njsPC — otherwise
         a watchdog restarts a perfectly healthy process every time the pool
         controller reboots. */
      const body = await (await fetch(sup.url("/health"))).json();
      expect(body.ok).toBe(true);
      expect(body.njspc).toBe(false);
    });

    it("serves the current state over plain HTTP too", async () => {
      const body = await (await fetch(sup.url("/state"))).json();
      expect(body.connected).toBe(false);
      expect(body).toHaveProperty("targets");
    });

    it("renders the app for an unknown path rather than a 404", async () => {
      const res = await fetch(sup.url("/pump"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
    });

    it("cannot be talked out of its web root", async () => {
      for (const attack of [
        "/../../../../etc/passwd",
        "/%2e%2e/%2e%2e/%2e%2e/etc/passwd",
        "/..%2f..%2f..%2fetc%2fpasswd",
      ]) {
        const text = await (await fetch(sup.url(attack))).text();
        expect(text, attack).not.toMatch(/root:/);
      }
    });

    it("reports the njsPC link as down in the state it serves", async () => {
      const body = await (await fetch(sup.url("/state"))).json();
      expect(body.connected).toBe(false);
    });
  });

  describe("the intent protocol", () => {
    it("greets a new connection with the current state", async () => {
      /* Without this the first paint would wait a whole heartbeat. */
      expect(client.frames[0]).toMatchObject({ type: "state" });
    });

    it("echoes the reqId it was given", async () => {
      const ack = await client.intent("setPanelMode", { mode: "auto" });
      expect(ack.reqId).toBe(client.seq);
    });

    it("keeps concurrent intents apart", async () => {
      const acks = await Promise.all([
        client.intent("toggle", { key: "nonsense" }),
        client.intent("startProgram", { id: "no-such-program" }),
        client.intent("setRpm", { rpm: 2400 }),
      ]);
      const ids = acks.map((a) => a.reqId);
      expect(new Set(ids).size).toBe(3);
      expect(acks[0].error).toMatch(/nonsense/);
      expect(acks[1].error).toMatch(/no program/);
      expect(acks[2].error).toMatch(/manual circuit/);
    });

    it("correlates an intent whose args carry an id of their own", async () => {
      /* The collision that shipped: `args.id` flattened over the envelope's
         reqId, so this ack came back addressed to request 'skimming'. */
      const ack = await client.intent("startProgram", { id: "skimming" });
      expect(ack.reqId).toBe(client.seq);
      expect(typeof ack.reqId).toBe("number");
    });

    it("rejects a frame that is not JSON, without dropping the connection", async () => {
      const err = client.next((m) => m.type === "error");
      client.raw("<not json>");
      expect((await err).error).toBe("bad json");
      expect((await client.intent("setPanelMode", { mode: "auto" })).ok).toBe(true);
    });

    it("names an intent it does not implement", async () => {
      const ack = await client.intent("selfDestruct");
      expect(ack).toMatchObject({ ok: false });
      expect(ack.error).toBe("intent 'selfDestruct' not implemented in v0");
    });

    it("acks with a null reqId when the client sent none", async () => {
      const ack = client.next((m) => m.type === "ack");
      client.raw(JSON.stringify({ intent: "setPanelMode", args: { mode: "auto" } }));
      expect((await ack).reqId).toBeNull();
    });
  });

  describe("refusals, which are answers and not silence", () => {
    it("refuses a pump speed, and says the reason is architectural", async () => {
      /* njsPC has no runtime speed endpoint; the only lever rewrites what a
         circuit means permanently. Refusing is the design, not a gap. */
      const ack = await client.intent("setRpm", { rpm: 2400 });
      expect(ack.ok).toBe(false);
      expect(ack.error).toMatch(/dedicated manual circuit/);
    });

    it("reports the floor it would have applied when heat is called", async () => {
      const ack = await client.intent("setRpm", { rpm: 400 });
      expect(ack.error).toMatch(/dedicated manual circuit/);
    });

    it("refuses an unbound program with the reason it cannot bind", async () => {
      /* Not "see commissioning" any more: binding is something the supervisor
         does, so the refusal says what is actually in the way. Here njsPC is
         unreachable, so it has no pump to put a speed on. */
      const ack = await client.intent("startProgram", { id: "filtration" });
      expect(ack.ok).toBe(false);
      expect(ack.error).toMatch(/Filtration/);
      expect(ack.error).toMatch(/no pump is configured/);
    });

    it("refuses a program that does not exist", async () => {
      const ack = await client.intent("startProgram", { id: "ghost" });
      expect(ack.error).toBe("no program 'ghost'");
    });

    it("refuses to switch something that is not a switch", async () => {
      expect((await client.intent("toggle", { key: "heater" })).error).toBe(
        "cannot switch 'heater'",
      );
    });

    it("refuses the blower outside spa mode", async () => {
      /* Preference rather than safety — but the toggle is gated to spa, so a
         blower left running in pool mode is both on and unreachable. */
      const ack = await client.intent("toggle", { key: "blower" });
      expect(ack.ok).toBe(false);
      expect(ack.error).toBe("the blower only starts in spa mode");
    });

    it("refuses an unknown mode", async () => {
      expect((await client.intent("setMode", { mode: "jacuzzi" })).error).toBe(
        "unknown mode jacuzzi",
      );
    });

    it("refuses a target for a body it does not have", async () => {
      expect((await client.intent("setTarget", { body: "hot-tub", delta: 1 })).error).toBe(
        "unknown body hot-tub",
      );
    });

    it("passes an njsPC failure through instead of claiming success", async () => {
      /* This one really does try to reach njsPC, and njsPC is not there. The
         ack must carry that, or the UI shows a mode change that never
         happened. */
      const ack = await client.intent("setMode", { mode: "spa" });
      expect(ack.ok).toBe(false);
      expect(ack.error).toBeTruthy();
    });

    it("stays up after an intent throws", async () => {
      expect((await client.intent("setPanelMode", { mode: "auto" })).ok).toBe(true);
    });
  });
});

/* ---- state changes get their own process, so order cannot matter -------- */

describe("changing supervisor-owned state", () => {
  let sup;
  let client;

  beforeAll(async () => {
    sup = await start();
    client = await connect(sup.port);
  }, 20000);

  afterAll(async () => {
    await client?.close();
    await sup?.stop();
  });

  it("switches the light and publishes the change", async () => {
    const ack = await client.intent("toggle", { key: "light" });
    expect(ack.ok).toBe(true);
    expect((await client.state()).light).toBe(true);
  });

  it("switches it back", async () => {
    await client.intent("toggle", { key: "light" });
    expect((await client.state()).light).toBe(false);
  });

  it("accumulates stepper taps instead of losing all but one", async () => {
    const before = (await (await fetch(sup.url("/state"))).json()).targets.pool;
    await Promise.all([
      client.intent("setTarget", { body: "pool", delta: -1 }),
      client.intent("setTarget", { body: "pool", delta: -1 }),
      client.intent("setTarget", { body: "pool", delta: -1 }),
    ]);
    const after = (await (await fetch(sup.url("/state"))).json()).targets.pool;
    expect(after).toBe(before - 3);
  });

  it("clamps a target to the heater's own cap, however it is asked", async () => {
    /* ADR-4 lives on this side of the wire on purpose: a target arriving
       from Home Assistant, or from a replayed message, must not be able to
       ask for more heat than the heater allows. */
    for (let i = 0; i < 30; i++) await client.intent("setTarget", { body: "pool", delta: +5 });
    const { targets } = await (await fetch(sup.url("/state"))).json();
    expect(targets.pool).toBeLessThanOrEqual(95);
  });

  it("clamps the spa to its own, higher cap", async () => {
    for (let i = 0; i < 30; i++) await client.intent("setTarget", { body: "spa", delta: +5 });
    const { targets } = await (await fetch(sup.url("/state"))).json();
    expect(targets.spa).toBeLessThanOrEqual(104);
    expect(targets.spa).toBeGreaterThan(95);
  });

  it("adds a program and hands it back in state", async () => {
    const program = {
      id: "vacuum",
      name: "Vacuum",
      rpm: 2600,
      minutes: 45,
      circuit: null,
      isNew: true,
    };
    expect((await client.intent("saveProgram", { program })).ok).toBe(true);
    const { programs } = await (await fetch(sup.url("/state"))).json();
    expect(programs.map((p) => p.id)).toContain("vacuum");
    /* `isNew` is a form flag, not part of the program. */
    expect(programs.find((p) => p.id === "vacuum")).not.toHaveProperty("isNew");
  });

  it("edits a program in place rather than duplicating it", async () => {
    const program = { id: "vacuum", name: "Vacuum", rpm: 2800, minutes: 45, circuit: null };
    await client.intent("saveProgram", { program });
    const { programs } = await (await fetch(sup.url("/state"))).json();
    expect(programs.filter((p) => p.id === "vacuum")).toHaveLength(1);
    expect(programs.find((p) => p.id === "vacuum").rpm).toBe(2800);
  });

  it("refuses a program with no id", async () => {
    const ack = await client.intent("saveProgram", { program: { name: "Nameless" } });
    expect(ack.error).toBe("program needs an id");
  });

  it("deletes a program", async () => {
    expect((await client.intent("deleteProgram", { id: "vacuum" })).ok).toBe(true);
    const { programs } = await (await fetch(sup.url("/state"))).json();
    expect(programs.map((p) => p.id)).not.toContain("vacuum");
  });

  it("ships the two real activities on a fresh install", async () => {
    const { programs } = await (await fetch(sup.url("/state"))).json();
    expect(programs.map((p) => p.id)).toEqual(
      expect.arrayContaining(["filtration", "skimming"]),
    );
  });
});

/* ---- the heartbeat, measured rather than asserted ---------------------- */

describe("the heartbeat", () => {
  let sup;

  beforeAll(async () => {
    sup = await start();
  }, 20000);

  afterAll(async () => {
    await sup?.stop();
  });

  it("keeps sending frames although njsPC never says anything", async () => {
    /* njsPC only talks when something changes, so silence would otherwise be
       indistinguishable from a dead supervisor. The client decides it is
       offline by the absence of these. */
    const client = await connect(sup.port);
    const first = await client.state(HEARTBEAT_MS * 2);
    const second = await client.state(HEARTBEAT_MS * 2);
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    await client.close();
  }, 20000);

  it("never leaves a gap the client would read as offline", async () => {
    /* The shipped bug was arithmetic: a 12 s staleness threshold measuring a
       15 s poll, so the banner appeared in every quiet stretch. What the
       client actually depends on is this bound — the longest silence the
       supervisor ever produces — so that is what is measured, over a window
       long enough to contain several beats.

       Frames arrive faster than the heartbeat here, because a failing njsPC
       reconnect also publishes. That is the flapping case, and it only ever
       shortens the gap; the heartbeat is the ceiling. */
    const client = await connect(sup.port);
    const at = [];
    client.ws.on("message", (raw) => {
      if (JSON.parse(String(raw)).type === "state") at.push(Date.now());
    });

    await new Promise((r) => setTimeout(r, HEARTBEAT_MS * 2.5));
    await client.close();

    expect(at.length, "no frames at all").toBeGreaterThan(1);
    const gaps = at.slice(1).map((t, i) => t - at[i]);
    expect(Math.max(...gaps)).toBeLessThan(HEARTBEAT_MS * 1.4);
  }, 20000);

  it("serves several clients the same frame", async () => {
    const [a, b] = await Promise.all([connect(sup.port), connect(sup.port)]);
    const [x, y] = await Promise.all([a.state(HEARTBEAT_MS * 2), b.state(HEARTBEAT_MS * 2)]);
    expect(x).toEqual(y);
    await Promise.all([a.close(), b.close()]);
  }, 20000);
});

/* ---- restarts, which are the only test of what is worth keeping -------- */

describe("across a restart", () => {
  let dir;
  let stateFile;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "poolctl-restart-"));
    stateFile = join(dir, "state.json");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("remembers preferences", async () => {
    const first = await start({ stateFile });
    const client = await connect(first.port);
    await client.intent("setTarget", { body: "pool", delta: -4 });
    const chosen = (await (await fetch(first.url("/state"))).json()).targets.pool;
    await client.close();
    await first.term();

    const second = await start({ stateFile });
    const restored = (await (await fetch(second.url("/state"))).json()).targets.pool;
    await second.stop();
    expect(restored).toBe(chosen);
  }, 30000);

  it("forgets positions", async () => {
    /* Deliberate, and the reason is safety rather than laziness: boot leaves
       the heater off and re-drives the valves unconditionally, so restoring a
       remembered position would describe equipment that is not in it. */
    const first = await start({ stateFile });
    const client = await connect(first.port);
    await client.intent("toggle", { key: "light" });
    expect((await (await fetch(first.url("/state"))).json()).light).toBe(true);
    await client.close();
    await first.term();

    const second = await start({ stateFile });
    const after = await (await fetch(second.url("/state"))).json();
    await second.stop();
    expect(after.light).toBe(false);
  }, 30000);

  it("writes the preference file atomically, and only the durable parts", async () => {
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    expect(saved).toHaveProperty("targets");
    expect(saved).not.toHaveProperty("bypass");
    expect(saved).not.toHaveProperty("connected");
    expect(saved).not.toHaveProperty("light");
  });

  it("starts from defaults when the file is corrupt", async () => {
    /* A controller that will not boot because a preferences file is damaged
       is worse than one that boots with the defaults. */
    const broken = join(dir, "broken.json");
    await import("node:fs/promises").then((fs) => fs.writeFile(broken, "{ not json"));
    const sup = await start({ stateFile: broken });
    const body = await (await fetch(sup.url("/state"))).json();
    await sup.stop();
    expect(body.targets).toBeTruthy();
  }, 30000);
});

describe("a supervisor that has stopped thinking", () => {
  /**
   * The half of the watchdog `kill -STOP` cannot reach.
   *
   * A frozen process obviously stops pinging. The condition in
   * `evaluationHealth` was written for something subtler and more likely: a
   * process that is alive, bound, answering HTTP and holding sockets open,
   * whose evaluation loop has died. `SIGUSR2` manufactures exactly that.
   */
  /* `thinking` is false for the first few seconds of every boot — the first
     evaluation happens one heartbeat in, and until then there is genuinely
     nothing to report. Wait for it rather than sleeping a guess. The
     watchdog's own first tick is a third of its window away, so this window
     never costs a restart in production. */
  const thinking = async (sup, want, ms = HEARTBEAT_MS * 3) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const h = await (await fetch(sup.url("/health"))).json();
      if (h.thinking === want) return h;
      if (Date.now() > deadline) {
        throw new Error(`thinking never became ${want}: ${JSON.stringify(h)}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  it("keeps serving, stops publishing, and says it is not thinking", async () => {
    const sup = await start();
    const client = await connect(sup.port);
    await thinking(sup, true);

    sup.signal("SIGUSR2");
    /* Still a live HTTP server — this is the whole point. A dead process
       would be caught by anything; this one looks fine from the outside. */
    const after = await thinking(sup, false);
    expect(after.ok, "the process should still be answering").toBe(true);
    expect(after.why).toMatch(/last evaluation threw/);

    /* And it keeps talking to the phones. `evaluate()` is not the only
       caller of publish() — the njsPC link publishes on every reconnect
       attempt — so a client goes on receiving state from a supervisor that
       has stopped supervising. Asserted rather than merely noted, because it
       is the reason this endpoint needed a second field: "frames are still
       arriving" is not evidence that anything is being checked. */
    const seen = client.frames.length;
    await new Promise((r) => setTimeout(r, HEARTBEAT_MS + 1000));
    expect(client.frames.length, "the stream should not have gone quiet")
      .toBeGreaterThan(seen);

    await sup.stop();
  }, 40000);

  it("is one-way: a second signal changes nothing", async () => {
    /* A toggle would invite using this as a live switch. The only thing that
       clears the fault is a restart — which, on the Pi, the watchdog
       provides. */
    const sup = await start();
    await connect(sup.port);
    await thinking(sup, true);
    sup.signal("SIGUSR2");
    await thinking(sup, false);
    sup.signal("SIGUSR2");
    await new Promise((r) => setTimeout(r, HEARTBEAT_MS + 1000));

    const health = await (await fetch(sup.url("/health"))).json();
    expect(health.thinking).toBe(false);
    const armed = sup.output.join("").match(/SIGUSR2: evaluate\(\) will throw/g) ?? [];
    expect(armed, "should have armed once, not twice").toHaveLength(1);

    await sup.stop();
  }, 40000);
});

describe("shutting down", () => {
  it("exits on SIGTERM even with a browser still attached", async () => {
    /* systemd sends SIGTERM and waits. A supervisor that lingers because a
       phone left a socket open gets SIGKILLed instead, losing the flush that
       shutdown exists to perform. */
    const sup = await start();
    const client = await connect(sup.port);
    await client.state(HEARTBEAT_MS * 2);
    const how = await sup.term({ patience: 5000 });
    expect(how.signal, "was SIGKILLed, so it did not exit on its own").not.toBe("SIGKILL");
  }, 30000);
});
