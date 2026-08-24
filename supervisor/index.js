import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { NjsPC } from "./njspc.js";
import { toUiState, SPA_CIRCUIT, POOL_CIRCUIT } from "./map.js";
import { applyTarget } from "./targets.js";
import { Store, pickPersisted, applyPersisted } from "./store.js";
import { DEFAULT_PROGRAMS } from "../src/lib/programs.js";
import {
  floorRpm, bypassFor, mayCallForHeat, mayToggleBlower, refuse,
} from "./interlocks.js";
import {
  circuitConfig, withPumpCircuit, withoutPumpCircuit, whyNotBindable, pumpLimits,
} from "./binding.js";
import { checkCommissioning } from "./commissioning.js";

/**
 * poolctl supervisor — v0.
 *
 * What this is today: the transport and translation layer. It holds one link
 * to njsPC, maps njsPC's model into the shape the UI already speaks, serves
 * the built client, and streams state to every connected browser.
 *
 * What it is NOT yet: the six interlocks. Those land on top of this spine one
 * at a time, each testable. See ADR-10 and docs/architecture.md. Until they
 * exist, this process supervises nothing — it observes and relays, and the
 * banner below says so at startup rather than letting anyone assume otherwise.
 *
 * Runs with `node index.js`. No build step, by design — the Pi gets artifacts.
 */

const PORT = Number(process.env.PORT || 4300);
const NJSPC_URL = process.env.NJSPC_URL || "http://localhost:4200";

/* How often a frame goes out no matter what njsPC is doing.
 *
 * The client uses absence of frames to decide it has gone offline, so this is
 * the pulse that decision is measured against. Clients MUST allow several
 * missed beats before crying offline — see STALE_MS in useSupervisor.js. Do
 * not lengthen this without lengthening that. */
const HEARTBEAT_MS = 5000;

/* How often the settings njsPC owns are re-read.
 *
 * Not on the state path: these change at commissioning and then effectively
 * never. But dashPanel can change them at any time, and a notice that
 * persists after the operator has just fixed the thing it names is worse
 * than no notice — so it cannot only be checked when the link comes up. */
const COMMISSIONING_MS = 5 * 60 * 1000;

/* Shortest gap between checks prompted by njsPC saying something changed.
 *
 * It is one small GET, so the floor only exists to stop a burst of events
 * during a transition turning into a burst of requests. Deliberately the
 * same in both directions: a complaint still on screen after the operator
 * has fixed the thing it names is how a warning system teaches people to
 * ignore it, and that is the direction that would suffer from a longer
 * window. */
const REVIEW_FLOOR_MS = 3000;
const STATE_FILE = process.env.STATE_FILE
  || fileURLToPath(new URL("./state.json", import.meta.url));
const WEB_ROOT = fileURLToPath(new URL("../dist", import.meta.url));

/* Supervisor-owned state: the things njsPC has no concept of.
   Preferences here are restored from disk at startup; positions are not —
   see store.js for why that distinction is deliberate. */
const store = new Store(STATE_FILE);
const own = {
  bypass: "around",
  /* Seeded so a fresh install has the two real activities rather than an
     empty list. Persisted, and editable, but not yet runnable: each needs an
     njsPC circuit to carry its speed, which commissioning creates. */
  programs: DEFAULT_PROGRAMS,
  /* Why each program last failed to bind, by program id. Not persisted:
     it describes njsPC's condition a moment ago, not a preference, and a
     stale reason is worse than none. */
  bindErrors: {},
  /* Settings that live on njsPC and disagree with what we believe. Re-read
     whenever the link comes up, because dashPanel can change them under us. */
  commissioning: [],
  panelMode: "auto",
  targets: { pool: 88, spa: 102 },
  poolHeatDemand: false,
  preheat: null,
  blower: false,
  light: false,
  target: null,
  activeSequence: null,
  step: null,
  stepIndex: 0,
  connected: false,
  lastSeen: null,
};

let njsRaw = {};
let ui = null;

/** Queue a durable write. Only the persistable subset is ever written. */
function remember() {
  store.save(pickPersisted(own));
}

