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
 */

export const SEQUENCES = {
  spa: [
    { id: "heater-off", label: "Heater off", real: "instant", ms: 400 },
    { id: "purge", label: "Purging exchanger", real: "3 min", ms: 2400 },
    { id: "pump-low", label: "Pump to 1000 rpm", real: "20 sec", ms: 900 },
    { id: "intake", label: "Intake to spa drain", real: "45 sec", ms: 2000 },
    { id: "returns", label: "Returns fully to spa", real: "45 sec", ms: 2000 },
    { id: "pump-spa", label: "Pump to 2800 rpm", real: "20 sec", ms: 900 },
    { id: "heat", label: "Heater to spa setpoint", real: "instant", ms: 400 },
  ],
  pool: [
    { id: "heater-off", label: "Heater off", real: "instant", ms: 400 },
    { id: "purge", label: "Purging exchanger", real: "3 min", ms: 2400 },
    { id: "pump-low", label: "Pump to 1000 rpm", real: "20 sec", ms: 900 },
    { id: "returns", label: "Returns to spill split", real: "45 sec", ms: 2000 },
    { id: "intake", label: "Intake to pool drain", real: "45 sec", ms: 2000 },
    { id: "pump-pool", label: "Pump to 1600 rpm", real: "20 sec", ms: 900 },
  ],
};

export const MODES = [
  { id: "pool", label: "Pool" },
  { id: "spa", label: "Spa" },
];

/**
 * Invariants the sequencer must assert continuously, not just at
 * transition boundaries.
 */
export const INVARIANTS = [
  "heaterCall !== 'off' implies pumpRpm >= HEATER_MIN_RPM",
  "heaterCall !== 'off' implies valves.bypass === 'flow'",
  "bypass may only move when heaterCall === 'off' and purge has elapsed",
  "no valve command may be issued while another valve move is in flight",
  "spa mode auto-reverts to pool after SPA_TIMEOUT_MIN",
];

/** Flow thresholds. Placeholders. Measure on the real system and correct. */
export const HEATER_MIN_RPM = 1900;
export const CELL_MIN_RPM = 1150;
export const SPA_TIMEOUT_MIN = 120;
