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

describe("the relay card", () => {
  /**
   * The only output that moves equipment, and until this slice no test had
   * ever looked at one. `hat` was null in every run — `available()` looks for
   * `/dev/i2c-1`, absent off the Pi — so `driveRelays()` returned immediately
   * and the path from an intent to a byte went unexercised. Both of the bugs
   * found on 29 August lived in that seam.
   *
   * The card is faked at the process boundary, so `hat.js` itself runs for
   * real: argument building, output parsing, write serialisation. Only the
   * two `i2c` binaries are ours.
   */
  it("de-energises everything before it serves anything", async () => {
    /* Whatever the card was holding through a crash, a kill or a power cut is
       not ours to inherit. This is the boot half of ADR-10, and it is a
       `force` rather than a `set` precisely because the shadow is empty and
       the card's real state is unknown. */
    const sup = await start({ card: true });
    await new Promise((r) => setTimeout(r, 1200));
    expect(await sup.card.writes()).toEqual([0x00]);
    await sup.stop();
  }, 30000);

  it("puts an intent on the card", async () => {
    /* The light is the whole path in one intent: supervisor state, no njsPC
       circuit, CH7. Bit 3 of the measured map, so 0x08 — a number that only
       comes out right if relays.js, hat.js and the byte the card holds all
       agree. */
    const sup = await start({ card: true });
    const client = await connect(sup.port);
    await client.state(HEARTBEAT_MS * 2);

    await client.intent("toggle", { key: "light" });
    await new Promise((r) => setTimeout(r, 800));
    expect(await sup.card.byte()).toBe(0x08);

    await client.intent("toggle", { key: "light" });
    await new Promise((r) => setTimeout(r, 800));
    expect(await sup.card.byte()).toBe(0x00);
    await sup.stop();
  }, 30000);

  it("de-energises on the way out, not just on the way in", async () => {
    /* `systemctl stop`, a deploy and a reboot all come through SIGTERM. A
       clean stop that left a coil energised would hand the next boot exactly
       the state boot refuses to trust. */
    const sup = await start({ card: true });
    const client = await connect(sup.port);
    await client.state(HEARTBEAT_MS * 2);
    await client.intent("toggle", { key: "light" });
    await new Promise((r) => setTimeout(r, 800));
    expect(await sup.card.byte()).toBe(0x08);

    await sup.term({ patience: 5000 });
    expect(await sup.card.byte()).toBe(0x00);
  }, 30000);

  it("writes once for one change", async () => {
    /* Concurrent publish() calls used to each pass the shadow check and all
       write — three lines in the journal for one change. Serialised now, and
       this is the assertion that would have caught it. */
    const sup = await start({ card: true });
    const client = await connect(sup.port);
    await client.state(HEARTBEAT_MS * 2);
    await client.intent("toggle", { key: "light" });
    await new Promise((r) => setTimeout(r, HEARTBEAT_MS + 1000));
    expect(await sup.card.writes()).toEqual([0x00, 0x08]);
    await sup.stop();
  }, 30000);
});

