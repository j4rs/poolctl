import React from "react";
import { C, FONT_UI, FONT_DATA } from "../theme";
import { HEATER_CAP, TARGET_MIN } from "../lib/sequences";

const BODIES = [
  { id: "spa", label: "Spa" },
  { id: "pool", label: "Pool" },
];

/**
 * Target temperature per body.
 *
 * These are NOT the heater's setpoint. The 3-wire interface (ADR-4) carries
 * no temperature — the heater holds its own setpoint and its own hard caps
 * on its board, and the contacts only say "call for heat". These targets
 * tell the controller when to stop calling. They can end a call early; they
 * can never ask for more heat than the heater allows.
 *
 * A stepper rather than a slider: this is a precise value read at arm's
 * length in sunlight, and a degree of drag error matters.
 */
/* `onAdjust(body, delta)` rather than an absolute or an updater: the value is
   owned and clamped by the server, and a relative change is the only form that
   survives both JSON and taps arriving faster than the round trip. */
export default function TargetTemp({ targets, activeCall, onAdjust }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, marginBottom: 10 }}>
      {BODIES.map((b, i) => {
        const value = targets[b.id];
        const cap = HEATER_CAP[b.id];
        const min = TARGET_MIN[b.id];
        const atCap = value >= cap;
        const atMin = value <= min;
        const live = activeCall === b.id;

        return (
          <div key={b.id}
            style={{
              display: "flex", alignItems: "center", gap: 12, padding: "12px 14px",
              borderTop: i === 0 ? "none" : `1px solid ${C.line}`,
            }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: FONT_UI, fontSize: 13.5, fontWeight: 500, color: C.stone }}>
                {b.label} target
              </div>
              <div style={{ fontFamily: FONT_DATA, fontSize: 10.5, color: atCap ? C.heat : C.muted, marginTop: 3 }}>
                {atCap ? `Heater limit ${cap}°F` : live ? "Calling for heat" : `Max ${cap}°F`}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <Step label="−" ariaLabel={`Lower ${b.label} target`}
                disabled={atMin} onClick={() => onAdjust(b.id, -1)} />
              <div style={{
                fontFamily: FONT_DATA, fontSize: 22, fontWeight: 500, minWidth: 62,
                textAlign: "center", color: live ? C.heat : C.stone,
              }}>
                {value}<span style={{ fontSize: 12, color: C.muted, marginLeft: 1 }}>°F</span>
              </div>
              <Step label="+" ariaLabel={`Raise ${b.label} target`}
                disabled={atCap} onClick={() => onAdjust(b.id, +1)} />
            </div>
          </div>
        );
      })}

      <div style={{
        padding: "10px 14px 12px", borderTop: `1px solid ${C.line}`,
        fontFamily: FONT_UI, fontSize: 11.5, color: C.faint, lineHeight: 1.5,
      }}>
        The heater keeps its own thermostat and hard caps. These targets stop
        the controller calling for heat sooner — they cannot raise the limit.
      </div>
    </div>
  );
}

function Step({ label, ariaLabel, disabled, onClick }) {
  return (
    <button onClick={onClick} disabled={disabled} aria-label={ariaLabel}
      style={{
        width: 44, height: 44, borderRadius: 22, flexShrink: 0,
        border: `1px solid ${disabled ? C.line : C.waterDim}`,
        background: "transparent",
        color: disabled ? C.faint : C.water,
        fontFamily: FONT_UI, fontSize: 20, lineHeight: 1,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "all 140ms ease",
      }}>
      {label}
    </button>
  );
}