const njs = new NjsPC({
  url: NJSPC_URL,
  onState: (s) => {
    njsRaw = s;
    own.lastSeen = Date.now();
    publish();
  },
  onEvent: () => reviewCommissioningSoon(),
  onLink: (up, why) => {
    if (own.connected !== up) {
      console.log(up ? "njsPC link up" : `njsPC link down${why ? `: ${why}` : ""}`);
      /* Only on a transition, not on every failed reconnect. */
      if (up) reviewCommissioning();
    }
    own.connected = up;
    publish();
  },
});

/* Current heat call, as njsPC reports it — the input to the pump floor. */
const heatCall = () => ui?.heaterCall ?? "off";

function publish() {
  ui = toUiState(njsRaw, own);
  const msg = JSON.stringify({ type: "state", state: ui });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

/* ---- commissioning ----------------------------------------------------- */

/**
 * Compare the settings njsPC owns against what this repo believes, and say
 * so rather than correcting them.
 *
 * Prompted by a spa that reverted after one minute: the egg timer had been
 * left at a test value, and the UI reported the resulting countdown
 * perfectly accurately without ever suggesting the configuration was wrong.
 */
let lastReview = 0;
let reviewTimer = null;

/**
 * Throttled re-check, driven by njsPC saying something changed.
 *
 * The five-minute sweep alone is not enough: the operator fixes the setting
 * in dashPanel, comes back, and the notice naming it is still there. A stale
 * complaint about something already dealt with is how a warning system
 * teaches people to ignore it.
 */
function reviewCommissioningSoon() {
  /* Trailing edge, not leading. Dropping an event that arrives inside the
     window would lose the only notification we get: njsPC speaks once per
     change, so a setting edited in dashPanel a second after some other event
     would go unnoticed until the five-minute sweep — including the case that
     matters most, the operator fixing the thing we are complaining about and
     watching the complaint stay put. Coalescing instead means a burst costs
     one check and the last change is never the one that is missed. */
  if (reviewTimer) return;
  const wait = Math.max(0, REVIEW_FLOOR_MS - (Date.now() - lastReview));
  reviewTimer = setTimeout(() => {
    reviewTimer = null;
    reviewCommissioning();
  }, wait);
  reviewTimer.unref?.();
}

async function reviewCommissioning() {
  lastReview = Date.now();
  try {
    const spaCircuit = await njs.circuitConfig(SPA_CIRCUIT);
    const findings = checkCommissioning({ spaCircuit });
    const changed = JSON.stringify(findings) !== JSON.stringify(own.commissioning);
    own.commissioning = findings;
    if (changed) {
      for (const f of findings) console.warn(`commissioning: ${f.what} — ${f.detail}`);
      publish();
    }
  } catch (err) {
    /* Not being able to check is not a finding. Reporting "misconfigured"
       because a request failed would be worse than reporting nothing. */
    console.warn(`commissioning: could not read njsPC config: ${err.message}`);
  }
}

/* ---- binding programs to njsPC ---------------------------------------- */

/**
 * Give a program an njsPC circuit, and give that circuit a speed on the pump.
 *
 * Idempotent: a program that already has a circuit has it updated rather than
 * replaced, so saving a renamed program keeps its identity in njsPC instead of
 * leaving the old circuit behind.
 *
 * Records the reason on failure rather than throwing it away, because the one
 * that matters most — njsPC has no pump configured — is a state the system
 * sits in for weeks before commissioning, not a transient error.
 */
async function bind(id) {
  const p = own.programs.find((x) => x.id === id);
  if (!p) throw refuse(`no program '${id}'`);

  const fail = (why) => {
    own.bindErrors[id] = why;
    publish();
    return refuse(why);
  };

  const limits = pumpLimits(njsRaw);
  const why = whyNotBindable(p, limits);
  if (why) throw fail(why);

  try {
    /* One: the circuit, which carries the name and the egg timer. njsPC
       allocates the id when we send 0, skipping the Pool and Spa circuits. */
    const circuit = await njs.setCircuitConfig(circuitConfig(p));
    const circuitId = circuit?.id;
    if (!Number.isFinite(circuitId)) {
      throw new Error("njsPC did not return a circuit id");
    }

    /* Two: the speed, which lives on the pump. Read the pump in its config
       shape and send it back complete — a partial write deletes the speeds
       the schedules run on. */
    const options = await njs.pumpOptions();
    const pump = (options?.pumps ?? []).find((x) => x.id === limits.pumpId);
    if (!pump) throw new Error(`pump ${limits.pumpId} vanished between reads`);
    pump.circuits = withPumpCircuit(pump, { circuit: circuitId, speed: p.rpm }, limits);
    await njs.setPumpConfig(pump);

    p.circuit = circuitId;
    delete own.bindErrors[id];
    remember();
    publish();
    console.log(`bound program '${p.name}' to njsPC circuit ${circuitId} at ${p.rpm} rpm`);
    return circuitId;
  } catch (err) {
    throw fail(err.message);
  }
}

/**
 * Take the circuit back out of njsPC.
 *
 * Pump first, then the circuit. The other order leaves the pump holding a
 * circuit id that no longer resolves, and `setTargetSpeed` reads every entry
 * on every poll.
 */
async function unbind(id) {
  const p = own.programs.find((x) => x.id === id);
  if (!p || p.circuit == null) return;

  const limits = pumpLimits(njsRaw);
  if (limits) {
    const options = await njs.pumpOptions();
    const pump = (options?.pumps ?? []).find((x) => x.id === limits.pumpId);
    if (pump) {
      pump.circuits = withoutPumpCircuit(pump, p.circuit);
      await njs.setPumpConfig(pump);
    }
  }
  await njs.deleteCircuitConfig(p.circuit);
  console.log(`unbound program '${p.name}' from njsPC circuit ${p.circuit}`);
  p.circuit = null;
  remember();
  publish();
}

/* ---- intents ---------------------------------------------------------- */

/**
 * The UI sends intents, never primitives (ADR-7). Each one is translated into
 * whatever njsPC calls achieve it. Anything the supervisor has not learned yet
 * is refused explicitly rather than silently ignored — a control that appears
 * to work and does nothing is worse than one that says no.
 */
const intents = {
  /**
   * Pump speed.
   *
   * Refused, and the reason is architectural rather than unfinished work.
   * njsPC has no runtime endpoint for pump speed at all: it drives the pump
   * from circuit assignments, so the only lever is `/config/pumpCircuit`,
   * which rewrites the speed a circuit runs at permanently — including for
   * every schedule using it. Setting 1800 rpm now would silently redefine
   * what "filtration" means.
   *
   * The idiomatic fix is a dedicated manual circuit the supervisor owns and
   * rewrites, turned on with manual priority. That is a commissioning
   * decision, not something to improvise here. The floor is applied first
   * regardless, so the refusal reports the speed that would have been used.
   */
  async setRpm({ rpm }) {
    const { rpm: floored, clamped } = floorRpm(rpm, heatCall());
    throw refuse(
      `pump speed needs a dedicated manual circuit in njsPC` +
        (clamped ? ` (${rpm} would floor to ${floored} while heat is called)` : ""),
    );
  },

  async setMode({ mode }) {
    if (mode !== "pool" && mode !== "spa") throw new Error(`unknown mode ${mode}`);
    /* njsPC's shared-body model does the whole switch off one circuit. */
    await njs.setCircuit(mode === "spa" ? SPA_CIRCUIT : POOL_CIRCUIT, true);
  },
  /**
   * Targets are cutoffs, not setpoints (ADR-4). Clamping them to the heater's
   * own caps is supervisor job #4, and it belongs here rather than in the
   * client: a target that arrives from anywhere — a phone, Home Assistant, a
   * replayed message — must not be able to ask for more heat than the heater
   * allows.
   *
   * `delta` is the stepper's form. Sending a relative change means taps that
   * outrun the round trip still accumulate; sending absolutes would make each
   * tap compute from whatever the client last heard, and lose all but one.
   */
  /**
   * Blower and light. The blower gate is enforced here rather than only in
   * the client — a rule that lives on the wrong side of the wire is not a
   * rule, and Home Assistant will be sending these too (Phase 6).
   */
  async toggle({ key }) {
    if (key !== "blower" && key !== "light") throw refuse(`cannot switch '${key}'`);
    const turningOn = !own[key];
    if (key === "blower" && !mayToggleBlower({ turningOn, mode: ui?.mode })) {
      throw refuse("the blower only starts in spa mode");
    }
    /* No relay is assigned until the HAT is fitted, so this is supervisor
       state for now. It becomes a circuit call at commissioning. */
    own[key] = turningOn;
    publish();
  },

  /**
   * Pool heat. The bypass must be open before any call is made — the valve is
   * binary, so a call with it around is zero flow through the exchanger, not
   * reduced flow (ADR-5, invariants 2 and 3).
   */
  async setPoolHeat({ on }) {
    if (ui?.mode === "spa") throw refuse("spa mode owns the heater");
    const want = Boolean(on);
    if (want) {
      const bypass = bypassFor("pool", true);
      if (!mayCallForHeat(bypass)) throw refuse("bypass is not in flow position");
      /* Ordering matters and is not negotiable: valve first, contact second. */
      own.bypass = bypass;
      own.poolHeatDemand = true;
    } else {
      own.poolHeatDemand = false;
      own.bypass = bypassFor("pool", false);
    }
    publish();
  },


  /** Run or stop the pump outright — the Pool circuit being on at all. */
  async setPumpRunning({ on }) {
    await njs.setCircuit(POOL_CIRCUIT, Boolean(on));
    publish();
  },

  /**
   * Auto or service. njsPC's endpoint toggles rather than sets, so the
   * current mode is checked first — sending it twice would otherwise put the
   * panel in the state you were trying to leave.
   */
  async setPanelMode({ mode }) {
    const want = mode === "service" ? "service" : "auto";
    if ((ui?.panelMode ?? "auto") === want) return;
    await njs.put("/state/toggleServiceMode", {});
  },

  /**
   * Programs.
   *
   * A program is a name, a speed and an expiry; njsPC keeps those in two
   * places — the name and the egg timer on a circuit, the speed in the
   * pump's circuit list — so binding is two writes. `binding.js` decides
   * what to write and refuses what njsPC would accept but should not.
   *
   * Binding is attempted whenever a program is saved, because a program that
   * cannot run is not much of a program. It is also a separate intent, so a
   * failure caused by njsPC being down can be retried without editing
   * anything. Either way the program is kept: defining one is a preference
   * and works offline, and only the binding needs njsPC.
   */
  async startProgram({ id }) {
    const p = own.programs.find((x) => x.id === id);
    if (!p) throw refuse(`no program '${id}'`);
    if (p.circuit == null) {
      /* Prefer the reason as it stands now over the one recorded at the last
         attempt: a pump configured since then makes the old message a lie. */
      const why =
        whyNotBindable(p, pumpLimits(njsRaw)) ??
        own.bindErrors[id] ??
        "it is not bound to a circuit yet";
      throw refuse(`'${p.name}' cannot run — ${why}`);
    }
    await njs.setCircuit(p.circuit, true);
    /* Nothing recorded here. The circuit's egg timer runs the expiry, and
       `map.js` reads the running program back out of njsPC's own state. */
  },

  async stopProgram() {
    const running = ui?.activeProgram;
    const p = own.programs.find((x) => x.id === running?.id);
    if (p?.circuit != null) await njs.setCircuit(p.circuit, false);
  },

  async saveProgram({ program }) {
    const { isNew, ...clean } = program || {};
    if (!clean.id) throw refuse("program needs an id");
    /* Editing the running one stops it: leaving the pump going under a name
       that no longer describes it is worse than interrupting. */
    if (ui?.activeProgram?.id === clean.id) await intents.stopProgram({});
    /* Keep whichever circuit it was already bound to — the editor never
       sends one, and dropping it here would orphan the circuit in njsPC. */
    const previous = own.programs.find((x) => x.id === clean.id);
    const merged = { ...clean, circuit: clean.circuit ?? previous?.circuit ?? null };
    own.programs = isNew
      ? [...own.programs, merged]
      : own.programs.map((x) => (x.id === merged.id ? merged : x));
    remember();
    publish();
    /* Saved either way. The binding is best-effort and reports itself. */
    await bind(merged.id).catch(() => {});
  },

  async deleteProgram({ id }) {
    if (ui?.activeProgram?.id === id) await intents.stopProgram({});
    /* Unbind before forgetting, or the circuit outlives every reference to
       it and shows up in dashPanel as equipment nobody can name. */
    await unbind(id).catch((err) => {
      console.warn(`could not unbind '${id}' before deleting: ${err.message}`);
    });
    own.programs = own.programs.filter((x) => x.id !== id);
    delete own.bindErrors[id];
    remember();
    publish();
  },

  /** Retry a binding that failed, without editing the program. */
  async bindProgram({ id }) {
    await bind(id);
  },

  async setTarget({ body, degrees, delta }) {
    if (!(body in own.targets)) throw new Error(`unknown body ${body}`);
    own.targets[body] = applyTarget(own.targets[body], body, { degrees, delta });
    remember();
    publish();
  },
};

async function handleIntent(raw) {
  /* `args` is nested rather than spread across the envelope: an intent
     parameter named `id` would otherwise be indistinguishable from the
     request's correlation id. */
  const { intent, args = {} } = raw;
  const fn = intents[intent];
  if (!fn) return { ok: false, error: `intent '${intent}' not implemented in v0` };
  try {
    await fn(args);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ---- static file serving ---------------------------------------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function serveStatic(req, res) {
  /* normalize() then reject any escape: this serves from a fixed root and
     must not be talked out of it by a crafted path. */
  const rel = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (rel.includes("..")) {
    res.writeHead(403).end("forbidden");
    return;
  }
  let file = join(WEB_ROOT, rel === "/" ? "index.html" : rel);
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, "index.html");
  } catch {
    /* SPA fallback: unknown paths render the app, not a 404. */
    file = join(WEB_ROOT, "index.html");
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(
      "No built client found.\n\n" +
        "The supervisor serves ../dist, which is built on the laptop and copied.\n" +
        "Run `npm run build` in the repo root.\n",
    );
  }
}

const server = createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, njspc: own.connected, lastSeen: own.lastSeen }));
    return;
  }
  if (req.url === "/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ui ?? {}));
    return;
  }
  await serveStatic(req, res);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  if (ui) ws.send(JSON.stringify({ type: "state", state: ui }));
  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return ws.send(JSON.stringify({ type: "error", error: "bad json" }));
    }
    const result = await handleIntent(msg);
    ws.send(JSON.stringify({ type: "ack", reqId: msg.reqId ?? null, ...result }));
  });
});

