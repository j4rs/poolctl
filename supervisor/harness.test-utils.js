/**
 * Spawning a supervisor and talking to it, shared by the socket-layer tests
 * and the binding tests.
 *
 * Not named `*.test.js`, so Vitest does not collect it as a suite.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const ENTRY = fileURLToPath(new URL("./index.js", import.meta.url));

/* Restated from index.js. `src/lib/useSupervisor.test.jsx` restates the
   client's tolerance against the same number; if either drifts, the pair
   fails, which is the whole defence against the threshold-shorter-than-the-
   heartbeat bug that shipped once already. */
const HEARTBEAT_MS = 5000;

export async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/** Spawn a supervisor and wait until it answers /health. */
export async function start({ stateFile, njspcUrl, authFile } = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      /* Nothing listens on port 1. Refused instantly and forever, so the
         "njsPC is unreachable" state is reached deterministically. Tests that
         want a reachable njsPC pass their own fake. */
      NJSPC_URL: njspcUrl ?? "http://127.0.0.1:1",
      /* Points at a file that does not exist unless a test made one, which
         leaves the supervisor open — the state most tests want, and the
         reason auth has its own suite. */
      AUTH_FILE: authFile ?? join(tmpdir(), "poolctl-no-such-auth.json"),
      STATE_FILE: stateFile ?? join(await mkdtemp(join(tmpdir(), "poolctl-")), "state.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output = [];
  proc.stdout.on("data", (d) => output.push(String(d)));
  proc.stderr.on("data", (d) => output.push(String(d)));

  const exited = new Promise((r) => proc.once("exit", (code, signal) => r({ code, signal })));
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`supervisor never started:\n${output.join("")}`);
    await new Promise((r) => setTimeout(r, 40));
  }

  return {
    port,
    output,
    url: (path) => `http://127.0.0.1:${port}${path}`,
    /** Send a signal and carry on — the process is expected to survive it. */
    signal(sig) { proc.kill(sig); },
    /** SIGTERM, then wait. Resolves with how it exited. */
    async term({ patience = 4000 } = {}) {
      proc.kill("SIGTERM");
      const killer = setTimeout(() => proc.kill("SIGKILL"), patience);
      const how = await exited;
      clearTimeout(killer);
      return how;
    },
    async stop() {
      proc.kill("SIGKILL");
      await exited;
    },
  };
}

/** A browser, near enough: one socket, correlated intents, awaited frames. */
export class Client {
  constructor(port) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.frames = [];
    this.listeners = new Set();
    this.seq = 0;
    this.ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      this.frames.push(msg);
      for (const l of [...this.listeners]) l(msg);
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  /** The next frame matching `match`, or a failure that says what was missed. */
  next(match, ms = 4000) {
    return new Promise((resolve, reject) => {
      const listener = (msg) => {
        if (!match(msg)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(msg);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`no matching frame in ${ms}ms; saw ${JSON.stringify(this.frames)}`));
      }, ms);
      this.listeners.add(listener);
    });
  }

  /** Send an intent, resolve with its ack. */
  intent(intent, args = {}) {
    const reqId = ++this.seq;
    const ack = this.next((m) => m.type === "ack" && m.reqId === reqId);
    this.ws.send(JSON.stringify({ reqId, intent, args }));
    return ack;
  }

  /** Send something the protocol does not describe. */
  raw(text) {
    this.ws.send(text);
  }

  state(ms) {
    return this.next((m) => m.type === "state", ms).then((m) => m.state);
  }

  async close() {
    this.ws.close();
    await new Promise((r) => this.ws.once("close", r));
  }
}

export async function connect(port) {
  const c = new Client(port);
  await c.opened;
  return c;
}

