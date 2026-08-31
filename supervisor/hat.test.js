import { describe, it, expect, vi } from "vitest";
import { createHat, ADDRESS, OUTPUT_REG, INPUT_REG, BUS } from "./hat.js";

/**
 * The card writer, with the process spawn replaced.
 *
 * `exec` is injectable for exactly this: everything here is about *which*
 * command would be run and what is done with the answer, which is the part
 * that has been wrong, and none of it needs an I2C bus.
 */
const quiet = { log: () => {}, error: () => {}, warn: () => {} };

/** An exec double that records calls and replies from a script. */
function fakeExec(reply = () => ({ stdout: "0x00\n" })) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push({ cmd, args });
    const r = reply(cmd, args);
    if (r instanceof Error) throw r;
    return r;
  };
  return { exec, calls };
}

describe("writing", () => {
  it("writes the byte to the output latch, not the input port", () => {
    /* Reading the input port and writing it back is the read-modify-write
       this module exists to avoid. */
    const { exec, calls } = fakeExec();
    return createHat({ exec, log: quiet }).set(0x40).then(() => {
      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual(["-y", String(BUS), ADDRESS, OUTPUT_REG, "0x40"]);
    });
  });

  it("skips a write that would change nothing", async () => {
    const { exec, calls } = fakeExec();
    const hat = createHat({ exec, log: quiet });
    await hat.set(0x40);
    const again = await hat.set(0x40);
    expect(again).toMatchObject({ written: false, unchanged: true });
    expect(calls).toHaveLength(1);
  });

  it("force writes even when the shadow already matches", async () => {
    /* Boot and shutdown: the card's real state is unknown, and assuming it is
       the shadow is what leaves a coil energised through a restart. */
    const { exec, calls } = fakeExec();
    const hat = createHat({ exec, log: quiet });
    await hat.set(0x00);
    await hat.force(0x00);
    expect(calls).toHaveLength(2);
  });

  it("does not move the shadow when the write fails", async () => {
    /* The shadow means "what we got onto the card". A failed write got
       nothing onto the card, so believing it did is how the two diverge. */
    const { exec } = fakeExec(() => new Error("Remote I/O error"));
    const hat = createHat({ exec, log: quiet });
    const r = await hat.set(0x40);
    expect(r.written).toBe(false);
    expect(hat.lastWritten).toBeNull();
  });

  it("reports a failing card once, not once per write", async () => {
    const errors = [];
    const { exec } = fakeExec(() => new Error("Remote I/O error"));
    const hat = createHat({ exec, log: { ...quiet, error: (m) => errors.push(m) } });
    await hat.set(0x40);
    await hat.set(0x10);
    await hat.set(0x05);
    expect(errors).toHaveLength(1);
  });
});

describe("reading back", () => {
  it("reads the input port, which is the pin level rather than our own echo", async () => {
    /* 0x01 would only hand back the byte we wrote. 0x00 is what the pins are
       actually at, which is the question being asked. */
    const { exec, calls } = fakeExec(() => ({ stdout: "0x63\n" }));
    const hat = createHat({ exec, log: quiet });
    expect(await hat.read()).toBe(0x63);
    expect(calls[0].args).toEqual(["-y", String(BUS), ADDRESS, INPUT_REG]);
  });

  it("returns null rather than a guess when the read fails", async () => {
    const { exec } = fakeExec(() => new Error("Remote I/O error"));
    expect(await createHat({ exec, log: quiet }).read()).toBeNull();
  });

  it("returns null on an answer that is not a byte", async () => {
    /* i2cget printing something unexpected must not become a relay state. */
    for (const junk of ["", "\n", "not a byte", "0x1ff", "-1"]) {
      const { exec } = fakeExec(() => ({ stdout: junk }));
      expect(await createHat({ exec, log: quiet }).read(), junk).toBeNull();
    }
  });

  it("can see a card that disagrees with the shadow", async () => {
    /* The whole point. Observed for real: manual i2csets during bench work
       left the shadow at 0x40 while the card sat elsewhere, silently. */
    const { exec } = fakeExec((cmd) =>
      cmd.endsWith("i2cget") ? { stdout: "0x00\n" } : { stdout: "" });
    const hat = createHat({ exec, log: quiet });
    await hat.set(0x40);
    expect(hat.lastWritten).toBe(0x40);
    expect(await hat.read()).toBe(0x00);
  });
});

