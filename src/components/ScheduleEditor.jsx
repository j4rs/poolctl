import React, { useState } from "react";
import { C, FONT_UI, FONT_DATA } from "../theme";
import { Sheet, Row, Action } from "./Sheet";
import { useConfirm } from "../lib/useConfirm";
import { HEATER_MIN_RPM, CELL_MIN_RPM } from "../lib/sequences";
import { watts, DAYS, daysLabel, hoursBetween, overlaps } from "../lib/pump";

/**
 * Add or edit one pump schedule, as a bottom sheet.
 *
 * Shows the cost of the window while you are choosing it — a schedule
 * decision made on rpm alone is made blind (PR-5). Overlaps warn rather
 * than block: the server resolves them, and forbidding them here would be
 * guessing at an interlock the UI does not own.
 */
export default function ScheduleEditor({ value, others, circuits = [], onSave, onDelete, onCancel }) {
  const [draft, setDraft] = useState(value);
  const confirm = useConfirm();
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  /* The speed is the circuit's, not the schedule's. njsPC schedules carry no
     rpm at all — they run a circuit, and the pump holds that circuit's
     speed. Same reason the live pump slider went. */
  const chosen = circuits.find((c) => c.circuit === draft.circuit) ?? null;
  const rpm = chosen?.rpm ?? null;

  const hours = hoursBetween(draft.start, draft.end);
  const kwh = rpm != null ? (watts(rpm) / 1000) * hours : null;
  const clashes = others.filter((o) => overlaps(draft, o));
  const noDays = draft.days.length === 0;
  const noSpan = draft.start === draft.end;
  const noCircuit = draft.circuit == null;
  const invalid = noDays || noSpan || noCircuit;

  /* Functional update: taps arriving faster than a re-render would each
     compute from the same stale day list and cancel each other out. */
  const toggleDay = (i) =>
    setDraft((d) => ({
      ...d,
      days: d.days.includes(i)
        ? d.days.filter((x) => x !== i)
        : [...d.days, i].sort((a, b) => a - b),
    }));

  return (
    <Sheet
      title={value.isNew ? "New schedule" : "Edit schedule"}
      label={value.isNew ? "Add schedule" : "Edit schedule"}
      onCancel={onCancel}
    >
        <Row label="Runs">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <TimeField value={draft.start} onChange={(v) => set({ start: v })} label="Start time" />
            <span style={{ color: C.muted }}>–</span>
            <TimeField value={draft.end} onChange={(v) => set({ end: v })} label="End time" />
          </div>
        </Row>

        <Row label="Days" hint={daysLabel(draft.days)}>
          <div style={{ display: "flex", gap: 6 }}>
            {DAYS.map((d) => {
              const on = draft.days.includes(d.i);
              return (
                <button key={d.i} onClick={() => toggleDay(d.i)}
                  aria-pressed={on} aria-label={d.name}
                  style={{
                    flex: 1, height: 40, borderRadius: 8,
                    border: `1px solid ${on ? C.water : C.line}`,
                    background: on ? C.wash : "transparent",
                    color: on ? C.water : C.muted,
                    fontFamily: FONT_UI, fontSize: 12.5, fontWeight: 600, cursor: "pointer",
                  }}>
                  {d.short}
                </button>
              );
            })}
          </div>
        </Row>

        <Row label="Runs">
          {circuits.length === 0 ? (
            <div style={{ fontSize: 12.5, color: C.alert, lineHeight: 1.5 }}>
              No circuits with a pump speed yet. njsPC needs a pump configured,
              and a program bound, before a schedule has anything to run.
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {circuits.map((c) => {
                  const on = draft.circuit === c.circuit;
                  return (
                    <button key={c.circuit} onClick={() => set({ circuit: c.circuit })}
                      aria-pressed={on} aria-label={`Run ${c.name}`}
                      style={{
                        flex: "1 0 30%", padding: "10px 6px", borderRadius: 8,
                        border: `1px solid ${on ? C.water : C.line}`,
                        background: on ? C.wash : "transparent",
                        color: on ? C.water : C.muted, cursor: "pointer",
                        fontFamily: FONT_UI, fontSize: 12.5, fontWeight: 500,
                      }}>
                      <div>{c.name ?? `Circuit ${c.circuit}`}</div>
                      <div style={{ fontFamily: FONT_DATA, fontSize: 10.5, marginTop: 2, color: C.muted }}>
                        {c.rpm != null ? `${c.rpm} rpm` : "no speed"}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* The thresholds still inform the choice, they just describe
                  the circuit being picked rather than a slider position. */}
              {rpm != null && (
                <div style={{ fontFamily: FONT_DATA, fontSize: 10.5, color: C.muted, marginTop: 10, lineHeight: 1.5 }}>
                  {watts(rpm)} W ·{" "}
                  {rpm < CELL_MIN_RPM
                    ? "below chlorinator flow — the cell will not generate."
                    : rpm < HEATER_MIN_RPM
                      ? "below heater minimum — the heater will not fire."
                      : "above both flow thresholds."}
                </div>
              )}
            </>
          )}
        </Row>

        <div style={{
          background: C.surfaceUp, borderRadius: 10, padding: "12px 14px", marginBottom: 14,
          display: "flex", justifyContent: "space-between", alignItems: "baseline",
        }}>
          <span style={{ fontSize: 12.5, color: C.muted }}>
            {noSpan ? "No runtime" : `${hours.toFixed(1)} h per run`}
          </span>
          <span style={{ fontFamily: FONT_DATA, fontSize: 13, color: kwh == null ? C.faint : C.stone }}>
            {kwh == null ? "— kWh" : `${kwh.toFixed(2)} kWh`}
          </span>
        </div>

        {clashes.length > 0 && (
          <div style={{ fontSize: 12, color: C.heat, marginBottom: 14, lineHeight: 1.5 }}>
            Overlaps {clashes.map((c) => `${c.start}–${c.end}`).join(", ")}.
            Not a conflict: njsPC runs every circuit whose schedule says so
            and drives the pump at the fastest of them.
          </div>
        )}
        {invalid && (
          <div style={{ fontSize: 12, color: C.alert, marginBottom: 14, lineHeight: 1.5 }}>
            {noCircuit
              ? "Pick what this schedule runs."
              : noDays ? "Pick at least one day." : "Start and end cannot match."}
          </div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <Action label="Cancel" onClick={onCancel} />
          {!value.isNew && (
            <Action
              label={confirm.isArmed("delete") ? "Tap again" : "Delete"}
              tone={confirm.isArmed("delete") ? C.heat : C.alert}
              onClick={confirm.guard("delete", () => onDelete(draft.id))}
            />
          )}
          <Action label="Save" primary disabled={invalid} onClick={() => onSave(draft)} />
        </div>
    </Sheet>
  );
}


function TimeField({ value, onChange, label }) {
  return (
    <input type="time" value={value} aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      style={{
        flex: 1, background: C.ground, border: `1px solid ${C.line}`, borderRadius: 9,
        color: C.stone, fontFamily: FONT_DATA, fontSize: 16, padding: "11px 10px",
        colorScheme: "dark",
      }} />
  );
}

