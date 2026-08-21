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
export default function Schematic({ valves, heaterCall = "off", onHeaterTap }) {
  const returnsSplit = valves.returns === "split";
  const poolReturn = returnsSplit;
  const spaIntake = valves.intake === "spa";
  const throughHeater = valves.bypass === "flow";

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
    fill: active ? C.wash : "transparent",
    stroke: active ? C.water : C.line,
    strokeWidth: 1.5,
  });

  return (
    <svg viewBox="0 0 340 208" style={{ width: "100%", display: "block" }} role="img"
      aria-label="Water path between equipment pad, spa and pool">
      <style>{`@keyframes flow { to { stroke-dashoffset: -28; } }
        @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }`}</style>

      {/* Return side: pump -> heater branch -> return diverter -> bodies.
          The heater is drawn as a real branch rather than a word in the pump
          box, because the bypass is one of the three valves and its position
          is otherwise invisible. Water visibly goes through it or around it. */}
      <path d="M84,92 H104" style={rail(true)} />
      <path d="M104,92 V64 H120" style={rail(throughHeater)} />
      <path d="M180,64 H196 V92" style={rail(throughHeater)} />
      <path d="M104,92 H196" style={rail(!throughHeater)} />
      <path d="M196,92 H214 V54 H236" style={rail(true)} />
      <path d="M196,92 H214 V154 H236" style={rail(poolReturn)} />

      {/* Intake side: bodies -> pump. Runs below, and never sees the heater. */}
      <path d="M236,68 H224 V128 H84" style={rail(spaIntake)} />
      <path d="M236,168 H224 V128 H84" style={rail(!spaIntake)} />

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
          <path d="M273,112 L278,120 L283,112" strokeWidth={2} strokeLinecap="round"
            style={{ fill: "none", stroke: C.water }} />
        </g>
      )}

      {/* Pump and filter are permanently inline and never switch, so they
          share one box. The heater used to sit here too — it moved out to its
          own branch because, unlike these, it can be valved out of the path. */}
      <rect x="16" y="82" width="68" height="56" rx="8" style={{ fill: C.surfaceUp, stroke: C.line }} />
      <text x="50" y="105" textAnchor="middle" style={{ fill: C.muted }} fontFamily={FONT_DATA} fontSize="8" letterSpacing="1">PUMP</text>
      <text x="50" y="119" textAnchor="middle" style={{ fill: C.muted }} fontFamily={FONT_DATA} fontSize="8" letterSpacing="1">FILTER</text>

      {/* Heater, on its own branch. Amber and filled when water is routed
          through it; outlined and dim when the bypass sends water around. */}
      <g onClick={onHeaterTap} role={onHeaterTap ? "button" : undefined}
        tabIndex={onHeaterTap ? 0 : undefined} aria-label="Heater settings"
        style={{ cursor: onHeaterTap ? "pointer" : "default" }}>
        <rect x="120" y="48" width="60" height="32" rx="7"
          style={{
            fill: throughHeater ? "var(--wash)" : "transparent",
            stroke: throughHeater ? C.heat : C.line,
            strokeWidth: 1.5,
            transition: "fill 200ms, stroke 200ms",
          }} />
        <text x="150" y="61" textAnchor="middle" fontFamily={FONT_DATA} fontSize="8" letterSpacing="1"
          style={{ fill: throughHeater ? C.heat : C.faint }}>HEATER</text>
        <text x="150" y="72" textAnchor="middle" fontFamily={FONT_DATA} fontSize="7" letterSpacing="0.5"
          style={{ fill: throughHeater ? C.heat : C.faint, opacity: 0.75 }}>
          {heaterCall !== "off" ? "calling" : throughHeater ? "flow" : "bypassed"}
        </text>
      </g>

      {/* Branch and rejoin points for the bypass. */}
      <circle cx="104" cy="92" r="4" strokeWidth="1.5" style={{ fill: C.ground, stroke: C.water }} />
      <circle cx="196" cy="92" r="4" strokeWidth="1.5" style={{ fill: C.ground, stroke: C.water }} />
      {/* Return diverter, and the intake diverter below it. */}
      <circle cx="214" cy="92" r="5" strokeWidth="1.5" style={{ fill: C.ground, stroke: C.water }} />
      <circle cx="224" cy="128" r="5" strokeWidth="1.5" style={{ fill: C.ground, stroke: C.water }} />

      <rect x="236" y="30" width="84" height="50" rx="8" style={bodyStyle(true)} />
      <text x="278" y="60" textAnchor="middle" fontFamily={FONT_UI}
        fontSize="13" fontWeight="500" letterSpacing="2" style={{ fill: C.water }}>SPA</text>

      <rect x="236" y="126" width="84" height="58" rx="8" style={bodyStyle(poolReturn || !spaIntake)} />
      <text x="278" y="160" textAnchor="middle" fontFamily={FONT_UI} fontSize="13"
        fontWeight="500" letterSpacing="2"
        style={{ fill: poolReturn || !spaIntake ? C.water : C.faint }}>POOL</text>
    </svg>
  );
}
