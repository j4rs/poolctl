import React, { useState, useMemo } from "react";
import { C, FONT_UI, FONT_DATA } from "../theme";
import { useBus } from "../lib/useBus";
import { addrName, hex, fieldLabel, fieldSummary, PROTO } from "../lib/rs485";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "pump", label: "Pump" },
  { id: "chlorinator", label: "Cell" },
  { id: "unknown", label: "Unknown" },
];

const KIND_TONE = {
  pump: C.water,
  chlorinator: C.water,
  other: C.muted,
  bad: C.heat,
  unknown: C.alert,
};

/**
 * RS-485 bus monitor.
 *
 * Built for one job: deciding ADR-6. The number that matters is the decode
 * rate, and specifically whether chlorinator frames are in the decoded half
 * or the unknown half. Everything else on this screen is supporting evidence.
 *
 * Undecoded frames are shown, counted, and coloured as an alert rather than
 * dropped. A monitor that quietly hid what it could not parse would be
 * actively misleading for this decision.
 */
export default function BusMonitor({ themeControl }) {
  const { frames, stats, paused, setPaused, clear } = useBus();
  const [filter, setFilter] = useState("all");
  const [openId, setOpenId] = useState(null);

  const shown = useMemo(
    () => (filter === "all" ? frames : frames.filter((f) => f.kind === filter)),
    [frames, filter]);

  const decodePct = stats.total ? Math.round((stats.decoded / stats.total) * 100) : 0;

  return (
    <div style={{ padding: "20px 16px 32px", fontFamily: FONT_UI, color: C.stone }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 22 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 2, color: C.muted, fontFamily: FONT_DATA, textTransform: "uppercase" }}>
            RS-485
          </div>
          <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: -0.5, lineHeight: 1.2 }}>Bus</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <div style={{
            fontFamily: FONT_DATA, fontSize: 10, letterSpacing: 1, textTransform: "uppercase",
            color: paused ? C.heat : C.water, border: `1px solid ${paused ? C.heat : C.water}`,
            borderRadius: 999, padding: "4px 9px",
          }}>
            {paused ? "Paused" : "Sniffing"}
          </div>
          {themeControl}
        </div>
      </div>

      {/* Decode rate is the Phase 1 deliverable in one number. */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16, marginBottom: 10 }}>
        <div style={{ display: "flex", gap: 12 }}>
          <Cell label="Frames" value={stats.total} />
          <Cell label="Decoded" value={`${decodePct}%`} tone={decodePct > 80 ? C.water : C.heat} />
          <Cell label="Unknown" value={stats.unknown} tone={stats.unknown ? C.alert : C.muted} />
          <Cell label="Bad CRC" value={stats.bad} tone={stats.bad ? C.heat : C.muted} />
        </div>
        <div style={{ fontSize: 11.5, color: C.faint, lineHeight: 1.5, marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
          Undecoded frames are the ADR-6 evidence. If chlorinator traffic sits
          in Unknown once the real bus is attached, that is Path B.
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {FILTERS.map((f) => {
          const on = filter === f.id;
          return (
            <button key={f.id} onClick={() => setFilter(f.id)} aria-pressed={on}
              style={{
                flex: 1, padding: "9px 4px", borderRadius: 8,
                border: `1px solid ${on ? C.water : C.line}`,
                background: on ? C.wash : "transparent",
                color: on ? C.water : C.muted,
                fontFamily: FONT_UI, fontSize: 12, fontWeight: 500, cursor: "pointer",
              }}>
              {f.label}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <Action label={paused ? "Resume" : "Pause"} onClick={() => setPaused(!paused)} primary={paused} />
        <Action label="Clear" onClick={clear} />
      </div>

      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, overflow: "hidden" }}>
        {shown.length === 0 && (
          <div style={{ padding: "18px 14px", fontSize: 13, color: C.muted, textAlign: "center" }}>
            {frames.length === 0 ? "Waiting for traffic…" : "No frames match this filter."}
          </div>
        )}
        {shown.slice(0, 60).map((f) => {
          const open = openId === f.id;
          const tone = KIND_TONE[f.kind] ?? C.muted;
          return (
            <div key={f.id} style={{ borderBottom: `1px solid ${C.line}` }}>
              <button onClick={() => setOpenId(open ? null : f.id)}
                aria-expanded={open}
                aria-label={`Frame ${f.id}, ${f.label}`}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 10,
                  padding: "10px 14px", background: "transparent", border: "none",
                  cursor: "pointer", textAlign: "left", color: "inherit",
                }}>
                <span style={{ width: 6, height: 6, borderRadius: 3, background: tone, flexShrink: 0 }} />
                <span style={{ fontFamily: FONT_DATA, fontSize: 10.5, color: C.faint, flexShrink: 0, width: 26 }}>
                  {f.proto}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 12.5, color: f.kind === "unknown" ? C.alert : C.stone }}>
                    {f.label}
                  </span>
                  <span style={{ display: "block", fontFamily: FONT_DATA, fontSize: 10, color: C.muted, marginTop: 2 }}>
                    {f.src == null ? `${f.bytes.length} bytes` : `${addrName(f.src)} → ${addrName(f.dst)}`}
                  </span>
                </span>
                {Object.keys(f.fields).length > 0 && (
                  <span style={{ fontFamily: FONT_DATA, fontSize: 11, color: C.water, flexShrink: 0 }}>
                    {fieldSummary(f.fields)}
                  </span>
                )}
                {!f.valid && f.proto !== PROTO.UNKNOWN && (
                  <span style={{ fontFamily: FONT_DATA, fontSize: 10, color: C.heat, flexShrink: 0 }}>CRC</span>
                )}
              </button>

              {open && (
                <div style={{ padding: "0 14px 12px 36px", fontFamily: FONT_DATA, fontSize: 10.5, color: C.muted, lineHeight: 1.7 }}>
                  <div style={{ wordBreak: "break-all", color: C.stone }}>{hex(f.bytes)}</div>
                  {f.checksum && (
                    <div style={{ color: f.valid ? C.muted : C.heat }}>
                      checksum want {f.checksum.want} · got {f.checksum.got}
                      {f.valid ? " · ok" : " · MISMATCH"}
                    </div>
                  )}
                  {Object.entries(f.fields).map(([k, v]) => (
                    <div key={k}>{k}: <span style={{ color: C.water }}>{fieldLabel(k, v)}</span></div>
                  ))}
                  {f.proto === PROTO.UNKNOWN && (
                    <div style={{ color: C.alert }}>
                      No known framing matched. Capture and add a decoder, or
                      this device stays on Path B.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.6, padding: "14px 2px 0" }}>
        Synthetic traffic. The decoders come from public reverse-engineering
        and are unverified against this equipment — treat a clean decode as a
        hypothesis until the real bus agrees.
      </div>
    </div>
  );
}

function Cell({ label, value, tone }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontFamily: FONT_DATA, fontSize: 9.5, letterSpacing: 1, color: C.muted, textTransform: "uppercase", marginBottom: 5 }}>
        {label}
      </div>
      <div style={{ fontFamily: FONT_DATA, fontSize: 19, fontWeight: 500, color: tone || C.stone, lineHeight: 1 }}>
        {value}
      </div>
    </div>
  );
}

function Action({ label, onClick, primary }) {
  return (
    <button onClick={onClick}
      style={{
        flex: 1, padding: "11px 8px", borderRadius: 10,
        border: `1px solid ${primary ? C.water : C.line}`,
        background: primary ? C.water : "transparent",
        color: primary ? C.ground : C.stone,
        fontFamily: FONT_UI, fontSize: 13, fontWeight: 600, cursor: "pointer",
      }}>
      {label}
    </button>
  );
}
