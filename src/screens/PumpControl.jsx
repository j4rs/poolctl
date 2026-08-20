import React, { useState, useMemo } from "react";
import { C, FONT_UI, FONT_DATA } from "../theme";
import { HEATER_MIN_RPM, CELL_MIN_RPM } from "../lib/sequences";
import { RPM_MIN, RPM_MAX, watts, daysLabel, hoursBetween } from "../lib/pump";
import ScheduleEditor from "../components/ScheduleEditor";

const RATE = 0.15;        // $/kWh — set to your own utility rate

const MARKER_ROW = 14;    // vertical offset between staggered marker labels
const MARKER_H = 44;      // total height of the marker strip above the slider

const THRESHOLDS = [
  { rpm: CELL_MIN_RPM, label: "Chlorinator flow", color: C.waterDim },
  { rpm: HEATER_MIN_RPM, label: "Heater minimum", color: C.heat },
];

const PRESETS = [
  { id: "eco", label: "Filtration", rpm: 1600 },
  { id: "skim", label: "Skimming", rpm: 2100 },
  { id: "spill", label: "Strong spill", rpm: 2200 },
  { id: "spa", label: "Spa jets", rpm: 2800 },
];

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

const INITIAL = [
  { id: 1, start: "08:00", end: "12:00", rpm: 1600, days: EVERY_DAY, on: true },
  { id: 2, start: "12:00", end: "16:00", rpm: 2600, days: EVERY_DAY, on: true, note: "Solar gain hours" },
  { id: 3, start: "16:00", end: "20:00", rpm: 1400, days: EVERY_DAY, on: true },
  { id: 4, start: "22:00", end: "23:30", rpm: 2100, days: [0, 6], on: false, note: "Weekend skim" },
];

const blankSchedule = () => ({
  id: `new-${Math.random().toString(36).slice(2, 8)}`,
  start: "09:00", end: "13:00", rpm: 1600, days: EVERY_DAY, on: true, isNew: true,
});

