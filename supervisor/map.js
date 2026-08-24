/**
 * njsPC state -> the shape the UI already speaks.
 *
 * The UI's `state` object was designed against a mock. This translates njsPC's
 * real model into it, so the client did not have to change. Where njsPC has no
 * concept of something (the bypass, targets-as-cutoffs) the supervisor's own
 * state is merged over the top — see `own` below.
 *
 * Field names on the njsPC side were read off a live `/state/all`, not guessed.
 * If njsPC changes shape this is the one file that needs to know.
 */

/** njsPC's shared-equipment model fixes these circuit ids. */
const SPA_CIRCUIT = 1;
const POOL_CIRCUIT = 6;

const byId = (list, id) => (list || []).find((x) => x.id === id);
const nameOf = (v) => (v && typeof v === "object" ? v.name : v);

/**
 * `own` is supervisor-held state njsPC knows nothing about: bypass position,
 * heat cutoffs, pool heat demand, scheduled preheat, and whatever sequence the
 * supervisor is currently walking.
 */
export function toUiState(njs, own) {
  const circuits = njs.circuits || [];
  const spaCircuit = byId(circuits, SPA_CIRCUIT);
  const poolCircuit = byId(circuits, POOL_CIRCUIT);

  const valves = njs.valves || [];
  const intake = valves.find((v) => v.isIntake);
  const returns = valves.find((v) => v.isReturn);

  const bodies = (njs.temps && njs.temps.bodies) || [];
  const activeBody = bodies.find((b) => b.isOn) || bodies[0] || {};

  const pump = (njs.pumps || [])[0] || {};
  const chlor = (njs.chlorinators || [])[0] || {};

  /* njsPC reports mode through valveMode, which already folds in spillway and
     spa-drain. We only have two modes, so anything not 'spa' is pool. */
  const mode = nameOf(njs.valveMode) === "spa" ? "spa" : "pool";

  /* heatStatus is njsPC's authority on whether the heater is actually calling;
     setPoint is what it is calling toward. Neither is our cutoff (ADR-4). */
  const heatStatus = nameOf(activeBody.heatStatus) || "off";
  const heaterCall =
    heatStatus === "off" || heatStatus === "cooldown"
      ? "off"
      : mode === "spa" ? "spa" : "pool";

  return {
    mode,
    /* A sequence in flight is the supervisor's business, not njsPC's. */
    target: own.target ?? null,
    activeSequence: own.activeSequence ?? null,
    step: own.step ?? null,
    stepIndex: own.stepIndex ?? 0,

    valves: {
      intake: intake?.isDiverted ? "spa" : "pool",
      returns: returns?.isDiverted ? "spa" : "split",
      /* njsPC has no bypass concept — the supervisor owns this one. */
      bypass: own.bypass ?? "around",
    },

    /* No `?? 0`. A pump we cannot hear from is not a pump at rest, and
       collapsing the two here would make it unrecoverable upstream. */
    pumpRpm: pump.rpm ?? null,

    /* What njsPC is asking for, derived from whichever pump circuit is on.
       njsPC deliberately does not put this in `rpm` — that field is what the
       pump reports back over RS-485. Keeping them apart is what lets the UI
       tell "idle" from "commanded but silent", which is a wiring fault. */
    pumpCommandedRpm: (() => {
      const on = (pump.circuits || []).find((pc) => pc?.circuit?.isOn);
      return on?.speed ?? null;
    })(),
    pumpWatts: pump.watts ?? null,
    /* True while njsPC is holding the pump off for a valve move. The UI can
       distinguish "stopped on purpose" from "stopped unexpectedly". */
    pumpHeldOff: Boolean(pump.pumpOnDelay),

    waterTemp: activeBody.temp ?? null,
    airTemp: njs.temps?.air ?? null,
    /* njsPC reports 0 for a body with no heater configured. Zero is not a
       setpoint anyone ever chose, so it means "unset", not "freezing". */
    setpoint: activeBody.setPoint || null,
    heaterCall,
    heatStatus,

    /* Cutoffs are ours; njsPC believes it owns setpoints. */
    targets: own.targets,
    poolHeatDemand: own.poolHeatDemand ?? false,
    preheat: own.preheat ?? null,

    /* njsPC's own egg timer is the spa auto-revert (ADR-11 / commissioning). */
    spaExpiresAt: spaCircuit?.endTime ? Date.parse(spaCircuit.endTime) : null,

    /* Manual programs are njsPC circuits carrying a pump speed and an egg
       timer. None exist until commissioning creates them, so an empty list
       is the honest answer rather than an absent field. */
    programs: own.programs ?? [],
    activeProgram: own.activeProgram ?? null,
    /* Whether the pump circuit is on at all, distinct from its speed. */
    pumpRunning: Boolean(poolCircuit?.isOn || spaCircuit?.isOn),
    /* njsPC panel mode: 'service' stands the schedules down. */
    panelMode: nameOf(njs.mode) === "service" ? "service" : (own.panelMode ?? "auto"),

    /* Not yet mapped — no relay assignment exists until the HAT arrives. */
    blower: own.blower ?? false,
    light: own.light ?? false,

    saltPpm: chlor.saltLevel ?? null,
    cellOutput: chlor.currentOutput ?? null,

    /* Reflects the supervisor's link to njsPC, which is the thing that can
       actually fail. Set by index.js, not derived from payload. */
    connected: own.connected,
    lastSeen: own.lastSeen,

    /* Passed through so the UI can show what njsPC is waiting on. */
    delays: (njs.delays || []).map((d) => nameOf(d.type) || String(d.type)),

    /* Debug aid: which circuits njsPC thinks are on. */
    _circuits: { spa: Boolean(spaCircuit?.isOn), pool: Boolean(poolCircuit?.isOn) },
  };
}

export { SPA_CIRCUIT, POOL_CIRCUIT };
