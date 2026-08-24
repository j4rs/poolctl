import React, { useState } from "react";
import { C, FONT_UI, FONT_DATA } from "../theme";
import { RPM_MIN, RPM_MAX, watts } from "../lib/pump";
import { DURATIONS, speedNotes, validate } from "../lib/programs";
import { Sheet, Row, Action } from "./Sheet";
import { useConfirm } from "../lib/useConfirm";

/**
 * Add or edit a manual pump program.
 *
 * A program is a name, a speed and how long it runs — the three things that
 * make a manual run repeatable and bounded. The duration is required: this
 * is the only place the expiry can be set, and njsPC's default if we leave
 * it alone is twelve hours.
 *
 * The speed slider lives here rather than on the main screen. Choosing the
 * speed a program will hold for its whole run is a decision; dragging the
 * live pump around is not.
 */
export default function ProgramEditor({ value, onSave, onDelete, onCancel, running, limits }) {
  const [draft, setDraft] = useState(value);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const confirm = useConfirm();

  /* The pump's own range when njsPC knows of a pump, the IntelliFlo figures
     otherwise. They agree on this site, but they are not the same claim: one
     is what the equipment reports, the other is what the manual says the
     model does. Before commissioning only the second exists. */
  const min = limits?.minSpeed ?? RPM_MIN;
  const max = limits?.maxSpeed ?? RPM_MAX;

  const problem = validate(draft, limits);
  const notes = speedNotes(draft.rpm);
  const kwh = (watts(draft.rpm) / 1000) * (draft.minutes / 60);
  const pct = ((draft.rpm - min) / (max - min)) * 100;

  return (
    <Sheet
      title={value.isNew ? "New program" : "Edit program"}
      label={value.isNew ? "Add program" : "Edit program"}
      onCancel={onCancel}
    >
      <Row label="Name">
        <input
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Cleaning"
          aria-label="Program name"
          style={{
            width: "100%", background: C.ground, border: `1px solid ${C.line}`,
            borderRadius: 9, color: C.stone, fontFamily: FONT_UI, fontSize: 16,
            padding: "11px 12px",
          }}
        />
      </Row>

      <Row label="Speed" hint={`${watts(draft.rpm)} W`}>
        <div style={{ fontFamily: FONT_DATA, fontSize: 28, fontWeight: 500, marginBottom: 10 }}>
          {draft.rpm}
          <span style={{ fontSize: 13, color: C.muted, marginLeft: 4 }}>rpm</span>
        </div>
        <input
          type="range" min={min} max={max} step={50} value={draft.rpm}
          aria-label="Program speed in rpm"
          onChange={(e) => set({ rpm: Number(e.target.value) })}
          style={{
            width: "100%", appearance: "none", height: 6, borderRadius: 3, outline: "none",
            background: `linear-gradient(90deg, ${C.water} ${pct}%, ${C.line} ${pct}%)`,
          }}
        />
        {/* The thresholds inform a real decision here: this is the speed the
            program holds for its entire run, not a momentary position. */}
        {notes.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 12, color: C.heat, lineHeight: 1.5 }}>
            {notes.map((n) => <div key={n}>{n}</div>)}
          </div>
        )}
      </Row>

      <Row label="Runs for" hint={`${kwh.toFixed(2)} kWh per run`}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {DURATIONS.map((d) => {
            const on = draft.minutes === d.minutes;
            return (
              <button key={d.minutes} onClick={() => set({ minutes: d.minutes })}
                aria-pressed={on} aria-label={`Run for ${d.label}`}
                style={{
                  flex: "1 0 28%", padding: "11px 4px", borderRadius: 8,
                  border: `1px solid ${on ? C.water : C.line}`,
                  background: on ? C.wash : "transparent",
                  color: on ? C.water : C.muted,
                  fontFamily: FONT_UI, fontSize: 12.5, fontWeight: 500, cursor: "pointer",
                }}>
                {d.label}
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: 11.5, color: C.faint, marginTop: 10, lineHeight: 1.5 }}>
          Every program stops on its own. A manual run you walk away from is
          the one thing this prevents.
        </div>
      </Row>

      {problem && (
        <div style={{ fontSize: 12.5, color: C.alert, marginBottom: 14 }}>{problem}</div>
      )}

      {running && (
        <div style={{ fontSize: 12.5, color: C.heat, marginBottom: 14, lineHeight: 1.5 }}>
          This program is running. Saving or deleting it stops the pump first.
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <Action label="Cancel" onClick={onCancel} />
        {/* Deleting takes the njsPC circuit with it, so this one is not
            recoverable by re-adding a program with the same name. */}
        {!value.isNew && (
          <Action
            label={confirm.isArmed("delete") ? "Tap again" : "Delete"}
            tone={confirm.isArmed("delete") ? C.heat : C.alert}
            onClick={confirm.guard("delete", () => onDelete(value.id))}
          />
        )}
        <Action label="Save" primary disabled={Boolean(problem)} onClick={() => onSave(draft)} />
      </div>
    </Sheet>
  );
}
