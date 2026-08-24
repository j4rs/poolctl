import React, { useState, useMemo, useEffect } from "react";
import { C, FONT_UI, FONT_DATA } from "../theme";
import { HEATER_MIN_RPM, CELL_MIN_RPM, POOL_RPM } from "../lib/sequences";
import {
  RPM_MIN, RPM_MAX, watts, daysLabel, hoursBetween, activeSchedule, clockAt,
} from "../lib/pump";
import ScheduleEditor from "../components/ScheduleEditor";
import ProgramEditor from "../components/ProgramEditor";
import { blankProgram, remaining } from "../lib/programs";

const RATE = 0.15;        // $/kWh — set to your own utility rate


const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/* ILLUSTRATIVE ONLY — see the mock-data warning in useController.js.
   Several windows, varying speeds, a note and a disabled row, chosen to
   exercise the UI. The real schedule is a single daily window; the PRD has it. */
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

export default function PumpControl({ controller, themeControl }) {
  const { state, setPumpRunning, setPanelMode,
    startProgram, stopProgram, saveProgram, deleteProgram } = controller;
  /* null means no reading from the pump — distinct from 0, which means
     stopped. The slider still needs a position, so it falls back to the
     filtration speed, but the readout says plainly that we do not know. */
  const rpm = state.pumpRpm;
  const rpmKnown = rpm != null;
  /* What the controller is asking for. Present without a reading means the
     pump is not answering — a fault, not an absence. */
  const commanded = state.pumpCommandedRpm ?? null;
  const notResponding = !rpmKnown && commanded != null;
  const sliderRpm = rpmKnown ? rpm : POOL_RPM;
  /* Defaults because the live supervisor legitimately has no programs until
     commissioning creates the circuits, and no panel mode until njsPC
     reports one. Absent is not the same as broken. */
  const { heaterCall, mode } = state;
  const programs = state.programs ?? [];
  const activeProgram = state.activeProgram ?? null;
  const pumpRunning = state.pumpRunning ?? false;
  const panelMode = state.panelMode ?? "auto";
  const [schedules, setSchedules] = useState(INITIAL);
  const [editing, setEditing] = useState(null);
  const [editingProgram, setEditingProgram] = useState(null);
  /* Countdowns need their own clock; state only moves on the beat. */
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const scheduled = activeSchedule(schedules);
  const spaOwnsPump = mode === "spa";

  /* In spa mode the pump is already immune to schedules, so a hold would
     protect against nothing — and the pool sequence resets the speed on the
     way out regardless. */
  const owner = !pumpRunning
    ? { label: "Stopped", tone: C.alert }
    : spaOwnsPump
      ? { label: "Spa mode", tone: C.heat }
      : activeProgram
        ? { label: activeProgram.name, tone: C.heat }
        : panelMode === "service"
          ? { label: "Service", tone: C.alert }
          : scheduled
            ? { label: "Schedule", tone: C.water }
            : { label: "Idle", tone: C.muted };

  const w = rpmKnown ? watts(rpm) : null;
  const pct = ((sliderRpm - RPM_MIN) / (RPM_MAX - RPM_MIN)) * 100;

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
      {/* Who is driving the pump. Without this the screen asserts things
          like "spa mode owns the pump" while showing no sign anywhere that
          spa mode is even on. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 22 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 2, color: C.muted, fontFamily: FONT_DATA, textTransform: "uppercase" }}>Pump</div>
          <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: -0.5, lineHeight: 1.2 }}>Speed</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <div style={{
            fontFamily: FONT_DATA, fontSize: 10, letterSpacing: 1, textTransform: "uppercase",
            color: owner.tone, border: `1px solid ${owner.tone}`, borderRadius: 999,
            padding: "4px 9px", opacity: 0.9,
          }}>
            {owner.label}
          </div>
          {themeControl}
        </div>
      </div>

      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: "20px 16px 16px", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 22 }}>
          <div style={{ fontFamily: FONT_DATA, fontSize: 40, fontWeight: 500, lineHeight: 1 }}>
            {rpmKnown ? rpm : "—"}
            <span style={{ fontSize: 14, color: C.muted, marginLeft: 4 }}>rpm</span>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontFamily: FONT_DATA, fontSize: 20, color: C.water, lineHeight: 1 }}>
              {w ?? "—"}<span style={{ fontSize: 11, color: C.muted, marginLeft: 2 }}>W</span>
            </div>
            <div style={{ fontFamily: FONT_DATA, fontSize: 11, color: C.muted, marginTop: 5 }}>
              {w != null ? `$${((w / 1000) * 24 * RATE).toFixed(2)}/day if constant` : "—"}
            </div>
          </div>
        </div>

        {/* A commanded speed with no reading is a fault, not an absence: the
            pump was told to run and is not answering. Full width, because the
            sentence matters more than the number beside it. */}
        {!rpmKnown && (
          <div style={{
            fontFamily: FONT_DATA, fontSize: 11, lineHeight: 1.5, marginBottom: 16,
            color: notResponding ? C.alert : C.muted,
          }}>
            {notResponding
              ? `Pump not responding — asked for ${commanded} rpm`
              : "No reading from the pump"}
          </div>
        )}

        {/* Run or stop, which is what "the pump" means to anyone standing at
            the equipment. Speed belongs to a program or a schedule, never to a
            live slider — njsPC drives the pump from circuits, and an arbitrary
            rpm had neither a user nor an expiry. */}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setPumpRunning(!pumpRunning)}
            style={{
              flex: 1, padding: "15px 8px", borderRadius: 11,
              border: `1px solid ${pumpRunning ? C.alert : C.water}`,
              background: pumpRunning ? "transparent" : C.water,
              color: pumpRunning ? C.alert : C.ground,
              fontFamily: FONT_UI, fontSize: 15, fontWeight: 600, cursor: "pointer",
            }}>
            {pumpRunning ? "Stop the pump" : "Run the pump"}
          </button>
        </div>
        {!pumpRunning && (
          <div style={{ fontSize: 11.5, color: C.faint, marginTop: 10, lineHeight: 1.5 }}>
            Schedules and programs cannot run the pump while it is stopped.
          </div>
        )}
      </div>

      {/* Programs — a named speed you run on purpose, for a bounded time.
          Each is an njsPC circuit with a pump speed and an egg timer. */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ fontSize: 17, fontWeight: 600 }}>Programs</div>
        <button onClick={() => setEditingProgram(blankProgram())} aria-label="Add program"
          style={{ background: "transparent", border: "none", color: C.water, fontFamily: FONT_UI, fontSize: 13, cursor: "pointer", padding: 0 }}>
          Add
        </button>
      </div>

      <div style={{ display: "grid", gap: 8, marginBottom: 24 }}>
        {programs.map((p) => {
          const running = activeProgram?.id === p.id;
          const left = running ? remaining(activeProgram) : null;
          return (
            <div key={p.id} style={{
              display: "flex", alignItems: "center", gap: 10,
              border: `1px solid ${running ? C.heat : C.line}`,
              background: running ? C.wash : "transparent",
              borderRadius: 11, padding: "12px 12px 12px 14px",
            }}>
              <button
                onClick={() => (running ? stopProgram() : startProgram(p.id))}
                disabled={!pumpRunning || spaOwnsPump}
                aria-label={running ? `Stop ${p.name}` : `Run ${p.name}`}
                style={{
                  flex: 1, minWidth: 0, textAlign: "left", background: "transparent",
                  border: "none", padding: 0,
                  cursor: !pumpRunning || spaOwnsPump ? "not-allowed" : "pointer",
                  opacity: !pumpRunning || spaOwnsPump ? 0.45 : 1,
                }}>
                <div style={{ fontFamily: FONT_UI, fontSize: 14, fontWeight: 600, color: running ? C.heat : C.stone }}>
                  {running ? `${p.name} — stop` : p.name}
                </div>
                <div style={{ fontFamily: FONT_DATA, fontSize: 11, color: C.muted, marginTop: 3 }}>
                  {p.rpm} rpm · {watts(p.rpm)} W ·{" "}
                  {running && left != null
                    ? `${Math.ceil(left / 60000)} min left`
                    : `${p.minutes} min`}
                </div>
              </button>
              <button onClick={() => setEditingProgram(p)} aria-label={`Edit ${p.name}`}
                style={{
                  flexShrink: 0, width: 34, height: 34, borderRadius: 999,
                  border: `1px solid ${C.line}`, background: "transparent",
                  color: C.muted, cursor: "pointer", fontSize: 15, padding: 0,
                }}>
                ›
              </button>
            </div>
          );
        })}
        {programs.length === 0 && (
          <div style={{ fontSize: 12.5, color: C.faint, padding: "8px 2px", lineHeight: 1.5 }}>
            No programs yet. Add one for the things you do by hand — skimming,
            or clearing the water after service.
          </div>
        )}
      </div>

      {/* Automation, as a whole. njsPC's panel mode: service stands the
          schedules down without disabling them one at a time. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12, marginBottom: 24,
        background: C.surface, border: `1px solid ${panelMode === "service" ? C.alert : C.line}`,
        borderRadius: 12, padding: "13px 14px",
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: panelMode === "service" ? C.alert : C.stone }}>
            {panelMode === "service" ? "Service — schedules are standing down" : "Automation running"}
          </div>
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 3, lineHeight: 1.45 }}>
            {panelMode === "service"
              ? "Only manual commands act. Nothing will start on its own."
              : "Schedules run as configured."}
          </div>
        </div>
        <button onClick={() => setPanelMode(panelMode === "service" ? "auto" : "service")}
          style={{
            flexShrink: 0, padding: "10px 14px", borderRadius: 9,
            border: `1px solid ${panelMode === "service" ? C.water : C.line}`,
            background: "transparent",
            color: panelMode === "service" ? C.water : C.muted,
            fontFamily: FONT_UI, fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}>
          {panelMode === "service" ? "Resume" : "Service"}
        </button>
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
        A speed set by hand lasts until the next schedule begins. Hold it to
        keep it past that — an open-ended hold pauses filtration too, so it
        stays on screen until you release it. Spa mode sets its own speed and
        takes the pump back either way.
      </div>

      {editingProgram && (
        <ProgramEditor
          value={editingProgram}
          running={activeProgram?.id === editingProgram.id}
          onSave={(d) => { saveProgram(d); setEditingProgram(null); }}
          onDelete={(id) => { deleteProgram(id); setEditingProgram(null); }}
          onCancel={() => setEditingProgram(null)}
        />
      )}

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
