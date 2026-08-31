// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  checkCommissioning, checkExposure, checkSerialPort, checkClock, checkHeater,
  checkValveBinding, checkPump, checkHeatFloor, checkHeaterSetpoint,
  NJSPC_DEFAULT_EGG_TIMER,
} from "./commissioning.js";
import { SPA_TIMEOUT_MIN } from "../src/lib/sequences.js";

/**
 * The checks that make a silent commissioning fault audible.
 *
 * Written after a spa reverted one minute into a session: the egg timer had
 * been left at a test value, and the screen reported the resulting countdown
 * perfectly accurately without ever suggesting anything was wrong.
 */

const spa = (over) => ({ id: 1, name: "Spa", eggTimer: SPA_TIMEOUT_MIN, dontStop: false, ...over });

describe("the heater's own setpoint, which nothing can read", () => {
  it("says nothing when it was not asked about", () => {
    /* This file's convention: an absent argument is "not knowing", never a
       finding. Every other check here reads njsPC; this one reads our own
       store, so undefined means the caller did not ask. */
    expect(checkHeaterSetpoint(undefined)).toEqual([]);
    expect(checkCommissioning({ spaCircuit: spa() })).toEqual([]);
  });

  it("says nothing once both are stated", () => {
    expect(checkHeaterSetpoint({ pool: 90, spa: 100 })).toEqual([]);
  });

  it("names only the bodies nobody has stated", () => {
    const [f] = checkHeaterSetpoint({ pool: 90, spa: null });
    expect(f.id).toBe("heater-setpoint-unknown");
    expect(f.what).toMatch(/spa setpoint/);
    expect(f.what).not.toMatch(/pool/);
  });

  it("is a note, never a fault — an unstated setpoint blocks nothing", () => {
    const [f] = checkHeaterSetpoint({ pool: null, spa: null });
    expect(f.severity).toBe("note");
    expect(f.detail).toMatch(/commands nothing/);
  });
});

describe("the spa egg timer", () => {
  it("says nothing when it matches", () => {
    expect(checkCommissioning({ spaCircuit: spa() })).toEqual([]);
  });

  it("catches the value that caused this", () => {
    const [f] = checkCommissioning({ spaCircuit: spa({ eggTimer: 1 }) });
    expect(f.id).toBe("spa-egg-tiny");
    expect(f.severity).toBe("warn");
    expect(f.what).toMatch(/Spa sessions end after 1 minute/);
    expect(f.detail).toMatch(String(SPA_TIMEOUT_MIN));
  });

  it("talks about the setting, not about what is happening now", () => {
    /* "The spa reverts after 1 minute", read while sitting in pool mode,
       sounds like a live countdown for something nobody started. */
    const [f] = checkCommissioning({ spaCircuit: spa({ eggTimer: 1 }) });
    expect(f.what).toMatch(/^Spa sessions/);
    expect(f.what).not.toMatch(/^The spa reverts/);
  });

  it("gets the plural right, because it will be read by a person", () => {
    const [f] = checkCommissioning({ spaCircuit: spa({ eggTimer: 3 }) });
    expect(f.what).toMatch(/Spa sessions end after 3 minutes/);
  });

  it("catches njsPC's untouched default", () => {
    /* Twelve hours is not a spa session, it is a forgotten one. */
    const [f] = checkCommissioning({ spaCircuit: spa({ eggTimer: NJSPC_DEFAULT_EGG_TIMER }) });
    expect(f.id).toBe("spa-egg-default");
    expect(f.what).toMatch(/12 hours/);
  });

  it("catches a spa set never to stop", () => {
    /* njsPC reads 1440 as `dontStop`, not as twenty-four hours. */
    const [f] = checkCommissioning({ spaCircuit: spa({ eggTimer: 1440 }) });
    expect(f.id).toBe("spa-egg-never");
    expect(f.what).toMatch(/never/);
  });

  it("catches the flag as well as the number", () => {
    const [f] = checkCommissioning({ spaCircuit: spa({ dontStop: true }) });
    expect(f.id).toBe("spa-egg-never");
  });

  it("notes a deliberate-looking difference without calling it wrong", () => {
    /* 90 minutes is a plausible choice. The point is that two numbers now
       describe one fact, and njsPC's is the one that runs. */
    const [f] = checkCommissioning({ spaCircuit: spa({ eggTimer: 90 }) });
    expect(f.id).toBe("spa-egg-differs");
    expect(f.severity).toBe("note");
    expect(f.detail).toMatch(/SPA_TIMEOUT_MIN/);
  });

  it("reports one finding at a time, the most serious", () => {
    /* Three notices about the same setting is noise, and the operator only
       has one thing to change. */
    expect(checkCommissioning({ spaCircuit: spa({ eggTimer: 1440 }) })).toHaveLength(1);
    expect(checkCommissioning({ spaCircuit: spa({ eggTimer: 1 }) })).toHaveLength(1);
  });

  it("says nothing when njsPC could not be read", () => {
    /* Not knowing is not the same as knowing something is wrong. */
    expect(checkCommissioning({})).toEqual([]);
    expect(checkCommissioning({ spaCircuit: null })).toEqual([]);
    expect(checkCommissioning()).toEqual([]);
  });

  it("says nothing about a circuit with no egg timer reported", () => {
    expect(checkCommissioning({ spaCircuit: spa({ eggTimer: undefined }) })).toEqual([]);
  });
});

