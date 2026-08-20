import React from "react";
import { C, FONT_UI, FONT_DATA } from "../theme";
import { SEQUENCES, MODES, SPA_HEAT_RATE } from "../lib/sequences";
import Schematic from "../components/Schematic";
import Stat from "../components/Stat";
import Toggle from "../components/Toggle";

export default function PoolSpaControl({ controller, onOpenHeat }) {
  const { state, setMode, toggle } = controller;
  const {
    mode, target, activeSequence, stepIndex, valves, pumpRpm, waterTemp, targets,
    setpoint, heaterCall, blower, light, saltPpm, cellOutput, connected,
  } = state;

  const busy = Boolean(activeSequence);
  const steps = activeSequence ? SEQUENCES[activeSequence] : [];
  /* No estimate while the blower runs: blower and heater roughly cancel, so
     any figure would be an artefact of dividing by nearly zero. PR-4 asks
     only that the copy say so. */
  const minsToSetpoint =
    heaterCall === "spa" && setpoint && !blower
      ? Math.max(0, Math.round(((setpoint - waterTemp) / SPA_HEAT_RATE) * 60))
      : null;

  return (
    <div style={{ padding: "20px 16px 32px", fontFamily: FONT_UI, color: C.stone }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 22 }}>
        <div>
          {/* Keyed off `target`, not `busy`: a heat sequence runs without
              changing mode, and there is no mode to name for it. */}
          <div style={{ fontSize: 11, letterSpacing: 2, color: C.muted, fontFamily: FONT_DATA, textTransform: "uppercase" }}>
            {target ? "Changing to" : "Mode"}
          </div>
          <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: -0.5, lineHeight: 1.2 }}>
            {MODES.find((m) => m.id === (target || mode)).label}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: FONT_DATA, fontSize: 10, color: connected ? C.water : C.alert, letterSpacing: 1 }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: connected ? C.water : C.alert }} />
          {connected ? "LIVE" : "OFFLINE"}
        </div>
      </div>

      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: "18px 12px", marginBottom: 14 }}>
        <Schematic valves={valves} onHeaterTap={onOpenHeat} />
      </div>

      {busy && (
        <div style={{ background: C.surface, border: `1px solid ${C.waterDim}`, borderRadius: 12, padding: 14, marginBottom: 14 }}>
          {steps.map((s, i) => {
            const done = i < stepIndex;
            const now = i === stepIndex;
            return (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0", opacity: done ? 0.4 : now ? 1 : 0.3 }}>
                <span style={{ width: 7, height: 7, borderRadius: 4, flexShrink: 0, background: done ? C.waterDim : now ? C.water : "transparent", border: `1px solid ${done || now ? "transparent" : C.line}` }} />
                <span style={{ fontSize: 13, flex: 1 }}>{s.label}</span>
                <span style={{ fontFamily: FONT_DATA, fontSize: 11, color: C.muted }}>{s.real}</span>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {MODES.map((m) => {
          const active = mode === m.id && !busy;
          return (
            <button key={m.id} onClick={() => setMode(m.id)} disabled={busy || mode === m.id}
              style={{
                flex: 1, padding: "16px 6px", borderRadius: 12,
                border: `1px solid ${active ? C.water : C.line}`,
                background: active ? C.water : "transparent",
                color: active ? C.ground : busy ? C.faint : C.stone,
                fontFamily: FONT_UI, fontSize: 14, fontWeight: 600,
                cursor: busy || mode === m.id ? "default" : "pointer",
                transition: "all 200ms ease",
              }}>
              {m.label}
            </button>
          );
        })}
      </div>

      {/* Preheat needs a scheduled trigger and a heat-time estimate, so it
          cannot exist until the server sequencer does. Disabled and labelled
          rather than left as a button that silently does nothing. */}
      {mode !== "spa" && !busy && (
        <button disabled
          style={{ width: "100%", padding: 13, marginBottom: 16, borderRadius: 10, border: `1px dashed ${C.line}`, background: "transparent", color: C.muted, fontFamily: FONT_UI, fontSize: 13, cursor: "not-allowed", opacity: 0.7, display: "block" }}>
          Have the spa ready at a set time
          <span style={{ display: "block", fontSize: 10.5, color: C.faint, marginTop: 4 }}>
            Not built yet — needs the sequencer
          </span>
        </button>
      )}

      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16, display: "flex", gap: 12, marginBottom: 10 }}>
        <Stat label="Water" value={waterTemp.toFixed(1)} unit="°F" tone={heaterCall !== "off" ? C.heat : C.stone} />
        <Stat label="Target" value={setpoint ?? "—"} unit={setpoint ? "°F" : ""} />
        <Stat label="Pump" value={pumpRpm} unit="rpm" />
      </div>

      {/* Heater section. Tapping opens the lean heat screen; the subtitle
          carries enough state that most of the time you never need to. */}
      <button onClick={onOpenHeat} aria-label="Heater settings"
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 12,
          background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14,
          padding: "14px 16px", marginBottom: 10, cursor: "pointer", textAlign: "left",
        }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: FONT_UI, fontSize: 13.5, fontWeight: 500, color: C.stone }}>
            Heater
          </div>
          <div style={{ fontFamily: FONT_DATA, fontSize: 10.5, color: heaterCall !== "off" ? C.heat : C.muted, marginTop: 3 }}>
            {heaterCall !== "off"
              ? `Calling for ${heaterCall} · ${setpoint}°F`
              : valves.bypass === "around"
                ? "Isolated · bypass around heater"
                : "Idle · flow through heater"}
          </div>
        </div>
        <div style={{ fontFamily: FONT_DATA, fontSize: 18, color: C.stone }}>
          {targets[mode]}<span style={{ fontSize: 11, color: C.muted, marginLeft: 1 }}>°F</span>
        </div>
        <span style={{ color: C.muted, fontSize: 18, lineHeight: 1 }}>›</span>
      </button>

      {heaterCall === "spa" && (blower || minsToSetpoint > 0) && (
        <div style={{ fontSize: 12.5, color: blower ? C.heat : C.muted, marginBottom: 16, paddingLeft: 2, lineHeight: 1.5 }}>
          {blower
            ? `Blower is running — it takes back about as much heat as the heater adds, so the water will hold rather than climb.`
            : `About ${minsToSetpoint} min to ${setpoint}°F.`}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <Toggle label="Blower" on={blower} disabled={valves.intake !== "spa"}
          reason="Available in spa mode" onClick={() => toggle("blower")} />
        <Toggle label="Light" on={light} onClick={() => toggle("light")} />
      </div>

      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16, display: "flex", gap: 12 }}>
        <Stat label="Salt" value={saltPpm} unit="ppm" />
        <Stat label="Cell output" value={mode === "spa" ? 0 : cellOutput} unit="%" tone={mode === "spa" ? C.muted : C.stone} />
        <Stat label="Spill" value={valves.returns === "split" ? "On" : "Off"} tone={valves.returns === "split" ? C.water : C.muted} />
      </div>
    </div>
  );
}
