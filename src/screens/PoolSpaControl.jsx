import React, { useState, useEffect } from "react";
import { C, FONT_UI, FONT_DATA } from "../theme";
import { MODES, SPA_HEAT_RATE } from "../lib/sequences";
import Schematic from "../components/Schematic";
import Stat from "../components/Stat";
import Toggle from "../components/Toggle";
import HoldButton from "../components/HoldButton";
import PreheatSheet from "../components/PreheatSheet";

/** Coarse relative time. Precision past a minute is noise here. */
const ago = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

const countdown = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
};

export default function PoolSpaControl({ controller, themeControl, onOpenHeat }) {
  const { state, setMode, toggle, extendSpa, schedulePreheat, cancelPreheat,
    simulateOutage } = controller;
  const {
    mode, target, activeSequence, stepIndex, steps, valves, pumpRpm, waterTemp,
    targets, setpoint, heaterCall, blower, light, saltPpm, cellOutput,
    connected, lastSeen, spaExpiresAt, preheat,
  } = state;

  const [sheet, setSheet] = useState(false);
  /* Countdowns need a clock of their own; state only changes on the beat,
     and while offline it does not change at all. */
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const busy = Boolean(activeSequence);
  const stale = !connected;
  /* No estimate while the blower runs: blower and heater roughly cancel, so
     any figure would be an artefact of dividing by nearly zero. PR-4 asks
     only that the copy say so. */
  const minsToSetpoint =
    heaterCall === "spa" && setpoint && !blower
      ? Math.max(0, Math.round(((setpoint - waterTemp) / SPA_HEAT_RATE) * 60))
      : null;

  return (
    <div style={{ padding: "20px 16px 32px", fontFamily: FONT_UI, color: C.stone }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 22 }}>
        <div>
          {/* Keyed off `target`, not `busy`: a heat sequence runs without
              changing mode, and there is no mode to name for it. */}
          <div style={{ fontSize: 11, letterSpacing: 2, color: C.muted, fontFamily: FONT_DATA, textTransform: "uppercase" }}>
            {target ? "Changing to" : "Mode"}
          </div>
          <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: -0.5, lineHeight: 1.2 }}>
            {MODES.find((m) => m.id === (target || mode)).label}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        {/* Tapping simulates a transport outage. Mock-only affordance, but
            the offline path it exposes is the real one. */}
        <button onClick={simulateOutage}
          aria-label={connected ? "Connected. Tap to simulate an outage" : "Offline. Tap to reconnect"}
          style={{
            display: "flex", alignItems: "center", gap: 6, background: "transparent",
            border: "none", padding: 0, cursor: "pointer", textAlign: "right",
            fontFamily: FONT_DATA, fontSize: 10, letterSpacing: 1,
            color: connected ? C.water : C.alert,
          }}>
          <span style={{
            width: 6, height: 6, borderRadius: 3,
            background: connected ? C.water : C.alert,
          }} />
          <span>
            {connected ? "LIVE" : "OFFLINE"}
            {stale && (
              <span style={{ display: "block", color: C.muted, letterSpacing: 0, fontSize: 9.5, marginTop: 2 }}>
                last seen {ago(Date.now() - lastSeen)}
              </span>
            )}
          </span>
        </button>
        {themeControl}
        </div>
      </div>

      {stale && (
        <div style={{
          background: C.surface, border: `1px solid ${C.alert}`, borderRadius: 12,
          padding: "12px 14px", marginBottom: 14, fontSize: 12.5, lineHeight: 1.5,
          color: C.alert,
        }}>
          <strong style={{ fontWeight: 600 }}>Not connected.</strong> Everything below
          is the last state received{" "}
          {ago(Date.now() - lastSeen)} and may no longer be true. Controls are
          disabled — the equipment carries on without the phone.
        </div>
      )}

      <div style={{
        background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14,
        padding: "18px 12px", marginBottom: 14,
        opacity: stale ? 0.45 : 1, transition: "opacity 200ms",
      }}>
        <Schematic valves={valves} heaterCall={heaterCall} onHeaterTap={onOpenHeat} />
      </div>

      {busy && (
        <div style={{ background: C.surface, border: `1px solid ${C.waterDim}`, borderRadius: 12, padding: 14, marginBottom: 14 }}>
          {steps.map((s, i) => {
            const done = i < stepIndex;
            const now = i === stepIndex;
            /* A skipped step is struck through, never dropped. The short
               path and the long path then look like the same sequence, which
               is the point — otherwise "Spa now" appears to do something
               different depending on how recently the heater ran. */
            const skipped = s.skipped;
            return (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0", opacity: skipped ? 0.35 : done ? 0.4 : now ? 1 : 0.3 }}>
                <span style={{ width: 7, height: 7, borderRadius: 4, flexShrink: 0, background: skipped ? "transparent" : done ? C.waterDim : now ? C.water : "transparent", border: `1px solid ${!skipped && (done || now) ? "transparent" : C.line}` }} />
                <span style={{ fontSize: 13, flex: 1, textDecoration: skipped ? "line-through" : "none" }}>{s.label}</span>
                <span style={{ fontFamily: FONT_DATA, fontSize: 11, color: C.muted, textDecoration: skipped ? "line-through" : "none" }}>
                  {skipped ? "skipped" : s.real}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Hold to switch. A tap commits ~2 min of valve travel that nobody can
          cancel (ABORTABLE is false), so the gesture is made deliberate. */}
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        {MODES.map((m) => (
          <HoldButton key={m.id} label={m.label}
            active={mode === m.id && !busy}
            disabled={busy || stale}
            onConfirm={() => setMode(m.id)} />
        ))}
      </div>
      <div style={{ fontSize: 11, color: C.faint, marginBottom: 16, paddingLeft: 2, lineHeight: 1.5 }}>
        {busy
          ? "Transition in progress — it cannot be cancelled."
          : stale
            ? "Reconnect to change mode."
            : "Hold for 5 seconds. Release early and nothing happens."}
      </div>

      {/* Spa mode is time-boxed, so the countdown is not a nicety: without it
          the revert arrives unannounced while someone is in the water. */}
      {mode === "spa" && spaExpiresAt && !busy && (
        <div style={{
          background: C.surface, border: `1px solid ${C.heat}`, borderRadius: 12,
          padding: "12px 14px", marginBottom: 16, display: "flex",
          alignItems: "center", gap: 12,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: C.heat }}>
              Reverts to pool in {countdown(spaExpiresAt - Date.now())}
            </div>
            <div style={{ fontFamily: FONT_DATA, fontSize: 10.5, color: C.muted, marginTop: 3, lineHeight: 1.45 }}>
              Valves swing back and the heater stops. Extend if you are still in.
            </div>
          </div>
          <button onClick={extendSpa} disabled={stale}
            style={{
              flexShrink: 0, padding: "11px 16px", borderRadius: 10,
              border: `1px solid ${C.heat}`, background: "transparent",
              color: C.heat, fontFamily: FONT_UI, fontSize: 13, fontWeight: 600,
              cursor: stale ? "not-allowed" : "pointer", opacity: stale ? 0.5 : 1,
            }}>
            Extend
          </button>
        </div>
      )}

      {mode !== "spa" && !busy && (
        preheat ? (
          <div style={{
            background: C.surface, border: `1px solid ${C.waterDim}`, borderRadius: 12,
            padding: "12px 14px", marginBottom: 16, display: "flex",
            alignItems: "center", gap: 12,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500 }}>
                Spa ready at {new Date(preheat.readyAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </div>
              <div style={{ fontFamily: FONT_DATA, fontSize: 10.5, color: C.muted, marginTop: 3, lineHeight: 1.45 }}>
                starts {new Date(preheat.startsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                {" · "}estimate only, the heating rate is unmeasured
              </div>
            </div>
            <button onClick={cancelPreheat} disabled={stale}
              style={{
                flexShrink: 0, padding: "11px 14px", borderRadius: 10,
                border: `1px solid ${C.line}`, background: "transparent",
                color: C.muted, fontFamily: FONT_UI, fontSize: 13,
                cursor: stale ? "not-allowed" : "pointer",
              }}>
              Cancel
            </button>
          </div>
        ) : (
          <button onClick={() => setSheet(true)} disabled={stale}
            style={{
              width: "100%", padding: 13, marginBottom: 16, borderRadius: 10,
              border: `1px dashed ${C.line}`, background: "transparent",
              color: C.muted, fontFamily: FONT_UI, fontSize: 13,
              cursor: stale ? "not-allowed" : "pointer", opacity: stale ? 0.5 : 1,
            }}>
            Have the spa ready at a set time
          </button>
        )
      )}

      {sheet && (
        <PreheatSheet
          waterTemp={waterTemp}
          targetTemp={targets.spa}
          onCancel={() => setSheet(false)}
          onConfirm={(readyAt) => { schedulePreheat(readyAt); setSheet(false); }}
        />
      )}

      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16, display: "flex", gap: 12, marginBottom: 10 }}>
        <Stat label="Water" value={waterTemp.toFixed(1)} unit="°F" tone={heaterCall !== "off" ? C.heat : C.stone} />
        <Stat label="Target" value={setpoint ?? "—"} unit={setpoint ? "°F" : ""} />
        <Stat label="Pump" value={pumpRpm} unit="rpm" />
      </div>

      {/* Heater section. Tapping opens the lean heat screen; the subtitle
          carries enough state that most of the time you never need to. */}
      <button onClick={onOpenHeat} aria-label="Heater settings"
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 12,
          background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14,
          padding: "14px 16px", marginBottom: 10, cursor: "pointer", textAlign: "left",
        }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: FONT_UI, fontSize: 13.5, fontWeight: 500, color: C.stone }}>
            Heater
          </div>
          <div style={{ fontFamily: FONT_DATA, fontSize: 10.5, color: heaterCall !== "off" ? C.heat : C.muted, marginTop: 3 }}>
            {heaterCall !== "off"
              ? `Calling for ${heaterCall} · ${setpoint}°F`
              : valves.bypass === "around"
                ? "Isolated · bypass around heater"
                : "Idle · flow through heater"}
          </div>
        </div>
        <div style={{ fontFamily: FONT_DATA, fontSize: 18, color: C.stone }}>
          {targets[mode]}<span style={{ fontSize: 11, color: C.muted, marginLeft: 1 }}>°F</span>
        </div>
        <span style={{ color: C.muted, fontSize: 18, lineHeight: 1 }}>›</span>
      </button>

      {heaterCall === "spa" && (blower || minsToSetpoint > 0) && (
        <div style={{ fontSize: 12.5, color: blower ? C.heat : C.muted, marginBottom: 16, paddingLeft: 2, lineHeight: 1.5 }}>
          {blower
            ? `Blower is running — it takes back about as much heat as the heater adds, so the water will hold rather than climb.`
            : `About ${minsToSetpoint} min to ${setpoint}°F.`}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <Toggle label="Blower" on={blower} disabled={stale || valves.intake !== "spa"}
          reason={stale ? "Not connected" : "Available in spa mode"}
          onClick={() => toggle("blower")} />
        <Toggle label="Light" on={light} disabled={stale}
          reason="Not connected" onClick={() => toggle("light")} />
      </div>

      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16, display: "flex", gap: 12 }}>
        <Stat label="Salt" value={saltPpm} unit="ppm" />
        <Stat label="Cell output" value={mode === "spa" ? 0 : cellOutput} unit="%" tone={mode === "spa" ? C.muted : C.stone} />
        <Stat label="Spill" value={valves.returns === "split" ? "On" : "Off"} tone={valves.returns === "split" ? C.water : C.muted} />
      </div>
    </div>
  );
}