export default function PumpControl({ controller }) {
  const { state, setRpm } = controller;
  const rpm = state.pumpRpm;
  const [schedules, setSchedules] = useState(INITIAL);
  const [editing, setEditing] = useState(null);

  const w = watts(rpm);
  const pct = ((rpm - RPM_MIN) / (RPM_MAX - RPM_MIN)) * 100;
  const activePreset = PRESETS.find((p) => Math.abs(p.rpm - rpm) < 60);
  const unmet = THRESHOLDS.filter((t) => rpm < t.rpm);

  const daily = useMemo(() => {
    const on = schedules.filter((s) => s.on);
    const kwh = on.reduce((a, s) => a + (watts(s.rpm) / 1000) * hoursBetween(s.start, s.end), 0);
    const hours = on.reduce((a, s) => a + hoursBetween(s.start, s.end), 0);
    return { kwh, hours, cost: kwh * RATE };
  }, [schedules]);

  const toggleSchedule = (id) =>
    setSchedules((ss) => ss.map((s) => (s.id === id ? { ...s, on: !s.on } : s)));

  const saveSchedule = (draft) => {
    const { isNew, ...clean } = draft;
    setSchedules((ss) =>
      isNew ? [...ss, clean] : ss.map((s) => (s.id === clean.id ? clean : s)));
    setEditing(null);
  };

  const deleteSchedule = (id) => {
    setSchedules((ss) => ss.filter((s) => s.id !== id));
    setEditing(null);
  };

  return (
    <div style={{ padding: "20px 16px 32px", fontFamily: FONT_UI, color: C.stone }}>
      <div style={{ marginBottom: 22 }}>
        <div style={{ fontSize: 11, letterSpacing: 2, color: C.muted, fontFamily: FONT_DATA, textTransform: "uppercase" }}>Pump</div>
        <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: -0.5, lineHeight: 1.2 }}>Speed</div>
      </div>

      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: "20px 16px 16px", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 22 }}>
          <div style={{ fontFamily: FONT_DATA, fontSize: 40, fontWeight: 500, lineHeight: 1 }}>
            {rpm}<span style={{ fontSize: 14, color: C.muted, marginLeft: 4 }}>rpm</span>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontFamily: FONT_DATA, fontSize: 20, color: C.water, lineHeight: 1 }}>
              {w}<span style={{ fontSize: 11, color: C.muted, marginLeft: 2 }}>W</span>
            </div>
            <div style={{ fontFamily: FONT_DATA, fontSize: 11, color: C.muted, marginTop: 5 }}>
              ${((w / 1000) * 24 * RATE).toFixed(2)}/day if constant
            </div>
          </div>
        </div>

        {/* Labels alternate rows. The two thresholds sit close enough on the
            scale that centred captions collide, and they will move again once
            the real flow rates are measured — staggering holds either way. */}
        <div style={{ position: "relative", height: MARKER_H, marginBottom: 2 }}>
          {THRESHOLDS.map((t, i) => {
            const p = ((t.rpm - RPM_MIN) / (RPM_MAX - RPM_MIN)) * 100;
            const met = rpm >= t.rpm;
            const row = i % 2;
            return (
              <div key={t.label} style={{ position: "absolute", left: `${p}%`, top: row * MARKER_ROW, transform: "translateX(-50%)", textAlign: "center", width: 96 }}>
                <div style={{ fontFamily: FONT_DATA, fontSize: 9, color: met ? t.color : C.faint, lineHeight: 1.25, whiteSpace: "nowrap", transition: "color 200ms" }}>{t.label}</div>
                <div style={{ width: 1, height: MARKER_H - row * MARKER_ROW - 14, background: met ? t.color : C.line, margin: "3px auto 0", transition: "background 200ms" }} />
              </div>
            );
          })}
        </div>

        <input type="range" min={RPM_MIN} max={RPM_MAX} step={10} value={rpm}
          aria-label="Pump speed in rpm"
          onChange={(e) => setRpm(Number(e.target.value))}
          style={{ width: "100%", appearance: "none", height: 6, borderRadius: 3, outline: "none", cursor: "pointer",
            background: `linear-gradient(90deg, ${C.water} ${pct}%, ${C.line} ${pct}%)` }} />
        <style>{`
          input[type=range]::-webkit-slider-thumb { appearance: none; width: 22px; height: 22px; border-radius: 11px; background: ${C.water}; border: 3px solid ${C.ground}; cursor: grab; }
          input[type=range]::-moz-range-thumb { width: 16px; height: 16px; border-radius: 8px; background: ${C.water}; border: 3px solid ${C.ground}; cursor: grab; }
          input[type=range]:focus-visible { outline: 2px solid ${C.water}; outline-offset: 4px; }
        `}</style>
        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: FONT_DATA, fontSize: 10, color: C.faint, marginTop: 8 }}>
          <span>{RPM_MIN}</span><span>{RPM_MAX}</span>
        </div>

        {unmet.length > 0 && (
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.line}`, fontSize: 12.5, color: C.muted, lineHeight: 1.55 }}>
            Below {unmet.map((u) => u.label.toLowerCase()).join(" and ")}.{" "}
            {unmet.some((u) => u.label === "Heater minimum")
              ? "The heater will not fire at this speed."
              : "The cell will not generate at this speed."}
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 24 }}>
        {PRESETS.map((p) => {
          const active = activePreset?.id === p.id;
          return (
            <button key={p.id} onClick={() => setRpm(p.rpm)}
              style={{ padding: "12px 14px", borderRadius: 11, border: `1px solid ${active ? C.water : C.line}`,
                background: active ? "rgba(79,191,180,0.10)" : "transparent", color: C.stone,
                textAlign: "left", cursor: "pointer", transition: "all 160ms ease" }}>
              <div style={{ fontSize: 13.5, fontWeight: 500 }}>{p.label}</div>
              <div style={{ fontFamily: FONT_DATA, fontSize: 11, color: active ? C.water : C.muted, marginTop: 4 }}>
                {p.rpm} rpm · {watts(p.rpm)} W
              </div>
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ fontSize: 17, fontWeight: 600 }}>Schedules</div>
        <button onClick={() => setEditing(blankSchedule())} aria-label="Add schedule"
          style={{ background: "transparent", border: "none", color: C.water, fontFamily: FONT_UI, fontSize: 13, cursor: "pointer", padding: "4px 2px" }}>
          Add
        </button>
      </div>

      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, overflow: "hidden", marginBottom: 12 }}>
        {schedules.length === 0 && (
          <div style={{ padding: "18px 14px", fontSize: 13, color: C.muted, textAlign: "center" }}>
            No schedules. The pump only runs when you set a speed by hand.
          </div>
        )}
        {schedules.map((s) => {
          const kwh = (watts(s.rpm) / 1000) * hoursBetween(s.start, s.end);
          return (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 14px", borderBottom: `1px solid ${C.line}`, opacity: s.on ? 1 : 0.42 }}>
              <button onClick={() => toggleSchedule(s.id)} aria-pressed={s.on}
                aria-label={`Enable schedule ${s.start} to ${s.end}`}
                style={{ width: 34, height: 20, borderRadius: 10, border: "none", flexShrink: 0, background: s.on ? C.water : C.line, position: "relative", cursor: "pointer", transition: "background 180ms" }}>
                <span style={{ position: "absolute", top: 3, left: s.on ? 17 : 3, width: 14, height: 14, borderRadius: 7, background: s.on ? C.ground : C.surfaceUp, transition: "left 180ms" }} />
              </button>
              {/* The row body opens the editor; the switch stays its own
                  target so enabling never means editing by accident. */}
              <button onClick={() => setEditing(s)} aria-label={`Edit schedule ${s.start} to ${s.end}`}
                style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 12, background: "transparent", border: "none", padding: 0, cursor: "pointer", textAlign: "left", color: "inherit" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: FONT_DATA, fontSize: 14, color: C.stone }}>{s.start} – {s.end}</div>
                  <div style={{ fontSize: 11.5, color: C.muted, marginTop: 3 }}>{daysLabel(s.days)}{s.note ? ` · ${s.note}` : ""}</div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontFamily: FONT_DATA, fontSize: 14, color: C.water }}>
                    {s.rpm}<span style={{ fontSize: 10, color: C.muted, marginLeft: 2 }}>rpm</span>
                  </div>
                  <div style={{ fontFamily: FONT_DATA, fontSize: 11, color: C.muted, marginTop: 3 }}>{kwh.toFixed(1)} kWh</div>
                </div>
                <span style={{ color: C.muted, fontSize: 16, lineHeight: 1 }}>›</span>
              </button>
            </div>
          );
        })}
        <div style={{ display: "flex", justifyContent: "space-between", padding: 14, background: C.surfaceUp }}>
          <span style={{ fontSize: 13, color: C.muted }}>{daily.hours.toFixed(1)} h/day runtime</span>
          <span style={{ fontFamily: FONT_DATA, fontSize: 13 }}>{daily.kwh.toFixed(1)} kWh · ${daily.cost.toFixed(2)}/day</span>
        </div>
      </div>

      <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.6, padding: "0 2px" }}>
        Manual speed changes hold until the next schedule begins. Spa mode sets
        its own speed and ignores schedules while active.
      </div>

      {editing && (
        <ScheduleEditor
          value={editing}
          others={schedules.filter((s) => s.id !== editing.id)}
          onSave={saveSchedule}
          onDelete={deleteSchedule}
          onCancel={() => setEditing(null)} />
      )}
    </div>
  );
}