describe("the purge, at speed", () => {
  /**
   * A three-minute rule asserted in three seconds.
   *
   * `PURGE_MS` is the supervisor's own knob, not the spec's — `sequences.js`
   * goes on saying three minutes, and this says how long *this process* will
   * wait for it. Without it the release could only ever be checked by
   * watching a journal on the Pi, by hand, once; the hold was all a test
   * could reach.
   *
   * njsPC is at a dead port throughout, which is fine here: the purge is
   * driven by our own heat call and our own clock, and every boot starts one
   * because we cannot know whether the heater was firing a second before the
   * power went.
   */
  it("holds the bypass at boot, then releases it", async () => {
    const sup = await start({ card: true, purgeMs: 2500 });
    await sup.card.quiet();

    /* The whole point of seeding `purgeHolding` true: no 0x40 flash before
       the hold engages. Seeding only `heatEndedAt` left one, seen on the Pi. */
    expect(await sup.card.trace()).toEqual(["0x00  (all off)"]);

    /* Wait for the write, not for the clock.
     *
     * A fixed 3.5 s sleep lived here and failed on a slow runner. The purge
     * expiring is not what emits the write — `evaluate()` notices it on the
     * heartbeat, which is 5 s and deliberately not overridable, so a 2.5 s
     * purge is released somewhere between 2.5 s and 7.5 s after boot
     * depending on where the beat lands. The sleep assumed the lucky end of
     * that range and was right most of the time, which is the worst way for
     * a test to be wrong. */
    const deadline = Date.now() + 20000;
    while ((await sup.card.trace()).length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    await sup.card.quiet();
    /* njsPC is unreachable, so mode reads pool and the released bypass goes
       around the heater — REL3, the one coil held energised in normal pool
       running. */
    expect(await sup.card.trace()).toEqual(["0x00  (all off)", "0x40  REL3"]);
    await sup.stop();
  }, 40000);

  it("reports how long it is holding for", async () => {
    /* Not on the first frame: that is published when njsPC connects, before
       the first evaluation, and `purgeUntil` is set by the evaluation. */
    const sup = await start({ card: true, purgeMs: 60_000 });
    const client = await connect(sup.port);
    const held = await client.next(
      (m) => m.type === "state" && m.state.purgeUntil != null, HEARTBEAT_MS * 3);
    expect(held.state.purgeUntil).toBeGreaterThan(Date.now());
    await sup.stop();
  }, 30000);
});

describe("the watchdog, at speed", () => {
  /**
   * `WATCHDOG_USEC` is systemd's own variable, so compressing it needs no new
   * knob — the supervisor already reads it and is inert when it is absent.
   *
   * What can be asserted here is the *withholding*, which is the decision
   * this process makes. The kill that follows is systemd's, and there is no
   * systemd in a test; on the Pi it was verified by watching a wedged
   * supervisor be SIGABRTed at 51 s.
   */
  it("withholds, recovers, and withholds again for a new reason", async () => {
    /* A 3 s window, so the watchdog ticks every second and the whole cycle
       fits in one test.
     *
     * The order matters and writing this found it. The first tick happens
     * before the first evaluation, so the watchdog withholds immediately for
     * "no evaluation has completed yet" — and the say-once rule then hides
     * anything that goes wrong afterwards. On the Pi that never shows,
     * because the window is 60 s and the first tick is 20 s in, by which time
     * an evaluation has long since landed. So wait for health before breaking
     * anything, or the test asserts the boot condition and nothing else.
     */
    const sup = await start({ watchdogUsec: 3_000_000 });
    const healthy = async () => {
      for (let i = 0; i < 60; i++) {
        const h = await (await fetch(sup.url("/health"))).json();
        if (h.thinking) return;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error("never became healthy");
    };
    await healthy();

    sup.signal("SIGUSR2");
    for (let i = 0; i < 40 && !/last evaluation threw/.test(sup.output.join("")); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }

    const log = sup.output.join("");
    /* Withheld at boot for want of an evaluation, resumed when one landed,
       and withheld again once they started throwing. Three states, and the
       reason changes with them — a bare "unhealthy" would not explain the
       kill that follows. */
    expect(log).toMatch(/withholding the ping — no evaluation has completed yet/);
    expect(log).toMatch(/healthy again, resuming/);
    expect(log).toMatch(/withholding the ping — last evaluation threw/);
    await sup.stop();
  }, 30000);

  it("is inert when systemd is not watching", async () => {
    /* Running by hand, or in every other test in this file. */
    const sup = await start();
    const client = await connect(sup.port);
    await client.state(HEARTBEAT_MS * 2);
    expect(sup.output.join("")).not.toMatch(/watchdog:/);
    await sup.stop();
  }, 30000);
});

describe("when the card misbehaves", () => {
  /**
   * Every recovery path here was written from reasoning and verified, if at
   * all, by breaking something on the Pi over SSH. The drift corrector was
   * found that way — and it was found only *after* it had shipped, undone a
   * legitimate relay change, and reported a hardware fault that had not
   * happened.
   */
  const logOf = (sup) => sup.output.join("");

  it("notices a card holding something nobody asked for, and puts it back", async () => {
    const sup = await start({ card: true, purgeMs: 500 });
    /* Wait for the boot purge to release rather than guessing at it: the hold
       expires on our clock but the valve moves on an evaluation, so a short
       PURGE_MS still lands on the next heartbeat. 0x40 is settled pool. */
    const settled = 0x40;
    for (let i = 0; i < 40 && (await sup.card.byte()) !== settled; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(await sup.card.byte()).toBe(settled);

    await sup.card.poke(0x02);        /* REL8 — the spare, which nothing sets */
    /* Two passes: one to notice and re-assert, the next to confirm. Up to two
       heartbeats, so poll rather than sleep on a guess. */
    for (let i = 0; i < 60 && !/back in agreement/.test(logOf(sup)); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(await sup.card.byte(), "the card should have been put back").toBe(settled);
    expect(logOf(sup)).toMatch(/drifted — card reads 0x02  REL8/);
    expect(logOf(sup)).toMatch(/back in agreement/);
    await sup.stop();
  }, 30000);

  it("does not call a write landing inside a read a drift", async () => {
    /* The bug this slice exists for. `verifyRelays` sampled what it expected
       *before* spawning `i2cget`, so a write during the read produced a fresh
       card against a stale expectation: reported as a hardware fault, counted
       against the card, and re-asserted — undoing a change the supervisor had
       just made on purpose.
     *
     * Deterministic rather than hopeful: the read announces itself, the test
     * waits for one to be open, and only then changes the byte. */
    const sup = await start({ card: true, purgeMs: 500 });
    const client = await connect(sup.port);
    await client.state(HEARTBEAT_MS * 2);
    await new Promise((r) => setTimeout(r, 1500));
    await sup.card.quiet();

    await sup.card.setReadDelay(2500);
    await sup.card.whileReading();
    await client.intent("toggle", { key: "light" });
    await new Promise((r) => setTimeout(r, 4000));

    expect(logOf(sup), "a legitimate write is not a drift").not.toMatch(/drifted/);
    await sup.card.setReadDelay(0);
    await sup.stop();
  }, 30000);

  it("keeps supervising a card that has gone away, and says so once", async () => {
    /* A dead card must not take the process with it. The invariants still
       want checking and the phones still want state — what is lost is the
       ability to move anything, and that is worth exactly one line. */
    const sup = await start({ card: true });
    const client = await connect(sup.port);
    await client.state(HEARTBEAT_MS * 2);

    await sup.card.setFailing(true);
    await client.intent("toggle", { key: "light" });
    await client.intent("toggle", { key: "light" });
    await new Promise((r) => setTimeout(r, HEARTBEAT_MS + 1500));

    const health = await (await fetch(sup.url("/health"))).json();
    expect(health.ok, "the supervisor must survive its card").toBe(true);
    expect(health.thinking, "and keep evaluating").toBe(true);
    expect(logOf(sup).match(/relay card: (write|read) failed/g).length)
      .toBeLessThanOrEqual(2);
    await sup.card.setFailing(false);
    await sup.stop();
  }, 30000);

  it("does not invent a drift out of a failed read", async () => {
    /* A read that cannot be done tells us nothing about the card. Treating
       "no answer" as "wrong answer" would raise a hardware fault every time
       the bus was busy, and then re-assert on the strength of it. */
    const sup = await start({ card: true, purgeMs: 500 });
    await new Promise((r) => setTimeout(r, 1500));
    await sup.card.setFailing(true);
    await new Promise((r) => setTimeout(r, HEARTBEAT_MS + 2000));

    expect(logOf(sup)).not.toMatch(/drifted/);
    await sup.card.setFailing(false);
    await sup.stop();
  }, 30000);
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
