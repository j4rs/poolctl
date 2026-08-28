import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { NjsPC } from "./njspc.js";
import { toUiState, SPA_CIRCUIT, POOL_CIRCUIT } from "./map.js";
import { applyTarget } from "./targets.js";
import { Store, pickPersisted, applyPersisted } from "./store.js";
import {
  verifyPassword, issueToken, verifyToken, parseCookies,
  sessionCookie, clearedCookie, COOKIE,
} from "./auth.js";
import { DEFAULT_PROGRAMS } from "../src/lib/programs.js";
import {
  floorRpm, bypassFor, mayCallForHeat, mayToggleBlower, shouldStopHeat, refuse,
} from "./interlocks.js";
import { checkInvariants } from "./invariants.js";
import {
  circuitConfig, echoCircuitConfig, withPumpCircuit, withoutPumpCircuit,
  whyNotBindable, pumpLimits,
} from "./binding.js";
import { checkCommissioning } from "./commissioning.js";
import { access } from "node:fs/promises";
import { scheduleConfig, whyNotSchedulable } from "./schedules.js";
import { byteFor, describe as describeRelays } from "./relays.js";
import { createHat, available as hatAvailable } from "./hat.js";
import { createWatchdog, evaluationHealth } from "./watchdog.js";

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
const AUTH_FILE = process.env.AUTH_FILE
  || fileURLToPath(new URL("./auth.json", import.meta.url));

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
  /* Invariants broken right now. Not persisted: it describes the equipment a
     moment ago, and a stale alarm is worse than none. */
  violations: [],
  /* The last time a target ended a heat call, so the screen can say why the
     heater stopped rather than leaving it looking like a fault. */
  lastCutoff: null,
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
    /* Every fresh reading is a chance for an invariant to have broken or a
       target to have been reached. */
    evaluate();
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
  /* Drive the card from the very view being broadcast, so the relays and the
     screen cannot disagree. Doing this in `evaluate()` instead left every
     intent that only publishes — the light, the blower, a pool heat call —
     waiting up to a full heartbeat for its relay, with the UI already
     claiming the change had happened. Five seconds of the app lying about
     equipment state is worse than five seconds of latency. */
  driveRelays(ui);
  const msg = JSON.stringify({ type: "state", state: ui });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

/* ---- continuous evaluation --------------------------------------------- */

/**
 * Decide, then publish.
 *
 * Everything else in this file reacts to somebody tapping something. This is
 * the part that runs whether or not anyone is looking, which is what makes
 * the process a supervisor rather than a translator: njsPC acts on its own
 * timers, dashPanel writes behind our back, and equipment does not always do
 * what it was told.
 *
 * Deliberately small. It asserts the invariants and reports what it finds,
 * and it acts on exactly one thing — the heat call we own, at the target the
 * owner set. Correcting equipment on the strength of a snapshot is how a
 * supervisor makes a bad situation worse.
 */
/* The watchdog asks these two questions and nothing else: did an evaluation
   finish, and did it finish cleanly. See watchdog.js for why it deliberately
   does not ask whether the invariants were satisfied. */
let lastEvaluatedAt = null;
let lastEvaluationError = null;

/**
 * Break `evaluate()` on purpose, to exercise the half of the watchdog that
 * cannot be reached any other way.
 *
 * The wedge test — `kill -STOP` — freezes the whole process, so it proves
 * systemd notices a supervisor that has stopped pinging. It says nothing
 * about the case the health condition was actually written for: a process
 * that is alive, answering HTTP, holding sockets open, and no longer
 * thinking. That one has to be manufactured.
 *
 * `SIGUSR2` makes every subsequent evaluation throw. Persistent, not
 * one-shot: a single throw is cleared by the next good tick long before the
 * 60 s window elapses, so it would prove nothing. Only a restart clears it —
 * and if the watchdog is doing its job, the restart is what clears it.
 *
 * There is deliberately no network path to this, for the same reason
 * `passwd.js` has none. It needs a shell on the box, and anyone with a shell
 * can `systemctl stop poolctl`, which is strictly worse.
 *
 * Note that this displaces Node's default `SIGUSR2` behaviour, which is to
 * terminate. That is the point: without a listener the signal would kill the
 * process outright and the test would prove nothing about the watchdog.
 */
