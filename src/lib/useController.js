import { useState, useEffect, useRef } from "react";
import {
  SEQUENCES, isSkipped, POOL_RPM, SPA_RPM, VALVE_RPM,
  HEATER_MIN_RPM, HEATER_CAP, TARGET_MIN,
} from "./sequences";

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
    poolHeatDemand: false,
    blower: false,
    light: false,
    saltPpm: 3150,
    cellOutput: 45,
    connected: true,
  });

  const timer = useRef(null);
  /* Last moment the compressor was running, for the conditional purge.
     Null means it has not run since the app loaded — the common case, and
     the one where "Spa now" skips the purge entirely. */
  const compressorAt = useRef(null);

  /**
   * Run a named sequence. `mode` is the mode to land in, if this sequence
   * changes mode at all; `seed` patches state before the first step.
   */
  const runSequence = (name, { mode: landing = null, seed = {} } = {}) => {
    const steps = SEQUENCES[name];
    const sim = {
      valves: { ...state.valves },
      pumpRpm: state.pumpRpm,
      poolHeatDemand: state.poolHeatDemand,
      targets: { ...state.targets },
      ...seed,
    };
    let i = 0;

    const advance = () => {
      if (i >= steps.length) {
        setState((s) => ({
          ...s,
          ...(landing ? { mode: landing } : {}),
          target: null, activeSequence: null, step: null, stepIndex: 0,
        }));
        return;
      }

      const step = steps[i];
      const skipped = isSkipped(step, {
        ...sim,
        compressorIdleMin: compressorAt.current == null
          ? Infinity
          : (Date.now() - compressorAt.current) / 60000,
      });
      const patch = skipped ? {} : applyStep(step.id, sim);

      setState((s) => ({
        ...s, ...seed, ...patch,
        target: landing, activeSequence: name, step, stepIndex: i,
      }));

      i += 1;
      /* Skipped steps still occupy their index so the rendered step list
         stays aligned with SEQUENCES; they just cost no time. */
      timer.current = setTimeout(advance, skipped ? 0 : step.ms);
    };

    advance();
  };

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

  const setRpm = (rpm) => setState((s) => ({ ...s, pumpRpm: rpm }));

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

  /* The spa is always full, so the blower is never unsafe here. It is
     gated to spa mode as a preference: jets while spilling just dump heat
     and noise into the pool. Relax if you disagree — and drop the matching
     invariant in sequences.js with it. */
  const toggle = (key) =>
    setState((s) => {
      if (key === "blower" && s.valves.intake !== "spa") return s;
      return { ...s, [key]: !s[key] };
    });

  useEffect(() => {
    const t = setInterval(() => {
      setState((s) => {
        if (s.heaterCall === "off") return s;
        compressorAt.current = Date.now();
        /* Compressed for the mock. The blower figure is near zero because
           blower and heater roughly cancel — see PRD §Thermal reality. */
        const rate = s.blower ? 0.004 : 0.09;
        return { ...s, waterTemp: Math.min(s.waterTemp + rate, s.setpoint ?? s.targets.spa) };
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return { state, setMode, setRpm, setTarget, setPoolHeat, toggle };
}
