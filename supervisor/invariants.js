import { HEATER_MIN_RPM } from "../src/lib/sequences.js";

/**
 * The invariants, checked against whatever is true right now.
 *
 * `sequences.js` lists these and `interlocks.js` holds the rules that stop
 * them being broken by a request. Neither notices when one is broken anyway —
 * by njsPC acting on its own timers, by dashPanel, by a relay that did not
 * move. CLAUDE.md's invariant block opens "assert continuously, not just at
 * transitions", and until this file nothing did.
 *
 * Three rules run the whole thing:
 *
 * **Unknown is never a violation.** A null pump speed means the pump is not
 * answering, not that it is too slow. Reporting a breach on absent data would
 * make the monitor noise within a day, and noise is how a safety display
 * teaches people to ignore it.
 *
 * **Expected states are not violations.** njsPC holds the pump off during a
 * valve delay on purpose; a slow pump then is the design working.
 *
 * **This reports, it does not correct.** Reaching in to "fix" equipment on
 * the strength of a snapshot is how a supervisor makes things worse. The one
 * thing it does act on lives in `index.js` and is a decision we own outright:
 * ending our own heat call at the target.
 *
 * Only the snapshot-checkable invariants are here. Those about transitions —
 * no valve command while another is in flight, actuator cooldown, the purge
 * before a bypass move — cannot be seen in a single state and belong with
 * valve driving, which is not built.
 */

/** A breach worth showing, or nothing. */
const breach = (id, what, detail) => ({ id, severity: "alarm", what, detail });

export function checkInvariants(s) {
  if (!s) return [];
  const out = [];
  const calling = s.heaterCall && s.heaterCall !== "off";
  const bypass = s.valves?.bypass;

  /* heaterCall !== 'off' implies pumpRpm >= HEATER_MIN_RPM.
     Suppressed while njsPC is deliberately holding the pump off for a valve
     move, and whenever the pump is not reporting a speed at all. */
  if (calling && typeof s.pumpRpm === "number" && !s.pumpHeldOff) {
    if (s.pumpRpm < HEATER_MIN_RPM) {
      out.push(breach(
        "heat-below-floor",
        `Heat is called with the pump at ${s.pumpRpm} rpm`,
        `The heater needs ${HEATER_MIN_RPM} rpm of flow. Below it the exchanger is being fired without enough water through it.`,
      ));
    }
  }

  /* The two bypass implications are converses and both are needed: one stops
     a call into a bypassed exchanger, the other stops the valve swinging away
     under a live call. As a snapshot they collapse into one comparison — the
     distinction is about which action is refused, not what is true. */
  if (calling && bypass === "around") {
    out.push(breach(
      "heat-into-bypass",
      "Heat is called with the bypass around the heater",
      "The valve is binary, so this is zero flow through the exchanger, not reduced flow.",
    ));
  }

  /* mode !== 'spa' implies blower === false. Preference, not safety — but a
     blower running in pool mode is also unreachable, because its toggle is
     gated to spa. */
  if (s.mode !== "spa" && s.blower === true) {
    out.push(breach(
      "blower-outside-spa",
      "The blower is running in pool mode",
      "Its switch only appears in spa mode, so nothing on this screen can turn it off.",
    ));
  }

  /* spa mode auto-reverts after SPA_TIMEOUT_MIN. The egg timer is njsPC's,
     and commissioning checks its length; this catches a session running with
     no expiry attached at all, which is the case that never ends. */
  if (s.mode === "spa" && s.spaExpiresAt == null) {
    out.push(breach(
      "spa-without-expiry",
      "The spa is on with nothing set to end it",
      "njsPC reports no end time for the spa circuit, so it will run until somebody switches it off.",
    ));
  }

  return out;
}