let injectedFault = null;

process.on("SIGUSR2", () => {
  if (injectedFault) return;
  injectedFault = "fault injected by SIGUSR2";
  console.error("SIGUSR2: evaluate() will throw from now on. The watchdog should");
  console.error("         withhold its ping and systemd should restart this");
  console.error("         service. Only a restart clears this.");
});

function evaluate() {
  try {
    if (injectedFault) throw new Error(injectedFault);
    const view = toUiState(njsRaw, own);
    applyCutoff(view);
    const settled = toUiState(njsRaw, own);
    own.violations = checkInvariants(settled);
    publish();
    lastEvaluatedAt = Date.now();
    lastEvaluationError = null;
  } catch (err) {
    /* Recorded rather than swallowed. The loop keeps running so a transient
       does not take the process down, but the watchdog stops pinging, so a
       persistent one ends in a restart instead of a supervisor that looks
       alive and has stopped thinking. */
    lastEvaluationError = err.message;
    console.error(`evaluate() threw: ${err.stack || err.message}`);
  }
}

/**
 * The card follows the state; it is never commanded directly.
 *
 * `set` writes only when the byte changes, so this is free on the heartbeat
 * and costs one process spawn on an actual valve move. Failures are reported
 * by `hat` once and do not throw here — a card that has gone away must not
 * stop the supervisor evaluating, because everything else it does still works
 * and the Water screen is how anyone finds out.
 */
function driveRelays(view) {
  if (!hat) return;
  const byte = byteFor(view);
  hat.set(byte).then((r) => {
    if (r.written) console.log(`relays -> ${describeRelays(byte)}`);
  }).catch(() => {});
}

/**
 * Targets are cutoffs (ADR-4), and this is the only place that has ever
 * enforced it.
 *
 * Until now `state.targets` was clamped, stored, persisted and displayed, and
 * nothing ever ended a call when the water reached it — the promise the whole
 * feature is named for was not kept anywhere.
 *
 * Only the pool call, because it is the only one we own: in spa mode njsPC
 * holds the heater and reaching in would be a second authority on it. And
 * the bypass is left where it is rather than swung back, because a valve may
 * only move after a purge has elapsed and the purge duration is unmeasured.
 * Ending the call is the safe half and the half that matters.
 */
function applyCutoff(view) {
  if (!own.poolHeatDemand || view.mode === "spa") return;
  if (!shouldStopHeat({ waterTemp: view.waterTemp, target: own.targets.pool })) return;

  own.poolHeatDemand = false;
  own.lastCutoff = {
    body: "pool",
    at: Date.now(),
    temp: view.waterTemp,
    target: own.targets.pool,
  };
  console.log(
    `target reached: pool at ${view.waterTemp}\u00b0F, cutting the heat call at ${own.targets.pool}\u00b0F`,
  );
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
/**
 * Can njsPC be reached from the network, or only from this box?
 *
 * Asked by trying it. Every non-internal IPv4 address this machine has is
 * offered to njsPC's own port; one answer means it is listening on more than
 * loopback. A refused connection is the good outcome and arrives instantly,
 * so the usual cost of this is microseconds.
 *
 * Returns null when the supervisor is configured to reach njsPC across a
 * network anyway, because then the question means nothing.
 */
async function njspcOnLan() {
  let target;
  try {
    target = new URL(NJSPC_URL);
  } catch {
    return null;
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(target.hostname)) return null;

  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === "IPv4" && !n.internal)
    .map((n) => n.address);

  for (const address of addresses) {
    try {
      const res = await fetch(`http://${address}:${target.port}/state/all`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) return true;
    } catch {
      /* Refused, unreachable or timed out — all mean not listening there. */
    }
  }
  return false;
}

