#!/usr/bin/env node
/**
 * A PCA9554 that lives in a JSON file.
 *
 * Stands in for `i2cset` and `i2cget` so the supervisor's relay path can be
 * exercised without a Pi. It is invoked exactly as the real tools are —
 * `hat.js` is not aware of it and needs no test branch; the harness simply
 * points `I2C_TOOL_DIR` at a directory containing wrappers that run this.
 *
 * That matters more than it sounds. Faking at the *process boundary* leaves
 * `hat.js` running for real: argument construction, the output parsing that
 * had to learn `Number("")` is 0, the serialisation of concurrent writes, the
 * error path when a spawn fails. Faking `exec` inside the module — which
 * `hat.test.js` does, correctly, for unit tests — skips all of that.
 *
 * The card it models is the one measured on 27 August: four registers, of
 * which this implements the two that matter.
 *
 *   0x00  input port    — the pin level; what `read()` samples
 *   0x01  output latch  — what a write lands in
 *
 * They track each other here, which is what a real card does when every pin
 * is an output and nothing external is dragging one. Test 0 confirmed it on
 * the bench: with four channels energised, both read 0x63.
 *
 * The `writes` log is not decoration. Order is the safety property in this
 * system — valve before contact, purge before isolation, boot passing through
 * 0x00 — and a resting byte cannot show it.
 *
 * Usage, via the wrappers the harness writes:
 *   fake-i2c.js set -y 1 0x27 0x01 0x40
 *   fake-i2c.js get -y 1 0x27 0x00
 *
 * `FAKE_I2C_STATE` names the JSON file. `FAKE_I2C_FAIL`, if set, makes every
 * operation exit non-zero — the card having gone away, for slice 6.
 */
import { readFileSync, writeFileSync } from "node:fs";

const STATE = process.env.FAKE_I2C_STATE;
if (!STATE) {
  process.stderr.write("fake-i2c: FAKE_I2C_STATE is not set\n");
  process.exit(2);
}

if (process.env.FAKE_I2C_FAIL) {
  process.stderr.write("Error: Read failed\n");
  process.exit(1);
}

const read = () => {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return { byte: 0x00, writes: [] };
  }
};

const [, , tool, ...rest] = process.argv;
/* The real tools take `-y` to skip their confirmation prompt. Positional
   arguments after it are bus, address, register, and — for a write — value. */
const args = rest.filter((a) => a !== "-y");
const [, , register, value] = args;

const state = read();

if (tool === "set") {
  const byte = Number(value);
  if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
    process.stderr.write(`fake-i2c: bad value ${value}\n`);
    process.exit(1);
  }
  state.byte = byte;
  state.writes.push({ at: Date.now(), byte, register });
  writeFileSync(STATE, JSON.stringify(state));
  process.exit(0);
}

if (tool === "get") {
  /* Both registers answer with the latch: every pin is an output and nothing
     external drives one, so the input port mirrors it. See the header. */
  process.stdout.write(`0x${state.byte.toString(16).padStart(2, "0")}\n`);
  process.exit(0);
}

process.stderr.write(`fake-i2c: unknown tool ${tool}\n`);
process.exit(2);
