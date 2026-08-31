import React from "react";
import { C, FONT_UI, FONT_DATA } from "../theme";
import { SEQUENCES, SPA_HEAT_RATE } from "../lib/sequences";
import TargetTemp from "../components/TargetTemp";
import Toggle from "../components/Toggle";
import { useConfirm } from "../lib/useConfirm";

/**
 * Heat control. Reached by tapping the heater on the Water screen.
 *
 * Deliberately lean: one job, no tab bar, no schematic. Everything here is
 * about what temperature the controller stops calling for heat at, and what
 * is standing between a target and the water right now.
 */
export default function HeatControl({ controller, onBack }) {
  const { state, adjustTarget, setPoolHeat, setHeaterSetpoint } = controller;
  /* Calling for heat starts a heat pump that will run for hours, and ending
     a call mid-cycle is its own event. Both ask twice. */
  const confirm = useConfirm();
  const {
    waterTemp, setpoint, heaterCall, targets, blower, valves, mode,
    poolHeatDemand, activeSequence, stepIndex,
  } = state;

  const calling = heaterCall !== "off";
  /* Why the heater stopped, when it was the target that stopped it. Without
     this, a call ending exactly as designed looks identical to one that
     failed — and this is the only visible evidence that a target is a cutoff
     rather than a number in a box. */
  const cutoff = state.lastCutoff;
  const isolated = valves.bypass === "around";
  const busy = Boolean(activeSequence);
  const heatSeq = activeSequence === "heatEngage" || activeSequence === "heatRelease";
  const minsToSetpoint =
    heaterCall === "spa" && setpoint && waterTemp != null && !blower
      ? Math.max(0, Math.round(((setpoint - waterTemp) / SPA_HEAT_RATE) * 60))
      : null;

  return (
    <div style={{ padding: "20px 16px 32px", fontFamily: FONT_UI, color: C.stone, minHeight: "100vh" }}>
      <button onClick={onBack} aria-label="Back"
        style={{
          display: "flex", alignItems: "center", gap: 6, marginBottom: 20,
          background: "transparent", border: "none", padding: "6px 4px",
          color: C.water, fontFamily: FONT_UI, fontSize: 14, cursor: "pointer",
        }}>
        <span style={{ fontSize: 18, lineHeight: 1 }}>‹</span> Back
      </button>

      <div style={{ marginBottom: 22 }}>
        <div style={{ fontSize: 11, letterSpacing: 2, color: C.muted, fontFamily: FONT_DATA, textTransform: "uppercase" }}>
          Heater
        </div>
        <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: -0.5, lineHeight: 1.2 }}>
          {calling ? `Heating ${heaterCall}` : isolated ? "Isolated" : "Idle"}
        </div>
      </div>

      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16, marginBottom: 10 }}>
        <div style={{ fontFamily: FONT_DATA, fontSize: 10, letterSpacing: 1.2, color: C.muted, textTransform: "uppercase", marginBottom: 6 }}>
          Water now
        </div>
        <div style={{ fontFamily: FONT_DATA, fontSize: 38, fontWeight: 500, lineHeight: 1, color: calling ? C.heat : C.stone }}>
          {waterTemp == null ? "—" : waterTemp.toFixed(1)}<span style={{ fontSize: 15, color: C.muted, marginLeft: 3 }}>°F</span>
        </div>
        {calling && minsToSetpoint > 0 && (
          <div style={{ fontSize: 12.5, color: C.muted, marginTop: 12, lineHeight: 1.5 }}>
            About {minsToSetpoint} min to {setpoint}°F.
          </div>
        )}
        {calling && blower && (
          <div style={{ fontSize: 12.5, color: C.heat, marginTop: 12, lineHeight: 1.5 }}>
            Blower is running — it takes back about as much heat as the heater
            adds, so the water will hold rather than climb.
          </div>
        )}
      </div>

      {cutoff && !poolHeatDemand && (
        <div style={{
          background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12,
          padding: "11px 14px", marginBottom: 10,
        }}>
          <div style={{ fontSize: 13, color: C.stone }}>
            Heat stopped at your {cutoff.target}°F cutoff
          </div>
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 3, lineHeight: 1.45 }}>
            The water reached {Math.round(cutoff.temp)}°F. The heater keeps its
            own thermostat regardless — this target can only end a call early.
          </div>
        </div>
      )}

      {/* Pool heat. Spa mode owns the heater, so this refuses there rather
          than competing with the spa call. */}
      <div style={{ display: "flex", marginBottom: 10 }}>
        <Toggle
          label={poolHeatDemand ? "Pool heat is on" : "Heat the pool"}
          on={poolHeatDemand}
          disabled={mode === "spa" || busy}
          reason={
            mode === "spa" ? "Spa mode owns the heater"
              : busy ? "Sequence in progress"
              : undefined
          }
          armed={confirm.isArmed("poolHeat")}
          confirmLabel={poolHeatDemand ? "Tap again to stop heating" : "Tap again to start heating"}
          onClick={confirm.guard("poolHeat", () => setPoolHeat(!poolHeatDemand))} />
      </div>

      {heatSeq && (
        <div style={{ background: C.surface, border: `1px solid ${C.waterDim}`, borderRadius: 12, padding: 14, marginBottom: 10 }}>
          {SEQUENCES[activeSequence].map((s, i) => {
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

      <TargetTemp targets={targets} activeCall={heaterCall} onAdjust={adjustTarget}
        heaterSetpoint={state.heaterSetpoint} onSetSetpoint={setHeaterSetpoint} />

      {/* Why a pool target may look inert: in pool mode the bypass routes
          flow around the exchanger, so nothing happens until heat is called
          and the valve swings back. */}
      {isolated && (
        <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.6, padding: "4px 2px" }}>
          The bypass currently routes water around the heater, so the
          {mode === "pool" ? " pool " : " "}target has no effect yet. Calling
          for heat opens the valve first — about 45 sec, plus a purge if the
          compressor has run recently.
        </div>
      )}
    </div>
  );
}
