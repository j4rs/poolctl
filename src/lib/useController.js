import { useState, useEffect, useRef } from "react";
import { SEQUENCES } from "./sequences";

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
    valves: { intake: "pool", returns: "split", bypass: "flow" },
    pumpRpm: 1600,
    waterTemp: 84.2,
    airTemp: 88,
    setpoint: null,
    heaterCall: "off",
    blower: false,
    light: false,
    saltPpm: 3150,
    cellOutput: 45,
    connected: true,
  });

  const timer = useRef(null);

  const setMode = (target) => {
    if (state.target || target === state.mode) return;
    const steps = SEQUENCES[target];
    let i = 0;

    const advance = () => {
      if (i >= steps.length) {
        setState((s) => ({
          ...s,
          mode: target,
          target: null,
          step: null,
          stepIndex: 0,
          heaterCall: target === "spa" ? "spa" : "off",
          setpoint: target === "spa" ? 102 : null,
        }));
        return;
      }
      const step = steps[i];
      setState((s) => {
        const next = { ...s, target, step, stepIndex: i };
        if (step.id === "intake")
          next.valves = { ...s.valves, intake: target === "spa" ? "spa" : "pool" };
        if (step.id === "returns")
          next.valves = { ...s.valves, returns: target === "pool" ? "split" : "spa" };
        if (step.id === "pump-low") next.pumpRpm = 1000;
        if (step.id === "pump-spa") next.pumpRpm = 2800;
        if (step.id === "pump-pool") next.pumpRpm = 1600;
        if (step.id === "heater-off") next.heaterCall = "off";
        return next;
      });
      i += 1;
      timer.current = setTimeout(advance, step.ms);
    };
    advance();
  };

  const setRpm = (rpm) => setState((s) => ({ ...s, pumpRpm: rpm }));

  /* The spa is always full, so the blower is never unsafe here. It is
     gated to spa mode as a preference: jets while spilling just dump heat
     and noise into the pool. Relax if you disagree. */
  const toggle = (key) =>
    setState((s) => {
      if (key === "blower" && s.valves.intake !== "spa") return s;
      return { ...s, [key]: !s[key] };
    });

  useEffect(() => {
    const t = setInterval(() => {
      setState((s) => {
        if (s.heaterCall === "off") return s;
        const rate = s.blower ? 0.02 : 0.09;
        return { ...s, waterTemp: Math.min(s.waterTemp + rate, s.setpoint ?? 102) };
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return { state, setMode, setRpm, toggle };
}
