import React from "react";
import { C, FONT_DATA } from "../theme";

/**
 * A single readout.
 *
 * `null` or `undefined` means the value is genuinely unknown — no reading from
 * the equipment — and renders as a dimmed em-dash with no unit. That is not
 * the same as zero, and on a controller the difference matters: a pump at
 * 0 rpm is stopped, a pump we cannot hear from might be doing anything.
 */
export default function Stat({ label, value, unit, tone }) {
  const unknown = value === null || value === undefined;
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div
        style={{
          fontFamily: FONT_DATA,
          fontSize: 10,
          letterSpacing: 1.2,
          color: C.muted,
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: FONT_DATA,
          fontSize: 22,
          fontWeight: 500,
          color: unknown ? C.faint : tone || C.stone,
          lineHeight: 1,
          whiteSpace: "nowrap",
        }}
      >
        {unknown ? "—" : value}
        {!unknown && unit && (
          <span style={{ fontSize: 12, color: C.muted, marginLeft: 2 }}>{unit}</span>
        )}
      </div>
    </div>
  );
}