describe("njsPC answering to the whole network", () => {
  /**
   * The widest hole in the system and the easiest to reopen: njsPC's API
   * takes any request from anyone, and dashPanel bypasses every interlock
   * the supervisor adds. Binding it to loopback is a config change somebody
   * will eventually undo, so the supervisor checks rather than trusts.
   */

  it("warns when njsPC answered on a network address", () => {
    const [f] = checkExposure(true);
    expect(f.id).toBe("njspc-exposed");
    expect(f.severity).toBe("warn");
    expect(f.detail).toMatch(/127\.0\.0\.1/);
    expect(f.detail).toMatch(/dashPanel/);
  });

  it("says nothing when it only answers on loopback", () => {
    expect(checkExposure(false)).toEqual([]);
  });

  it("says nothing when the question does not apply", () => {
    /* The supervisor may be pointed at njsPC across a network on purpose.
       Not knowing is not the same as knowing it is fine, and neither is a
       finding. */
    expect(checkExposure(null)).toEqual([]);
    expect(checkExposure(undefined)).toEqual([]);
  });

  it("is reported alongside the other findings, not instead of them", () => {
    const found = checkCommissioning({
      njspcOnLan: true,
      spaCircuit: { id: 1, name: "Spa", eggTimer: 1, dontStop: false },
    });
    expect(found.map((f) => f.id)).toEqual(
      expect.arrayContaining(["njspc-exposed", "spa-egg-tiny"]),
    );
  });

  it("leads with it, because it is the one that matters most", () => {
    const found = checkCommissioning({
      njspcOnLan: true,
      spaCircuit: { id: 1, name: "Spa", eggTimer: 1, dontStop: false },
      options: { pumpDelay: true, valveDelayTime: 5 },
    });
    expect(found[0].id).toBe("njspc-exposed");
  });
});

