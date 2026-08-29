import {
  SPA_TIMEOUT_MIN, ASSUMED_VALVE_TRAVEL_SEC, HEATER_MIN_RPM,
} from "../src/lib/sequences.js";
import { DONT_STOP_MINUTES } from "./binding.js";

/**
 * Settings that live on njsPC rather than in this repo, checked against what
 * we believe they are.
 *
 * The commissioning list in CLAUDE.md opens by saying that forgetting one of
 * these is a silent fault. It was: a Spa circuit left with `eggTimer: 1` from
 * an afternoon of testing produced a one-minute spa session, and the screen
 * reported the resulting countdown perfectly accurately without ever
 * suggesting anything was wrong. Being right about the wrong configuration is
 * not much use at the side of a pool.
 *
 * These are checks, not corrections. The supervisor does not quietly rewrite
 * equipment configuration to match its own expectations — njsPC owns it,
 * dashPanel edits it, and a process that silently reverted a deliberate
 * change would be worse than one that says what it found.
 *
 * Everything here is a pure function of what njsPC reported, so each rule can
 * be argued with in a test rather than only observed in the wild.
 */

/** njsPC's own default, and far too long to be anybody's intent. */
export const NJSPC_DEFAULT_EGG_TIMER = 720;

/**
 * `circuits` is `{ [id]: { name, eggTimer, dontStop } }` as read from
 * `/config/circuit/:id`. Missing entries produce no findings: not knowing is
 * not the same as knowing something is wrong.
 */
export function checkCommissioning({
  spaCircuit, options, njspcOnLan, passwordSet, rs485, clock, heaters,
  valves, pumps, bodyCircuits,
} = {}) {
  return [
    ...checkPassword(passwordSet),
    ...checkExposure(njspcOnLan),
    ...checkSerialPort(rs485),
    ...checkValveBinding(valves),
    ...checkPump(pumps),
    ...checkHeatFloor(pumps, bodyCircuits),
    ...checkHeater(heaters),
    ...checkClock(clock),
    ...checkSpaEggTimer(spaCircuit),
    ...checkValveDelay(options),
  ];
}

/**
 * njsPC's valves must have **no device binding**.
 *
 * This supervisor drives the relay card directly, from `relays.js` and
 * `hat.js`. If a valve in njsPC is also bound to a device — REM, or anything
 * else njsPC can reach — then two processes are driving the same actuator
 * from different models of where it should be. The visible symptom is a valve
 * that moves twice, or moves back; the invisible one is a position nobody can
 * account for, on equipment with no feedback to recover from.
 *
 * A **warning**, not a note. Unlike most of this file, the bad state here is
 * not merely wrong information — it is a second authority on a device, which
 * is precisely what ADR-7 exists to forbid.
 *
 * It is also the kind of setting nobody sets on purpose: it arrives by
 * clicking through a dashPanel form, and there is no screen anywhere that
 * would otherwise mention it.
 */
export function checkValveBinding(valves) {
  if (!Array.isArray(valves)) return [];

  const bound = valves.filter(
    (v) => v && (nonEmpty(v.connectionId) || nonEmpty(v.deviceBinding)),
  );
  if (bound.length === 0) return [];

  const names = bound.map((v) => v.name || `valve ${v.id}`).join(", ");
  return [{
    id: "valve-bound-elsewhere",
    severity: "warn",
    what: bound.length === 1
      ? `njsPC is driving the ${names} valve itself`
      : `njsPC is driving these valves itself: ${names}`,
    detail:
      `This supervisor owns the relay card, so a valve with a device binding ` +
      `has two things deciding where it should be. Clear the binding in ` +
      `njsPC (dashPanel: the valve's connection and device), leaving the ` +
      `valve defined but not bound.`,
  }];
}

const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";

/**
 * Whether the pump can even reach the heater's flow floor.
 *
 * `heaterCall !== 'off' implies pumpRpm >= HEATER_MIN_RPM` is one of the
 * invariants, and njsPC decides the speed: `setTargetSpeed` takes the highest
 * among the circuits that are on. So if the circuit carrying a body runs
 * slower than the floor, calling for heat on that body breaches the invariant
 * every single time, by configuration rather than by fault.
 *
 * Which is exactly the shape of alarm this project has decided is worse than
 * useless. Once the pump is on the bus a permanent `heat-below-floor` would
 * sit on the Water screen for the whole of every heating run, and a monitor
 * that always fires is one nobody reads.
 *
 * Said here, before the pump is attached, it is a question with two honest
 * answers and no way yet to choose between them: either the circuit is too
 * slow or `HEATER_MIN_RPM` is wrong. It is a **placeholder** — the PRD's
 * instruction is to ramp the pump and find where the heat pump's flow fault
 * clears — so this deliberately does not say which one to change.
 *
 * A note, not a warning. Nothing is unsafe: the Raypak will not fire into
 * insufficient flow, it faults with `FLo`/`FL3`, and ADR-4 puts that
 * protection in the heater's firmware on purpose.
 */
