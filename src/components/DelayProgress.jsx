import React from "react";
import { C, FONT_UI, FONT_DATA } from "../theme";

/**
 * What the equipment is waiting on, while it waits.
 *
 * Tapping "Spa" and watching nothing happen for twenty seconds is the worst
 * moment in this UI: the valves are moving, the pump is deliberately off, and
 * the screen looks broken. This is the feedback for that window.
 *
 * Everything shown comes from njsPC's own delay object — its message, its
 * `startTime`, its `endTime`, and a duration taken from its configured
 * `valveDelayTime`. Nothing here is dead-reckoned.
 *
 * That distinction is the whole design. The obvious alternative was to
 * replay `sequences.js` step by step, which is what the mock does and what
 * this screen used to show. Every duration in that file is invented, and a
 * confident progress bar over an invented duration is worse than no bar: it
 * looks measured, and the first thing it teaches you is to distrust it when
 * the valve is still moving at 100%.
 *
 * So the steps stay in the mock, where they illustrate, and the live screen
 * shows the one clock that is real.
 */
export default function DelayProgress({ delays, now = Date.now() }) {
  const active = (delays ?? []).filter((d) => d.endsAt == null || d.endsAt > now);
  if (active.length === 0) return null;

  return (
    <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
      {active.map((d) => {
        const span = d.startsAt && d.endsAt ? d.endsAt - d.startsAt : null;
        /* Indeterminate is a real case: njsPC raises delays that carry no
           end time, and inventing one here would be the same mistake at a
           smaller scale. Those get the message and no bar. */
        const pct = span > 0
          ? Math.min(100, Math.max(0, ((now - d.startsAt) / span) * 100))
          : null;
        const left = d.endsAt ? Math.max(0, Math.ceil((d.endsAt - now) / 1000)) : null;

        return (
          <div key={d.type} style={{
            background: C.surface, border: `1px solid ${C.waterDim}`,
            borderRadius: 12, padding: "12px 14px",
          }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: C.stone }}>
                {d.message ?? "Equipment is waiting"}
              </div>
              {left != null && (
                <div style={{ fontFamily: FONT_DATA, fontSize: 12, color: C.water }}>
                  {left}s
                </div>
              )}
            </div>

            {pct != null && (
              <div aria-hidden="true" style={{
                marginTop: 9, height: 4, borderRadius: 2,
                background: C.line, overflow: "hidden",
              }}>
                <div style={{
                  width: `${pct}%`, height: "100%", background: C.water,
                  /* Linear over the tick interval, so a bar redrawn once a
                     second still travels smoothly rather than stepping. */
                  transition: "width 1s linear",
                }} />
              </div>
            )}

            <div style={{
              fontFamily: FONT_UI, fontSize: 10.5, color: C.faint,
              marginTop: 7, lineHeight: 1.4,
            }}>
              njsPC is holding this — the countdown is its own, not an estimate.
            </div>
          </div>
        );
      })}
    </div>
  );
}
