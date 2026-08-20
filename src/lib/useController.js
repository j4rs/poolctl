import { useState, useEffect, useRef } from "react";
import {
  SEQUENCES, isSkipped, POOL_RPM, SPA_RPM, VALVE_RPM,
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
    case "heater-off":    return { heaterCall: "off", setpoint: null };
    case "blower-off":    return { blower: false };
    case "purge":         return {};
    case "pump-low":      sim.pumpRpm = VALVE_RPM; return { pumpRpm: VALVE_RPM };
    case "pump-spa":      sim.pumpRpm = SPA_RPM;   return { pumpRpm: SPA_RPM };
    case "pump-pool":     sim.pumpRpm = POOL_RPM;  return { pumpRpm: POOL_RPM };
    case "bypass-flow":   sim.valves.bypass = "flow";     return valves();
    case "bypass-around": sim.valves.bypass = "around";   return valves();
    case "intake-spa":    sim.valves.intake = "spa";      return valves();
    case "intake-pool":   sim.valves.intake = "pool";     return valves();
    case "returns-spa":   sim.valves.returns = "spa";     return valves();
    case "returns-split": sim.valves.returns = "split";   return valves();
    case "heat-spa":      return { heaterCall: "spa", setpoint: 102 };
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
 *   - sends intents (setMode, setRpm, toggle) rather than mutating locally
 *
 * The UI never issues equipment primitives. It says setMode('spa'); the
 * server decides what relays that means and enforces every interlock.
 */
export function useController() {
  const [state, setState] = useState({
    mode: "pool",
    target: null,
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

  const setMode = (target) => {
    /* No abort: ABORTABLE is false, so a transition in flight is committed. */
    if (state.target || target === state.mode) return;

    const steps = SEQUENCES[target];
    const sim = {
      valves: { ...state.valves },
      pumpRpm: state.pumpRpm,
      poolHeatDemand: state.poolHeatDemand,
    };
    let i = 0;

    const advance = () => {
      if (i >= steps.length) {
        setState((s) => ({ ...s, mode: target, target: null, step: null, stepIndex: 0 }));
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

      setState((s) => ({ ...s, ...patch, target, step, stepIndex: i }));

      i += 1;
      /* Skipped steps still occupy their index so the rendered step list
         stays aligned with SEQUENCES; they just cost no time. */
      timer.current = setTimeout(advance, skipped ? 0 : step.ms);
    };

    advance();
  };

  const setRpm = (rpm) => setState((s) => ({ ...s, pumpRpm: rpm }));

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
        const rate = s.blower ? 0.02 : 0.09;
        return { ...s, waterTemp: Math.min(s.waterTemp + rate, s.setpoint ?? 102) };
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return { state, setMode, setRpm, toggle };
}