/* Restore before the first client can connect, so nobody sees defaults
   flash past on the way to the real values. */
Object.assign(own, applyPersisted(own, await store.load()));

njs.start();

/* njsPC only talks when something changes, and a quiet system is
   indistinguishable from a dead one over a socket. This makes silence
   meaningful: a client that stops hearing from us really has lost the link. */
const heartbeat = setInterval(publish, HEARTBEAT_MS);
const recheck = setInterval(reviewCommissioning, COMMISSIONING_MS);

server.listen(PORT, () => {
  console.log(`supervisor v0 on http://localhost:${PORT}  ->  njsPC at ${NJSPC_URL}`);
  console.log("NOTE: v0 relays state and two intents. None of the six interlocks");
  console.log("      are implemented yet — this process supervises nothing.");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    clearInterval(heartbeat);
    clearInterval(recheck);
    clearTimeout(reviewTimer);
    njs.stop();
    /* Flush synchronously enough to beat the exit: a debounced write in
       flight would otherwise be lost on every restart. */
    await store.flush();
    /* Close the sockets before the server. `server.close()` waits for every
       open connection to end, and a phone that left a tab open is an open
       connection — so without this, shutdown hangs until systemd gives up on
       TimeoutStopSec and SIGKILLs us. Every `systemctl restart` would take
       ninety seconds. */
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.close(() => process.exit(0));
    /* Belt and braces: leave regardless if something still holds the loop. */
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
