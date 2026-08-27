// @vitest-environment node
import { describe as suite, it, expect } from "vitest";
import { BIT, MASK, CHANNEL, byteFor, relaysIn, describe } from "./relays.js";

/**
 * The relay layer.
 *
 * Most of what is asserted here is a measurement rather than a preference:
 * the bit order was established on the bench by energising one channel at a
 * time and reading the silkscreen beside the lit LED. It disagrees with every
 * table Sequent publishes, so these tests exist mostly to stop someone
 * "correcting" it back.
 */

suite("the measured bit map", () => {
  it("is the table read off the V 7.1 card, not any published one", () => {
    expect(BIT).toEqual({ 1: 0, 2: 2, 3: 1, 4: 3, 5: 6, 6: 7, 7: 4, 8: 5 });
  });

  it("is a permutation — eight relays, eight distinct bits, none above 7", () => {
    const bits = Object.values(BIT);
    expect(new Set(bits).size).toBe(8);
    expect(Math.min(...bits)).toBe(0);
    expect(Math.max(...bits)).toBe(7);
  });

  it("disagrees with Sequent's driver on exactly channels 6, 7 and 8", () => {
    /* 8relay-rpi's relayChRemap, reported wrong for this revision as #7. */
    const theirs = [0, 2, 1, 3, 6, 4, 5, 7];
    const differ = theirs
      .map((bit, i) => (BIT[i + 1] === bit ? null : i + 1))
      .filter(Boolean);
    expect(differ).toEqual([6, 7, 8]);
  });
});

suite("de-energised is the safe rest position", () => {
  it("an empty state is all relays open", () => {
    /* The premise of the whole failure story: lose power, lose nothing.
       architecture.md — valves to pool, bypass to flow, heater open, blower
       off. If this is ever non-zero, that table has become a lie. */
    expect(byteFor({})).toBe(0x00);
  });

  it("pool, no heat, bypass in flow is also all off", () => {
    const rest = { valves: { intake: "pool", returns: "split", bypass: "flow" },
                   heaterCall: "off", blower: false, light: false };
    expect(byteFor(rest)).toBe(0x00);
  });

  it("tolerates a missing or partial state without energising anything", () => {
    for (const s of [undefined, null, {}, { valves: {} }, { valves: null }]) {
      expect(byteFor(s)).toBe(0x00);
    }
  });
});

suite("each channel drives its own relay", () => {
  const cases = [
    ["intake diverted",  { valves: { intake: "spa" } },     CHANNEL.INTAKE],
    ["return diverted",  { valves: { returns: "spa" } },    CHANNEL.RETURN],
    ["bypass around",    { valves: { bypass: "around" } },  CHANNEL.BYPASS],
    ["pool heat call",   { heaterCall: "pool" },            CHANNEL.HEAT_POOL],
    ["spa heat call",    { heaterCall: "spa" },             CHANNEL.HEAT_SPA],
    ["blower on",        { blower: true },                  CHANNEL.BLOWER],
    ["light on",         { light: true },                   CHANNEL.LIGHT],
  ];
  for (const [name, state, relay] of cases) {
    it(`${name} closes REL${relay} and nothing else`, () => {
      expect(byteFor(state)).toBe(MASK[relay]);
    });
  }
});

suite("the spare channel", () => {
  it("is never energised by any state", () => {
    /* REL6 is the blower contactor, and Sequent's driver reaches it by the
       channel number we call spare. Nothing here may set REL8 either: an
       unused channel that can be written is one edit away from a motor. */
    const every = [
      {}, { blower: true }, { light: true }, { heaterCall: "spa" },
      { valves: { intake: "spa", returns: "spa", bypass: "around" },
        heaterCall: "pool", blower: true, light: true },
    ];
    for (const s of every) {
      expect(byteFor(s) & MASK[CHANNEL.SPARE]).toBe(0);
    }
  });
});

suite("whole modes", () => {
  it("spa closes both body valves and leaves the bypass in flow", () => {
    const b = byteFor({ valves: { intake: "spa", returns: "spa", bypass: "flow" } });
    expect(relaysIn(b)).toEqual([1, 2]);
  });

  it("pool idle diverts the bypass around the exchanger", () => {
    const b = byteFor({ valves: { intake: "pool", returns: "split", bypass: "around" } });
    expect(relaysIn(b)).toEqual([3]);
  });

  it("pool heat swings the bypass back to flow, per ADR-9", () => {
    const b = byteFor({ valves: { intake: "pool", returns: "split", bypass: "flow" },
                        heaterCall: "pool" });
    expect(relaysIn(b)).toEqual([4]);
  });

  it("everything at once is still eight distinct bits", () => {
    const b = byteFor({ valves: { intake: "spa", returns: "spa", bypass: "around" },
                        heaterCall: "spa", blower: true, light: true });
    expect(relaysIn(b)).toEqual([1, 2, 3, 5, 6, 7]);
  });
});

suite("describe", () => {
  it("names the relays a byte closes", () => {
    expect(describe(0x00)).toContain("(all off)");
    expect(describe(byteFor({ valves: { intake: "spa" } }))).toBe("0x01  REL1");
  });
});
