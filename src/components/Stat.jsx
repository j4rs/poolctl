import React from "react";
import { C, FONT_DATA } from "../theme";

export default function Stat({ label, value, unit, tone }) {
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
          color: tone || C.stone,
          lineHeight: 1,
          whiteSpace: "nowrap",
        }}
      >
        {value}
        {unit && <span style={{ fontSize: 12, color: C.muted, marginLeft: 2 }}>{unit}</span>}
      </div>
    </div>
  );
}
