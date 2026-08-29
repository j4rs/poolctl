import { useState, useEffect, useRef } from "react";
import { DEFAULT_PROGRAMS } from "./programs.js";
import { RPM_MIN, RPM_MAX } from "./pump.js";
import {
  SEQUENCES, isSkipped, POOL_RPM, SPA_RPM, VALVE_RPM,
  HEATER_MIN_RPM, HEATER_CAP, TARGET_MIN, SPA_TIMEOUT_MIN, SPA_HEAT_RATE,
} from "./sequences.js";


/* ILLUSTRATIVE ONLY — see the mock-data warning above.
 *
 * These carry circuits rather than bare speeds because that is njsPC's model
 * and the live screen speaks it: a schedule runs a circuit, and the circuit
 * is what the pump has a speed for. The names do the work the old free-text
 * note used to, and unlike a note they survive the trip to real equipment. */
const MOCK_PUMP_CIRCUITS = [
  { circuit: 6, name: "Pool", rpm: 1600 },
  { circuit: 1, name: "Spa", rpm: 2800 },
  { circuit: 7, name: "Solar gain", rpm: 2600 },
  { circuit: 8, name: "Evening", rpm: 1400 },
  { circuit: 9, name: "Skim", rpm: 2100 },
];

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

const MOCK_SCHEDULES = [
  { id: 1, circuit: 6, circuitName: "Pool", rpm: 1600, start: "08:00", end: "12:00", days: EVERY_DAY, enabled: true, clockOnly: true, repeats: true },
  { id: 2, circuit: 7, circuitName: "Solar gain", rpm: 2600, start: "12:00", end: "16:00", days: EVERY_DAY, enabled: true, clockOnly: true, repeats: true },
  { id: 3, circuit: 8, circuitName: "Evening", rpm: 1400, start: "16:00", end: "20:00", days: EVERY_DAY, enabled: true, clockOnly: true, repeats: true },
  { id: 4, circuit: 9, circuitName: "Skim", rpm: 2100, start: "22:00", end: "23:30", days: [0, 6], enabled: false, clockOnly: true, repeats: true },
];

/**
 * Apply one step to the local simulation and return the matching state patch.
 *
 * `sim` mirrors the parts of state that skip conditions read, so the next
 * step's skip decision can be made synchronously — React state updates are
 * not visible in time to schedule the following timer.
 */
function applyStep(id, sim) {
  const valves = () => ({ valves: { ...sim.valves } });
  switch (id) {
    /* Turning the heater off also drops the pool-heat intent. A future
       pool-heating schedule re-asserts demand after a mode change rather
       than the mode change carrying it across. */
    case "heater-off":    sim.poolHeatDemand = false;
                          return { heaterCall: "off", setpoint: null, poolHeatDemand: false };
    case "blower-off":    return { blower: false };
    case "purge":         return {};
    case "pump-low":      sim.pumpRpm = VALVE_RPM;       return { pumpRpm: VALVE_RPM };
    case "pump-spa":      sim.pumpRpm = SPA_RPM;         return { pumpRpm: SPA_RPM };
    case "pump-pool":     sim.pumpRpm = POOL_RPM;        return { pumpRpm: POOL_RPM };
    case "pump-min":      sim.pumpRpm = HEATER_MIN_RPM;  return { pumpRpm: HEATER_MIN_RPM };
    case "pump-restore":  sim.pumpRpm = POOL_RPM;        return { pumpRpm: POOL_RPM };
    case "bypass-flow":   sim.valves.bypass = "flow";    return valves();
    case "bypass-around": sim.valves.bypass = "around";  return valves();
    case "intake-spa":    sim.valves.intake = "spa";     return valves();
    case "intake-pool":   sim.valves.intake = "pool";    return valves();
    case "returns-spa":   sim.valves.returns = "spa";    return valves();
    case "returns-split": sim.valves.returns = "split";  return valves();
    case "heat-spa":      return { heaterCall: "spa", setpoint: sim.targets.spa };
    case "heat-pool":     return { heaterCall: "pool", setpoint: sim.targets.pool };
    default:              return {};
  }
}

