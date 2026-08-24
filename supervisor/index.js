import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { NjsPC } from "./njspc.js";
import { toUiState, SPA_CIRCUIT, POOL_CIRCUIT } from "./map.js";

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
const WEB_ROOT = fileURLToPath(new URL("../dist", import.meta.url));

/* Supervisor-owned state: the things njsPC has no concept of. In production
   this must persist — a phone cannot be what remembers the bypass position.
   v0 keeps it in memory and says so. */
const own = {
  bypass: "around",
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
  async setMode({ mode }) {
    if (mode !== "pool" && mode !== "spa") throw new Error(`unknown mode ${mode}`);
    /* njsPC's shared-body model does the whole switch off one circuit. */
    await njs.setCircuit(mode === "spa" ? SPA_CIRCUIT : POOL_CIRCUIT, true);
  },
  async setTarget({ body, degrees }) {
    if (!(body in own.targets)) throw new Error(`unknown body ${body}`);
    own.targets[body] = degrees;
    publish();
  },
};

async function handleIntent(raw) {
  const { intent, ...args } = raw;
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
    ws.send(JSON.stringify({ type: "ack", id: msg.id ?? null, ...result }));
  });
});

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
  process.on(sig, () => {
    clearInterval(heartbeat);
    njs.stop();
    server.close(() => process.exit(0));
  });
}