describe("the RS-485 port", () => {
  /**
   * How the pump and the chlorinator are reached at all. The failure is
   * silent in the worst way: njsPC logs "cannot open" every ten seconds and
   * keeps serving a healthy-looking API while every reading stays null.
   */
  const ok = { port: "/dev/serial0", enabled: true, mock: false, netConnect: false, exists: true };

  it("says nothing when the port is there", () => {
    expect(checkSerialPort(ok)).toEqual([]);
  });

  it("catches a port that does not exist", () => {
    const [f] = checkSerialPort({ ...ok, exists: false });
    expect(f.id).toBe("rs485-missing");
    expect(f.what).toMatch(/cannot open \/dev\/serial0/);
  });

  it("recognises the USB path njsPC ships with, and names the HAT's port", () => {
    /* The exact trap on this hardware: the relay HAT puts RS-485 on the GPIO
       UART, and njsPC's default points at a USB dongle that is not fitted. */
    const [f] = checkSerialPort({ ...ok, port: "/dev/ttyUSB0", exists: false });
    expect(f.detail).toMatch(/\/dev\/serial0/);
    expect(f.detail).toMatch(/enable_uart/);
    expect(f.detail).toMatch(/console=serial0/);
  });

  it("says nothing when the port could not be established", () => {
    /* Undefined is "not asked", not "fine" — njsPC across a network. */
    expect(checkSerialPort({ ...ok, exists: undefined })).toEqual([]);
  });

  it("says nothing about a bus reached over the network", () => {
    expect(checkSerialPort({ ...ok, netConnect: true, exists: false })).toEqual([]);
  });

  it("says nothing about a mocked port", () => {
    expect(checkSerialPort({ ...ok, mock: true, exists: false })).toEqual([]);
  });

  it("says the port is switched off, and only that", () => {
    /* Disabling comms is the bench fix for njsPC transmitting at an absent
       pump. It also silences the missing-port check, so without this the one
       setting whose symptom is silence would itself be silent. */
    const found = checkSerialPort({ ...ok, enabled: false, exists: false });
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe("rs485-disabled");
    expect(found[0].severity).toBe("note");
    expect(found[0].detail).toMatch(/before wiring the bus/i);
  });

  it("says nothing when njsPC reported no port at all", () => {
    expect(checkSerialPort(null)).toEqual([]);
    expect(checkSerialPort(undefined)).toEqual([]);
    expect(checkSerialPort({ enabled: true })).toEqual([]);
  });
});

describe("the heater njsPC does not have", () => {
  it("says nothing when a heater is configured", () => {
    expect(checkHeater([{ id: 256, type: 3, name: "Raypak" }])).toEqual([]);
  });

  it("says nothing when the configuration could not be read", () => {
    /* Not knowing is not the same as knowing there is none. */
    expect(checkHeater(undefined)).toEqual([]);
    expect(checkHeater(null)).toEqual([]);
  });

  it("notes an empty list without calling it a fault", () => {
    /* A note, not a warning: the heat contacts follow this app's own call,
       so a missing njsPC heater costs the setpoint display and dashPanel,
       not the relays. It was a warning for about an hour, on the older
       assumption that heaterCall came from njsPC. */
    const [f] = checkHeater([]);
    expect(f.id).toBe("heater-missing");
    expect(f.severity).toBe("note");
    expect(f.detail).toMatch(/heatpump/);
  });
});

describe("the clock", () => {
  /**
   * The bring-up notes promised to compare njsPC's local time against ours.
   * That is worthless — they share a Pi, so they agree even when both are
   * wrong, which is the whole failure. These check what can actually be
   * established.
   */

  it("says nothing when the clock is set and a zone was chosen", () => {
    expect(checkClock({ synchronized: true, timeZone: "America/New_York" })).toEqual([]);
  });

  it("catches a clock that has never been set from the network", () => {
    const [f] = checkClock({ synchronized: false, timeZone: "America/New_York" });
    expect(f.id).toBe("clock-unsynced");
    expect(f.severity).toBe("warn");
  });

  it("notices a box still on UTC", () => {
    /* Schedules are minutes past midnight in local time, so this runs the
       pool hours out and throws nothing. */
    const [f] = checkClock({ synchronized: true, timeZone: "UTC" });
    expect(f.id).toBe("clock-utc");
    expect(f.detail).toMatch(/set-timezone/);
  });

  it("treats Etc/UTC the same, because it is the same thing", () => {
    expect(checkClock({ synchronized: true, timeZone: "Etc/UTC" })[0].id).toBe("clock-utc");
  });

  it("reports both when both are wrong", () => {
    expect(checkClock({ synchronized: false, timeZone: "UTC" }).map((f) => f.id))
      .toEqual(["clock-unsynced", "clock-utc"]);
  });

  it("says nothing when sync could not be established", () => {
    /* Not a systemd-timesyncd box: absent is not false. */
    expect(checkClock({ timeZone: "America/New_York" })).toEqual([]);
    expect(checkClock({})).toEqual([]);
    expect(checkClock()).toEqual([]);
  });
});

