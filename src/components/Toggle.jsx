import React from "react";
import { C, FONT_UI } from "../theme";

/**
 * The reason a control is disabled is rendered, not tucked into a `title`.
 * This is a phone-first UI — there is no hover, so a tooltip would never be
 * seen, and the accessible name became the reason instead of the label.
 */
export default function Toggle({ label, on, disabled, reason, onClick }) {
  const showReason = Boolean(disabled && reason);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      aria-label={showReason ? `${label} — ${reason}` : label}
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        padding: "14px 8px",
        borderRadius: 10,
        border: `1px solid ${on ? C.water : C.line}`,
        background: on ? "rgba(79,191,180,0.12)" : "transparent",
        color: disabled ? C.muted : on ? C.water : C.stone,
        fontFamily: FONT_UI,
        fontSize: 13,
        fontWeight: 500,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.7 : 1,
        transition: "all 160ms ease",
      }}
    >
      <span>{label}</span>
      {showReason && (
        <span style={{ fontSize: 10.5, fontWeight: 400, color: C.faint, lineHeight: 1.3 }}>
          {reason}
        </span>
      )}
    </button>
  );
}
