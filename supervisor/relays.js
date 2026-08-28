/**
 * The relay layer: what the supervisor believes, as one byte.
 *
 * The Eight Relays HAT is a single I2C port expander at `0x27`. Register
 * `0x01` is its output latch, and all eight relays are that one byte. There is
 * no microcontroller on the card, no firmware, and nothing to ask — writing
 * the byte is the whole interface.
 *
 * Two things here were measured on the card rather than read from a datasheet,
 * and both cost an evening to find. See `docs/bench-relays.md`.
 *
 * **The bit order is not the relay order.** The expander's pins are routed to
 * whichever relay was nearest on the board, so relay N is not bit N-1. That is
 * normal, and it is why every driver for these cards carries a remap table.
 *
 * The catch is which table. This board was bought as *Eight Relays* and its
 * product page names `8relay-rpi`, but its routing is `8relind-rpi`'s — the
 * *Industrial* card's driver — matching in all eight entries. Drive it with
 * `8relay-rpi` and only channels 1 and 2 land where you asked; the rest reach
 * relays 8, 7, 3, 4, 5 and 6. `8relay 0 write 8 on` is nominally the spare and
 * closes REL6, the blower contactor. Raised upstream as 8relay-rpi#7, though
 * this module means we do not depend on the answer.
 *
 * **Write the whole byte; never read-modify-write.** Both Sequent bindings
 * change one channel by reading the port back, flipping a bit and writing it
 * again — and they read the *input* register to compute a value for the output
 * latch. The supervisor owns all eight channels and therefore always knows the
 * byte it wants, so it can write that byte outright. One transaction, and the
 * failure mode where one channel's write drags the other seven along cannot
 * arise.
 */

/**
 * Relay number to bit position, measured on the V 7.1 card by writing **one
 * bit at a time** and reading the silkscreen label beside the lit LED.
 *
 * Do not derive this from anything. It is a fact about one board revision's
 * copper, it disagrees with every published table, and the only way to know it
 * is to look.
 *
 * **Measured twice, because the first attempt was wrong in five of eight
 * entries.** That attempt lit four channels at once, read the set of four LEDs
 * that came on, and paired them with the channels in order. The set was read
 * correctly; the pairing was an assumption, and it was false. Reading the
 * output latch back afterwards felt like corroboration and was not — it only
 * ever proves the code set the bit it meant to, which says nothing about which
 * relay that bit reaches.
 *
 * One bit, one LED, one label. Anything else is inference.
 */
export const BIT = { 1: 0, 2: 2, 3: 6, 4: 4, 5: 5, 6: 7, 7: 3, 8: 1 };

/** `1 << BIT[n]`, precomputed, because this is written on every evaluation. */
export const MASK = Object.fromEntries(
  Object.entries(BIT).map(([relay, bit]) => [relay, 1 << bit]),
);

/**
 * What each relay switches. These are relay numbers on the board, matching
 * the channel map in PRD §4 — CH1 is REL1 and so on. The driver's channel
 * numbers are a separate, wrong thing and appear nowhere in this file.
 */
export const CHANNEL = {
  INTAKE: 1, RETURN: 2, BYPASS: 3,
  HEAT_POOL: 4, HEAT_SPA: 5,
  BLOWER: 6, LIGHT: 7, SPARE: 8,
};

/**
 * De-energised is the safe rest position for every channel, which is what
 * makes a power cut harmless: `architecture.md` — *"relays de-energise: valves
 * to pool, bypass to flow, heater open, blower off"*.
 *
 * So the sense of each bit is chosen to make the *unpowered* state the safe
 * one, not to make the code read nicely:
 *
 *   intake / return   energised = spa      so losing power returns to pool
 *   bypass            energised = around   so losing power leaves flow through
 *                                          the exchanger, which is harmless
 *                                          with no call (ADR-9)
 *   heater, blower    energised = calling / running
 *
 * The cost is that spa mode holds three coils energised continuously. The
 * actuators do not care — a PE24GVA keeps one of its two lines energised in
 * either position — so the standing cost is coil current alone.
 */
export function byteFor(state) {
  const s = state || {};
  const valves = s.valves || {};
  let b = 0;

  if (valves.intake === "spa") b |= MASK[CHANNEL.INTAKE];
  if (valves.returns === "spa") b |= MASK[CHANNEL.RETURN];
  if (valves.bypass === "around") b |= MASK[CHANNEL.BYPASS];

  if (s.heaterCall === "pool") b |= MASK[CHANNEL.HEAT_POOL];
  if (s.heaterCall === "spa") b |= MASK[CHANNEL.HEAT_SPA];

  if (s.blower === true) b |= MASK[CHANNEL.BLOWER];
  if (s.light === true) b |= MASK[CHANNEL.LIGHT];

  /* CHANNEL.SPARE is never set. Nothing is wired to it, and the one way this
     project could start the blower by accident is a stray write to the channel
     everybody believes is unused. */
  return b;
}

/** Which relays a byte closes, by number. For logs and the bench. */
export function relaysIn(byte) {
  return Object.entries(BIT)
    .filter(([, bit]) => (byte >> bit) & 1)
    .map(([relay]) => Number(relay))
    .sort((a, b) => a - b);
}

/** `0x4d -> "0x4d  REL1 REL3 REL5"`, for a log line that can be checked by eye. */
export function describe(byte) {
  const on = relaysIn(byte);
  return `0x${byte.toString(16).padStart(2, "0")}  ${
    on.length ? on.map((r) => `REL${r}`).join(" ") : "(all off)"}`;
}