/**
 * njsPC's RS-485 port, and whether it is actually there.
 *
 * Only asked when njsPC is on this box — the device node is local, so the
 * question is meaningless across a network and `exists` stays undefined,
 * which the rule treats as "not established" rather than "fine".
 */
async function rs485Status() {
  let target;
  try {
    target = new URL(NJSPC_URL);
  } catch {
    return null;
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(target.hostname);

  const opts = await njs.rs485Options();
  const port = (opts?.ports ?? [])[0];
  if (!port) return null;

  const status = {
    port: port.rs485Port,
    enabled: port.enabled,
    mock: port.mock,
    netConnect: port.netConnect,
  };
  if (!local || !status.port || status.netConnect) return status;

  try {
    await access(status.port);
    status.exists = true;
  } catch {
    status.exists = false;
  }
  return status;
}

/**
 * What this box believes about the time.
 *
 * `synchronized` comes from the file systemd-timesyncd touches once NTP has
 * answered — cheaper and more honest than shelling out to `timedatectl`, and
 * absent rather than false on a box that does not run timesyncd, which the
 * rule reads as "not established".
 */
async function clockStatus() {
  const status = { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  try {
    await access("/run/systemd/timesync/synchronized");
    status.synchronized = true;
  } catch (err) {
    /* Only a definite answer when timesyncd is present at all. */
    try {
      await access("/run/systemd/timesync");
      status.synchronized = false;
    } catch {
      /* not a systemd-timesyncd box; say nothing */
    }
  }
  return status;
}

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
    /* Settled, not all. These are independent reads against a dependency
       whose endpoints vary by version, and one of them being unavailable
       should cost us that one check — not every check. Whatever could not be
       read arrives as undefined, which the rules treat as "not known" rather
       than "not a problem". */
    const [circuit, config, onLan, rs485, clock] = await Promise.allSettled([
      njs.circuitConfig(SPA_CIRCUIT),
      njs.configAll(),
      njspcOnLan(),
      rs485Status(),
      clockStatus(),
    ]);
    if (circuit.status === "rejected" && config.status === "rejected") {
      throw new Error(circuit.reason?.message ?? "no configuration could be read");
    }
    const findings = checkCommissioning({
      spaCircuit: circuit.value,
      options: config.value?.pool?.options,
      njspcOnLan: onLan.value,
      passwordSet: authRequired(),
      rs485: rs485.value,
      clock: clock.value,
      heaters: config.value?.heaters,
    });
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

    /* ADR-9's first clause: the bypass **follows the mode** — flow in spa,
       around in pool. Until the relays were wired this line was missing and
       nothing noticed, because `own.bypass` was a string no actuator read:
       it was only ever assigned by the pool-heat intent below, so switching
       to spa left it wherever pool had put it. The first spa switch after the
       card went in came out as 0x07 — REL1, REL2 and the bypass — when spa
       must be 0x05. Deriving it here rather than leaving it to drift is the
       whole of the fix.

       Not derived at read time, deliberately. The cutoff path leaves the
       bypass where it is on purpose, because a valve may only move once a
       purge has elapsed and that duration is unmeasured; a pure derivation
       would silently override that. Mode changes are the one transition
       where ADR-9 says it must follow. */
    own.bypass = bypassFor(mode, mode === "pool" && own.poolHeatDemand);

    /* Spa owns the heater (ADR-4), so a pool call cannot survive the switch. */
    if (mode === "spa") own.poolHeatDemand = false;
    publish();
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
    /* The body has to carry a mode even though the endpoint is a toggle.
     *
     * njsPC's handler builds a local `data`, sets `data.mode` on it, and then
     * calls `setPanelModeAsync(req.body)` — the original body, not the object
     * it just prepared. So the mode it worked out is thrown away and an empty
     * body fails validation with "Invalid mode value cannot set mode".
     *
     * We sent `{}` for months and every service-mode tap returned a 400
     * against real njsPC. Nothing caught it because the fake njsPC in the
     * tests accepted any body; it now rejects one without a mode, exactly as
     * the real thing does.
     *
     * Sending "service" is right in both directions: leaving service is
     * handled by the `state.mode !== 0` branch, which ignores the body. */
    await njs.put("/state/toggleServiceMode", { mode: "service" });
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

  /**
   * Extend the spa session.
   *
   * njsPC's egg timer is what ends a spa session (ADR-11), and there is no
   * endpoint that moves an end time. `setEndTime` only fires on an off→on
   * transition — so re-sending "on" to a spa that is already on does nothing
   * — unless `bForce` is set, which happens in exactly one place: a circuit
   * config write. Writing the Spa circuit's configuration back unchanged
   * therefore recomputes its end time as now plus the egg timer, without
   * stopping the body or moving a valve. Verified against njsPC 10.0.1: the
   * end time advanced by precisely the elapsed time.
   *
   * This resets to a full session rather than adding a fixed amount, which
   * is both what njsPC can express and what the button means to somebody
   * sitting in the water.
   */
  async extendSpa() {
    if (ui?.mode !== "spa") throw refuse("the spa is not on");
    const cfg = await njs.circuitConfig(SPA_CIRCUIT);
    if (!cfg?.eggTimer || cfg.dontStop) {
      /* Nothing to extend: njsPC is not going to end this session anyway,
         and the commissioning check already says so. */
      throw refuse("the spa has no timer to extend");
    }
    await njs.setCircuitConfig(echoCircuitConfig(cfg));
  },

  /**
   * Schedules.
   *
   * njsPC owns these outright — it evaluates them on its own timers and will
   * switch a body without asking (ADR-11). So these intents translate and
   * write through; nothing is kept on this side that could disagree, and the
   * list the UI renders is read straight back out of njsPC's state.
   */
  async saveSchedule({ schedule }) {
    const why = whyNotSchedulable(schedule);
    if (why) throw refuse(why);
    await njs.setScheduleConfig(scheduleConfig(schedule));
  },

  async deleteSchedule({ id }) {
    if (!Number.isFinite(Number(id))) throw refuse(`no schedule '${id}'`);
    await njs.deleteScheduleConfig(Number(id));
  },

  /**
   * Switch a schedule off without deleting it.
   *
   * njsPC keeps `disabled` separate from `isActive`, which is the difference
   * between "not running this week" and "gone". Read-modify-write, because
   * `setScheduleAsync` fills unspecified fields from the stored schedule and
   * we would rather send what we mean than rely on that.
   */
  async setScheduleEnabled({ id, on }) {
    const current = (ui?.schedules ?? []).find((s) => s.id === Number(id));
    if (!current) throw refuse(`no schedule '${id}'`);
    await njs.setScheduleConfig(scheduleConfig({ ...current, enabled: Boolean(on) }));
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
    /* Re-evaluate straight away rather than waiting for the next beat. A
       heat call asked for when the water is already at the target should end
       on the same tap, not up to five seconds later. */
    evaluate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ---- who is allowed in ------------------------------------------------- */

/**
 * The credential, or null if nobody has set a password.
 *
 * Read once at startup rather than per request: it is a 0600 file the owner
 * writes over SSH with `passwd.js`, and re-reading it on every socket upgrade
 * would put a disk hit on the hot path for a file that changes twice a year.
 * Changing the password therefore needs a restart, which `passwd.js` says.
 */
let credential = null;

async function loadCredential() {
  try {
    credential = JSON.parse(await readFile(AUTH_FILE, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") console.warn(`auth: ignoring unreadable ${AUTH_FILE}: ${err.message}`);
    credential = null;
  }
}

const authRequired = () => Boolean(credential?.hash && credential?.secret);

/** Whether this request carries a valid session. */
function isAuthed(req) {
  if (!authRequired()) return true;
  const token = parseCookies(req.headers?.cookie)[COOKIE];
  return verifyToken(token, credential.secret);
}

/**
 * Login throttling.
 *
 * scrypt already costs ~40 ms a guess, which makes an online brute force
 * hopeless on its own, but it also makes the login endpoint a free way to
 * pin the Pi's CPU. Five tries then a spreading lockout costs an honest
 * fat-fingered owner nothing.
 */
const attempts = new Map();
const FREE_TRIES = 5;

function throttle(ip) {
  const record = attempts.get(ip);
  if (!record) return 0;
  return Math.max(0, record.until - Date.now());
}

function recordFailure(ip) {
  const record = attempts.get(ip) ?? { fails: 0, until: 0 };
  record.fails += 1;
  if (record.fails > FREE_TRIES) {
    const seconds = Math.min(300, 2 ** (record.fails - FREE_TRIES));
    record.until = Date.now() + seconds * 1000;
  }
  attempts.set(ip, record);
}

const clearFailures = (ip) => attempts.delete(ip);

/** Read a small JSON body, refusing anything large enough to be an attack. */
async function readJson(req, limit = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString());
}

const sendJson = (res, status, body, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

/** The /auth/* routes. Returns true if it handled the request. */
async function handleAuth(req, res) {
  const path = req.url.split("?")[0];
  if (!path.startsWith("/auth/")) return false;

  if (path === "/auth/status" && req.method === "GET") {
    /* Public on purpose: the client has to know whether to show a login
       screen before it has a session, and the answer leaks nothing that
       trying to connect would not. */
    sendJson(res, 200, { required: authRequired(), authenticated: isAuthed(req) });
    return true;
  }

  if (path === "/auth/logout" && req.method === "POST") {
    sendJson(res, 200, { ok: true }, { "Set-Cookie": clearedCookie() });
    return true;
  }

  if (path === "/auth/login" && req.method === "POST") {
    if (!authRequired()) {
      sendJson(res, 200, { ok: true, required: false });
      return true;
    }
    const ip = req.socket.remoteAddress ?? "unknown";
    const wait = throttle(ip);
    if (wait > 0) {
      sendJson(res, 429, { ok: false, error: `too many attempts, wait ${Math.ceil(wait / 1000)}s` });
      return true;
    }
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { ok: false, error: "bad request" });
      return true;
    }
    if (!verifyPassword(body?.password, credential)) {
      recordFailure(ip);
      console.warn(`auth: failed login from ${ip}`);
      /* One message for every failure. "No such user" and "wrong password"
         are different sentences that tell an attacker which half to work on;
         here there is only one secret, so there is only one sentence. */
      sendJson(res, 401, { ok: false, error: "wrong password" });
      return true;
    }
    clearFailures(ip);
    sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(issueToken(credential.secret)) });
    return true;
  }

  sendJson(res, 404, { ok: false, error: "no such route" });
  return true;
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
  if (await handleAuth(req, res)) return;

  if (req.url === "/health") {
    /* Left open, and kept free of pool state for that reason. A watchdog
       needs to reach this without a session, and "is the process alive" is
       not worth protecting.

       `thinking` is the distinction this endpoint could not previously make.
       A supervisor whose evaluation loop has died still binds the port, still
       answers here, and still holds every socket open — so `ok: true` alone
       reports a healthy process that has stopped supervising. This is the
       same condition the watchdog withholds its ping on, read from the same
       function, so a human can see the state that is about to cause a
       restart rather than only its aftermath in the journal. */
    const think = evaluationStatus();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true, njspc: own.connected, lastSeen: own.lastSeen,
      thinking: think.ok, ...(think.ok ? {} : { why: think.why }),
    }));
    return;
  }
  if (req.url === "/state") {
    if (!isAuthed(req)) {
      sendJson(res, 401, { error: "sign in" });
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ui ?? {}));
    return;
  }
  /* The app shell is public. It is markup and JavaScript with no pool state
     in it, and it has to load before anyone can sign in. */
  await serveStatic(req, res);
});

