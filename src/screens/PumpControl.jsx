import React, { useState, useMemo, useEffect } from "react";
import { C, FONT_UI, FONT_DATA } from "../theme";
import { HEATER_MIN_RPM, CELL_MIN_RPM, POOL_RPM } from "../lib/sequences";
import {
  RPM_MIN, RPM_MAX, watts, daysLabel, hoursBetween, activeSchedule, clockAt,
} from "../lib/pump";
import ScheduleEditor from "../components/ScheduleEditor";
import ProgramEditor from "../components/ProgramEditor";
import { blankProgram, remaining } from "../lib/programs";
import { useConfirm } from "../lib/useConfirm";

const RATE = 0.15;        // $/kWh — set to your own utility rate


const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/* A new schedule starts as a blank the editor fills in. No speed: the speed
   belongs to whichever circuit it is pointed at, which is njsPC's model and
   the reason the old rpm slider is gone from here too. */
const blankSchedule = () => ({
  id: `new-${Math.random().toString(36).slice(2, 8)}`,
  circuit: null, start: "09:00", end: "13:00", days: EVERY_DAY,
  enabled: true, isNew: true,
});

export default function PumpControl({ controller, themeControl }) {
  const { state, setPumpRunning, setPanelMode,
    startProgram, stopProgram, saveProgram, deleteProgram, bindProgram,
    saveSchedule, deleteSchedule, setScheduleEnabled } = controller;
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
  /* What the pump will accept, as njsPC reports it. Null before a pump is
     configured, which the editor falls back from rather than inventing. */
  const pumpLimits = state.pumpLimits ?? null;
  /* njsPC owns schedules; this list is read back from it, not held here.
     Absent means not known yet — distinct from a known-empty list, and the
     daily total says so rather than confidently reporting $0.00. */
  const schedulesKnown = Array.isArray(state.schedules);
  const schedules = state.schedules ?? [];
  /* What a schedule can be pointed at — the circuits the pump has a speed
     for. Empty before commissioning, which the editor says rather than
     offering an empty picker. */
  const pumpCircuits = state.pumpCircuits ?? [];
  /* Anything that starts or stops equipment asks twice. See useConfirm. */
  const confirm = useConfirm();
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

  /* Who is driving the pump right now, most specific first. In spa mode the
     pump is immune to schedules, and the pool transition resets the speed on
     the way out regardless. */
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
    /* Only schedules whose circuit the pump actually carries a speed for.
       One pointed elsewhere costs nothing and would otherwise contribute a
       confident NaN to the daily total. */
    const on = schedules.filter((s) => s.enabled && typeof s.rpm === "number");
    const kwh = on.reduce((a, s) => a + (watts(s.rpm) / 1000) * hoursBetween(s.start, s.end), 0);
    const hours = on.reduce((a, s) => a + hoursBetween(s.start, s.end), 0);
    return { kwh, hours, cost: kwh * RATE };
  }, [schedules]);

  /* These write through to njsPC and return; the list re-renders when njsPC
     reports the change, not when the tap lands (ADR-7). */
  const onToggleSchedule = (s) => setScheduleEnabled(s.id, !s.enabled);

  const onSaveSchedule = (draft) => {
    saveSchedule(draft);
    setEditing(null);
  };

  const onDeleteSchedule = (id) => {
    deleteSchedule(id);
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
          <button
            onClick={confirm.guard("pump", () => setPumpRunning(!pumpRunning))}
            aria-label={
              confirm.isArmed("pump")
                ? `Confirm: ${pumpRunning ? "stop" : "run"} the pump`
                : pumpRunning ? "Stop the pump" : "Run the pump"
            }
            style={{
              flex: 1, padding: "15px 8px", borderRadius: 11,
              border: `1px solid ${confirm.isArmed("pump") ? C.heat : pumpRunning ? C.alert : C.water}`,
              background: confirm.isArmed("pump") ? "transparent" : pumpRunning ? "transparent" : C.water,
              color: confirm.isArmed("pump") ? C.heat : pumpRunning ? C.alert : C.ground,
              fontFamily: FONT_UI, fontSize: 15, fontWeight: 600, cursor: "pointer",
            }}>
            {confirm.isArmed("pump")
              ? `Tap again to ${pumpRunning ? "stop" : "run"} the pump`
              : pumpRunning ? "Stop the pump" : "Run the pump"}
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
          /* A program with no njsPC circuit has nowhere to put its speed, so
             it cannot run at all — whatever the pump is doing. The reason is
             rendered under the name rather than surfacing only on the tap
             that fails. */
          const unbound = p.circuit == null;
          const blocked = unbound || !pumpRunning || spaOwnsPump;
          const why = unbound
            ? (p.bindError ?? "not set up in njsPC yet")
            : null;
          return (
            <div key={p.id} style={{
              display: "flex", alignItems: "center", gap: 10,
              border: `1px solid ${running ? C.heat : C.line}`,
              background: running ? C.wash : "transparent",
              borderRadius: 11, padding: "12px 12px 12px 14px",
            }}>
              <button
                onClick={confirm.guard(`program:${p.id}`, () =>
                  running ? stopProgram() : startProgram(p.id))}
                disabled={blocked}
                aria-label={
                  confirm.isArmed(`program:${p.id}`)
                    ? `Confirm: ${running ? "stop" : "run"} ${p.name}`
                    : running ? `Stop ${p.name}` : `Run ${p.name}`
                }
                style={{
                  flex: 1, minWidth: 0, textAlign: "left", background: "transparent",
                  border: "none", padding: 0,
                  cursor: blocked ? "not-allowed" : "pointer",
                  opacity: blocked ? 0.45 : 1,
                }}>
                <div style={{ fontFamily: FONT_UI, fontSize: 14, fontWeight: 600, color: running ? C.heat : C.stone }}>
                  {confirm.isArmed(`program:${p.id}`)
                    ? `${p.name} — tap again to ${running ? "stop" : "run"}`
                    : running ? `${p.name} — stop` : p.name}
                </div>
                <div style={{ fontFamily: FONT_DATA, fontSize: 11, color: C.muted, marginTop: 3 }}>
                  {p.rpm} rpm · {watts(p.rpm)} W ·{" "}
                  {running && left != null
                    ? `${Math.ceil(left / 60000)} min left`
                    : `${p.minutes} min`}
                </div>
                {why && (
                  <div style={{ fontSize: 11, color: C.alert, marginTop: 5, lineHeight: 1.45 }}>
                    {why}
                  </div>
                )}
              </button>
              {unbound && (
                <button onClick={() => bindProgram(p.id)} aria-label={`Set up ${p.name} in njsPC`}
                  style={{
                    flexShrink: 0, padding: "7px 11px", borderRadius: 8,
                    border: `1px solid ${C.water}`, background: "transparent",
                    color: C.water, fontFamily: FONT_UI, fontSize: 12, fontWeight: 500,
                    cursor: "pointer",
                  }}>
                  Set up
                </button>
              )}
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
        {/* Both directions ask twice. Entering service stands the schedules
            down; leaving it can start the pump on the next boundary. */}
        <button
          onClick={confirm.guard("panel", () =>
            setPanelMode(panelMode === "service" ? "auto" : "service"))}
          aria-label={
            confirm.isArmed("panel")
              ? `Confirm: ${panelMode === "service" ? "resume automation" : "enter service mode"}`
              : panelMode === "service" ? "Resume automation" : "Enter service mode"
          }
          style={{
            flexShrink: 0, padding: "10px 14px", borderRadius: 9,
            border: `1px solid ${confirm.isArmed("panel") ? C.heat : panelMode === "service" ? C.water : C.line}`,
            background: "transparent",
            color: confirm.isArmed("panel") ? C.heat : panelMode === "service" ? C.water : C.muted,
            fontFamily: FONT_UI, fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}>
          {confirm.isArmed("panel")
            ? "Tap again"
            : panelMode === "service" ? "Resume" : "Service"}
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
          /* Null rpm means the schedule points at a circuit the pump carries
             no speed for. It will still run the circuit; it just will not
             move the pump, which is worth saying rather than rendering NaN. */
          const known = typeof s.rpm === "number";
          const kwh = known ? (watts(s.rpm) / 1000) * hoursBetween(s.start, s.end) : null;
          return (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 14px", borderBottom: `1px solid ${C.line}`, opacity: s.enabled ? 1 : 0.42 }}>
              {/* Enabling one means the pump starts at its next boundary;
                  disabling one means it does not. Both change flow. */}
              <button
                onClick={confirm.guard(`schedule:${s.id}`, () => onToggleSchedule(s))}
                aria-pressed={s.enabled}
                aria-label={
                  confirm.isArmed(`schedule:${s.id}`)
                    ? `Confirm: ${s.enabled ? "disable" : "enable"} schedule ${s.start} to ${s.end}`
                    : `Enable schedule ${s.start} to ${s.end}`
                }
                style={{ width: 34, height: 20, borderRadius: 10, flexShrink: 0, background: s.enabled ? C.water : C.line, position: "relative", cursor: "pointer", transition: "background 180ms", border: confirm.isArmed(`schedule:${s.id}`) ? `2px solid ${C.heat}` : "none" }}>
                <span style={{ position: "absolute", top: 3, left: s.enabled ? 17 : 3, width: 14, height: 14, borderRadius: 7, background: s.enabled ? C.ground : C.surfaceUp, transition: "left 180ms" }} />
              </button>
              {/* The row body opens the editor; the switch stays its own
                  target so enabling never means editing by accident. */}
              <button onClick={() => setEditing(s)} aria-label={`Edit schedule ${s.start} to ${s.end}`}
                style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 12, background: "transparent", border: "none", padding: 0, cursor: "pointer", textAlign: "left", color: "inherit" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: FONT_DATA, fontSize: 14, color: C.stone }}>{s.start} – {s.end}</div>
                  <div style={{ fontSize: 11.5, color: C.muted, marginTop: 3 }}>
                    {daysLabel(s.days)}{s.circuitName ? ` · ${s.circuitName}` : ""}
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontFamily: FONT_DATA, fontSize: 14, color: known ? C.water : C.faint }}>
                    {known ? s.rpm : "—"}
                    <span style={{ fontSize: 10, color: C.muted, marginLeft: 2 }}>rpm</span>
                  </div>
                  <div style={{ fontFamily: FONT_DATA, fontSize: 11, color: C.muted, marginTop: 3 }}>
                    {known ? `${kwh.toFixed(1)} kWh` : "no pump speed"}
                  </div>
                </div>
                <span style={{ color: C.muted, fontSize: 16, lineHeight: 1 }}>›</span>
              </button>
            </div>
          );
        })}
        <div style={{ display: "flex", justifyContent: "space-between", padding: 14, background: C.surfaceUp }}>
          <span style={{ fontSize: 13, color: C.muted }}>
            {schedulesKnown ? `${daily.hours.toFixed(1)} h/day runtime` : "runtime unknown"}
          </span>
          <span style={{ fontFamily: FONT_DATA, fontSize: 13, color: schedulesKnown ? C.stone : C.faint }}>
            {schedulesKnown
              ? `${daily.kwh.toFixed(1)} kWh · $${daily.cost.toFixed(2)}/day`
              : "— kWh"}
          </span>
        </div>
      </div>

      {/* Left over from the slider and the hold, both of which are gone.
          Replaced with how overlaps actually resolve, which is the question
          this screen now raises and njsPC answers. */}
      <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.6, padding: "0 2px" }}>
        Overlapping schedules are not a conflict. njsPC runs every circuit
        whose schedule says so and drives the pump at the fastest of them, so
        a skim window inside a filtration window simply speeds the pump up
        while both are on. Spa mode sets its own speed and takes the pump
        back either way.
      </div>

      {editingProgram && (
        <ProgramEditor
          value={editingProgram}
          running={activeProgram?.id === editingProgram.id}
          onSave={(d) => { saveProgram(d); setEditingProgram(null); }}
          onDelete={(id) => { deleteProgram(id); setEditingProgram(null); }}
          limits={pumpLimits}
          onCancel={() => setEditingProgram(null)}
        />
      )}

      {editing && (
        <ScheduleEditor
          value={editing}
          others={schedules.filter((s) => s.id !== editing.id)}
          onSave={onSaveSchedule}
          onDelete={onDeleteSchedule}
          circuits={pumpCircuits}
          onCancel={() => setEditing(null)} />
      )}
    </div>
  );
}