describe("dry run", () => {
  it("touches nothing and reads back its own shadow", async () => {
    const { exec, calls } = fakeExec();
    const hat = createHat({ dryRun: true, exec, log: quiet });
    await hat.set(0x40);
    expect(calls).toHaveLength(0);
    expect(await hat.read()).toBe(0x40);
  });
});

/**
 * The window that let the corrector fight the controller, twice.
 *
 * `put()` assigns the shadow only after its own await resolves, so between
 * `i2cset` exiting and that assignment there is a moment where the card holds
 * the new byte and `lastWritten` still holds the old one. A read taken in
 * that moment looks exactly like drift, and the corrector's response to drift
 * is to force the shadow's byte back onto the card — undoing a change the
 * supervisor had just decided on.
 *
 * Seen on the Pi on 31 August 2026: the purge released the bypass mid-read
 * and the valve was commanded around, to flow, and around again in three
 * seconds. Guarding by sampling the shadow either side of the read does not
 * catch it — the shadow is unchanged at both samples. The window has to be
 * closed, not narrowed.
 */
describe("a read taken while a write is landing", () => {
  it("never reports the card and the shadow disagreeing over the same write", async () => {
    /* The window is held open explicitly rather than by counting microtasks:
       `i2cset` changes the card and then blocks, so while the gate is shut
       the card holds the new byte and `put` has not yet assigned the shadow.
       That is exactly the state the Pi was in. */
    let card = 0x00;
    let release = () => {};
    let hold = false;
    const exec = async (cmd, args) => {
      if (/i2cset/.test(cmd)) {
        card = Number(args[args.length - 1]);
        if (hold) await new Promise((r) => { release = r; });
        return { stdout: "" };
      }
      return { stdout: `0x${card.toString(16).padStart(2, "0")}` };
    };

    const hat = createHat({ exec, log: quiet });
    await hat.set(0x00);

    hold = true;
    const writing = hat.set(0x40);              /* card -> 0x40, shadow 0x00 */
    await new Promise((r) => setTimeout(r, 10));

    const looking = hat.inspect();              /* started, deliberately not awaited */
    setTimeout(() => release(), 10);            /* now let the write land */
    const looked = await looking;
    await writing;

    /* Either side of the write, never across it. A disagreement here is what
       the corrector reads as drift, and its answer to drift is to force the
       stale byte back onto the card — undoing a live decision. */
    expect(looked.actual).toBe(looked.shadow);
  });

  it("still sees genuine drift, which is the whole point of looking", async () => {
    let card = 0x00;
    const exec = async (cmd, args) => {
      if (/i2cset/.test(cmd)) { card = Number(args[args.length - 1]); return { stdout: "" }; }
      return { stdout: `0x${card.toString(16).padStart(2, "0")}` };
    };
    const hat = createHat({ exec, log: quiet });
    await hat.set(0x40);
    card = 0x08;                                  /* somebody else drove it */
    const { actual, shadow } = await hat.inspect();
    expect(actual).toBe(0x08);
    expect(shadow).toBe(0x40);
  });
});

describe("concurrent writes", () => {
  it("does not let two callers race the same change onto the card", async () => {
    /* `set` compares against the shadow, awaits a spawn, and updates the
       shadow only on success — so two publish() calls in one tick both passed
       the guard and both wrote. Observed on the Pi as three "relays -> 0x40"
       lines for one change. */
    let inFlight = 0, overlapped = false;
    const exec = async () => {
      if (++inFlight > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { stdout: "" };
    };
    const hat = createHat({ exec, log: quiet });
    const results = await Promise.all([hat.set(0x40), hat.set(0x40), hat.set(0x40)]);
    expect(overlapped, "writes overlapped on the bus").toBe(false);
    expect(results.filter((r) => r.written)).toHaveLength(1);
  });

  it("still writes a genuine second change after the first lands", async () => {
    const seen = [];
    const exec = async (_cmd, args) => { seen.push(args[args.length - 1]); return { stdout: "" }; };
    const hat = createHat({ exec, log: quiet });
    await Promise.all([hat.set(0x40), hat.set(0x10)]);
    expect(seen).toEqual(["0x40", "0x10"]);
  });

  it("keeps a force ordered against the sets around it", async () => {
    const seen = [];
    const exec = async (_cmd, args) => { seen.push(args[args.length - 1]); return { stdout: "" }; };
    const hat = createHat({ exec, log: quiet });
    await Promise.all([hat.set(0x40), hat.force(0x00), hat.set(0x40)]);
    expect(seen).toEqual(["0x40", "0x00", "0x40"]);
  });
});
