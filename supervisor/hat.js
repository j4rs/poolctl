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
const I2CSET = "/usr/sbin/i2cset";
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
export function createHat({ dryRun = false, log = console } = {}) {
  let last = null;
  let failing = false;

  async function put(byte) {
    if (dryRun) { last = byte; return { written: true, dryRun: true }; }
    try {
      await run(I2CSET, ["-y", String(BUS), ADDRESS, OUTPUT_REG,
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
  };
}
