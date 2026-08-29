// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer } from "node:http";
import { Server as SocketServer } from "socket.io";
import { start, connect } from "./harness.test-utils.js";

/* Each test spawns a supervisor and waits on real socket round trips, so the
   5 s default is not enough to distinguish slow from broken. */
vi.setConfig({ testTimeout: 20000, hookTimeout: 30000 });

/**
 * Binding a program, against an njsPC that answers.
 *
 * The fake below is not a stub of our own calls — it is a small
 * reimplementation of the four njsPC behaviours the binding depends on, each
 * read out of njsPC 10.0.1 and each verified once by hand against a running
 * instance before being written down here:
 *
 *   - `PUT /config/circuit` with `id: 0` allocates, skipping 1 and 6
 *   - `PUT /config/pump` replaces the pump wholesale, circuits included
 *   - a circuit's `endTime` comes from its egg timer, and njsPC owns it
 *   - `/state/all` reports the pump's range and its expanded type
 *
 * If njsPC ever stops behaving this way, these tests keep passing and are
 * wrong — which is the standing risk with any fake. The mitigation is that
 * every behaviour above is also asserted in `binding.test.js` against the
 * shapes njsPC actually returned, and the comment there names the source.
 */

/** Enough of njsPC to bind a program to. */
function fakeNjspc() {
  const circuits = [
    { id: 6, name: "Pool", type: 12, isOn: true, isActive: true, eggTimer: 720 },
    { id: 1, name: "Spa", type: 13, isOn: false, isActive: true, eggTimer: 120 },
  ];
  /* The pump in its *config* shape — flat circuit ids. `/state/all` expands
     these into objects, which is why the two are built separately below. */
  let pumpCircuits = [
    { id: 1, circuit: 6, speed: 1600, units: 0 },
    { id: 2, circuit: 1, speed: 2800, units: 0 },
  ];
  const TYPE = {
    val: 4, name: "vsf", minSpeed: 450, maxSpeed: 3450, maxCircuits: 8,
  };
  const writes = [];
  let io;

  let temps = { temp: 84, heatStatus: { name: "off" } };
  let pumpRpm;

  /* Whether the Spa circuit is on, which in njsPC's shared-body model is the
     single fact that decides the body, the valve mode and both diverters. */
  const spaOn = () => Boolean(circuits.find((c) => c.id === 1)?.isOn);

  /**
   * One place a circuit changes, whoever asked.
   *
   * Deliberately shared between the supervisor's route and the helpers that
   * let a test act *as* njsPC. If the two diverged, the fake would behave one
   * way when driven and another when it moved on its own — which is precisely
   * the asymmetry these tests exist to look for, and it would be hidden
   * inside the instrument.
   */
  const setCircuitState = (id, on) => {
    const c = circuits.find((x) => x.id === id);
    if (!c) return null;
    c.isOn = on;
    c.endTime = on && c.eggTimer
      ? new Date(Date.now() + c.eggTimer * 60000).toISOString()
      : undefined;
    /* Shared bodies are exclusive: njsPC turns the other one off rather than
       running both. */
    if (on && (id === 1 || id === 6)) {
      const other = circuits.find((x) => x.id === (id === 1 ? 6 : 1));
      if (other) { other.isOn = false; other.endTime = undefined; }
    }
    return c;
  };

  const stateAll = () => ({
    circuits,
    /* njsPC's panel mode — what `toggleServiceMode` flips and what the
       supervisor reads back to decide whether a toggle is even needed. */
    mode: { val: panelMode === "service" ? 1 : 0, name: panelMode, desc: panelMode },
    /* Derived, as njsPC does it: turning on the Spa circuit switches the
       body and the valve mode with it — the nxps shared-body behaviour that
       ADR-10 is built around. Hardcoding "pool" here made a mode-change test
       silently unprovable. */
    valveMode: { name: spaOn() ? "spa" : "pool" },
    temps: { bodies: [{ id: 1, isOn: true, ...temps }] },
    pumps: [{
      id: 50, name: "IntelliFlo", isActive: true, minSpeed: 450, maxSpeed: 3450,
      type: TYPE,
      ...(pumpRpm === undefined ? {} : { rpm: pumpRpm }),
      circuits: pumpCircuits.map((pc) => ({
        ...pc,
        circuit: { id: pc.circuit, isOn: Boolean(circuits.find((c) => c.id === pc.circuit)?.isOn) },
      })),
    }],
    /* njsPC's `nxps` shared-body model diverts both valves when the body
       switches — the behaviour ADR-10 is built around, and it happens in the
       same tick because njsPC has no travel model. Returning `valves: []`
       here made the fake claim the opposite: the spa heat contact closed
       while the valves still read pool, which is an ordering fault the real
       controller cannot produce. Found by the first trace assertion. */
    valves: [
      { id: 1, isIntake: true, isDiverted: spaOn() },
      { id: 2, isReturn: true, isDiverted: spaOn() },
    ],
    chlorinators: [], delays: [],
  });

  let options = { pumpDelay: true, valveDelayTime: 45 };
  let panelMode = "auto";

  const routes = {
    "GET /state/all": () => stateAll(),
    /* Where njsPC keeps the settings the commissioning check reads. */
    /* `pumps` and `valves` mirror what real njsPC returns here — measured on
       the rig, 29 August 2026. They were `pumps: []` and absent respectively,
       written as filler, which made this fixture claim there was no pump
       while every other route served pump 50. The commissioning check for a
       missing pump found the contradiction. */
    "GET /config/all": () => ({
      pool: { options },
      circuits,
      pumps: [{ id: 50, name: "IntelliFlo", type: TYPE, isActive: true }],
      valves: [
        { id: 1, name: "Intake", connectionId: "", deviceBinding: "" },
        { id: 2, name: "Return", connectionId: "", deviceBinding: "" },
      ],
    }),
    "GET /config/options/pumps": () => ({
      pumpTypes: [TYPE],
      pumps: [{
        id: 50, name: "IntelliFlo", type: 4, address: 96, isActive: true,
        minSpeed: 450, maxSpeed: 3450, circuits: pumpCircuits,
      }],
    }),
    "GET /config/circuit/1": () => {
      const c = circuits.find((x) => x.id === 1);
      return { id: c.id, name: c.name, type: c.type, eggTimer: c.eggTimer, showInFeatures: false, freeze: false };
    },
    "PUT /config/circuit": (body) => {
      let id = Number(body.id);
      if (!id || id <= 0) {
        /* njsPC allocates the next free id and excludes the body circuits. */
        id = 2;
        while (circuits.some((c) => c.id === id) || id === 1 || id === 6) id += 1;
      }
      const existing = circuits.find((c) => c.id === id);
      const circuit = existing ?? { id, isOn: false, isActive: true };
      Object.assign(circuit, {
        name: body.name ?? circuit.name,
        type: body.type ?? 0,
        eggTimer: body.eggTimer ?? 0,
      });
      if (!existing) circuits.push(circuit);
      /* njsPC recomputes a running circuit's end time on a config write —
         `setEndTime(..., bForce = true)`. This is the whole mechanism behind
         extending a spa session, so the fake has to model it. */
      if (circuit.isOn && circuit.eggTimer) {
        circuit.endTime = new Date(Date.now() + circuit.eggTimer * 60000).toISOString();
      }
      return circuit;
    },
    "DELETE /config/circuit": (body) => {
      const i = circuits.findIndex((c) => c.id === Number(body.id));
      if (i < 0) return { id: body.id };
      return circuits.splice(i, 1)[0];
    },
    "PUT /config/pump": (body) => {
      /* The destructive part, faithfully: whatever arrives replaces what is
         there, and an absent `circuits` key blanks the list. */
      pumpCircuits = (body.circuits ?? []).map((c, i) => ({ ...c, id: i + 1 }));
      return { id: 50, circuits: pumpCircuits };
    },
    /**
     * Service mode, with njsPC's own defect reproduced.
     *
     * The real handler works out the mode into a local object and then calls
     * `setPanelModeAsync(req.body)` — the untouched body — so an empty body
     * fails validation even though the endpoint is a toggle. The supervisor
     * sent `{}` for months and every tap returned 400 against real njsPC
     * while passing here, because this fake did not have the route at all.
     *
     * Faithful beats convenient: a fake that accepts what the real thing
     * rejects is not a test, it is a second implementation that agrees with
     * you.
     */
    "PUT /state/toggleServiceMode": (body) => {
      if (!body || typeof body.mode === "undefined") {
        throw Object.assign(new Error("Invalid mode value cannot set mode"), { status: 400 });
      }
      panelMode = panelMode === "auto" ? "service" : "auto";
      return { mode: { val: panelMode === "service" ? 1 : 0, name: panelMode } };
    },
    "PUT /state/circuit/setState": (body) => {
      const c = setCircuitState(Number(body.id), Boolean(body.state));
      if (!c) throw Object.assign(new Error("circuit not found"), { status: 404 });
      return c;
    },
  };

  const http = createServer(async (req, res) => {
    const path = req.url.split("?")[0];
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    let route = routes[`${req.method} ${path}`];
    /* `/config/circuit/:id` — where eggTimer lives. It is not in
       `/state/all`, which is why the commissioning check reads it. */
    const one = req.method === "GET" && path.match(/^\/config\/circuit\/(\d+)$/);
    if (one) route = () => circuits.find((c) => c.id === Number(one[1])) ?? {};
    if (!route) {
      res.writeHead(404).end("not found");
      return;
    }
    if (req.method !== "GET") writes.push({ path, body });
    try {
      const out = route(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
      /* Any change makes njsPC talk, which is what prompts a refetch. */
      if (req.method !== "GET") io.emit("circuit", {});
    } catch (err) {
      res.writeHead(err.status ?? 500).end(err.message);
    }
  });
  io = new SocketServer(http, { cors: { origin: "*" } });

  return {
    async listen() {
      await new Promise((r) => http.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${http.address().port}`;
    },
    async close() {
      await io.close();
      await new Promise((r) => http.close(r));
    },
    circuits: () => circuits,
    pumpCircuits: () => pumpCircuits,
    writes: () => writes,
    /* njsPC only speaks when something changes, and the supervisor only
       refetches when it hears. A test that reaches in and edits state has to
       say so, or it is waiting on the 15 s poll and calling that a race. */
    touch: () => io.emit("circuit", {}),

    /**
     * njsPC changing something by itself.
     *
     * A schedule firing, an egg timer expiring, dashPanel writing a circuit —
     * from the supervisor's side these are indistinguishable, and all of them
     * arrive as "the body is different now and nobody asked us". ADR-11 is
     * entirely about this, and it has already produced a real bug: the card
     * came out 0x65, spa valves with the exchanger still bypassed, because
     * the bypass was remembered from the last *intent* rather than derived
     * from what was true.
     */
    switchBody: (mode) => {
      setCircuitState(mode === "spa" ? 1 : 6, true);
      io.emit("circuit", {});
    },
    /** The Spa circuit's egg timer running out — njsPC's spa auto-revert. */
    expireSpa: () => {
      setCircuitState(1, false);
      setCircuitState(6, true);
      io.emit("circuit", {});
    },
    setTemps: (patch) => {
      temps = { ...temps, ...patch };
      io.emit("body", {});
    },
    setPumpRpm: (rpm) => {
      pumpRpm = rpm;
      io.emit("pump", {});
    },
    setOptions: (patch) => {
      options = { ...options, ...patch };
      io.emit("config", {});
    },
    setSpaEggTimer: (minutes) => {
      circuits.find((c) => c.id === 1).eggTimer = minutes;
      io.emit("circuit", {});
    },
    fillPump: () => {
      pumpCircuits = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, circuit: 20 + i, speed: 1000 }));
      io.emit("pump", {});
    },
  };
}

let njspc;
let sup;
let client;

beforeEach(async () => {
  njspc = fakeNjspc();
  sup = await start({ njspcUrl: await njspc.listen(), card: true });
  client = await connect(sup.port);
  /* Wait for real state, not merely for the link.
   *
   * `connected` flips true the moment the socket.io connection opens, which
   * is before the first `/state/all` has landed — so a bind issued on that
   * signal alone finds no pump and refuses. `pumpLimits` is only non-null
   * once njsPC's state has actually been read. */
  await client.next((m) => m.type === "state" && m.state.pumpLimits != null, 8000);
}, 25000);

afterEach(async () => {
  await client?.close();
  await sup?.stop();
  await njspc?.close();
});

/** The state as the supervisor currently sees it. */
const now = async () => (await (await fetch(sup.url("/state"))).json());

/**
 * Findings about njsPC's settings, which is what this suite is about.
 *
 * The supervisor also reports that no password is set — true of every
 * spawned test supervisor, and covered properly in `auth.integration.test.js`
 * rather than asserted around here.
 */
const njspcFindings = (state) =>
  (state.commissioning ?? []).filter((f) => f.id !== "no-password");

/** Wait until `check` holds of a published state frame. */
const settles = (check, ms = 6000) =>
  client.next((m) => m.type === "state" && check(m.state), ms).then((m) => m.state);

describe("binding a program", () => {
  it("reads the pump's real limits off njsPC", async () => {
    expect((await now()).pumpLimits).toEqual({
      pumpId: 50, minSpeed: 450, maxSpeed: 3450, maxCircuits: 8, used: 2,
    });
  });

  it("starts unbound", async () => {
    const { programs } = await now();
    expect(programs.every((p) => p.circuit == null)).toBe(true);
  });

  it("creates a circuit and gives it the program's name and expiry", async () => {
    expect((await client.intent("bindProgram", { id: "skimming" })).ok).toBe(true);
    const circuit = njspc.circuits().find((c) => c.name === "Skimming");
    expect(circuit).toBeTruthy();
    expect(circuit.eggTimer).toBe(30);
    /* Generic, not a body: a skim must not switch the pool over. */
    expect(circuit.type).toBe(0);
    /* Allocated around the body circuits njsPC reserves. */
    expect(circuit.id).not.toBe(1);
    expect(circuit.id).not.toBe(6);
  });

  it("puts the speed on the pump", async () => {
    await client.intent("bindProgram", { id: "skimming" });
    const circuit = njspc.circuits().find((c) => c.name === "Skimming");
    expect(njspc.pumpCircuits()).toContainEqual(
      expect.objectContaining({ circuit: circuit.id, speed: 2100, units: 0 }),
    );
  });

  it("leaves the speeds the schedules run on alone", async () => {
    /* The destructive-write guard. `PUT /config/pump` replaces the circuit
       list, so a partial body would silently delete Pool and Spa. */
    await client.intent("bindProgram", { id: "skimming" });
    expect(njspc.pumpCircuits()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ circuit: 6, speed: 1600 }),
        expect.objectContaining({ circuit: 1, speed: 2800 }),
      ]),
    );
  });

  it("remembers the circuit against the program", async () => {
    await client.intent("bindProgram", { id: "skimming" });
    const state = await settles((s) => s.programs.find((p) => p.id === "skimming")?.circuit != null);
    const skimming = state.programs.find((p) => p.id === "skimming");
    expect(skimming.circuit).toBe(njspc.circuits().find((c) => c.name === "Skimming").id);
    expect(skimming.bindError).toBeNull();
  });

  it("consumes a pump slot", async () => {
    await client.intent("bindProgram", { id: "skimming" });
    await settles((s) => s.pumpLimits.used === 3);
    expect((await now()).pumpLimits.used).toBe(3);
  });

  it("binds each program to its own circuit", async () => {
    await client.intent("bindProgram", { id: "skimming" });
    await client.intent("bindProgram", { id: "filtration" });
    const ids = (await now()).programs.map((p) => p.circuit);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain(null);
  });

  it("is idempotent — rebinding updates rather than piling up circuits", async () => {
    await client.intent("bindProgram", { id: "skimming" });
    const first = (await now()).programs.find((p) => p.id === "skimming").circuit;
    await client.intent("bindProgram", { id: "skimming" });
    const again = (await now()).programs.find((p) => p.id === "skimming").circuit;

    expect(again).toBe(first);
    expect(njspc.circuits().filter((c) => c.name === "Skimming")).toHaveLength(1);
    expect(njspc.pumpCircuits().filter((c) => c.circuit === first)).toHaveLength(1);
  });
});

describe("binding as a side effect of saving", () => {
  it("binds a program the moment it is saved", async () => {
    const program = { id: "vacuum", name: "Vacuum", rpm: 2600, minutes: 45, isNew: true };
    expect((await client.intent("saveProgram", { program })).ok).toBe(true);
    await settles((s) => s.programs.find((p) => p.id === "vacuum")?.circuit != null);
    expect(njspc.circuits().find((c) => c.name === "Vacuum")).toBeTruthy();
  });

  it("pushes a rename and a new speed through to njsPC", async () => {
    await client.intent("bindProgram", { id: "skimming" });
    const circuit = (await now()).programs.find((p) => p.id === "skimming").circuit;

    await client.intent("saveProgram", {
      program: { id: "skimming", name: "Surface skim", rpm: 2400, minutes: 45 },
    });
    await settles((s) => s.programs.find((p) => p.id === "skimming")?.rpm === 2400);

    const c = njspc.circuits().find((x) => x.id === circuit);
    expect(c.name).toBe("Surface skim");
    expect(c.eggTimer).toBe(45);
    expect(njspc.pumpCircuits().find((x) => x.circuit === circuit).speed).toBe(2400);
  });

  it("keeps the circuit when the editor sends no circuit field", async () => {
    /* The editor never sends one. Dropping it on save would orphan the
       circuit in njsPC and quietly create a second. */
    await client.intent("bindProgram", { id: "skimming" });
    const before = (await now()).programs.find((p) => p.id === "skimming").circuit;
    await client.intent("saveProgram", {
      program: { id: "skimming", name: "Skimming", rpm: 2100, minutes: 30 },
    });
    await settles((s) => s.programs.find((p) => p.id === "skimming")?.name === "Skimming");
    expect((await now()).programs.find((p) => p.id === "skimming").circuit).toBe(before);
    expect(njspc.circuits().filter((c) => c.name === "Skimming")).toHaveLength(1);
  });
});

describe("running a bound program", () => {
  it("turns its circuit on", async () => {
    await client.intent("bindProgram", { id: "skimming" });
    const circuit = (await now()).programs.find((p) => p.id === "skimming").circuit;
    expect((await client.intent("startProgram", { id: "skimming" })).ok).toBe(true);
    expect(njspc.circuits().find((c) => c.id === circuit).isOn).toBe(true);
  });

  it("reports it as running, with njsPC's own expiry", async () => {
    /* `endsAt` is read back from the circuit's `endTime` rather than computed
       here. The egg timer is what actually stops the program, so a second
       copy of it would only ever drift. */
    await client.intent("bindProgram", { id: "skimming" });
    await client.intent("startProgram", { id: "skimming" });
    const state = await settles((s) => s.activeProgram != null);

    expect(state.activeProgram).toMatchObject({ id: "skimming", name: "Skimming", rpm: 2100 });
    const minutesLeft = (state.activeProgram.endsAt - Date.now()) / 60000;
    expect(minutesLeft).toBeGreaterThan(28);
    expect(minutesLeft).toBeLessThanOrEqual(30);
  });

  it("commands the higher of the speeds that are on", async () => {
    /* `setTargetSpeed` takes the max across active circuits: Pool is on at
       1600, so a 2100 skim wins. Reporting 1600 would put the screen at odds
       with the equipment. */
    await client.intent("bindProgram", { id: "skimming" });
    await client.intent("startProgram", { id: "skimming" });
    const state = await settles((s) => s.activeProgram != null);
    expect(state.pumpCommandedRpm).toBe(2100);
  });

  it("stops it again", async () => {
    await client.intent("bindProgram", { id: "skimming" });
    await client.intent("startProgram", { id: "skimming" });
    await settles((s) => s.activeProgram != null);

    expect((await client.intent("stopProgram")).ok).toBe(true);
    const state = await settles((s) => s.activeProgram == null);
    expect(state.activeProgram).toBeNull();
  });

  it("notices a program that was started outside the app", async () => {
    /* Because the running program is read out of njsPC rather than
       remembered, dashPanel turning the circuit on shows up here too. */
    await client.intent("bindProgram", { id: "skimming" });
    const circuit = (await now()).programs.find((p) => p.id === "skimming").circuit;
    njspc.circuits().find((c) => c.id === circuit).isOn = true;
    njspc.touch();
    const state = await settles((s) => s.activeProgram != null, 8000);
    expect(state.activeProgram.id).toBe("skimming");
  });
});

describe("deleting a bound program", () => {
  it("takes the circuit back out of njsPC", async () => {
    await client.intent("bindProgram", { id: "skimming" });
    const circuit = (await now()).programs.find((p) => p.id === "skimming").circuit;

    expect((await client.intent("deleteProgram", { id: "skimming" })).ok).toBe(true);
    expect(njspc.circuits().find((c) => c.id === circuit)).toBeUndefined();
  });

  it("takes the speed off the pump too, and leaves the rest", async () => {
    /* Pump first, then the circuit: the other order leaves the pump holding
       an id that no longer resolves, and `setTargetSpeed` reads every entry
       on every poll. */
    await client.intent("bindProgram", { id: "skimming" });
    const circuit = (await now()).programs.find((p) => p.id === "skimming").circuit;
    await client.intent("deleteProgram", { id: "skimming" });

    expect(njspc.pumpCircuits().find((c) => c.circuit === circuit)).toBeUndefined();
    expect(njspc.pumpCircuits().map((c) => c.circuit)).toEqual([6, 1]);
  });

  it("frees the slot", async () => {
    await client.intent("bindProgram", { id: "skimming" });
    await settles((s) => s.pumpLimits.used === 3);
    await client.intent("deleteProgram", { id: "skimming" });
    await settles((s) => s.pumpLimits.used === 2);
    expect((await now()).pumpLimits.used).toBe(2);
  });
});

describe("when binding cannot happen", () => {
  it("keeps the program but records why", async () => {
    /* Defining a program is a preference and must work regardless; only
       running it needs njsPC. */
    const program = { id: "fast", name: "Too fast", rpm: 5000, minutes: 30, isNew: true };
    expect((await client.intent("saveProgram", { program })).ok).toBe(true);

    const state = await settles((s) => s.programs.some((p) => p.id === "fast"));
    const saved = state.programs.find((p) => p.id === "fast");
    expect(saved.circuit).toBeNull();
    expect(saved.bindError).toMatch(/450–3450/);
  });

  it("refuses the retry with the same reason", async () => {
    await client.intent("saveProgram", {
      program: { id: "fast", name: "Too fast", rpm: 5000, minutes: 30, isNew: true },
    });
    const ack = await client.intent("bindProgram", { id: "fast" });
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/450–3450/);
  });

  it("refuses to run it, saying what is wrong rather than that it is unbound", async () => {
    await client.intent("saveProgram", {
      program: { id: "fast", name: "Too fast", rpm: 5000, minutes: 30, isNew: true },
    });
    const ack = await client.intent("startProgram", { id: "fast" });
    expect(ack.error).toMatch(/Too fast/);
    expect(ack.error).toMatch(/450–3450/);
  });

  it("clears the reason once the program is fixed", async () => {
    await client.intent("saveProgram", {
      program: { id: "fast", name: "Too fast", rpm: 5000, minutes: 30, isNew: true },
    });
    await settles((s) => s.programs.find((p) => p.id === "fast")?.bindError != null);

    await client.intent("saveProgram", {
      program: { id: "fast", name: "Brisk", rpm: 2800, minutes: 30 },
    });
    const state = await settles((s) => s.programs.find((p) => p.id === "fast")?.circuit != null);
    expect(state.programs.find((p) => p.id === "fast").bindError).toBeNull();
  });

  it("refuses when the pump has no room left", async () => {
    /* Eight circuits is the pump type's limit, and njsPC silently ignores
       everything past it rather than complaining. */
    njspc.fillPump();
    await settles((s) => s.pumpLimits.used === 8, 8000);
    const ack = await client.intent("bindProgram", { id: "skimming" });
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/8/);
  });
});

describe("service mode", () => {
  /**
   * The maintenance switch, and it was broken against real njsPC for months.
   *
   * The supervisor sent an empty body to `toggleServiceMode`. njsPC works the
   * mode out into a local object and then validates `req.body` instead, so an
   * empty body is rejected with "Invalid mode value cannot set mode" — every
   * tap a 400. Nothing failed here because the fake njsPC had no such route
   * and the intent was never exercised end to end.
   */

  const toggles = () =>
    njspc.writes().filter((w) => w.path === "/state/toggleServiceMode");

  it("actually reaches service mode", async () => {
    const ack = await client.intent("setPanelMode", { mode: "service" });
    expect(ack.ok, ack.error).toBe(true);
    expect((await settles((s) => s.panelMode === "service")).panelMode).toBe("service");
  });

  it("sends a mode, because an empty body is refused", async () => {
    /* The assertion that pins the bug. njsPC rejects a body without one, and
       the fake now rejects it too. */
    await client.intent("setPanelMode", { mode: "service" });
    expect(toggles()).toHaveLength(1);
    expect(toggles()[0].body).toHaveProperty("mode");
  });

  it("comes back to auto", async () => {
    await client.intent("setPanelMode", { mode: "service" });
    await settles((s) => s.panelMode === "service");

    const ack = await client.intent("setPanelMode", { mode: "auto" });
    expect(ack.ok, ack.error).toBe(true);
    expect((await settles((s) => s.panelMode === "auto")).panelMode).toBe("auto");
  });

  it("does nothing when it is already in the mode asked for", async () => {
    /* The endpoint is a toggle, so a redundant call would put the panel into
       exactly the state the operator was trying to stay out of. */
    expect((await client.intent("setPanelMode", { mode: "auto" })).ok).toBe(true);
    expect(toggles()).toHaveLength(0);
  });
});

describe("settings njsPC owns", () => {
  /* A Spa circuit left at `eggTimer: 1` produced a one-minute spa session,
     and the screen reported the countdown perfectly accurately without ever
     suggesting the configuration was wrong. Being right about the wrong
     configuration is not much use at the side of a pool. */

  it("says nothing when njsPC agrees with us", async () => {
    expect(njspcFindings(await now())).toEqual([]);
  });

  it("notices a spa session too short to be one", async () => {
    njspc.setSpaEggTimer(1);
    const state = await settles((s) => njspcFindings(s).length > 0, 10000);
    expect(njspcFindings(state)[0].id).toBe("spa-egg-tiny");
    expect(njspcFindings(state)[0].what).toMatch(/Spa sessions end after 1 minute/);
  });

  it("clears itself once the setting is put right", async () => {
    /* The direction that matters most. A complaint still on screen after the
       operator has fixed the thing it names is how a warning system teaches
       people to ignore it. */
    njspc.setSpaEggTimer(1);
    await settles((s) => njspcFindings(s).length > 0, 10000);

    njspc.setSpaEggTimer(120);
    const state = await settles((s) => njspcFindings(s).length === 0, 10000);
    expect(njspcFindings(state)).toEqual([]);
  });

  it("notices njsPC's twelve-hour default", async () => {
    njspc.setSpaEggTimer(720);
    const state = await settles((s) => njspcFindings(s).length > 0, 10000);
    expect(njspcFindings(state)[0].id).toBe("spa-egg-default");
  });

  it("does not stop the spa being used while it complains", async () => {
    /* A notice is not a lockout: the spa works with a short egg timer, it
       just does not last. */
    njspc.setSpaEggTimer(1);
    await settles((s) => njspcFindings(s).length > 0, 10000);
    expect((await client.intent("setMode", { mode: "spa" })).ok).toBe(true);
  });
});

describe("the evaluation loop", () => {
  /**
   * The part that runs whether or not anyone is looking. Everything else in
   * the supervisor reacts to a tap; this asserts the invariants and enforces
   * the one thing the owner set — the target.
   */

  it("reports nothing wrong with a system behaving itself", async () => {
    expect((await now()).violations).toEqual([]);
  });

  it("ends a heat call when the water reaches the target", async () => {
    /* The promise the whole targets feature is named for, and until this
       loop existed nothing anywhere kept it: the target was clamped, stored,
       persisted and displayed, and never acted on. */
    njspc.setTemps({ temp: 70 });
    await settles((s) => s.waterTemp === 70, 8000);

    /* Cutoff at 72, water at 70 — the call should stand. */
    await client.intent("setTarget", { body: "pool", degrees: 72 });
    expect((await client.intent("setPoolHeat", { on: true })).ok).toBe(true);
    expect((await now()).poolHeatDemand).toBe(true);

    njspc.setTemps({ temp: 73 });
    const state = await settles((s) => s.poolHeatDemand === false, 8000);
    expect(state.poolHeatDemand).toBe(false);
  });

  it("says the target was why, not that something failed", async () => {
    njspc.setTemps({ temp: 70 });
    await settles((s) => s.waterTemp === 70, 8000);
    await client.intent("setTarget", { body: "pool", degrees: 72 });
    await client.intent("setPoolHeat", { on: true });

    njspc.setTemps({ temp: 75 });
    const state = await settles((s) => s.lastCutoff != null, 8000);
    expect(state.lastCutoff).toMatchObject({ body: "pool", target: 72, temp: 75 });
  });

  it("cuts a call asked for when the water is already there, on the same tap", async () => {
    njspc.setTemps({ temp: 90 });
    await settles((s) => s.waterTemp === 90, 8000);
    await client.intent("setTarget", { body: "pool", degrees: 80 });
    await client.intent("setPoolHeat", { on: true });
    expect((await now()).poolHeatDemand).toBe(false);
  });

  it("never ends a call on a temperature it does not have", async () => {
    /* The rig's actual state today. Guessing here would cut the heat off for
       a reading nobody took, and the heater governs itself regardless. */
    njspc.setTemps({ temp: undefined });
    await settles((s) => s.waterTemp == null, 8000);
    await client.intent("setPoolHeat", { on: true });
    await new Promise((r) => setTimeout(r, 1500));
    expect((await now()).poolHeatDemand).toBe(true);
    await client.intent("setPoolHeat", { on: false });
  });

  it("does not isolate the exchanger the instant the call ends", async () => {
    /* The purge. Releasing pool heat used to swing the bypass to `around` in
       the same tick, closing a valve on an exchanger that had been firing a
       moment earlier. The hold is observable immediately, so this asserts it
       without waiting three minutes; the release is unit-tested. */
    njspc.setTemps({ temp: 70 });
    await settles((s) => s.waterTemp === 70, 8000);
    await client.intent("setTarget", { body: "pool", degrees: 85 });
    await client.intent("setPoolHeat", { on: true });
    await settles((s) => s.valves.bypass === "flow", 8000);

    await client.intent("setPoolHeat", { on: false });
    const after = await settles((s) => s.purgeUntil != null, 8000);
    expect(after.poolHeatDemand).toBe(false);

    /* Asserted on the card rather than on `valves.bypass`. The state field is
       what the supervisor believes; the byte is what the relays are doing,
       and the two came apart once already — the first attempt at the purge
       moved a field that drives nothing while every unit test passed. */
    expect(await sup.card.byte(), "the valve must not close on a hot exchanger")
      .toBe(0x00);
  });

  it("says how long the exchanger is being held open for", async () => {
    /* An absolute timestamp, like spaExpiresAt — the client counts down on
       its own clock rather than us streaming a number that is already stale. */
    njspc.setTemps({ temp: 70 });
    await settles((s) => s.waterTemp === 70, 8000);
    await client.intent("setTarget", { body: "pool", degrees: 85 });
    await client.intent("setPoolHeat", { on: true });
    await settles((s) => s.valves.bypass === "flow", 8000);
    await client.intent("setPoolHeat", { on: false });

    const held = await settles((s) => s.purgeUntil != null, 8000);
    expect(held.purgeUntil).toBeGreaterThan(Date.now());
  });

  it("leaves the spa call alone, because njsPC owns that heater", async () => {
    njspc.setTemps({ temp: 105 });
    await settles((s) => s.waterTemp === 105, 8000);
    await client.intent("setMode", { mode: "spa" });
    await settles((s) => s.mode === "spa", 8000);
    /* Well past the spa target, and the supervisor still does not reach in. */
    expect((await client.intent("setPoolHeat", { on: true })).ok).toBe(false);
  });

  /* The heat call is provoked by asking for it, not by njsPC claiming to
     heat. njsPC's `heatStatus` no longer reaches a contact — its heater has
     no device binding and actuates nothing — so a call it reports is not a
     call anybody is making. Driving these from `setPoolHeat` also means the
     invariant is exercised through the path that will exist at the pad. */
  const callForPoolHeat = async () => {
    njspc.setTemps({ temp: 70 });
    await settles((s) => s.waterTemp === 70, 8000);
    await client.intent("setTarget", { body: "pool", degrees: 85 });
    expect((await client.intent("setPoolHeat", { on: true })).ok).toBe(true);
    await settles((s) => s.heaterCall === "pool", 8000);
  };

  it("catches a heat call running below the heater's flow minimum", async () => {
    await callForPoolHeat();
    njspc.setPumpRpm(800);
    const state = await settles((s) => s.violations.length > 0, 8000);
    expect(state.violations.map((v) => v.id)).toContain("heat-below-floor");
    expect(state.violations[0].severity).toBe("alarm");
    await client.intent("setPoolHeat", { on: false });
  });

  it("clears the alarm when the equipment comes right", async () => {
    await callForPoolHeat();
    njspc.setPumpRpm(800);
    await settles((s) => s.violations.length > 0, 8000);

    njspc.setPumpRpm(2400);
    const state = await settles(
      (s) => !s.violations.some((v) => v.id === "heat-below-floor"), 8000);
    expect(state.violations.map((v) => v.id)).not.toContain("heat-below-floor");
    await client.intent("setPoolHeat", { on: false });
  });

  it("does not alarm on a pump that is simply not answering", async () => {
    /* Which is every pump on this rig right now. A monitor that fires
       permanently is one nobody reads. */
    await callForPoolHeat();
    njspc.setPumpRpm(null);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await now()).violations.map((v) => v.id)).not.toContain("heat-below-floor");
    await client.intent("setPoolHeat", { on: false });
  });

  it("keeps checking while njsPC says nothing at all", async () => {
    /* njsPC only speaks when something changes, and "nothing changed" is
       exactly what a stuck heat call looks like. The heartbeat evaluates
       rather than merely republishing. */
    await callForPoolHeat();
    njspc.setPumpRpm(800);
    await settles((s) => s.violations.length > 0, 8000);
    /* No further njsPC events from here — the alarm must persist on our own
       clock rather than needing to be re-provoked. */
    const later = await settles((s) => s.violations.length > 0, 8000);
    expect(later.violations.map((v) => v.id)).toContain("heat-below-floor");
    await client.intent("setPoolHeat", { on: false });
  });
});

describe("what the card actually does", () => {
  /**
   * Traces, not snapshots.
   *
   * The order is the safety property here — valve before contact, purge
   * before isolation, boot passing through de-energised — and a resting byte
   * cannot show any of it. Both bugs found on 29 August had the right end
   * state and the wrong path: a boot that flashed `0x40` before the purge
   * hold engaged, and a drift corrector re-asserting a byte the supervisor
   * had just stopped wanting.
   *
   * These read as a specification. That is deliberate; someone who will never
   * open the harness should be able to review them.
   */
  /* Quiesce the card, then start the trace from there. */
  const from = async () => { await sup.card.quiet(); await sup.card.reset(); };

  it("switches to spa in one write, heat contact included", async () => {
    /* 0x25 rather than 0x05, and the difference is the authority change: the
       spa heat call follows the mode now, because njsPC's heater has no
       device binding and actuates nothing. */
    await client.intent("setMode", { mode: "pool" });
    await settles((s) => s.mode === "pool", 8000);
    await from();

    await client.intent("setMode", { mode: "spa" });
    await sup.card.quiet();
    expect(await sup.card.trace()).toEqual(["0x25  REL1 REL2 REL5"]);
  });

  it("adds the blower without disturbing anything else", async () => {
    await client.intent("setMode", { mode: "spa" });
    await settles((s) => s.mode === "spa", 8000);
    await from();

    await client.intent("toggle", { key: "blower" });
    await sup.card.quiet();
    expect(await sup.card.trace()).toEqual(["0xa5  REL1 REL2 REL5 REL6"]);
  });

  it("clears the blower on the way out of spa", async () => {
    /* `mode !== 'spa' implies blower === false`. The toggle is gated to spa
       mode, so a blower carried into pool mode is on and awkward to reach —
       and sequences.js has an explicit blower-off step in the pool path. */
    await client.intent("setMode", { mode: "spa" });
    await settles((s) => s.mode === "spa", 8000);
    if (!(await now()).blower) await client.intent("toggle", { key: "blower" });
    await from();

    await client.intent("setMode", { mode: "pool" });
    await settles((s) => s.mode === "pool", 8000);
    await sup.card.quiet();
    const state = await now();
    expect(state.blower, "the blower must not survive the mode change").toBe(false);
    expect(state.violations.map((v) => v.id)).not.toContain("blower-out-of-spa");
  });

  it("leaves spa through de-energised, not through the bypass", async () => {
    /* Spa heat was on, so the purge holds the bypass at flow — the card lands
       on 0x00 and stays there. A 0x40 here would be the exchanger isolated
       moments after the heater stopped. */
    await client.intent("setMode", { mode: "spa" });
    await settles((s) => s.mode === "spa", 8000);
    await from();

    await client.intent("setMode", { mode: "pool" });
    await settles((s) => s.mode === "pool", 8000);
    await sup.card.quiet();
    expect(await sup.card.trace()).toEqual(["0x00  (all off)"]);
  });
});

describe("when njsPC moves without being asked", () => {
  /**
   * ADR-11's hazard, and the one the supervisor is least able to argue with.
   * njsPC owns the bodies and drives them from its own timers — a schedule
   * firing, an egg timer expiring, somebody in dashPanel. From here all three
   * look the same: the body is different now and nobody asked us.
   *
   * The rule that follows is *observe and react*, never assert. Anything the
   * supervisor decides at intent time is a memory, and a memory is wrong the
   * moment njsPC moves on its own. That is not hypothetical — the card once
   * came out `0x65`, spa valves with the exchanger still bypassed, because
   * the bypass was remembered from the last intent instead of derived.
   */
  const from = async () => { await sup.card.quiet(); await sup.card.reset(); };

  it("follows the body onto the card with nobody having tapped anything", async () => {
    njspc.switchBody("pool");
    await settles((s) => s.mode === "pool", 8000);
    await from();

    njspc.switchBody("spa");
    await settles((s) => s.mode === "spa", 8000);
    await sup.card.quiet();
    /* The 0x65 test. Spa valves and the spa heat contact, and crucially the
       bypass at flow — REL3 absent — because it is derived from what is true
       rather than remembered from an intent that never happened. */
    expect(await sup.card.trace()).toEqual(["0x25  REL1 REL2 REL5"]);
  });

  it("drops a pool heat call when njsPC takes the body", async () => {
    /* Spa owns the heater (ADR-4), and `setMode` clears the pool call for
       exactly that reason — but njsPC switching the body never goes through
       `setMode`. If the call only dies in the intent, it survives here and
       comes back the moment the spa reverts. */
    njspc.switchBody("pool");
    await settles((s) => s.mode === "pool", 8000);
    njspc.setTemps({ temp: 70 });
    await settles((s) => s.waterTemp === 70, 8000);
    await client.intent("setTarget", { body: "pool", degrees: 85 });
    await client.intent("setPoolHeat", { on: true });
    await settles((s) => s.heaterCall === "pool", 8000);

    njspc.switchBody("spa");
    await settles((s) => s.mode === "spa", 8000);
    expect((await now()).poolHeatDemand,
      "a pool call must not outlive the body it was made for").toBe(false);
  });

  it("clears the blower when the spa reverts on its own", async () => {
    /* The egg timer expiring is the ordinary end of a spa session — ADR-11
       accepts that njsPC owns it. `setMode` clears the blower on the way out
       of spa; this path does not call `setMode`. */
    njspc.switchBody("spa");
    await settles((s) => s.mode === "spa", 8000);
    if (!(await now()).blower) await client.intent("toggle", { key: "blower" });
    await settles((s) => s.blower === true, 8000);

    njspc.expireSpa();
    await settles((s) => s.mode === "pool", 8000);
    await sup.card.quiet();
    expect((await now()).blower,
      "the blower must not outlive the spa session").toBe(false);
  });

  it("holds the exchanger open when njsPC ends a spa session", async () => {
    /* Spa mode calls for spa heat, so a revert ends a heat call — and the
       purge applies whoever ended it. A 0x40 straight after would isolate an
       exchanger the heater was firing into moments earlier. */
    njspc.switchBody("spa");
    await settles((s) => s.mode === "spa", 8000);
    await from();

    njspc.expireSpa();
    await settles((s) => s.mode === "pool", 8000);
    await sup.card.quiet();
    expect(await sup.card.trace()).toEqual(["0x00  (all off)"]);
    expect((await now()).purgeUntil).toBeGreaterThan(Date.now());
  });
});

describe("extending a spa session", () => {
  /**
   * njsPC has no endpoint that moves an end time, and re-sending "on" to a
   * circuit that is already on does nothing — `setEndTime` only fires on an
   * off→on transition. A config write is the one caller that forces it.
   */
  const spaEnd = async () => (await now()).spaExpiresAt;

  it("refuses when the spa is not on", async () => {
    const ack = await client.intent("extendSpa");
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/not on/);
  });

  it("pushes the end time out without stopping the spa", async () => {
    await client.intent("setMode", { mode: "spa" });
    await settles((s) => s.mode === "spa", 8000);
    const before = await spaEnd();
    expect(before).toBeTruthy();

    await new Promise((r) => setTimeout(r, 1100));
    expect((await client.intent("extendSpa")).ok).toBe(true);
    const after = await settles((s) => s.spaExpiresAt > before, 8000);

    expect(after.spaExpiresAt).toBeGreaterThan(before);
    /* Still in spa, and the circuit never went off — no body switch, no
       valve travel, which is the entire point of doing it this way. */
    expect(after.mode).toBe("spa");
    expect(njspc.circuits().find((c) => c.id === 1).isOn).toBe(true);
  });

  it("resets to a full session rather than adding a slice", async () => {
    await client.intent("setMode", { mode: "spa" });
    await settles((s) => s.mode === "spa", 8000);
    await new Promise((r) => setTimeout(r, 1100));
    await client.intent("extendSpa");
    const after = await settles((s) => s.spaExpiresAt != null, 8000);

    /* The Spa circuit's egg timer is 120 in the fake, matching commissioning. */
    const minutes = (after.spaExpiresAt - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(119);
    expect(minutes).toBeLessThanOrEqual(120);
  });

  it("refuses a spa with no timer to extend", async () => {
    njspc.setSpaEggTimer(0);
    await client.intent("setMode", { mode: "spa" });
    await settles((s) => s.mode === "spa", 8000);
    const ack = await client.intent("extendSpa");
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/no timer/);
  });
});
