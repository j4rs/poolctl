/**
 * Transition sequences.
 *
 * This file is the executable spec for the state machine. The server-side
 * sequencer MUST implement the same steps in the same order. If the UI and
 * the server disagree about the sequence, that is a bug.
 *
 * `real` is the true duration. `ms` is compressed for the mock so the
 * sequence is watchable during development.
 *
 * Site facts these encode:
 *   - Intake diverter: 180 deg. A = pool main drain, B = spa main drain.
 *   - Return diverter:  90 deg. A = pool + spa (spilling), B = spa only.
 *   - Heater bypass:    90 deg. A = flow through heater, B = around it.
 *   - Pool mode spills continuously through the spa, so the spa is always
 *     full, filtered and chlorinated.
 *
 * Bypass policy (ADR-9): the bypass follows the mode — flow in spa, around
 * in pool — and swings back to flow whenever pool heat is called. The valve
 * is binary, so a heat call with the bypass around means zero flow through
 * the exchanger. The interlock is load-bearing in both directions.
 *
 * Valve moves are strictly sequential and always at low rpm. Never divert
 * against full flow: water hammer, and the actuator can stall.
 */

/** Flow thresholds. Placeholders. Measure on the real system and correct. */
export const HEATER_MIN_RPM = 1900;
export const CELL_MIN_RPM = 1150;
export const SPA_TIMEOUT_MIN = 120;

/** Skip the exchanger purge if the compressor has been idle this long. */
export const PURGE_SKIP_AFTER_MIN = 5;

/** Resting speeds. Spa jet rpm is a guess — tune once settable from a phone. */
export const POOL_RPM = 1600;
export const SPA_RPM = 2800;
export const VALVE_RPM = 1000;

/**
 * Named skip conditions.
 *
 * Kept declarative rather than inline so the server and the UI agree on when
 * a step is skipped, and so the UI can render a skipped step struck through
 * instead of silently dropping it. A two-minute path and a five-minute path
 * should look like the same sequence.
 *
 * The context object: { valves, pumpRpm, poolHeatDemand, compressorIdleMin }.
 */
export const SKIP_WHEN = {
  compressorIdle: (c) => c.compressorIdleMin >= PURGE_SKIP_AFTER_MIN,
  bypassAlreadyFlow: (c) => c.valves.bypass === "flow",
  bypassAlreadyAround: (c) => c.valves.bypass === "around",
  poolHeatDemand: (c) => c.poolHeatDemand === true,
  pumpAboveHeaterMin: (c) => c.pumpRpm >= HEATER_MIN_RPM,
};

export function isSkipped(step, ctx) {
  if (!step.skipWhen) return false;
  return step.skipWhen.some((key) => SKIP_WHEN[key](ctx));
}

/** Steps for a named sequence, each annotated with whether it will be run. */
export function stepsFor(name, ctx) {
  return (SEQUENCES[name] || []).map((s) => ({ ...s, skipped: isSkipped(s, ctx) }));
}

