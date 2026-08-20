import React from "react";
import { C, FONT_UI } from "../theme";

export default function Toggle({ label, on, disabled, reason, onClick }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={disabled ? reason : undefined}
      aria-pressed={on}
      style={{
        flex: 1,
        padding: "14px 8px",
        borderRadius: 10,
        border: `1px solid ${on ? C.water : C.line}`,
        background: on ? "rgba(79,191,180,0.12)" : "transparent",
        color: disabled ? C.faint : on ? C.water : C.stone,
        fontFamily: FONT_UI,
        fontSize: 13,
        fontWeight: 500,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        transition: "all 160ms ease",
      }}
    >
      {label}
    </button>
  );
}