/**
 * Mock controller.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ NOTHING IN THIS FILE IS REAL.                                        │
 * │                                                                      │
 * │ Every number below — temperatures, salt, cell output, rpm, targets — │
 * │ is invented to make the UI demonstrable. None of it is measured, and │
 * │ none of it describes the actual site. The same goes for the schedule │
 * │ rows in PumpControl and the traffic in useBus.                       │
 * │                                                                      │
 * │ `docs/prds/poolctl-v1.md` is the source of truth. If a decision      │
 * │ needs a real value and the PRD does not have one, the value is       │
 * │ unknown — say so rather than reading it off this screen. An ADR was  │
 * │ once justified on mock schedule data by mistake.                     │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * THIS IS THE ONLY FILE THAT CHANGES when you wire up real hardware.
 * Replace the body with a hook that:
 *   - subscribes to njsPC over MQTT or its WebSocket
 *   - maps incoming payloads into the same `state` shape below
 *   - sends intents (setMode, setRpm, setTarget, setPoolHeat, toggle)
 *     rather than mutating locally
 *
 * The UI never issues equipment primitives. It says setMode('spa'); the
 * server decides what relays that means and enforces every interlock.
 */
export function useController() {
  const [state, setState] = useState({
    mode: "pool",
    /* `target` is the mode being transitioned to, or null. `activeSequence`
       is the sequence running, which may be a heat change with no mode
       change at all — the two are not the same thing. */
    target: null,
    activeSequence: null,
    step: null,
    stepIndex: 0,
    /* Pool rests with the heater isolated — see the bypass policy in
       sequences.js. Calling for pool heat swings it back to flow. */
    valves: { intake: "pool", returns: "split", bypass: "around" },
    pumpRpm: POOL_RPM,
    waterTemp: 84.2,
    airTemp: 88,
    setpoint: null,
    heaterCall: "off",
    /* App-side targets. The heater holds its own setpoint on its board and
       the 3-wire contacts carry no temperature (ADR-4), so these can only
       end a heat call early — never raise the heater's cap. */
    targets: { pool: 88, spa: 102 },
    /* Manual programs, and which one is running. njsPC holds these as
       circuits with pump speeds and egg timers; here they are plain data. */
    programs: DEFAULT_PROGRAMS,
    activeProgram: null,
    /* What the pump would accept. Invented like everything else here — the
       live supervisor reads this off njsPC's pump. The shape matters more
       than the numbers: null limits mean no pump is configured. */
    pumpLimits: { pumpId: 50, minSpeed: RPM_MIN, maxSpeed: RPM_MAX, maxCircuits: 8, used: 5 },
    /* The circuits the pump carries a speed for. A schedule points at one of
       these; the speed is the circuit's, never the schedule's. */
    pumpCircuits: MOCK_PUMP_CIRCUITS,
    /* ILLUSTRATIVE. Several windows at different speeds, to exercise the
       screen. The real schedule is one daily filtration window — the PRD has
       it. Live, these come from njsPC and none of this is used. */
    schedules: MOCK_SCHEDULES,
    /* The pump itself, independent of speed: stopped means stopped. */
    pumpRunning: true,
    /* njsPC panel mode. 'service' means automation stands down and only
       manual commands act — the industry switch for working on equipment. */
    panelMode: "auto",
    poolHeatDemand: false,
    blower: false,
    light: false,
    saltPpm: 3150,
    cellOutput: 45,
    /* Connection. `connected` is now driven by a heartbeat rather than being
       hardcoded true — a client showing LIVE beside frozen state is the one
       thing ADR-7 says must never happen. */
    connected: true,
    lastSeen: Date.now(),
    /* Steps for the running sequence, each annotated `skipped`. Planned up
       front so the UI can strike skipped steps through instead of dropping
       them, keeping the short and long paths visually identical. */
    steps: [],
    /* When spa mode auto-reverts. Null outside spa mode. */
    spaExpiresAt: null,
    /* Scheduled preheat: { readyAt, startsAt } or null. */
    preheat: null,
  });

  const timer = useRef(null);
  /* Last moment the compressor was running, for the conditional purge.
     Null means it has not run since the app loaded — the common case, and
     the one where "Spa now" skips the purge entirely. */
  const compressorAt = useRef(null);
  /* Mock transport outage, toggled from the connection badge. */
  const outage = useRef(false);
  /* The heartbeat runs on a mount-once interval, so it needs a live handle
     on the current runSequence rather than the one captured at mount. */
  const runRef = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * Run a named sequence. `mode` is the mode to land in, if this sequence
   * changes mode at all; `seed` patches state before the first step.
   */
  const runSequence = (name, { mode: landing = null, seed = {} } = {}) => {
    const raw = SEQUENCES[name];
    const sim = {
      valves: { ...state.valves },
      pumpRpm: state.pumpRpm,
      poolHeatDemand: state.poolHeatDemand,
      targets: { ...state.targets },
      ...seed,
    };
    /* Walk the sequence against a throwaway copy of the simulation first, so
       every skip decision is known before the first step runs. Skips depend
       on the state left by earlier steps, so this has to be a forward walk
       rather than a map. */
    const plan = (() => {
      const probe = { ...sim, valves: { ...sim.valves } };
      const idleMin = compressorAt.current == null
        ? Infinity : (Date.now() - compressorAt.current) / 60000;
      return raw.map((step) => {
        const skipped = isSkipped(step, { ...probe, compressorIdleMin: idleMin });
        if (!skipped) applyStep(step.id, probe);
        return { ...step, skipped };
      });
    })();
    const steps = plan;
    let i = 0;

    const advance = () => {
      if (i >= steps.length) {
        setState((s) => ({
          ...s,
          ...(landing ? { mode: landing } : {}),
          /* Spa mode is time-boxed. The PRD is emphatic: this is what saves
             the system when someone opens the spa and forgets. */
          ...(landing === "spa"
            ? { spaExpiresAt: Date.now() + SPA_TIMEOUT_MIN * 60000 }
            : landing === "pool"
              ? { spaExpiresAt: null, preheat: null }
              : {}),
          target: null, activeSequence: null, step: null, stepIndex: 0, steps: [],
        }));
        return;
      }

      const step = steps[i];
      const skipped = step.skipped;
      const patch = skipped ? {} : applyStep(step.id, sim);

      setState((s) => ({
        ...s, ...seed, ...patch,
        /* A sequence takes the pump, so a manual program is over. This
           replaced `pumpHold: null` when the hold was removed; a whole block
           of initial state landed here by mistake at the same time, which
           reset the program list and re-enabled automation on every step. */
        activeProgram: null,
        target: landing, activeSequence: name, step, stepIndex: i, steps: plan,
      }));

      i += 1;
      /* Skipped steps still occupy their index so the rendered step list
         stays aligned with SEQUENCES; they just cost no time. */
      timer.current = setTimeout(advance, skipped ? 0 : step.ms);
    };

    advance();
  };

  runRef.current = runSequence;

  const setMode = (target) => {
    /* No abort: ABORTABLE is false, so a sequence in flight is committed. */
    if (state.activeSequence || target === state.mode) return;
    runSequence(target, { mode: target });
  };

  /**
   * Pool heat. Pool mode rests with the bypass around the exchanger, so
   * turning heat on has to open the water path before the contact closes.
   * Spa mode owns the heater outright and refuses this.
   */
  const setPoolHeat = (on) => {
    if (state.activeSequence || state.mode !== "pool") return;
    if (on) runSequence("heatEngage", { seed: { poolHeatDemand: true } });
    else runSequence("heatRelease", { seed: { poolHeatDemand: false } });
  };

  /* Invariant 1: a live heat call floors the pump at HEATER_MIN_RPM. The
     slider clamps rather than dropping the call — silently stopping the
     heat because someone dragged a control is the worse surprise. */
  const setRpm = (rpm) =>
    setState((s) => {
      const next = s.heaterCall !== "off" ? Math.max(rpm, HEATER_MIN_RPM) : rpm;
      return {
        ...s,
        pumpRpm: next,
      };
    });


  /* Start / stop the pump outright. Distinct from speed: this is the circuit
     being on at all, which is what "stop the pump" means to anyone standing
     at the equipment. */
  const setPumpRunning = (on) =>
    setState((s) => ({
      ...s,
      pumpRunning: Boolean(on),
      pumpRpm: on ? (s.activeProgram ? s.pumpRpm : POOL_RPM) : 0,
      activeProgram: on ? s.activeProgram : null,
    }));

  /* Auto or service. Service suspends schedules without disabling them one
     by one, and is what you want while cleaning a filter. */
  const setPanelMode = (mode) =>
    setState((s) => ({ ...s, panelMode: mode === "service" ? "service" : "auto" }));

  /** Run a program. Expiry is mandatory — see programs.js. */
  const startProgram = (id) =>
    setState((s) => {
      const p = s.programs.find((x) => x.id === id);
      /* Unbound programs cannot run here either. The speed lives on an njsPC
         circuit, so without one there is nowhere to put it. */
      if (!p || p.circuit == null) return s;
      return {
        ...s,
        pumpRunning: true,
        pumpRpm: p.rpm,
        activeProgram: { id: p.id, name: p.name, rpm: p.rpm, endsAt: Date.now() + p.minutes * 60000 },
      };
    });

  const stopProgram = () =>
    setState((s) => ({ ...s, activeProgram: null, pumpRpm: s.pumpRunning ? POOL_RPM : 0 }));

  const saveProgram = (draft) =>
    setState((s) => {
      const { isNew, ...clean } = draft;
      return {
        ...s,
        programs: isNew
          ? [...s.programs, clean]
          : s.programs.map((p) => (p.id === clean.id ? clean : p)),
      };
    });

  /* Editing or deleting a running program stops it first: leaving the pump
     running under a name that no longer exists is worse than interrupting. */
  const deleteProgram = (id) =>
    setState((s) => ({
      ...s,
      programs: s.programs.filter((p) => p.id !== id),
      activeProgram: s.activeProgram?.id === id ? null : s.activeProgram,
      pumpRpm: s.activeProgram?.id === id ? POOL_RPM : s.pumpRpm,
    }));

  /**
   * Give a program a circuit.
   *
   * The supervisor creates one in njsPC and is told the id; here the id is
   * made up. What is faithful is the shape of the flow — a program starts
   * unbound, cannot run, and becomes runnable once bound.
   */
  const bindProgram = (id) =>
    setState((s) => {
      const target = s.programs.find((p) => p.id === id);
      if (!target || target.circuit != null) return s;
      const next = Math.max(6, ...s.programs.map((p) => p.circuit ?? 0)) + 1;
      return {
        ...s,
        programs: s.programs.map((p) => (p.id === id ? { ...p, circuit: next } : p)),
        pumpLimits: { ...s.pumpLimits, used: s.pumpLimits.used + 1 },
      };
    });

  /* Schedules. Live these are njsPC's and the supervisor writes through;
     here they are plain state so the screen works with no backend. */
  const saveSchedule = (draft) =>
    setState((s) => {
      const { isNew, ...clean } = draft;
      const named = {
        ...clean,
        circuitName: s.pumpCircuits.find((c) => c.circuit === clean.circuit)?.name ?? null,
        rpm: s.pumpCircuits.find((c) => c.circuit === clean.circuit)?.rpm ?? null,
      };
      return {
        ...s,
        schedules: isNew
          ? [...s.schedules, { ...named, id: Math.max(0, ...s.schedules.map((x) => x.id)) + 1 }]
          : s.schedules.map((x) => (x.id === named.id ? named : x)),
      };
    });

  const deleteSchedule = (id) =>
    setState((s) => ({ ...s, schedules: s.schedules.filter((x) => x.id !== id) }));

  const setScheduleEnabled = (id, on) =>
    setState((s) => ({
      ...s,
      schedules: s.schedules.map((x) => (x.id === id ? { ...x, enabled: on } : x)),
    }));

  /** Push the spa auto-revert out by another full timeout from now. */
  const extendSpa = () =>
    setState((s) =>
      s.mode === "spa"
        ? { ...s, spaExpiresAt: Date.now() + SPA_TIMEOUT_MIN * 60000 }
        : s);

  /**
   * Schedule the spa to be ready at a wall-clock time.
   *
   * Works backwards: warm-up at SPA_HEAT_RATE from the current water temp to
   * the spa target, plus the transition itself. Both inputs are estimates —
   * the rate especially — so this is a best effort, not a promise, and the
   * UI says so.
   */
  const schedulePreheat = (readyAt) => {
    setState((s) => {
      const rise = Math.max(0, s.targets.spa - s.waterTemp);
      const warmMs = (rise / SPA_HEAT_RATE) * 3600 * 1000;
      const transitionMs = 3 * 60 * 1000;
      return { ...s, preheat: { readyAt, startsAt: readyAt - warmMs - transitionMs } };
    });
  };

  const cancelPreheat = () => setState((s) => ({ ...s, preheat: null }));

  /** Mock only: pretend the transport dropped, so the offline path is real. */
  const simulateOutage = () => {
    outage.current = !outage.current;
    setState((s) => ({ ...s, connected: !outage.current }));
  };

  /* `next` may be a value or an updater. Steppers must pass an updater:
     tapping faster than React re-renders would otherwise compute every tap
     from the same stale degree and lose all but one of them. */
  const setTarget = (body, next) => {
    setState((s) => {
      const raw = typeof next === "function" ? next(s.targets[body]) : next;
      const clamped = Math.min(HEATER_CAP[body], Math.max(TARGET_MIN[body], raw));
      return {
        ...s,
        targets: { ...s.targets, [body]: clamped },
        /* A live call follows its target, so the readout, the cutoff and the
           estimate never disagree with the stepper. */
        setpoint: s.heaterCall === body ? clamped : s.setpoint,
      };
    });
  };

  /** Relative form, matching the live transport. */
  const adjustTarget = (body, delta) => setTarget(body, (v) => v + delta);

  /* The spa is always full, so the blower is never unsafe here. It is
     gated to spa mode as a preference: jets while spilling just dump heat
     and noise into the pool. Relax if you disagree — and drop the matching
     invariant in sequences.js with it. */
  const toggle = (key) =>
    setState((s) => {
      /* Refuse to turn the blower ON outside spa mode, never to turn it
         off — otherwise a blower left running becomes unreachable. */
      if (key === "blower" && !s.blower && s.valves.intake !== "spa") return s;
      return { ...s, [key]: !s[key] };
    });

  /**
   * Heartbeat. Stands in for the transport's state stream: while it ticks the
   * client is live, and when it stops the UI must say so rather than showing
   * stale numbers under a LIVE badge.
   */
  useEffect(() => {
    const t = setInterval(() => {
      /* An outage means no beat arrives. `lastSeen` therefore stops advancing,
         which is exactly what the real failure looks like. */
      if (outage.current) return;

      const now = Date.now();
      const cur = stateRef.current;

      /* Spa auto-revert. Fires only when nothing else is running, so it can
         never interleave with a transition already in flight. */
      if (cur.mode === "spa" && !cur.activeSequence
          && cur.spaExpiresAt && now >= cur.spaExpiresAt) {
        runRef.current?.("pool", { mode: "pool" });
        return;
      }

      /* Scheduled preheat reaching its computed start. */
      if (cur.preheat && !cur.activeSequence && cur.mode !== "spa"
          && now >= cur.preheat.startsAt) {
        runRef.current?.("spa", { mode: "spa" });
        return;
      }

      setState((s) => {
        const beat = { lastSeen: now, connected: true };
        if (s.heaterCall === "off") return { ...s, ...beat };
        const base = s;
        compressorAt.current = now;
        /* Compressed for the mock. The blower figure is near zero because
           blower and heater roughly cancel — see PRD §Thermal reality. */
        const rate = base.blower ? 0.004 : 0.09;
        return {
          ...base, ...beat,
          waterTemp: Math.min(base.waterTemp + rate, base.setpoint ?? base.targets.spa),
        };
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return {
    state, setMode, setRpm, setTarget, adjustTarget, setPoolHeat, toggle,
    setPumpRunning, setPanelMode, startProgram, stopProgram, saveProgram, deleteProgram,
    bindProgram, saveSchedule, deleteSchedule, setScheduleEnabled,
    extendSpa, schedulePreheat, cancelPreheat, simulateOutage,
    /* So the connection badge can say MOCK rather than LIVE. The transport
       really is up — it is this file — but "LIVE" on a page of invented
       readings claims something about equipment, and the demo build is
       published where strangers see it. The live hook does not set this. */
    mock: true,
    /* The mock never refuses anything, but App renders the same Toast either
       way rather than caring which hook it was handed. */
    problem: null, dismissProblem: () => {},
  };
}