export function checkHeatFloor(pumps, bodyCircuits) {
  if (!Array.isArray(pumps) || !bodyCircuits) return [];

  const speeds = new Map();
  for (const p of pumps) {
    for (const pc of p?.circuits ?? []) {
      const id = pc?.circuit?.id ?? pc?.circuit;
      if (Number.isFinite(Number(id)) && Number.isFinite(Number(pc?.speed))) {
        speeds.set(Number(id), Number(pc.speed));
      }
    }
  }
  if (speeds.size === 0) return [];

  const slow = [];
  for (const [label, id] of Object.entries(bodyCircuits)) {
    const rpm = speeds.get(Number(id));
    if (Number.isFinite(rpm) && rpm < HEATER_MIN_RPM) slow.push({ label, rpm });
  }
  if (slow.length === 0) return [];

  const which = slow.map((s) => `${s.label} at ${s.rpm} rpm`).join(", ");
  return [{
    id: "heat-floor-unreachable",
    severity: "note",
    what: `Heating the ${slow.map((s) => s.label).join(" or ")} would run below the flow floor`,
    detail:
      `njsPC runs ${which}, and this repo believes the heater needs ` +
      `${HEATER_MIN_RPM} rpm. A heat call on that body breaches the pump-floor ` +
      `invariant by configuration, so the alarm would stand for the whole run. ` +
      `One of the two numbers is wrong and neither is measured: ramp the pump ` +
      `at commissioning, find where the heat pump's flow fault clears, and ` +
      `correct whichever it turns out to be.`,
  }];
}

/**
 * A pump has to exist before a program can bind to one.
 *
 * The speed lives on the pump, in `pump.circuits` — njsPC has no runtime
 * pump-speed endpoint, because that is how pool controllers model a pump, and
 * `binding.js` is built around it. With no pump configured there is nowhere
 * for a program's rpm to live, so every bind fails and the programs sit
 * unbindable with a reason nobody can act on from the app.
 *
 * A **note** rather than a warning: nothing is unsafe, and on a rig with no
 * pump on the bus yet this is a true statement about an unfinished
 * installation rather than a fault.
 */
export function checkPump(pumps) {
  if (!Array.isArray(pumps)) return [];
  if (pumps.some((p) => p && p.id != null)) return [];

  return [{
    id: "no-pump",
    severity: "note",
    what: "njsPC has no pump configured",
    detail:
      `A manual program's speed is stored on the pump, in its circuit list — ` +
      `there is no runtime endpoint for pump speed. Until a pump exists, no ` +
      `program can be bound and none of them will run.`,
  }];
}

/**
 * Whether njsPC owns a heater at all.
 *
 * A **note**, and it was briefly a warning by mistake. The first version of
 * this rule said calls for heat "can never reach the equipment" without a
 * heater in njsPC, which was true only while `heaterCall` was derived from
 * njsPC's `heatStatus`. It no longer is: the heat contacts follow this
 * process's own call, because njsPC's heater has no device binding and
 * actuates nothing. So an empty list stops nothing.
 *
 * It is still worth saying. njsPC's body setpoints, its heat modes and
 * everything dashPanel shows about heating are meaningless without one, and
 * `state.setpoint` — which the Heat screen renders — stays null.
 *
 * Undefined means the configuration could not be read, which is not a
 * finding. An empty array is njsPC positively saying there are none.
 */
export function checkHeater(heaters) {
  if (!Array.isArray(heaters) || heaters.length > 0) return [];
  return [{
    id: "heater-missing",
    severity: "note",
    what: "njsPC has no heater configured",
    detail:
      "The heat contacts are driven from this app's own call, so they still " +
      "work — but njsPC has no setpoint or heat mode to report, so the " +
      "Heat screen shows no setpoint and dashPanel shows no heater. Add it " +
      "with `PUT /config/heater {type: 'heatpump', body: 'poolspa'}`; " +
      "docs/pi-bringup.md has the command.",
  }];
}

/**
 * Whether njsPC's RS-485 port actually exists on this box.
 *
 * The bus is how the pump and the chlorinator are reached at all, and the
 * failure is silent in the worst way: njsPC logs "cannot open" every ten
 * seconds and carries on serving a perfectly healthy-looking API, while
 * every reading stays null and nothing on any screen says why.
 *
 * On this hardware the relay HAT puts RS-485 on the Pi's GPIO UART, which is
 * `/dev/serial0` — not `/dev/ttyUSB0`, which is what njsPC ships pointing at
 * and what a USB dongle would be. Getting there also needs `enable_uart=1`
 * and the serial console removed from `cmdline.txt`, so there are three ways
 * to arrive at a port that does not exist. Hence a check rather than a line
 * in a document.
 *
 * `exists` is resolved by the caller, which is the only part that touches a
 * filesystem. Undefined means it could not be established — njsPC across a
 * network, say — and undefined is never a finding.
 */
