import React, { useEffect } from "react";
import { C, FONT_UI } from "../theme";

/**
 * Transient notice for a refused intent.
 *
 * Sits above everything because it reports that something you asked for did
 * not happen — and the alternative, which this replaces, was a control that
 * absorbed the tap and left no trace. On a controller that is the worst
 * possible outcome: you believe the equipment moved.
 *
 * Auto-dismisses, because a refusal is news rather than a state. It can also
 * be dismissed by hand, and re-keying on `at` restarts the timer so a second
 * refusal is not cut short by the first one's countdown.
 */
export default function Toast({ problem, onDismiss, ms = 7000 }) {
  const at = problem?.at;
  useEffect(() => {
    if (!at) return;
    const t = setTimeout(onDismiss, ms);
    return () => clearTimeout(t);
  }, [at, ms, onDismiss]);

  if (!problem) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 30,
        maxWidth: 460, margin: "0 auto", padding: "10px 12px",
        paddingTop: "calc(10px + env(safe-area-inset-top))",
      }}
    >
      <div style={{
        display: "flex", alignItems: "flex-start", gap: 10,
        background: C.surfaceUp, border: `1px solid ${C.alert}`,
        borderRadius: 12, padding: "11px 12px",
        boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
      }}>
        <span aria-hidden="true" style={{
          width: 7, height: 7, borderRadius: 4, background: C.alert,
          flexShrink: 0, marginTop: 5,
        }} />
        <div style={{
          flex: 1, minWidth: 0, fontFamily: FONT_UI, fontSize: 12.5,
          lineHeight: 1.45, color: C.stone,
        }}>
          <strong style={{ color: C.alert, fontWeight: 600 }}>Not done. </strong>
          {problem.text}
        </div>
        <button onClick={onDismiss} aria-label="Dismiss"
          style={{
            flexShrink: 0, width: 26, height: 26, borderRadius: 13, border: "none",
            background: "transparent", color: C.muted, cursor: "pointer",
            fontSize: 15, lineHeight: 1, padding: 0,
          }}>
          ×
        </button>
      </div>
    </div>
  );
}
