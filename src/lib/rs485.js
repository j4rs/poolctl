/**
 * RS-485 frame model and decoders.
 *
 * Phase 1 exists to answer one question: do the frames on this bus decode?
 * Specifically the iChlor 30's, since ADR-6 turns on it. Everything here is
 * built to make that answerable by looking at a screen.
 *
 * IMPORTANT — these decoders are written from the public reverse-engineering
 * of Pentair's bus (njsPC and its predecessors). They are a starting point,
 * not an authority. Frame layouts vary across devices and firmware, and the
 * iChlor 30 in particular is the least well covered. Expect to correct this
 * file against the real bus. That is the point of the exercise; the monitor
 * is built so a wrong guess shows up as a checksum failure or an UNKNOWN
 * rather than as a plausible-looking lie.
 *
 * Two framings share the wire:
 *
 *   A5  — automation/pump. FF 00 FF A5 <ver> <dst> <src> <cfi> <len> <data..>
 *         <ck_hi> <ck_lo>.  Checksum is the plain sum of bytes from A5
 *         through the last data byte, big-endian.
 *
 *   IC  — chlorinator, DLE/STX framed. 10 02 <dst> <cmd> <data..> <ck> 10 03.
 *         Checksum is the sum of bytes from 10 02 through the last data byte,
 *         truncated to one byte.
 */

export const PROTO = { A5: "A5", IC: "IC", UNKNOWN: "??" };

/** Known bus addresses. Anything else renders as raw hex, which is a finding. */
const ADDR = {
  0x00: "controller", // IC framing addresses the controller as 0x00
  0x0f: "broadcast",
  0x10: "controller",
  0x50: "chlorinator",
  0x60: "pump",
};

/** Units for decoded fields, so a collapsed row reads as telemetry not noise. */
const FIELD_UNIT = { rpm: "rpm", watts: "W", saltPpm: "ppm", output: "%" };

export const fieldLabel = (k, v) =>
  FIELD_UNIT[k] ? `${v} ${FIELD_UNIT[k]}` : `${k} ${v}`;

/** Compact one-line summary of a frame's decoded fields. */
export const fieldSummary = (fields) =>
  Object.entries(fields).map(([k, v]) => fieldLabel(k, v)).join(" · ");

export const addrName = (a) =>
  ADDR[a] ?? `0x${a.toString(16).padStart(2, "0")}`;

export const hex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");

const sum = (bytes, from, to) => {
  let t = 0;
  for (let i = from; i < to; i++) t += bytes[i];
  return t;
};

/** A5 action codes we believe we recognise. Verify every one on real traffic. */
const A5_ACTION = {
  0x01: "pump command",
  0x04: "pump remote control",
  0x06: "pump run state",
  0x07: "pump status",
  0x02: "controller status",
};

function decodeA5(b) {
  const i = b.findIndex((v, n) => v === 0xa5 && n >= 3);
  if (i < 0 || b.length < i + 7) return null;
  const len = b[i + 5];
  const end = i + 6 + len;
  if (b.length < end + 2) return null;

  const want = (b[end] << 8) | b[end + 1];
  const got = sum(b, i, end);
  const payload = b.slice(i + 6, end);
  const action = b[i + 4];

  /* Pump status carries rpm and watts in the payload. Offsets are the
     commonly cited ones and are exactly the sort of thing to re-check. */
  const fields = {};
  if (action === 0x07 && payload.length >= 6) {
    fields.watts = (payload[3] << 8) | payload[4];
    fields.rpm = (payload[5] << 8) | payload[6];
  }

  return {
    proto: PROTO.A5,
    dst: b[i + 2],
    src: b[i + 3],
    action,
    label: A5_ACTION[action] ?? `action 0x${action.toString(16)}`,
    payload,
    valid: want === got,
    checksum: { want, got },
    fields,
  };
}

