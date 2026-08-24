import React from "react";
import { C, FONT_UI } from "../theme";

/**
 * The reason a control is disabled is rendered, not tucked into a `title`.
 * This is a phone-first UI — there is no hover, so a tooltip would never be
 * seen, and the accessible name became the reason instead of the label.
 *
 * `armed` is the middle of a two-tap confirmation (see `useConfirm`). Note
 * that `aria-pressed` does not move while armed: nothing has happened yet,
 * and a toggle that reads as switched before it has switched is the same lie
 * as one that moves because you touched it.
 */
export default function Toggle({ label, on, disabled, reason, armed, confirmLabel, onClick }) {
  const showReason = Boolean(disabled && reason);
  const prompt = armed && !disabled ? (confirmLabel ?? "Tap again to confirm") : null;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      aria-label={
        showReason ? `${label} — ${reason}`
          : prompt ? `Confirm: ${label}`
          : label
      }
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        padding: "14px 8px",
        borderRadius: 10,
        border: `1px solid ${prompt ? C.heat : on ? C.water : C.line}`,
        background: on ? C.wash : "transparent",
        color: disabled ? C.muted : prompt ? C.heat : on ? C.water : C.stone,
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
      {prompt && (
        <span style={{ fontSize: 10.5, fontWeight: 400, color: C.heat, lineHeight: 1.3 }}>
          {prompt}
        </span>
      )}
    </button>
  );
}
