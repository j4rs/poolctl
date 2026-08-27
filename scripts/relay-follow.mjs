/**
 * Bench tool: follow njsPC's valve state and drive the HAT.
 *
 * Not part of the supervisor and not deployed by `deploy.sh`. It exists to
 * close the loop by hand — press Spa in the app, watch REL1 and REL2 click —
 * before any of this goes near `index.js` and the live control path.
 *
 *   node scripts/relay-follow.mjs            follow, writing on every change
 *   node scripts/relay-follow.mjs --dry-run  compute and log, write nothing
 *
 * Writes register 0x01 at 0x27 whole, via i2cset. No read-modify-write: see
 * the note in supervisor/relays.js for why that matters on this card.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { byteFor, describe } from "../supervisor/relays.js";

const run = promisify(execFile);
const DRY = process.argv.includes("--dry-run");
const NJSPC = process.env.NJSPC || "http://127.0.0.1:4200";
const I2CSET = "/usr/sbin/i2cset";

async function readState() {
  const res = await fetch(`${NJSPC}/state/all`);
  if (!res.ok) throw new Error(`njsPC ${res.status}`);
  const d = await res.json();
  const valves = d.valves || [];
  const intake = valves.find((v) => v.isIntake);
  const returns = valves.find((v) => v.isReturn);
  return {
    valves: {
      intake: intake?.isDiverted ? "spa" : "pool",
      returns: returns?.isDiverted ? "spa" : "split",
      /* njsPC has no bypass. On the bench it rests where it is safe. */
      bypass: "flow",
    },
    /* Deliberately not driven from here. This tool proves the valve path;
       heat, blower and light belong to the supervisor's own state, and
       inventing them here would demonstrate something that is not true. */
    heaterCall: "off", blower: false, light: false,
  };
}

async function write(byte) {
  if (DRY) return;
  await run(I2CSET, ["-y", "1", "0x27", "0x01", `0x${byte.toString(16)}`]);
}

let last = null;
console.log(`following ${NJSPC}${DRY ? "  (dry run)" : ""} — ctrl-c to stop`);
await write(0);                        // known state before anything else
console.log(`  ${new Date().toISOString().slice(11, 19)}  ${describe(0)}  (initial)`);
last = 0;

for (;;) {
  try {
    const byte = byteFor(await readState());
    if (byte !== last) {
      await write(byte);
      console.log(`  ${new Date().toISOString().slice(11, 19)}  ${describe(byte)}`);
      last = byte;
    }
  } catch (e) {
    console.error(`  ${new Date().toISOString().slice(11, 19)}  ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 500));
}
