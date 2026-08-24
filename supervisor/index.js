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
  activeProgram: null,
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
  onLink: (up, why) => {
    if (own.connected !== up) {
      console.log(up ? "njsPC link up" : `njsPC link down${why ? `: ${why}` : ""}`);
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
    if (!on) own.activeProgram = null;
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
   * Programs. Each is meant to be an njsPC circuit carrying the speed and the
   * egg timer; until commissioning creates them a program is definable and
   * editable but not runnable, and says so rather than pretending.
   */
  async startProgram({ id }) {
    const p = own.programs.find((x) => x.id === id);
    if (!p) throw refuse(`no program '${id}'`);
    if (p.circuit == null) {
      throw refuse(`'${p.name}' has no njsPC circuit yet — see commissioning`);
    }
    await njs.setCircuit(p.circuit, true);
    own.activeProgram = { id: p.id, name: p.name, rpm: p.rpm, endsAt: Date.now() + p.minutes * 60000 };
    publish();
  },

  async stopProgram() {
    const p = own.programs.find((x) => x.id === own.activeProgram?.id);
    if (p?.circuit != null) await njs.setCircuit(p.circuit, false);
    own.activeProgram = null;
    publish();
  },

  async saveProgram({ program }) {
    const { isNew, ...clean } = program || {};
    if (!clean.id) throw refuse("program needs an id");
    /* Editing the running one stops it: leaving the pump going under a name
       that no longer describes it is worse than interrupting. */
    if (own.activeProgram?.id === clean.id) await intents.stopProgram({});
    own.programs = isNew
      ? [...own.programs, clean]
      : own.programs.map((x) => (x.id === clean.id ? clean : x));
    remember();
    publish();
  },

  async deleteProgram({ id }) {
    if (own.activeProgram?.id === id) await intents.stopProgram({});
    own.programs = own.programs.filter((x) => x.id !== id);
    remember();
    publish();
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

server.listen(PORT, () => {
  console.log(`supervisor v0 on http://localhost:${PORT}  ->  njsPC at ${NJSPC_URL}`);
  console.log("NOTE: v0 relays state and two intents. None of the six interlocks");
  console.log("      are implemented yet — this process supervises nothing.");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    clearInterval(heartbeat);
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
