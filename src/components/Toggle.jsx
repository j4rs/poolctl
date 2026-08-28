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
 *
 * The height is fixed at two lines' worth whether or not there is a second
 * line. Sizing to content made the control ~18 px shorter whenever it had
 * nothing to say, so a reason arriving or a confirmation arming resized the
 * button under the thumb — and these sit in a stretch row, so one growing
 * dragged its neighbour with it and shifted everything below. A control that
 * moves while you are aiming at it is the same class of problem as one that
 * reads as switched before it is.
 *
 * Reserved rather than always-rendered so a lone label still sits in the
 * middle of its box: an empty second line would hold the space but push the
 * label off centre.
 */

/*
 * Two lines: 14+14 padding, 2 border, 15.6 label (13 x 1.2), 4 gap, 13.65
 * second line (10.5 x 1.3). Both line heights are set explicitly below so
 * this arithmetic stays true; `minHeight` rather than `height` so a reason
 * that wraps on a narrow phone can still take the room it needs.
 */
const TWO_LINES = 63.25;

export default function Toggle({ label, on, disabled, reason, armed, confirmLabel, onClick }) {
  const showReason = Boolean(disabled && reason);
  const prompt = armed && !disabled ? (confirmLabel ?? "Tap again to confirm") : null;
  const second = prompt ?? (showReason ? reason : null);
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
        minHeight: TWO_LINES,
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
      <span style={{ lineHeight: 1.2 }}>{label}</span>
      {/* `aria-hidden`: the reason and the prompt are already in the
          accessible name, and reading them twice is worse than not at all. */}
      {second && (
        <span aria-hidden="true" style={{
          fontSize: 10.5, fontWeight: 400, lineHeight: 1.3,
          color: prompt ? C.heat : C.faint,
        }}>
          {second}
        </span>
      )}
    </button>
  );
}
