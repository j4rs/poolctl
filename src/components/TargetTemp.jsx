import React from "react";
import { C, FONT_UI, FONT_DATA } from "../theme";
import { HEATER_CAP, TARGET_MIN } from "../lib/sequences";

/**
 * The highest target that does anything, and why.
 *
 * Mirrors `supervisor/targets.js`'s `ceilingFor`. The server clamps; this
 * only needs to render the same boundary and name its source, so the stepper
 * never offers a degree the server would refuse.
 */
function ceiling(body, stated) {
  const cap = HEATER_CAP[body];
  if (stated == null) return { value: cap, fromHeater: false };
  const n = Number(stated);
  if (!Number.isFinite(n)) return { value: cap, fromHeater: false };
  return n < cap
    ? { value: Math.max(TARGET_MIN[body], n), fromHeater: true }
    : { value: cap, fromHeater: false };
}

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
export default function TargetTemp({ targets, activeCall, onAdjust, heaterSetpoint, onSetSetpoint }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, marginBottom: 10 }}>
      {BODIES.map((b, i) => {
        const value = targets[b.id];
        const { value: cap, fromHeater } = ceiling(b.id, heaterSetpoint?.[b.id]);
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
                {atCap
                  ? (fromHeater ? `Heater is set to ${cap}°F` : `Heater limit ${cap}°F`)
                  : live ? "Calling for heat"
                  : fromHeater ? `Up to ${cap}°F — the heater's setting` : `Max ${cap}°F`}
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

      {/* What the heater is set to. Not a command — it reaches no equipment
          and moves nothing. It is the one number that decides where the
          steppers above stop meaning anything, and the only way in is a
          person reading the heater's keypad. Unguarded for the same reason
          Set up is: it writes a belief. */}
      {onSetSetpoint && BODIES.map((b) => {
        const stated = heaterSetpoint?.[b.id];
        const cap = HEATER_CAP[b.id];
        return (
          <div key={`sp-${b.id}`} style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "9px 14px", borderTop: `1px solid ${C.line}`,
          }}>
            <div style={{ flex: 1, minWidth: 0, fontFamily: FONT_UI, fontSize: 12, color: C.muted }}>
              {b.label} heater setting
            </div>
            {stated == null ? (
              <button onClick={() => onSetSetpoint(b.id, cap)}
                aria-label={`Record the heater's ${b.label} setting`}
                style={{
                  border: `1px solid ${C.waterDim}`, background: "transparent",
                  color: C.water, borderRadius: 999, padding: "6px 14px",
                  fontFamily: FONT_UI, fontSize: 12, cursor: "pointer",
                }}>
                Not said
              </button>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <Step label="−" ariaLabel={`Lower the ${b.label} heater setting`}
                  disabled={stated <= TARGET_MIN[b.id]}
                  onClick={() => onSetSetpoint(b.id, stated - 1)} small />
                <div style={{
                  fontFamily: FONT_DATA, fontSize: 15, minWidth: 48,
                  textAlign: "center", color: C.stone,
                }}>
                  {stated}<span style={{ fontSize: 10, color: C.muted }}>°F</span>
                </div>
                <Step label="+" ariaLabel={`Raise the ${b.label} heater setting`}
                  disabled={stated >= cap}
                  onClick={() => onSetSetpoint(b.id, stated + 1)} small />
              </div>
            )}
          </div>
        );
      })}

      <div style={{
        padding: "10px 14px 12px", borderTop: `1px solid ${C.line}`,
        fontFamily: FONT_UI, fontSize: 11.5, color: C.faint, lineHeight: 1.5,
      }}>
        The heater keeps its own thermostat and hard caps. These targets stop
        the controller calling for heat sooner — they cannot raise the limit.
        {(heaterSetpoint?.pool == null || heaterSetpoint?.spa == null) && (
          <>
            {" "}
            <strong style={{ color: C.muted, fontWeight: 600 }}>
              Nobody has said what the heater itself is set to
            </strong>
            , so these go up to the firmware caps. Above the heater's own
            setpoint they do nothing, and nothing here can tell.
          </>
        )}
      </div>
    </div>
  );
}

function Step({ label, ariaLabel, disabled, onClick, small }) {
  const d = small ? 32 : 44;
  return (
    <button onClick={onClick} disabled={disabled} aria-label={ariaLabel}
      style={{
        width: d, height: d, borderRadius: d / 2, flexShrink: 0,
        border: `1px solid ${disabled ? C.line : C.waterDim}`,
        background: "transparent",
        color: disabled ? C.faint : C.water,
        fontFamily: FONT_UI, fontSize: small ? 15 : 20, lineHeight: 1,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "all 140ms ease",
      }}>
      {label}
    </button>
  );
}
