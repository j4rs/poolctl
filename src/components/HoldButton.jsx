import React, { useRef, useState, useEffect, useCallback } from "react";
import { C, FONT_UI } from "../theme";

/**
 * Press-and-hold to confirm.
 *
 * Used for mode changes because the consequence is disproportionate to the
 * gesture: one tap commits ~2 minutes of valve travel that `ABORTABLE = false`
 * means nobody can cancel. A phone in a pocket, or a thumb landing while
 * scrolling, should not be able to start that.
 *
 * Release before the hold completes and nothing happens — deliberately no
 * "cancelled" toast. The absence of the transition is the feedback, and the
 * ring unwinding says it plainly enough.
 *
 * Progress is driven by rAF against wall-clock rather than by counting
 * frames, so a slow frame stretches the animation rather than the timer.
 */
export default function HoldButton({
  label,
  sublabel,
  holdMs = 5000,
  active = false,
  disabled = false,
  onConfirm,
}) {
  const [progress, setProgress] = useState(0);
  const raf = useRef(null);
  const startedAt = useRef(0);
  const held = useRef(false);

  const stop = useCallback(() => {
    held.current = false;
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
    setProgress(0);
  }, []);

  useEffect(() => stop, [stop]);

  const tick = useCallback(() => {
    if (!held.current) return;
    const p = Math.min(1, (performance.now() - startedAt.current) / holdMs);
    setProgress(p);
    if (p >= 1) {
      held.current = false;
      raf.current = null;
      setProgress(0);
      onConfirm?.();
      /* Haptic where it exists. Silently absent on desktop and iOS Safari. */
      navigator.vibrate?.(30);
      return;
    }
    raf.current = requestAnimationFrame(tick);
  }, [holdMs, onConfirm]);

  const start = useCallback(
    (e) => {
      if (disabled || active) return;
      /* Pointer capture keeps the hold alive if the finger drifts slightly,
         which it will on a wet phone at the side of a pool. It throws if the
         pointer is already gone, and a capture failure must never be the
         reason the button stops working — so it is best-effort. */
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        /* no capture; the hold still works, it is just less drift-tolerant */
      }
      held.current = true;
      startedAt.current = performance.now();
      raf.current = requestAnimationFrame(tick);
    },
    [disabled, active, tick],
  );

  const pct = Math.round(progress * 100);
  const holding = progress > 0;

  return (
    <button
      onPointerDown={start}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      disabled={disabled}
      aria-label={
        active ? `${label}, current mode`
          : `Hold to switch to ${label}`
      }
      style={{
        position: "relative",
        flex: 1,
        padding: "16px 8px",
        borderRadius: 12,
        border: `1px solid ${active ? C.water : C.line}`,
        background: active ? C.water : "transparent",
        color: active ? C.ground : C.stone,
        fontFamily: FONT_UI,
        fontSize: 15,
        fontWeight: 600,
        cursor: disabled || active ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
        overflow: "hidden",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        transition: "background 160ms ease, border-color 160ms ease",
      }}
    >
      {/* Fill sweeps left to right as the hold progresses. Sits under the
          label, which is why the label needs its own stacking context. */}
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          width: `${pct}%`,
          background: C.wash,
          borderRight: holding ? `2px solid ${C.water}` : "none",
          transition: "none",
          pointerEvents: "none",
        }}
      />
      <span style={{ position: "relative", display: "block" }}>{label}</span>
      <span
        style={{
          position: "relative",
          display: "block",
          fontSize: 10.5,
          fontWeight: 400,
          marginTop: 3,
          color: active ? C.ground : C.faint,
          opacity: active ? 0.75 : 1,
        }}
      >
        {active ? sublabel ?? "current" : holding ? `keep holding… ${pct}%` : "hold to switch"}
      </span>
    </button>
  );
}
