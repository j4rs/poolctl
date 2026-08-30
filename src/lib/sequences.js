/**
 * Transition sequences.
 *
 * This file is the executable spec for the state machine. The server-side
 * sequencer MUST implement the same steps in the same order. If the UI and
 * the server disagree about the sequence, that is a bug.
 *
 * `real` is the intended duration; `ms` is compressed so the sequence is
 * watchable during development.
 *
 * NONE OF THE DURATIONS BELOW ARE MEASURED. The 45 sec valve travel, the
 * 3 min purge and the 20 sec pump ramp are all assumptions, as are the rpm
 * constants. Every one of them wants timing against the real equipment
 * before it is trusted. Same rule as the rest of the mock: if a decision
 * needs a real number, get it from the PRD or from hardware — not from here.
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
 * Valve moves are strictly sequential and happen at ZERO flow. Settled
 * against the IntelliFlo manual: with priming enabled the pump ramps to
 * 1800 RPM for 3 sec on every restart and ignores automation commands while
 * it does, so a 1000 rpm floor across a restart is unenforceable by anyone.
 * With priming disabled at the pump (a commissioning step), njsPC's
 * stop-move-start costs only ramp time, and zero flow is gentler on the
 * actuator than turning against hydraulic load. `VALVE_RPM` therefore applies
 * only to moves that involve no pump restart.
 */

/**
 * The pump speed below which a heat call is not allowed.
 *
 * **1600, and it means "lowest verified", not "measured floor".** Observed on
 * 30 August 2026: pump at 1600 with the bypass open, a standing pool heat
 * call, and the heater running — its water pressure switch satisfied, no
 * `Water PS Open`. 1800 was verified the same afternoon.
 *
 * This was **1900 and invented**, which put it above the 1600 njsPC actually
 * runs the Pool circuit at, so `checkHeatFloor` reported a permanent conflict
 * it could not resolve. The measurement resolved it against this repo's
 * number, not njsPC's.
 *
 * The true floor is still unknown and deliberately so. Finding it means
 * ramping until the heater faults, and nobody would configure the pool
 * circuit at the flow floor anyway — the operationally useful number is the
 * lowest speed known to work, which is this one. Note also that a satisfied
 * pressure switch is not proof of the nameplate's 30–60 GPM; that needs a
 * flow reading, not the absence of a fault.
 */
export const HEATER_MIN_RPM = 1600;

/** Placeholder. Measure on the real system and correct. */
export const CELL_MIN_RPM = 1150;
export const SPA_TIMEOUT_MIN = 120;

/** Skip the exchanger purge if the compressor has been idle this long. */
export const PURGE_SKIP_AFTER_MIN = 5;

/**
 * How long flow is held through the exchanger after a heat call ends, before
 * the bypass may isolate it. **UNMEASURED** — the Raypak manual's ~5 min
 * figure is the anti-short-cycle delay, which is a different thing, and its
 * real post-compressor requirement is unconfirmed.
 *
 * Erring long is close to free here, which was not true of the design this
 * number was first written for. In `SEQUENCES` the purge blocks a whole
 * transition, so three minutes is three minutes of somebody waiting. As the
 * supervisor actually implements it, njsPC switches the body immediately and
 * all this delays is our own bypass relay — the water simply keeps going
 * through the heater a while longer, which nobody sees and nothing waits on.
 * So if the measurement comes back higher, raise it without hesitating.
 *
 * Note it is deliberately below `PURGE_SKIP_AFTER_MIN`. That makes the
 * skip-when-idle condition redundant rather than wrong: a call that ended
 * more than five minutes ago also ended more than three minutes ago, so the
 * hold has already expired and there is nothing to skip.
 */
export const PURGE_MIN = 3;

/**
 * Intermatic duty cycle: 1 min ON max, 8 min OFF min. An actuator may not be
 * re-driven inside this window. Nothing enforces it yet — a user toggling
 * spa -> pool -> spa would violate it with three normal transitions.
 */
export const ACTUATOR_COOLDOWN_MIN = 8;

/**
 * Hard caps enforced by the heater's own firmware (ADR-4). The 3-wire
 * interface carries no temperature — closing a contact calls for heat at a
 * setpoint held on the heater's board, which the app can neither read nor
 * write. These are the ceilings that board will not exceed.
 */
export const HEATER_CAP = { pool: 95, spa: 104 };

/** Floors for the target steppers. Below these, calling for heat is pointless. */
export const TARGET_MIN = { pool: 70, spa: 80 };

/**
 * Spa heating rate, °F/hr. The conservative end of the PRD's 20–25 range.
 *
 * Deliberately NOT derived from volume. The spa is now *measured* at ~458 gal
 * (6 ft diameter, 2.17 ft average depth), where nameplate 140k BTU/hr would
 * give 36.6 °F/hr before losses — so 20 implies the heater delivers ~55% of
 * nameplate. That is plausible for winter air plus evaporative loss, but
 * computing the rate from a geometric volume and a guessed derate factor
 * would look rigorous while resting on two assumptions instead of one.
 *
 * Erring slow is the right direction: the spa is ready sooner than promised.
 * A single heating run against the iChlor temp probe replaces all of this
 * with a measured effective thermal mass.
 */
export const SPA_HEAT_RATE = 20;

/** Resting speeds. Spa jet rpm is a guess — tune once settable from a phone. */
export const POOL_RPM = 1600;
export const SPA_RPM = 2800;
/* Held across every valve move. Owner's decision: low flow, not zero. */
export const VALVE_RPM = 1000;

/**
 * One-way actuator travel, in seconds. **UNMEASURED** — see the header: this
 * is the 45 sec that half the durations below rest on, and nobody has put a
 * stopwatch on a PE24GVA yet.
 *
 * Named rather than left as a literal because the supervisor compares njsPC's
 * `valveDelayTime` against it, and a figure that decides whether a warning
 * appears should be findable and obviously provisional.
 */
export const ASSUMED_VALVE_TRAVEL_SEC = 45;

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
  "an actuator may not be re-driven within ACTUATOR_COOLDOWN_MIN of its last move",
];

/**
 * A transition cannot be cancelled once started. The owner is committed for
 * the duration. Accepted deliberately: aborting mid-travel would leave a
 * dead-reckoned valve at an unknown angle with no feedback to recover from,
 * and abort-at-step-boundaries buys little when the bound is a 45 sec move.
 */
export const ABORTABLE = false;
