import React from "react";
import { C, FONT_UI, FONT_DATA } from "../theme";
import { SEQUENCES, MODES } from "../lib/sequences";
import Schematic from "../components/Schematic";
import Stat from "../components/Stat";
import Toggle from "../components/Toggle";

export default function PoolSpaControl({ controller }) {
  const { state, setMode, toggle } = controller;
  const {
    mode, target, stepIndex, valves, pumpRpm, waterTemp,
    setpoint, heaterCall, blower, light, saltPpm, cellOutput, connected,
  } = state;

  const busy = Boolean(target);
  const steps = target ? SEQUENCES[target] : [];
  const minsToSetpoint =
    heaterCall === "spa" && setpoint
      ? Math.max(0, Math.round(((setpoint - waterTemp) / (blower ? 1.2 : 5.4)) * 60))
      : null;

  return (
    <div style={{ padding: "20px 16px 32px", fontFamily: FONT_UI, color: C.stone }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 22 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 2, color: C.muted, fontFamily: FONT_DATA, textTransform: "uppercase" }}>
            {busy ? "Changing to" : "Mode"}
          </div>
          <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: -0.5, lineHeight: 1.2 }}>
            {MODES.find((m) => m.id === (busy ? target : mode)).label}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: FONT_DATA, fontSize: 10, color: connected ? C.water : C.alert, letterSpacing: 1 }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: connected ? C.water : C.alert }} />
          {connected ? "LIVE" : "OFFLINE"}
        </div>
      </div>

      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: "18px 12px", marginBottom: 14 }}>
        <Schematic valves={valves} />
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

      {mode !== "spa" && !busy && (
        <button style={{ width: "100%", padding: 13, marginBottom: 16, borderRadius: 10, border: `1px dashed ${C.line}`, background: "transparent", color: C.muted, fontFamily: FONT_UI, fontSize: 13, cursor: "pointer" }}>
          Have the spa ready at a set time
        </button>
      )}

      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16, display: "flex", gap: 12, marginBottom: 10 }}>
        <Stat label="Water" value={waterTemp.toFixed(1)} unit="°F" tone={heaterCall !== "off" ? C.heat : C.stone} />
        <Stat label="Target" value={setpoint ?? "—"} unit={setpoint ? "°F" : ""} />
        <Stat label="Pump" value={pumpRpm} unit="rpm" />
      </div>

      {heaterCall === "spa" && minsToSetpoint > 0 && (
        <div style={{ fontSize: 12.5, color: blower ? C.heat : C.muted, marginBottom: 16, paddingLeft: 2, lineHeight: 1.5 }}>
          {blower
            ? `Blower is running — heating has nearly stalled. About ${minsToSetpoint} min to ${setpoint}°F.`
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