export function checkSerialPort(rs485) {
  if (!rs485) return [];

  /* Turning the port off is the right move on a bench: with a pump
     configured and no bus, njsPC transmits anyway and logs an error for every
     attempt — 1165 an hour, measured. But it is also the setting whose
     symptom is silence, and disabling it switches off the missing-port check
     below, so the one thing that would have said "the bus is broken" goes
     quiet at the same time. A note, not a warning: right now it is correct. */
  if (rs485.enabled === false) {
    return [{
      id: "rs485-disabled",
      severity: "note",
      what: "njsPC's RS-485 port is switched off",
      detail:
        "Nothing is transmitted to the pump or the chlorinator, and every " +
        "reading from them stays null. Correct while no bus is attached. " +
        "Re-enable it — comms `enabled: true` in njsPC — before wiring the " +
        "bus, or the equipment will simply never answer and nothing will say " +
        "why.",
    }];
  }

  if (rs485.mock) return [];
  /* A port reached over the network is not this box's to check. */
  if (rs485.netConnect) return [];
  if (!rs485.port || rs485.exists !== false) return [];

  const usb = /ttyUSB|ttyACM/.test(rs485.port);
  return [{
    id: "rs485-missing",
    severity: "warn",
    what: `njsPC cannot open ${rs485.port}`,
    detail: usb
      ? `That is a USB adapter path and no such device is present. The relay ` +
        `HAT puts RS-485 on the GPIO UART — set njsPC's port to /dev/serial0, ` +
        `set enable_uart=1 in config.txt, and remove console=serial0 from ` +
        `cmdline.txt so the console stops holding it.`
      : `The port does not exist. Check enable_uart=1 in config.txt and that ` +
        `the serial console has been removed from cmdline.txt.`,
  }];
}

/**
 * Whether this box knows what time it is.
 *
 * The bring-up notes promised to compare njsPC's idea of local time against
 * ours. That turns out to be worthless: they run on the same Pi, so they
 * always agree — including when both are wrong, which is the entire failure
 * being guarded against.
 *
 * What can actually be established is whether the clock has been
 * synchronised and whether anybody chose a timezone. Both matter because
 * schedules are minutes past midnight and egg timers are wall-clock
 * deadlines, and a Pi has no battery-backed clock.
 */
export function checkClock({ synchronized, timeZone } = {}) {
  const findings = [];

  if (synchronized === false) {
    findings.push({
      id: "clock-unsynced",
      severity: "warn",
      what: "The clock has not been set from the network",
      detail:
        "A Pi has no battery-backed clock, so it boots with whatever time " +
        "was last written to disk. Schedules and egg timers are both " +
        "wall-clock, so they are running against a guess until NTP answers.",
    });
  }

  if (timeZone === "UTC" || timeZone === "Etc/UTC") {
    findings.push({
      id: "clock-utc",
      severity: "note",
      what: "This box is set to UTC",
      detail:
        "Almost certainly nobody chose that. Schedules are stored as minutes " +
        "past midnight and evaluated in local time, so an 08:00 filtration " +
        "window will run hours from when it reads. " +
        "`sudo timedatectl set-timezone <Region/City>`.",
    });
  }

  return findings;
}

/**
 * Whether anybody has set a password.
 *
 * The supervisor still starts without one, because bricking a pool mid-season
 * over a missing config file is its own kind of failure. But an open door
 * nobody mentions is exactly the silent fault this file exists to end, so it
 * is said on the screen as well as logged at startup.
 */
export function checkPassword(passwordSet) {
  if (passwordSet !== false) return [];
  return [{
    id: "no-password",
    severity: "warn",
    what: "Anyone who can reach this app can run the pool",
    detail:
      "No password is set, so any device on the network can switch the spa, " +
      "call for heat or stop the pump. Set one on the Pi with " +
      "`node supervisor/passwd.js`, then restart the supervisor.",
  }];
}

/**
 * Whether njsPC answers on a network address rather than only on loopback.
 *
 * This is the widest hole in the whole system and the easiest to reopen.
 * njsPC's REST API takes any request from anyone — no token, no password —
 * and dashPanel deliberately bypasses every interlock the supervisor adds.
 * Anyone on the wifi can switch bodies, call for heat and stop the pump.
 *
 * Checked by reachability rather than by reading `web.servers.http.ip`:
 * njsPC does not publish that setting over its API, and reachability is the
 * property that actually matters. A config value can be right while a
 * reverse proxy, a container port map or a second njsPC makes it moot.
 *
 * `null` means the question was not asked — the supervisor talks to njsPC
 * across a network by configuration, so loopback was never the plan. Not
 * knowing is not the same as knowing it is fine.
 */