describe("all the findings together", () => {
  it("leads with the ones that mean the pool is not under control", () => {
    const found = checkCommissioning({
      passwordSet: false,
      njspcOnLan: true,
      rs485: { port: "/dev/ttyUSB0", enabled: true, exists: false },
      clock: { synchronized: false, timeZone: "UTC" },
      spaCircuit: { id: 1, name: "Spa", eggTimer: 1 },
    });
    expect(found[0].id).toBe("no-password");
    expect(found[1].id).toBe("njspc-exposed");
    expect(found.map((f) => f.id)).toContain("rs485-missing");
    expect(found.map((f) => f.id)).toContain("clock-unsynced");
    expect(found.map((f) => f.id)).toContain("spa-egg-tiny");
  });

  it("is silent on a properly commissioned system", () => {
    expect(checkCommissioning({
      passwordSet: true,
      njspcOnLan: false,
      rs485: { port: "/dev/serial0", enabled: true, exists: true },
      clock: { synchronized: true, timeZone: "America/New_York" },
      spaCircuit: { id: 1, name: "Spa", eggTimer: 120, dontStop: false },
      options: { pumpDelay: true, valveDelayTime: 60 },
    })).toEqual([]);
  });
});

/**
 * Two settings the design depends on that nothing on any screen mentions.
 *
 * Both were prose in CLAUDE.md and nowhere else, which is the definition of a
 * silent fault: correct today because somebody remembered, and wrong later
 * with no way to find out.
 */
describe("valve device bindings", () => {
  const unbound = [
    { id: 1, name: "Intake", connectionId: "", deviceBinding: "" },
    { id: 2, name: "Return" },
  ];

  it("says nothing when njsPC only defines the valves", () => {
    /* The state of the live rig, checked 29 August 2026. */
    expect(checkValveBinding(unbound)).toEqual([]);
  });

  it("says nothing when the configuration could not be read", () => {
    /* Not knowing is not the same as knowing something is wrong — the rule
       this whole file is built on. */
    expect(checkValveBinding(undefined)).toEqual([]);
    expect(checkValveBinding(null)).toEqual([]);
  });

  it("warns when a valve is also bound to a device", () => {
    /* Two authorities on one actuator, which is the ADR-7 failure. It is a
       warning rather than a note for that reason. */
    const [f] = checkValveBinding([
      { id: 1, name: "Intake", connectionId: "rem-1", deviceBinding: "gpio-4" },
      { id: 2, name: "Return" },
    ]);
    expect(f.severity).toBe("warn");
    expect(f.what).toMatch(/Intake/);
    expect(f.what).not.toMatch(/Return/);
  });

  it("catches a binding that is only half filled in", () => {
    /* A connection with no device is still njsPC believing it owns the
       valve, and it is what a half-finished dashPanel form leaves behind. */
    expect(checkValveBinding([{ id: 1, name: "Intake", connectionId: "rem-1" }]))
      .toHaveLength(1);
    expect(checkValveBinding([{ id: 1, name: "Intake", deviceBinding: "gpio-4" }]))
      .toHaveLength(1);
  });

  it("names every bound valve, not just the first", () => {
    const [f] = checkValveBinding([
      { id: 1, name: "Intake", deviceBinding: "gpio-4" },
      { id: 2, name: "Return", deviceBinding: "gpio-5" },
    ]);
    expect(f.what).toMatch(/Intake/);
    expect(f.what).toMatch(/Return/);
  });

  it("does not treat whitespace as a binding", () => {
    expect(checkValveBinding([{ id: 1, name: "Intake", connectionId: "   " }]))
      .toEqual([]);
  });
});

