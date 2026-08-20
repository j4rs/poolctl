import React from "react";
import { C, FONT_UI, FONT_DATA } from "../theme";

/**
 * Water path schematic.
 *
 * Pool mode: returns split between pool and spa, spa spills back to pool.
 * Spa mode:  returns fully to spa, intake on spa drain, pool isolated.
 *
 * The spa always has flow in pool mode, which is why it never goes dark.
 */
export default function Schematic({ valves }) {
  const returnsSplit = valves.returns === "split";
  const poolReturn = returnsSplit;
  const spaIntake = valves.intake === "spa";

  const rail = (active) => ({
    fill: "none",
    stroke: active ? C.water : C.line,
    strokeWidth: active ? 2.5 : 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    strokeDasharray: active ? "7 7" : "none",
    opacity: active ? 1 : 0.5,
    animation: active ? "flow 1.1s linear infinite" : "none",
  });

  const bodyStyle = (active) => ({
    fill: active ? "rgba(79,191,180,0.10)" : "transparent",
    stroke: active ? C.water : C.line,
    strokeWidth: 1.5,
  });

  return (
    <svg viewBox="0 0 340 208" style={{ width: "100%", display: "block" }} role="img"
      aria-label="Water path between equipment pad, spa and pool">
      <style>{`@keyframes flow { to { stroke-dashoffset: -28; } }
        @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }`}</style>

      <path d="M96,92 H176 V54 H236" style={rail(true)} />
      <path d="M96,92 H176 V154 H236" style={rail(poolReturn)} />
      <path d="M236,68 H196 V120 H96" style={rail(spaIntake)} />
      <path d="M236,168 H196 V120 H96" style={rail(!spaIntake)} />

      {returnsSplit && (
        <g>
          <path
            d="M278,80 V118"
            style={{
              fill: "none",
              stroke: C.water,
              strokeWidth: 2,
              strokeDasharray: "4 5",
              animation: "flow 0.8s linear infinite",
            }}
          />
          <path d="M273,112 L278,120 L283,112" fill="none" stroke={C.water}
            strokeWidth={2} strokeLinecap="round" />
        </g>
      )}

      <rect x="16" y="76" width="80" height="60" rx="8" fill={C.surfaceUp} stroke={C.line} />
      <text x="56" y="98" textAnchor="middle" fill={C.muted} fontFamily={FONT_DATA} fontSize="8" letterSpacing="1">PUMP</text>
      <text x="56" y="112" textAnchor="middle" fill={C.muted} fontFamily={FONT_DATA} fontSize="8" letterSpacing="1">FILTER</text>
      <text x="56" y="126" textAnchor="middle" fill={valves.bypass === "flow" ? C.heat : C.faint}
        fontFamily={FONT_DATA} fontSize="8" letterSpacing="1">HEATER</text>

      <circle cx="176" cy="92" r="5" fill={C.ground} stroke={C.water} strokeWidth="1.5" />
      <circle cx="196" cy="120" r="5" fill={C.ground} stroke={C.water} strokeWidth="1.5" />

      <rect x="236" y="30" width="84" height="50" rx="8" style={bodyStyle(true)} />
      <text x="278" y="60" textAnchor="middle" fill={C.water} fontFamily={FONT_UI}
        fontSize="13" fontWeight="500" letterSpacing="2">SPA</text>

      <rect x="236" y="126" width="84" height="58" rx="8" style={bodyStyle(poolReturn || !spaIntake)} />
      <text x="278" y="160" textAnchor="middle" fill={poolReturn || !spaIntake ? C.water : C.faint}
        fontFamily={FONT_UI} fontSize="13" fontWeight="500" letterSpacing="2">POOL</text>
    </svg>
  );
}
