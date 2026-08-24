import React from "react";
import { C, FONT_UI, FONT_DATA } from "../theme";

/**
 * Bottom-sheet chrome, shared by the schedule and program editors.
 *
 * Extracted when the second editor appeared rather than before — two forms
 * with the same modal plumbing is the point at which duplicating it stops
 * being cheaper than naming it.
 */
export function Sheet({ title, label, onCancel, children }) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: 20, background: C.scrim,
        display: "flex", alignItems: "flex-end", justifyContent: "center",
      }}>
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label={label}
        style={{
          width: "100%", maxWidth: 460, maxHeight: "92vh", overflowY: "auto",
          background: C.surface, borderTop: `1px solid ${C.line}`,
          borderRadius: "16px 16px 0 0", padding: "18px 16px",
          paddingBottom: "calc(18px + env(safe-area-inset-bottom))",
          fontFamily: FONT_UI, color: C.stone,
        }}>
        <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 18 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

export function Row({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "baseline",
        marginBottom: 8,
      }}>
        <span style={{ fontFamily: FONT_DATA, fontSize: 10, letterSpacing: 1.2,
          color: C.muted, textTransform: "uppercase" }}>{label}</span>
        {hint && <span style={{ fontSize: 11.5, color: C.faint }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function Action({ label, onClick, primary, tone, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        flex: primary ? 1.4 : 1, padding: "14px 8px", borderRadius: 10,
        border: `1px solid ${primary ? (disabled ? C.line : C.water) : C.line}`,
        background: primary && !disabled ? C.water : "transparent",
        color: primary ? (disabled ? C.faint : C.ground) : tone || C.stone,
        fontFamily: FONT_UI, fontSize: 14, fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}>
      {label}
    </button>
  );
}
