import React, { useState, useMemo } from "react";
import { C, FONT_UI, FONT_DATA } from "../theme";
import { SPA_HEAT_RATE } from "../lib/sequences";

/** Next occurrence of HH:MM — today if it is still ahead, else tomorrow. */
function nextOccurrence(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setSeconds(0, 0);
  d.setHours(h, m);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

const clock = (ms) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Scheduled preheat.
 *
 * Works backwards from when you want to get in. The arithmetic is openly
 * approximate — `SPA_HEAT_RATE` is unmeasured and the spa volume is an
 * estimate — so the sheet shows its working rather than presenting a
 * confident time. PR-1 stands: "Spa now" is the default and this is the
 * option, not the main path.
 */
export default function PreheatSheet({ waterTemp, targetTemp, onCancel, onConfirm }) {
  const [time, setTime] = useState("19:30");

  const plan = useMemo(() => {
    const readyAt = nextOccurrence(time);
    const rise = Math.max(0, targetTemp - waterTemp);
    const warmMin = (rise / SPA_HEAT_RATE) * 60;
    const transitionMin = 3;
    const startsAt = readyAt - (warmMin + transitionMin) * 60000;
    return { readyAt, rise, warmMin, transitionMin, startsAt, late: startsAt <= Date.now() };
  }, [time, waterTemp, targetTemp]);

  return (
    <div onClick={onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: 20, background: C.scrim,
        display: "flex", alignItems: "flex-end", justifyContent: "center",
      }}>
      <div onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="Schedule spa preheat"
        style={{
          width: "100%", maxWidth: 460, background: C.surface,
          borderTop: `1px solid ${C.line}`, borderRadius: "16px 16px 0 0",
          padding: "18px 16px calc(20px + env(safe-area-inset-bottom))",
          fontFamily: FONT_UI, color: C.stone, boxShadow: C.lift,
        }}>
        <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>Spa ready at</div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 16, lineHeight: 1.5 }}>
          The controller starts early enough to be at temperature when you get in.
        </div>

        <input type="time" value={time} onChange={(e) => setTime(e.target.value)}
          aria-label="Time the spa should be ready"
          style={{
            width: "100%", padding: "14px 12px", borderRadius: 10,
            border: `1px solid ${C.line}`, background: C.ground, color: C.stone,
            fontFamily: FONT_DATA, fontSize: 22, marginBottom: 16,
          }} />

        {/* Show the working. The inputs are estimates and the output should
            not look more certain than they are. */}
        <div style={{
          background: C.ground, border: `1px solid ${C.line}`, borderRadius: 10,
          padding: "12px 14px", marginBottom: 16, fontFamily: FONT_DATA,
          fontSize: 11.5, color: C.muted, lineHeight: 1.7,
        }}>
          <div>water now · {waterTemp.toFixed(1)}°F → target {targetTemp}°F</div>
          <div>rise {plan.rise.toFixed(1)}°F at ~{SPA_HEAT_RATE}°F/hr · {Math.round(plan.warmMin)} min</div>
          <div>transition · {plan.transitionMin} min</div>
          <div style={{ color: C.stone, marginTop: 4 }}>
            starts {clock(plan.startsAt)} · ready {clock(plan.readyAt)}
          </div>
        </div>

        {plan.late && (
          <div style={{ fontSize: 12, color: C.heat, marginBottom: 14, lineHeight: 1.5 }}>
            That start time has already passed — it will begin immediately and
            reach temperature a little late.
          </div>
        )}

        <div style={{ fontSize: 11, color: C.faint, marginBottom: 16, lineHeight: 1.5 }}>
          The heating rate is an estimate and the spa volume has not been
          measured, so treat the time as approximate.
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onCancel}
            style={{
              flex: 1, padding: 13, borderRadius: 10, border: `1px solid ${C.line}`,
              background: "transparent", color: C.muted, fontFamily: FONT_UI,
              fontSize: 14, cursor: "pointer",
            }}>
            Cancel
          </button>
          <button onClick={() => onConfirm(plan.readyAt)}
            style={{
              flex: 2, padding: 13, borderRadius: 10, border: `1px solid ${C.water}`,
              background: C.water, color: C.ground, fontFamily: FONT_UI,
              fontSize: 14, fontWeight: 600, cursor: "pointer",
            }}>
            Schedule
          </button>
        </div>
      </div>
    </div>
  );
}