describe("a pump to bind programs to", () => {
  it("says nothing when a pump exists", () => {
    expect(checkPump([{ id: 50, name: "IntelliFlo", type: 4 }])).toEqual([]);
  });

  it("notes an empty pump list", () => {
    /* A note, not a warning: nothing is unsafe, it is an unfinished
       installation. */
    const [f] = checkPump([]);
    expect(f.severity).toBe("note");
    expect(f.id).toBe("no-pump");
  });

  it("treats an empty slot as no pump", () => {
    /* njsPC keeps unused slots in the same array — the lesson from
       schedules.js, where a present-but-idless object read as real. */
    expect(checkPump([{ name: "" }])).toHaveLength(1);
  });

  it("says nothing when the configuration could not be read", () => {
    expect(checkPump(undefined)).toEqual([]);
  });
});

describe("whether the pump can reach the heater's flow floor", () => {
  /* HEATER_MIN_RPM is 1600 as of the 30 August 2026 measurement. These use
     explicit numbers either side of it rather than importing it, so a later
     measurement changing the constant does not quietly change what is being
     asserted — which is exactly what happened when it moved from 1900. */
  const bodies = { pool: 6, spa: 1 };
  const pump = (circuits) => [{ id: 50, circuits }];

  it("says nothing when every body circuit clears the floor", () => {
    expect(checkHeatFloor(pump([
      { circuit: 6, speed: 2400 }, { circuit: 1, speed: 2800 },
    ]), bodies)).toEqual([]);
  });

  it("notes a body circuit configured below the floor", () => {
    /* 1200 is below the verified floor. Once the pump is on the bus this
       would breach the pump-floor invariant on every heat call, permanently,
       by configuration rather than by fault. The live rig's own 1600 no
       longer trips this — that is the measurement, not a weakened test. */
    const [f] = checkHeatFloor(pump([
      { circuit: 6, speed: 1200 }, { circuit: 1, speed: 2800 },
    ]), bodies);
    expect(f.severity).toBe("note");
    expect(f.id).toBe("heat-floor-unreachable");
    expect(f.what).toMatch(/pool/);
    expect(f.what).not.toMatch(/spa/);
    expect(f.detail).toMatch(/1200/);
  });

  it("says the floor is the lowest verified speed, not where the heater refuses", () => {
    /* It used to refuse to name a culprit, because neither number was
       measured. One now is, so the honest statement changed: below the floor
       is unverified rather than known bad, and finding the real refusal
       point is offered as the way to lower it. */
    const [f] = checkHeatFloor(pump([{ circuit: 6, speed: 1200 }]), bodies);
    expect(f.detail).toMatch(/lowest speed the heater has been seen to run at/);
    expect(f.detail).toMatch(/unverified rather than known bad/);
  });

  it("reads njsPC's expanded circuit shape as well as the bare id", () => {
    /* State expands enums into objects; config does not. Getting this wrong
       is the bug that has already cost this project twice. */
    expect(checkHeatFloor(pump([{ circuit: { id: 6 }, speed: 1200 }]), bodies))
      .toHaveLength(1);
  });

  it("says nothing when the pump lists no speeds", () => {
    expect(checkHeatFloor(pump([]), bodies)).toEqual([]);
    expect(checkHeatFloor(undefined, bodies)).toEqual([]);
    expect(checkHeatFloor(pump([{ circuit: 6, speed: 1600 }]), undefined)).toEqual([]);
  });
});
