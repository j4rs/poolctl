/**
 * Writing the relay card.
 *
 * `relays.js` decides the byte; this puts it on the wire. The split is the
 * same one `binding.js` uses — everything decidable is pure and testable, and
 * the part that touches the world is small enough to read in one sitting.
 *
 * **Why shelling out to `i2cset` rather than a library.** The supervisor is
 * plain JS with no build step, and every Node I2C binding is a native module
 * needing node-gyp on the Pi. Writes here are rare — only when the byte
 * actually changes, which is a valve move or a heat call, not a loop — so a
 * process spawn per change is not worth a toolchain.
 *
 * **Why `write` and never read-modify-write.** The card is one byte and the
 * supervisor owns all eight channels, so it always knows the byte it wants.
 * See relays.js for what goes wrong when you read a port back to change one
 * bit of it.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

export const BUS = 1;
export const ADDRESS = "0x27";
export const OUTPUT_REG = "0x01";
/**
 * The input port, read to check the card against what we believe we wrote.
 *
 * Register 0x01 is the output latch and would only echo our own write back;
 * 0x00 is the actual pin level, which is strictly more informative at the
 * same cost — it catches a latch that has drifted *and* a pin that is not
 * following it. The two agree in normal operation: measured 27 August 2026
 * with four channels energised, `0x00` = `0x63` and `0x01` = `0x63`.
 */
export const INPUT_REG = "0x00";
const I2CSET = "/usr/sbin/i2cset";
const I2CGET = "/usr/sbin/i2cget";
const DEVICE = `/dev/i2c-${BUS}`;

/**
 * Is there a card to talk to?
 *
 * Deliberately a check for the *bus*, not for the card. A missing `/dev/i2c-1`
 * means I2C was never enabled and no amount of retrying will help; a bus that
 * exists with nothing on it is a wiring question, and the write will say so
 * once rather than us guessing here.
 */
export function available() {
  return existsSync(DEVICE) && existsSync(I2CSET);
}

/**
 * Drive the card, and hold the last byte we successfully wrote.
 *
 * Nothing here retries. A failed I2C write on a two-wire bus six inches long
 * is not a transient to ride out — it means the card is gone, the bus is off,
 * or something is wrong that a retry will paper over. It is reported and the
 * shadow is left alone, so the next differing byte tries again naturally.
 */
export function createHat({ dryRun = false, log = console, exec = run } = {}) {
  let last = null;
  let failing = false;

  async function put(byte) {
    if (dryRun) { last = byte; return { written: true, dryRun: true }; }
    try {
      await exec(I2CSET, ["-y", String(BUS), ADDRESS, OUTPUT_REG,
                          `0x${byte.toString(16).padStart(2, "0")}`]);
      last = byte;
      if (failing) { log.log("relay card: writes recovered"); failing = false; }
      return { written: true };
    } catch (err) {
      /* Once, not once per evaluation. A card that has gone away will
         otherwise fill the journal faster than anything else in this process. */
      if (!failing) { log.error(`relay card: write failed — ${err.message}`); failing = true; }
      return { written: false, error: err };
    }
  }

  return {
    /** The byte we last got onto the card, or null if we never have. */
    get lastWritten() { return last; },
    /** True while writes are failing, for the commissioning surface. */
    get failing() { return failing; },

    /** Write only on change. Re-writing a latch to its current value is a
        no-op electrically, but it is also a spawn, and there is no reason. */
    async set(byte) {
      if (byte === last) return { written: false, unchanged: true };
      return put(byte);
    },

    /** Write regardless of the shadow. For boot and for shutdown, where the
        card's real state is unknown and assuming it is the shadow is exactly
        the assumption that gets a valve left where nobody expects it. */
    async force(byte) { return put(byte); },

    /**
     * What the card actually holds, or null if it cannot be read.
     *
     * The shadow above is what we *believe*; this is the only way to find out
     * whether that belief is true. Nothing else in this process ever looks at
     * the card — `set` compares against the shadow, so once the two disagree
     * they stay disagreeing forever, and every subsequent `set` short-circuits
     * on a belief that is wrong.
     */
    async read() {
      if (dryRun) return last;
      try {
        const { stdout } = await exec(I2CGET, ["-y", String(BUS), ADDRESS, INPUT_REG]);
        const text = String(stdout ?? "").trim();
        /* Matched before parsing, because `Number("")` is 0 and so is
           `Number("\n")`. An empty answer would otherwise read as "every
           relay is off" — a confident, wrong statement about the equipment,
           and indistinguishable from a card that really is at 0x00. */
        if (!/^(0x[0-9a-f]{1,2}|\d{1,3})$/i.test(text)) return null;
        const byte = Number(text);
        return Number.isInteger(byte) && byte >= 0 && byte <= 0xff ? byte : null;
      } catch (err) {
        /* Same discipline as a failed write: say it once. A card that has
           gone away must not fill the journal on the heartbeat. */
        if (!failing) { log.error(`relay card: read failed — ${err.message}`); failing = true; }
        return null;
      }
    },
  };
}
