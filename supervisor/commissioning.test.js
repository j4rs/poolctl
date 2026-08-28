// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  checkCommissioning, checkExposure, checkSerialPort, checkClock,
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