export function checkExposure(njspcOnLan) {
  if (njspcOnLan !== true) return [];
  return [{
    id: "njspc-exposed",
    severity: "warn",
    what: "njsPC answers to anyone on the network",
    detail:
      "Its API needs no password and dashPanel bypasses every interlock " +
      "this supervisor adds. Set web.servers.http.ip to 127.0.0.1 in njsPC's " +
      "config.json and restart it; reach dashPanel over an SSH tunnel.",
  }];
}

/**
 * How long njsPC holds the pump off after diverting a valve.
 *
 * njsPC believes a PE24GVA diverts instantly — it flips both valve flags in
 * the same tick — so this delay is the only thing standing between a valve
 * command and the pump running again. `NixieBoard` raises it when
 * `pumpDelay` is on and `valveDelayTime > 0`; `Lockouts` ends it exactly
 * `valveDelayTime` seconds later.
 *
 * The comparison figure is assumed, not measured, and the wording says so.
 * The point is not to assert that 20 seconds is wrong — it is to stop the
 * question going unasked until something grinds.
 */
export function checkValveDelay(options) {
  if (!options) return [];
  const findings = [];
  const secs = options.valveDelayTime;

  if (options.pumpDelay === false) {
    findings.push({
      id: "valve-no-pump-delay",
      severity: "warn",
      what: "The pump is not held off while valves move",
      detail:
        `njsPC only pauses the pump for a valve move when its pump delay is ` +
        `on. Without it the actuators turn under load. Enable pumpDelay and ` +
        `set valveDelayTime above measured valve travel.`,
    });
    return findings;
  }

  if (Number.isFinite(secs) && secs > 0 && secs < ASSUMED_VALVE_TRAVEL_SEC) {
    findings.push({
      id: "valve-delay-short",
      severity: "note",
      what: `Valve moves get ${secs} s before the pump restarts`,
      detail:
        `This repo assumes about ${ASSUMED_VALVE_TRAVEL_SEC} s of travel, ` +
        `which nobody has measured. If that is right the pump restarts ` +
        `mid-swing. Time a valve at commissioning and set valveDelayTime ` +
        `above it.`,
    });
  }

  return findings;
}

function checkSpaEggTimer(spaCircuit) {
  const findings = [];
  if (!spaCircuit) return findings;

  const egg = spaCircuit.eggTimer;

  if (spaCircuit.dontStop || egg >= DONT_STOP_MINUTES) {
    findings.push({
      id: "spa-egg-never",
      severity: "warn",
      what: "Spa sessions never end on their own",
      detail:
        `njsPC reads ${DONT_STOP_MINUTES} minutes or more as "don't stop", so ` +
        `nothing will switch the spa back to pool. Set the Spa circuit egg ` +
        `timer to ${SPA_TIMEOUT_MIN}.`,
    });
    return findings;
  }

  if (egg === NJSPC_DEFAULT_EGG_TIMER) {
    findings.push({
      id: "spa-egg-default",
      severity: "warn",
      what: `Spa sessions last ${NJSPC_DEFAULT_EGG_TIMER / 60} hours`,
      detail:
        `That is njsPC's untouched default rather than a choice. Set the Spa ` +
        `circuit egg timer to ${SPA_TIMEOUT_MIN}.`,
    });
    return findings;
  }

  /* A session shorter than the transition it takes to get there is not a
     session. Spa -> pool -> spa is roughly two minutes of valve travel. */
  if (Number.isFinite(egg) && egg > 0 && egg < 5) {
    findings.push({
      id: "spa-egg-tiny",
      severity: "warn",
      what: `Spa sessions end after ${egg} minute${egg === 1 ? "" : "s"}`,
      detail:
        `njsPC will switch back to pool that soon after the spa starts — ` +
        `less time than the transition that gets you there. Set the Spa ` +
        `circuit egg timer to ${SPA_TIMEOUT_MIN}.`,
    });
    return findings;
  }

  if (Number.isFinite(egg) && egg > 0 && egg !== SPA_TIMEOUT_MIN) {
    /* Not wrong, just not what this repo believes. `SPA_TIMEOUT_MIN` is used
       by the mock and named in the invariants, so a divergence means two
       numbers describing one fact — the duplication ADR-10 exists to avoid. */
    findings.push({
      id: "spa-egg-differs",
      severity: "note",
      what: `Spa sessions end after ${egg} min, not ${SPA_TIMEOUT_MIN}`,
      detail:
        `njsPC's egg timer is the one that actually runs. If ${egg} is ` +
        `deliberate, change SPA_TIMEOUT_MIN to match.`,
    });
  }

  return findings;
}