/**
 * The socket is where every intent travels, so it is the thing that actually
 * has to be guarded — an auth layer over the page alone would be theatre.
 *
 * `noServer` rather than `verifyClient`: this way a refusal is an ordinary
 * 401 on the upgrade, before any WebSocket exists, and the client can tell
 * "sign in" apart from "the supervisor is down".
 */
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!isAuthed(req)) {
    console.warn(`auth: refused socket from ${req.socket.remoteAddress}`);
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

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
await loadCredential();

njs.start();

/* njsPC only talks when something changes, and a quiet system is
   indistinguishable from a dead one over a socket. This makes silence
   meaningful: a client that stops hearing from us really has lost the link. */
/* The heartbeat evaluates rather than merely republishing: njsPC only speaks
   when something changes, and "nothing changed" is exactly the condition a
   stuck heat call presents. */
/**
 * The relay card, and the two moments its state is asserted rather than
 * followed.
 *
 * `RELAYS=off` disables all of it — for running the supervisor on a laptop, or
 * on a Pi whose card is not to be touched. Absent a card, `hat` is null and
 * every relay path is a no-op, which is what makes this safe to deploy before
 * the panel exists.
 */
const RELAYS_ENABLED = process.env.RELAYS !== "off" && hatAvailable();
const hat = RELAYS_ENABLED ? createHat({}) : null;
if (!RELAYS_ENABLED) {
  console.log(
    process.env.RELAYS === "off"
      ? "relays: disabled by RELAYS=off"
      : "relays: no I2C bus, running without a card",
  );
}

/**
 * De-energise, unconditionally, whatever the shadow says.
 *
 * Used at start and at stop, and `force` rather than `set` in both places on
 * purpose: at boot we have never written the card and cannot know what it is
 * holding, and at shutdown the shadow is the last thing *we* wrote, which is
 * not evidence about now. Assuming otherwise is how a valve gets left
 * somewhere nobody expects.
 *
 * De-energised is safe for every channel — architecture.md: valves to pool,
 * bypass to flow, heater open, blower off — which is the property that makes
 * this the right thing to do without knowing anything else.
 */
async function deEnergise(why) {
  if (!hat) return;
  const r = await hat.force(0x00);
  console.log(`relays -> 0x00 (all off) — ${why}${r.written ? "" : " [FAILED]"}`);
}

const heartbeat = setInterval(evaluate, HEARTBEAT_MS);
const recheck = setInterval(reviewCommissioning, COMMISSIONING_MS);

/* One definition, two readers: the watchdog decides whether to ping on it and
   /health reports it. They must not be able to disagree about whether this
   process is still thinking. */
function evaluationStatus() {
  return evaluationHealth({
    lastEvaluatedAt, lastError: lastEvaluationError,
    now: Date.now(),
    /* Three heartbeats. One missed tick is scheduling; three is a wedge. */
    staleAfterMs: HEARTBEAT_MS * 3,
  });
}

const watchdog = createWatchdog({ isHealthy: evaluationStatus });

server.listen(PORT, async () => {
  console.log(`supervisor v0 on http://localhost:${PORT}  ->  njsPC at ${NJSPC_URL}`);
  /* Before serving anything and before the first evaluation: whatever the card
     was holding through a crash, a kill or a power cut is not ours to inherit.
     This is the boot half of ADR-10 — every restart begins from de-energised. */
  await deEnergise("boot");
  watchdog.start();
  if (!authRequired()) {
    console.warn("WARNING: no password set. Anyone who can reach this port can");
    console.warn("         drive the equipment. Run: node supervisor/passwd.js");
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    clearInterval(heartbeat);
    clearInterval(recheck);
    clearTimeout(reviewTimer);
    watchdog.stop();
    njs.stop();
    /* Before the store flush and before the sockets close, because this is the
       only part of shutdown that moves equipment and the rest can wait. A
       clean stop must not leave a coil energised: `systemctl stop`, a deploy
       and a reboot all come through here. */
    await deEnergise(sig);
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
