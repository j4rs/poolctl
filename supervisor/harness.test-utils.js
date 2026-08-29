/**
 * Spawning a supervisor and talking to it, shared by the socket-layer tests
 * and the binding tests.
 *
 * Not named `*.test.js`, so Vitest does not collect it as a suite.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { describe as describeByte } from "./relays.js";

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

const FAKE_I2C = fileURLToPath(new URL("./fake-i2c.js", import.meta.url));

/**
 * Stand a fake relay card in front of the supervisor.
 *
 * Faked at the *process boundary* rather than inside `hat.js`: the harness
 * writes `i2cset` and `i2cget` wrappers into a directory and points
 * `I2C_TOOL_DIR` at it, so the supervisor spawns them exactly as it spawns the
 * real tools. `hat.js` runs for real — argument building, output parsing,
 * write serialisation, the failure path — and none of it knows.
 *
 * `available()` also wants a bus node to exist, so an empty file stands in for
 * `/dev/i2c-1`. It is only ever tested for existence.
 */
async function fakeCard() {
  const dir = await mkdtemp(join(tmpdir(), "poolctl-i2c-"));
  const state = join(dir, "card.json");
  const device = join(dir, "i2c-fake");

  await writeFile(state, JSON.stringify({ byte: 0x00, writes: [] }));
  await writeFile(device, "");
  for (const tool of ["set", "get"]) {
    const path = join(dir, `i2c${tool}`);
    await writeFile(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_I2C}" ${tool} "$@"\n`);
    await chmod(path, 0o755);
  }

  const load = async () => JSON.parse(await readFile(state, "utf8"));
  return {
    env: { I2C_TOOL_DIR: dir, I2C_DEVICE: device, FAKE_I2C_STATE: state },
    /** What the card holds right now. */
    async byte() { return (await load()).byte; },
    /** Every write, in order, as raw bytes. */
    async writes() { return (await load()).writes.map((w) => w.byte); },

    /**
     * The same writes, named.
     *
     * Order is the safety property in this system — valve before contact,
     * purge before isolation, boot passing through `0x00` — and a resting
     * byte cannot show it. Two bugs this week had the right end state and the
     * wrong path.
     *
     * Named rather than numeric so a failure explains itself: `0x25  REL1
     * REL2 REL5` against `0x05  REL1 REL2` says which relay differs without
     * anyone reaching for the map.
     */
    async trace() { return (await load()).writes.map((w) => describeByte(w.byte)); },

    /**
     * Resolve once the card has stopped changing.
     *
     * Trace tests need this and state assertions do not: `settles()` waits on
     * a published field, which can be true a beat before the byte that
     * follows from it has landed. Resetting the log in that gap captures a
     * stray write and the trace reads as though the supervisor did something
     * extra.
     */
    async quiet({ still = 700, timeout = 8000 } = {}) {
      const deadline = Date.now() + timeout;
      let count = (await load()).writes.length;
      let unchangedSince = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, 100));
        const now = (await load()).writes.length;
        if (now !== count) { count = now; unchangedSince = Date.now(); }
        else if (Date.now() - unchangedSince >= still) return;
        if (Date.now() > deadline) return;
      }
    },

    /** Forget the writes so far, so a trace can start from here. */
    async reset() {
      const s = await load();
      s.writes = [];
      await writeFile(state, JSON.stringify(s));
    },
    /** Drive the card behind the supervisor's back, as a bench hand would. */
    async poke(byte) {
      const s = await load();
      s.byte = byte;
      await writeFile(state, JSON.stringify(s));
    },

    /** The card has gone away, or come back. */
    async setFailing(fail) {
      const s = await load();
      s.fail = Boolean(fail);
      await writeFile(state, JSON.stringify(s));
    },

    /** Make reads slow, so a write can be made to land inside one. */
    async setReadDelay(ms) {
      const s = await load();
      s.readDelayMs = ms;
      await writeFile(state, JSON.stringify(s));
    },

    /** Resolve once a read is open, so a test can act during it. */
    async whileReading({ timeout = 15000 } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        if ((await load()).readingSince) return;
        if (Date.now() > deadline) throw new Error("no read went in flight");
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  };
}

/** Spawn a supervisor and wait until it answers /health. */
export async function start({
  stateFile, njspcUrl, authFile, card = false, purgeMs, commissioningMs, watchdogUsec,
} = {}) {
  const relays = card ? await fakeCard() : null;
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
      /* Absent unless a test asked for a card, so every existing test keeps
         the behaviour it was written against: no bus, no relay writes. */
      ...(relays ? relays.env : {}),
      /* Compressed durations, so a three-minute rule can be asserted in three
         seconds. Only set when a test asks: everything else keeps the real
         numbers, and a test that quietly ran against a different purge than
         the Pi does would be worse than no test. */
      ...(purgeMs === undefined ? {} : { PURGE_MS: String(purgeMs) }),
      ...(commissioningMs === undefined ? {} : { COMMISSIONING_MS: String(commissioningMs) }),
      /* systemd normally sets this. Absent, the watchdog is inert. */
      ...(watchdogUsec === undefined ? {} : { WATCHDOG_USEC: String(watchdogUsec) }),
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
    /** The fake card, when one was asked for. */
    card: relays,
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