function decodeIC(b) {
  const i = b.findIndex((v, n) => v === 0x10 && b[n + 1] === 0x02);
  if (i < 0) return null;
  let end = -1;
  for (let n = i + 2; n < b.length - 1; n++) {
    if (b[n] === 0x10 && b[n + 1] === 0x03) { end = n; break; }
  }
  if (end < 0 || end - i < 4) return null;

  const dst = b[i + 2];
  const cmd = b[i + 3];
  const payload = b.slice(i + 4, end - 1);
  const want = b[end - 1];
  const got = sum(b, i, end - 1) & 0xff;

  const fields = {};
  if (cmd === 0x11 && payload.length >= 1) fields.output = payload[0];
  if (cmd === 0x12 && payload.length >= 2) {
    fields.saltPpm = payload[0] * 50;
    fields.status = payload[1];
  }

  return {
    proto: PROTO.IC,
    dst,
    src: 0x00,
    action: cmd,
    label:
      cmd === 0x11 ? "cell output set"
        : cmd === 0x12 ? "cell status"
        : `cmd 0x${cmd.toString(16)}`,
    payload,
    valid: want === got,
    checksum: { want, got },
    fields,
  };
}

/**
 * Decode one captured frame. Never throws and never guesses: anything that
 * does not frame cleanly comes back UNKNOWN, which on this bus is a result
 * rather than an error.
 */
export function decode(bytes) {
  const b = Array.from(bytes);
  const out = decodeA5(b) || decodeIC(b);
  if (out) return { ...out, bytes: b };
  return {
    proto: PROTO.UNKNOWN,
    dst: null,
    src: null,
    action: null,
    label: "undecoded",
    payload: [],
    valid: false,
    checksum: null,
    fields: {},
    bytes: b,
  };
}

/** Which bucket a frame falls in, for filtering and for the decode stats. */
export function classify(f) {
  if (f.proto === PROTO.UNKNOWN) return "unknown";
  if (!f.valid) return "bad";
  if (f.proto === PROTO.IC) return "chlorinator";
  if (f.src === 0x60 || f.dst === 0x60) return "pump";
  return "other";
}

/* ---------------------------------------------------------------------- */

/** Build an A5 frame with a correct checksum. Mock only. */
function buildA5(dst, src, action, data) {
  const body = [0xa5, 0x00, dst, src, action, data.length, ...data];
  const ck = body.reduce((a, v) => a + v, 0);
  return [0xff, 0x00, 0xff, ...body, (ck >> 8) & 0xff, ck & 0xff];
}

/** Build a DLE/STX chlorinator frame with a correct checksum. Mock only. */
function buildIC(dst, cmd, data) {
  const body = [0x10, 0x02, dst, cmd, ...data];
  const ck = body.reduce((a, v) => a + v, 0) & 0xff;
  return [...body, ck, 0x10, 0x03];
}

const rnd = (n) => Math.floor(Math.random() * n);

/**
 * Synthetic bus traffic for development.
 *
 * Deliberately includes frames that do NOT decode. The whole reason this
 * screen exists is the possibility that the iChlor speaks something these
 * decoders do not cover, so the mock must be able to show that state — a
 * monitor that only ever renders tidy decoded rows would be useless for
 * the decision it is meant to inform.
 */
export function syntheticFrame() {
  const roll = Math.random();

  if (roll < 0.45) {
    const rpm = 1600 + rnd(400);
    const watts = Math.round(2400 * Math.pow(rpm / 3450, 3));
    return buildA5(0x10, 0x60, 0x07, [
      0x0a, 0x00, 0x00, (watts >> 8) & 0xff, watts & 0xff,
      (rpm >> 8) & 0xff, rpm & 0xff, 0x00,
    ]);
  }
  if (roll < 0.6) return buildA5(0x60, 0x10, 0x01, [0x04, 0x03, 0x21, 0x00]);
  if (roll < 0.72) return buildIC(0x50, 0x12, [63 + rnd(4), 0x00]);
  if (roll < 0.8) return buildIC(0x50, 0x11, [45]);

  /* Unknown traffic — the iChlor 30 question in concrete form. */
  if (roll < 0.92) return Array.from({ length: 6 + rnd(6) }, () => rnd(256));

  /* A corrupted A5: right shape, wrong checksum. Distinguishes "we cannot
     frame this" from "we framed it and the bus is noisy". */
  const f = buildA5(0x10, 0x60, 0x07, [0x0a, 0x00, 0x00, 0x01, 0x2c, 0x06, 0x40, 0x00]);
  f[f.length - 1] ^= 0xff;
  return f;
}
