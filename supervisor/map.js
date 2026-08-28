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

import { pumpLimits } from "./binding.js";
import { toUiSchedule, isRealSchedule } from "./schedules.js";
import { bypassFor } from "./interlocks.js";

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

  /* `heatStatus` is njsPC's opinion, kept for display and diagnostics. It is
     deliberately *not* what drives the heat contacts.

     njsPC cannot reach this heater. Its Nixie heater is configured with no
     `connectionId` and no `deviceBinding` — the same choice made for the
     valves — and in that case `setHeaterStateAsync` assigns `hstate.isOn` and
     returns. It actuates nothing. Deriving a physical contact from it would
     be hardware following a simulation, and it would give one Raypak two
     authorities that swap on a mode change njsPC can trigger by itself, which
     is the split ADR-7 exists to forbid.

     So the call is ours, both halves:

       spa   — implied by the mode. The 3-wire carries no temperature, so the
               contact only says "you may heat toward the spa setpoint"; the
               heater's own thermostat regulates from there, and its 104 °F
               cap is what makes that safe (ADR-4).
       pool  — explicit, and cut off at `targets.pool` by `applyCutoff`.

     Nothing is lost by taking it: `NixieHeatpump.getCooldownTime()` returns 0
     — "There is no cooldown delay at this time for a heatpump" — so njsPC's
     `HeaterCooldownDelay` never constructs for this heater type. */
  const heatStatus = nameOf(activeBody.heatStatus) || "off";
  const heaterCall =
    mode === "spa" ? "spa"
      : own.poolHeatDemand ? "pool"
        : "off";

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
      /* njsPC has no bypass concept — the supervisor owns this one, and
         derives it rather than latching it.

         It used to be a stored field written by `setMode` and `setPoolHeat`.
         That is only correct while every mode change comes through an intent,
         and njsPC changes the body on its own — a schedule, dashPanel, the
         Spa circuit's egg timer expiring. Driving the spa circuit straight
         through njsPC's API left the stored value at `around` from pool mode,
         and the card came out `0x65`: spa valves, spa heat call, and the
         bypass still routed around the exchanger. A heat call at zero flow,
         which is precisely the pair ADR-5's interlock exists to prevent.

         Deriving it makes that state unreachable rather than merely reported.
         The supervisor observes and reacts (ADR-11); its bypass policy has to
         be a function of what is true, not a memory of what it last asked
         for. */
      bypass: bypassFor(mode, mode === "pool" && Boolean(own.poolHeatDemand)),
    },

    /* No `?? 0`. A pump we cannot hear from is not a pump at rest, and
       collapsing the two here would make it unrecoverable upstream. */
    pumpRpm: pump.rpm ?? null,

    /* What njsPC is asking for, derived from whichever pump circuit is on.
       njsPC deliberately does not put this in `rpm` — that field is what the
       pump reports back over RS-485. Keeping them apart is what lets the UI
       tell "idle" from "commanded but silent", which is a wiring fault. */
    pumpCommandedRpm: (() => {
      /* The highest speed among the circuits that are on, not the first.
         `NixiePumpVS.setTargetSpeed` takes the max, so with Pool at 1600 and
         a skim program at 2100 both on, the pump is asked for 2100 — and
         reporting 1600 would make the screen disagree with the equipment. */
      const speeds = (pump.circuits || [])
        .filter((pc) => pc?.circuit?.isOn)
        .map((pc) => pc.speed)
        .filter((s) => typeof s === "number");
      return speeds.length ? Math.max(...speeds) : null;
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
       timer. The circuit is null until the program is bound, and the last
       failed binding travels with it so the reason can be read on the row
       rather than in a toast that has already gone. */
    programs: (own.programs ?? []).map((p) => ({
      ...p,
      bindError: own.bindErrors?.[p.id] ?? null,
    })),

    /* Read back from njsPC rather than remembered.
     *
     * The circuit's `endTime` is njsPC's egg timer, and the egg timer is what
     * actually stops the program — so holding our own `endsAt` alongside it
     * would be a second copy of a timer we do not own, drifting from the
     * first. It also means a program started from dashPanel shows up here,
     * and one that expires disappears without anybody being told. */
    activeProgram: (() => {
      for (const p of own.programs ?? []) {
        if (p.circuit == null) continue;
        const c = byId(circuits, p.circuit);
        if (!c?.isOn) continue;
        return {
          id: p.id,
          name: p.name,
          rpm: p.rpm,
          endsAt: c.endTime ? Date.parse(c.endTime) : null,
        };
      }
      return null;
    })(),

    /* What the pump will accept, straight from njsPC. Null until a pump is
       configured, which is the honest answer before commissioning. */
    pumpLimits: pumpLimits(njs),

    /* Every circuit the pump carries a speed for — what a schedule or a
       program can actually be pointed at. The speed lives on the pump, so
       this is the one list that knows both the name and the rpm. */
    pumpCircuits: (pump.circuits || [])
      .map((pc) => {
        const id = pc?.circuit?.id ?? pc?.circuit ?? null;
        return {
          circuit: id,
          name: pc?.circuit?.name ?? byId(circuits, id)?.name ?? null,
          rpm: typeof pc?.speed === "number" ? pc.speed : null,
        };
      })
      .filter((c) => c.circuit != null),

    /* njsPC's schedules, not ours. It owns them (ADR-11) and evaluates them
       on its own timers, so the supervisor translates and writes back rather
       than keeping a copy that could disagree. Inactive slots are dropped —
       njsPC keeps empty ones in the array. */
    schedules: !Array.isArray(njs.schedules) ? null : njs.schedules.filter(isRealSchedule).map((s) =>
      toUiSchedule(s, {
        speedFor: (id) => {
          const pc = (pump.circuits || []).find(
            (x) => (x?.circuit?.id ?? x?.circuit) === id,
          );
          return typeof pc?.speed === "number" ? pc.speed : null;
        },
        nameFor: (id) => byId(circuits, id)?.name ?? null,
      }),
    ),

    /* Settings on njsPC that disagree with what this repo believes. Empty is
       the normal case; anything here is a silent fault made audible. */
    commissioning: own.commissioning ?? [],

    /* Invariants broken right now, as of the last evaluation. Empty is the
       normal case and the only one anybody should ever see. */
    violations: own.violations ?? [],

    /* Why the heater stopped, when it was us that stopped it. Without this a
       heat call ending at the target looks identical to one that failed. */
    lastCutoff: own.lastCutoff ?? null,
    /* Whether the pump circuit is on at all, distinct from its speed. */
    pumpRunning: Boolean(poolCircuit?.isOn || spaCircuit?.isOn),
    /* njsPC panel mode: 'service' stands the schedules down. */
    panelMode: nameOf(njs.mode) === "service" ? "service" : (own.panelMode ?? "auto"),

    /* Still supervisor-owned rather than njsPC-derived. The relay assignment
       now exists (`relays.js`), but nothing writes it from the live path yet. */
    blower: own.blower ?? false,
    light: own.light ?? false,

    saltPpm: chlor.saltLevel ?? null,
    cellOutput: chlor.currentOutput ?? null,

    /* Reflects the supervisor's link to njsPC, which is the thing that can
       actually fail. Set by index.js, not derived from payload. */
    connected: own.connected,
    lastSeen: own.lastSeen,

    /* What njsPC is waiting on, with its own clock attached.
     *
     * This is the only honest source of progress during a mode change.
     * njsPC flips every valve flag in the same tick — it believes a PE24GVA
     * diverts instantly — so nothing in its state describes a valve part-way
     * through travel. What it does report is the delay it enforces before
     * restarting the pump, with a real `startTime`, `endTime` and duration
     * taken from its configured `valveDelayTime`.
     *
     * The alternative was to dead-reckon `sequences.js` here. Every duration
     * in that file is invented, and animating them would put a confident
     * progress bar over a guess. */
    delays: (njs.delays || []).map((d) => ({
      type: nameOf(d.type) || String(d.type),
      /* njsPC's own words, e.g. "IntelliFlo will start after valve delay". */
      message: d.message ?? null,
      startsAt: d.startTime ? Date.parse(d.startTime) : null,
      endsAt: d.endTime ? Date.parse(d.endTime) : null,
      seconds: Number.isFinite(d.duration) ? d.duration : null,
      canCancel: Boolean(d.canCancel),
    })),

    /* Debug aid: which circuits njsPC thinks are on. */
    _circuits: { spa: Boolean(spaCircuit?.isOn), pool: Boolean(poolCircuit?.isOn) },
  };
}

export { SPA_CIRCUIT, POOL_CIRCUIT };