export const SEQUENCES = {
  /* Pool -> Spa. Three sequential valve moves dominate the wall clock. */
  spa: [
    { id: "heater-off", label: "Heater off", real: "instant", ms: 400 },
    { id: "purge", label: "Purging exchanger", real: "3 min", ms: 2400,
      skipWhen: ["compressorIdle"] },
    { id: "pump-low", label: `Pump to ${VALVE_RPM} rpm`, real: "20 sec", ms: 900 },
    { id: "bypass-flow", label: "Bypass to heater flow", real: "45 sec", ms: 2000,
      skipWhen: ["bypassAlreadyFlow"] },
    { id: "intake-spa", label: "Intake to spa drain", real: "45 sec", ms: 2000 },
    { id: "returns-spa", label: "Returns fully to spa", real: "45 sec", ms: 2000 },
    { id: "pump-spa", label: `Pump to ${SPA_RPM} rpm`, real: "20 sec", ms: 900 },
    { id: "heat-spa", label: "Heater to spa setpoint", real: "instant", ms: 400 },
  ],

  /* Spa -> Pool. Also the auto-revert path after SPA_TIMEOUT_MIN.
     The blower is cleared explicitly: leaving it running in pool mode
     strands it on, since its toggle is gated to spa mode. */
  pool: [
    { id: "heater-off", label: "Heater off", real: "instant", ms: 400 },
    { id: "purge", label: "Purging exchanger", real: "3 min", ms: 2400,
      skipWhen: ["compressorIdle"] },
    { id: "blower-off", label: "Blower off", real: "instant", ms: 400 },
    { id: "pump-low", label: `Pump to ${VALVE_RPM} rpm`, real: "20 sec", ms: 900 },
    { id: "returns-split", label: "Returns to spill split", real: "45 sec", ms: 2000 },
    { id: "intake-pool", label: "Intake to pool drain", real: "45 sec", ms: 2000 },
    { id: "bypass-around", label: "Bypass around heater", real: "45 sec", ms: 2000,
      skipWhen: ["poolHeatDemand", "bypassAlreadyAround"] },
    { id: "pump-pool", label: `Pump to ${POOL_RPM} rpm`, real: "20 sec", ms: 900 },
  ],

  /* Pool heating. Pool mode rests with the heater isolated, so calling for
     heat has to open the water path first. Multi-day operation — see the
     winter pool-heating item in the backlog. */
  heatEngage: [
    { id: "bypass-flow", label: "Bypass to heater flow", real: "45 sec", ms: 2000,
      skipWhen: ["bypassAlreadyFlow"] },
    { id: "pump-min", label: `Pump to ${HEATER_MIN_RPM} rpm`, real: "20 sec", ms: 900,
      skipWhen: ["pumpAboveHeaterMin"] },
    { id: "heat-pool", label: "Heater to pool setpoint", real: "instant", ms: 400 },
  ],

  heatRelease: [
    { id: "heater-off", label: "Heater off", real: "instant", ms: 400 },
    { id: "purge", label: "Purging exchanger", real: "3 min", ms: 2400,
      skipWhen: ["compressorIdle"] },
    { id: "bypass-around", label: "Bypass around heater", real: "45 sec", ms: 2000,
      skipWhen: ["bypassAlreadyAround"] },
    { id: "pump-restore", label: "Pump back to schedule", real: "20 sec", ms: 900 },
  ],

  /* Boot resync. Valve position is dead-reckoned with no feedback, so the
     persisted position is not trusted across a restart.
     Deliberately carries no skip conditions: every valve is re-driven
     unconditionally, which is the whole point. */
  boot: [
    { id: "heater-off", label: "Heater contacts open", real: "instant", ms: 400 },
    { id: "blower-off", label: "Blower off", real: "instant", ms: 400 },
    { id: "pump-low", label: `Pump to ${VALVE_RPM} rpm`, real: "20 sec", ms: 900 },
    { id: "returns-split", label: "Returns to spill split", real: "45 sec", ms: 2000 },
    { id: "intake-pool", label: "Intake to pool drain", real: "45 sec", ms: 2000 },
    { id: "bypass-around", label: "Bypass around heater", real: "45 sec", ms: 2000 },
    { id: "pump-pool", label: `Pump to ${POOL_RPM} rpm`, real: "20 sec", ms: 900 },
  ],
};

export const MODES = [
  { id: "pool", label: "Pool" },
  { id: "spa", label: "Spa" },
];

/**
 * Invariants the sequencer must assert continuously, not just at
 * transition boundaries.
 *
 * The two bypass implications are converses of each other and both are
 * needed: the first keeps a heat call from being made into a bypassed
 * exchanger, the second keeps the bypass from swinging away under a live
 * call. Either one alone leaves a hole.
 *
 * The blower rule is a preference, not a safety interlock — the spa is
 * always full so the blower can never run dry. It is asserted anyway
 * because the toggle is gated to spa mode, so a blower left running on the
 * way out of spa mode is both on and unreachable. Relax the gate and this
 * invariant goes with it.
 */
export const INVARIANTS = [
  "heaterCall !== 'off' implies pumpRpm >= HEATER_MIN_RPM",
  "heaterCall !== 'off' implies valves.bypass === 'flow'",
  "valves.bypass === 'around' implies heaterCall === 'off'",
  "bypass may only move when heaterCall === 'off' and purge has elapsed",
  "no valve command may be issued while another valve move is in flight",
  "mode !== 'spa' implies blower === false (preference, not safety)",
  "spa mode auto-reverts to pool after SPA_TIMEOUT_MIN",
];

/**
 * A transition cannot be cancelled once started. The owner is committed for
 * the duration. Accepted deliberately: aborting mid-travel would leave a
 * dead-reckoned valve at an unknown angle with no feedback to recover from,
 * and abort-at-step-boundaries buys little when the bound is a 45 sec move.
 */
export const ABORTABLE = false;
