// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  daysToMask, maskToDays, toClock, toMinutes, toUiSchedule,
  isRealSchedule, whyNotSchedulable, scheduleConfig, REPEATS,
  HEAT_NO_CHANGE_FALLBACK, noChangeHeatSource,
} from "./schedules.js";

/**
 * The day bitmask gets the most attention here on purpose. Nixie puts Monday
 * at bit 0 and Sunday at bit 6; `Date#getDay` puts Sunday at 0. An off-by-one
 * there does not throw, does not look wrong on screen, and runs the pool a
 * day out — the kind of bug you find in September.
 */

describe("days", () => {
  it("puts Monday at bit 0, as Nixie does", () => {
    expect(daysToMask([1])).toBe(1);
  });

  it("puts Sunday at bit 6, not bit 0", () => {
    /* `Date#getDay` says Sunday is 0. njsPC does not. */
    expect(daysToMask([0])).toBe(64);
  });

  it("maps every day to the bit njsPC's own table gives it", () => {
    /* val-1 from NixieBoard's scheduleDays map: mon 1, tue 2 … sun 7. */
    expect(daysToMask([1])).toBe(1 << 0);
    expect(daysToMask([2])).toBe(1 << 1);
    expect(daysToMask([3])).toBe(1 << 2);
    expect(daysToMask([4])).toBe(1 << 3);
    expect(daysToMask([5])).toBe(1 << 4);
    expect(daysToMask([6])).toBe(1 << 5);
    expect(daysToMask([0])).toBe(1 << 6);
  });

  it("makes every day 127, which is what njsPC stores for a daily schedule", () => {
    expect(daysToMask([0, 1, 2, 3, 4, 5, 6])).toBe(127);
  });

  it("round-trips every combination", () => {
    /* Exhaustive rather than sampled: there are only 128 of them, and this
       is the assertion that would have caught a shifted bit. */
    for (let mask = 0; mask < 128; mask++) {
      expect(daysToMask(maskToDays(mask)), `mask ${mask}`).toBe(mask);
    }
  });

  it("returns days in ascending Date#getDay order", () => {
    expect(maskToDays(127)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(maskToDays(daysToMask([6, 0]))).toEqual([0, 6]);
  });

  it("treats no days as no days rather than as every day", () => {
    expect(daysToMask([])).toBe(0);
    expect(maskToDays(0)).toEqual([]);
  });

  it("refuses something that is not a day", () => {
    expect(() => daysToMask([7])).toThrow();
    expect(() => daysToMask(["monday"])).toThrow();
  });

  it("copes with njsPC sending nothing", () => {
    expect(maskToDays(undefined)).toEqual([]);
  });
});

describe("times", () => {
  it("reads njsPC's minutes past midnight", () => {
    expect(toClock(0)).toBe("00:00");
    expect(toClock(480)).toBe("08:00");
    expect(toClock(924)).toBe("15:24");
    expect(toClock(1439)).toBe("23:59");
  });

  it("writes them back", () => {
    expect(toMinutes("00:00")).toBe(0);
    expect(toMinutes("08:00")).toBe(480);
    expect(toMinutes("15:24")).toBe(924);
  });

  it("round-trips every minute of the day", () => {
    for (let m = 0; m < 1440; m++) expect(toMinutes(toClock(m)), `minute ${m}`).toBe(m);
  });

  it("rejects what is not a time", () => {
    for (const bad of ["", "8", "25:00", "08:60", "8:0", "abc", null, undefined]) {
      expect(toMinutes(bad), String(bad)).toBeNull();
    }
  });

  it("accepts a single-digit hour, which a text field will produce", () => {
    expect(toMinutes("8:05")).toBe(485);
  });

  it("has nothing to say about a missing time", () => {
    expect(toClock(undefined)).toBeNull();
    expect(toClock(null)).toBeNull();
  });
});

describe("reading a schedule out of njsPC", () => {
  const raw = {
    id: 3, circuit: 6, scheduleDays: 127, scheduleType: 128,
    startTime: 480, endTime: 1080, isActive: true, disabled: false,
    startTimeType: 0, endTimeType: 0,
  };
  const lookups = {
    speedFor: (id) => (id === 6 ? 1600 : null),
    nameFor: (id) => (id === 6 ? "Pool" : null),
  };

  it("translates the whole thing", () => {
    expect(toUiSchedule(raw, lookups)).toEqual({
      id: 3, circuit: 6, circuitName: "Pool", rpm: 1600,
      start: "08:00", end: "18:00", days: [0, 1, 2, 3, 4, 5, 6],
      enabled: true, clockOnly: true, repeats: true,
    });
  });

  it("reads the speed off the pump rather than off the schedule", () => {
    /* njsPC schedules carry no rpm. Storing one beside the schedule would be
       a second copy of a fact the pump already owns. */
    expect(raw).not.toHaveProperty("rpm");
    expect(toUiSchedule(raw, lookups).rpm).toBe(1600);
  });

  it("says nothing about speed for a circuit the pump does not carry", () => {
    /* A schedule pointed at an unbound circuit will run and do nothing to
       the pump, which is worth showing rather than papering over. */
    expect(toUiSchedule({ ...raw, circuit: 9 }, lookups).rpm).toBeNull();
  });

  it("tells 'switched off' from 'deleted'", () => {
    /* njsPC keeps both: `disabled` is the operator's toggle, `isActive` is
       whether the slot exists at all. */
    expect(toUiSchedule({ ...raw, disabled: true }, lookups).enabled).toBe(false);
    expect(isRealSchedule({ ...raw, disabled: true })).toBe(true);
    expect(isRealSchedule({ id: 1, isActive: false })).toBe(false);
  });

  it("ignores the empty slots njsPC keeps in its array", () => {
    expect(isRealSchedule({ id: 1, startTimeType: 0, endTimeType: 0 })).toBe(false);
  });

  it("copes with state's expanded circuit object as well as config's id", () => {
    expect(toUiSchedule({ ...raw, circuit: { id: 6 } }, lookups).circuit).toBe(6);
  });

  it("flags a schedule this UI cannot safely edit", () => {
    /* Sunrise and sunset offsets are a real njsPC feature and not one the
       editor models. Better to know than to overwrite it with a clock time. */
    expect(toUiSchedule({ ...raw, startTimeType: 1 }, lookups).clockOnly).toBe(false);
  });

  it("reads scheduleType whether njsPC expanded it or not", () => {
    expect(toUiSchedule({ ...raw, scheduleType: { val: 128 } }, lookups).repeats).toBe(true);
    expect(toUiSchedule({ ...raw, scheduleType: 0 }, lookups).repeats).toBe(false);
  });
});

describe("what cannot be saved", () => {
  const ok = { circuit: 6, start: "08:00", end: "18:00", days: [1], enabled: true };

  it("accepts a sound schedule", () => expect(whyNotSchedulable(ok)).toBeNull());

  it("needs something to run", () => {
    expect(whyNotSchedulable({ ...ok, circuit: null })).toMatch(/what it should run/);
  });

  it("needs times that are times", () => {
    expect(whyNotSchedulable({ ...ok, start: "" })).toMatch(/start time/);
    expect(whyNotSchedulable({ ...ok, end: "25:00" })).toMatch(/end time/);
  });

  it("refuses a zero-length window", () => {
    expect(whyNotSchedulable({ ...ok, end: "08:00" })).toMatch(/same moment/);
  });

  it("needs at least one day", () => {
    /* njsPC rejects this itself for a repeating schedule; catching it here
       means the operator gets a sentence instead of a 400. */
    expect(whyNotSchedulable({ ...ok, days: [] })).toMatch(/at least one day/);
  });

  it("allows a window that crosses midnight", () => {
    /* Evening spa hours are the obvious case and njsPC handles them. */
    expect(whyNotSchedulable({ ...ok, start: "22:00", end: "01:00" })).toBeNull();
  });
});

describe("writing a schedule back", () => {
  const ui = { id: 3, circuit: 6, start: "08:00", end: "18:00", days: [0, 1, 2, 3, 4, 5, 6], enabled: true };

  it("sends what njsPC's validator expects", () => {
    expect(scheduleConfig(ui)).toEqual({
      id: 3, circuit: 6, startTime: 480, endTime: 1080, scheduleDays: 127,
      scheduleType: REPEATS, startTimeType: 0, endTimeType: 0,
      disabled: false, heatSource: HEAT_NO_CHANGE_FALLBACK, changeHeatSetpoint: false,
    });
  });

  it("asks njsPC to allocate an id for a new one", () => {
    expect(scheduleConfig({ ...ui, id: undefined }).id).toBe(0);
    expect(scheduleConfig({ ...ui, id: "new-a1b2c3" }).id).toBe(0);
  });

  it("always repeats, never runs once", () => {
    /* Type 0 is "run once" and njsPC then ignores the days entirely. */
    expect(scheduleConfig(ui).scheduleType).toBe(REPEATS);
  });

  it("always sends a heat source, because a new schedule is refused without one", () => {
    /* njsPC inherits heatSource from the stored schedule when absent, so an
       edit succeeds and a create fails with "Invalid heat source:
       undefined". Live bug, found on the first create. */
    expect(scheduleConfig({ ...ui, id: undefined }).heatSource).toBe(HEAT_NO_CHANGE_FALLBACK);
  });

  it("never lets a schedule touch the heater", () => {
    /* A schedule can carry a heat setpoint and impose it when it fires,
       which would put a second authority on the heater — straight through
       ADR-4. Sent explicitly rather than trusting njsPC's default, which is
       guarded by a `typeof` around a comparison and never actually runs. */
    expect(scheduleConfig(ui).changeHeatSetpoint).toBe(false);
    expect(scheduleConfig(ui).heatSource).toBe(HEAT_NO_CHANGE_FALLBACK);
    expect(scheduleConfig(ui)).not.toHaveProperty("heatSetpoint");
  });

  it("takes the no-change value njsPC actually offers, not a constant", () => {
    /* The live 400. NixieBoard's constructor map has nochange at 32, but
       updateHeaterServices() rebuilds it and puts nochange at 0 — so a rig
       with a heat pump rejects 32 outright. */
    const live = [
      { val: 1, name: "off", desc: "Off" },
      { val: 9, name: "heatpump", desc: "Heat Pump" },
      { val: 0, name: "nochange", desc: "No Change" },
    ];
    expect(noChangeHeatSource(live)).toBe(0);
    expect(scheduleConfig(ui, { heatSource: noChangeHeatSource(live) }).heatSource).toBe(0);
  });

  it("reads the keyed shape too, because njsPC serialises value maps both ways", () => {
    expect(noChangeHeatSource({ 1: { name: "off" }, 32: { name: "nochange" } })).toBe(32);
  });

  it("falls back rather than refusing when njsPC offers nothing usable", () => {
    /* A save that fails because an options lookup failed would be a worse
       bug than the one this replaces. */
    for (const junk of [undefined, null, [], {}, [{ val: 1, name: "off" }]]) {
      expect(noChangeHeatSource(junk)).toBe(HEAT_NO_CHANGE_FALLBACK);
    }
  });


  it("carries the enabled toggle across as njsPC's inverse", () => {
    expect(scheduleConfig({ ...ui, enabled: false }).disabled).toBe(true);
    expect(scheduleConfig({ ...ui, enabled: true }).disabled).toBe(false);
  });

  it("survives a round trip through njsPC's shape", () => {
    const back = toUiSchedule(
      { ...scheduleConfig(ui), isActive: true },
      { speedFor: () => 1600, nameFor: () => "Pool" },
    );
    expect(back).toMatchObject({
      circuit: 6, start: "08:00", end: "18:00",
      days: [0, 1, 2, 3, 4, 5, 6], enabled: true,
    });
  });
});

describe("njsPC's state shape, which is not its config shape", () => {
  /**
   * Captured from a running njsPC 10.0.1, not hand-written.
   *
   * The supervisor reads `/state/all`, where every enumerated field is
   * expanded into an object — `scheduleDays` becomes `{ val, days: [...] }`,
   * `startTimeType` becomes `{ val, name, desc }`, and `circuit` becomes the
   * whole circuit. The first version of this module was written against
   * `/config/all`, which sends plain numbers, and every one of these
   * assertions failed live while the unit tests stayed green.
   */
  const stateShaped = {
    id: 3,
    circuit: { id: 6, name: "Pool", isOn: true, type: { val: 12, name: "pool" } },
    scheduleDays: {
      val: 127,
      days: [{ name: "sun", dow: 0, bitval: 64 }, { name: "mon", dow: 1, bitval: 1 }],
    },
    scheduleType: { val: 128, name: "repeat", desc: "Repeats" },
    startTimeType: { val: 0, name: "manual", desc: "Manual" },
    endTimeType: { val: 0, name: "manual", desc: "Manual" },
    startTime: 924,
    endTime: 984,
    isActive: true,
  };

  /** An unused slot, exactly as njsPC reports one. */
  const emptySlot = {
    id: 1,
    circuit: { freezeProtect: false, type: { val: 0, name: "generic" }, equipmentType: "circuit" },
    startTimeType: { val: 0, name: "manual" },
    endTimeType: { val: 0, name: "manual" },
    display: { val: 0, name: "always" },
    scheduleTime: { calculated: false, shouldBeOn: false },
    isOn: false,
  };

  it("reads days out of the expanded object, not as zero", () => {
    /* `Number({val: 127})` is NaN, so the naive version gave every schedule
       no days at all — visible live as "Every day" collapsing to nothing. */
    expect(toUiSchedule(stateShaped, {}).days).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("finds the circuit inside the expanded circuit object", () => {
    expect(toUiSchedule(stateShaped, {}).circuit).toBe(6);
  });

  it("reads the time types as clock times", () => {
    /* `{val: 0} === 0` is false, so a perfectly ordinary schedule was being
       flagged as one this UI cannot edit. */
    expect(toUiSchedule(stateShaped, {}).clockOnly).toBe(true);
  });

  it("recognises a repeating schedule", () => {
    expect(toUiSchedule(stateShaped, {}).repeats).toBe(true);
  });

  it("rejects njsPC's empty slots", () => {
    /* The circuit object is present and truthy but has no id. Two of these
       reached the screen as blank rows before this was checked properly. */
    expect(isRealSchedule(emptySlot)).toBe(false);
    expect(isRealSchedule(stateShaped)).toBe(true);
  });

  it("treats a slot njsPC has deactivated as gone", () => {
    expect(isRealSchedule({ ...stateShaped, isActive: false })).toBe(false);
  });

  it("round-trips a state-shaped schedule back into a config write", () => {
    const ui = toUiSchedule(stateShaped, {});
    expect(scheduleConfig(ui)).toMatchObject({
      id: 3, circuit: 6, startTime: 924, endTime: 984,
      scheduleDays: 127, scheduleType: REPEATS,
    });
  });
});
