import React, { useState, useEffect } from "react";
import { C, FONT_UI, FONT_DATA, THEMES, readTheme, applyTheme } from "./theme";
import { useController } from "./lib/useController";
import PoolSpaControl from "./screens/PoolSpaControl";
import PumpControl from "./screens/PumpControl";
import HeatControl from "./screens/HeatControl";
import BusMonitor from "./screens/BusMonitor";

const TABS = [
  { id: "water", label: "Water", Screen: PoolSpaControl },
  { id: "pump", label: "Pump", Screen: PumpControl },
  /* Diagnostics, not daily use — but Phase 1 lives here, so it earns a tab
     until the chlorinator path is settled. */
  { id: "bus", label: "Bus", Screen: BusMonitor },
];

const THEME_LABEL = { auto: "Auto", dark: "Dark", light: "Day" };

export default function App() {
  const [tab, setTab] = useState("water");
  /* Daylight matters here: this is read at midday in Florida sun, where the
     dark palette is unreadable. Auto follows the OS; the override exists
     because the OS often does not know you have walked outside. */
  const [theme, setTheme] = useState(readTheme);
  /* The updater stays pure — React runs it during render and double-invokes
     it under StrictMode, so touching the DOM in there is a bug waiting to
     happen. The side effect belongs in an effect. Functional form so taps
     arriving faster than a re-render do not all compute from a stale value. */
  const cycleTheme = () =>
    setTheme((cur) => THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
  useEffect(() => { applyTheme(theme); }, [theme]);
  /* A focused screen pushed over the tabs. Not a router — one level, one
     way back. The tab bar hides so the screen stays lean. */
  const [pushed, setPushed] = useState(null);
  const controller = useController();
  const { Screen } = TABS.find((t) => t.id === tab);

  if (pushed === "heat") {
    return (
      <div style={{ background: C.ground, minHeight: "100vh", maxWidth: 460, margin: "0 auto" }}>
        <HeatControl controller={controller} onBack={() => setPushed(null)} />
      </div>
    );
  }

  return (
    <div style={{ background: C.ground, minHeight: "100vh", maxWidth: 460, margin: "0 auto", paddingBottom: 92 }}>
      <Screen controller={controller} onOpenHeat={() => setPushed("heat")} />

      {/* The mock badge lives inside the nav so it sits on an opaque surface.
          Floating it over the page put it on top of whatever happened to
          scroll underneath. */}
      <nav style={{
        position: "fixed", bottom: 0, left: 0, right: 0, maxWidth: 460, margin: "0 auto",
        background: C.surface, borderTop: `1px solid ${C.line}`,
        paddingBottom: "env(safe-area-inset-bottom)",
      }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
          fontSize: 9, color: C.faint, letterSpacing: 1, padding: "7px 0 8px",
        }}>
          <span>MOCK DATA</span>
          <button onClick={cycleTheme} aria-label={`Theme: ${THEME_LABEL[theme]}. Tap to change.`}
            style={{
              background: "transparent", border: `1px solid ${C.line}`, borderRadius: 999,
              color: C.muted, fontFamily: FONT_DATA, fontSize: 9, letterSpacing: 1,
              padding: "2px 8px", cursor: "pointer", textTransform: "uppercase",
            }}>
            {THEME_LABEL[theme]}
          </button>
        </div>
        <div style={{ display: "flex" }}>
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              style={{
                flex: 1, padding: "13px 0 16px", background: "transparent",
                /* Longhands only. Mixing `border` with `borderTop` makes
                   React warn every time the active tab changes. */
                borderLeft: "none", borderRight: "none", borderBottom: "none",
                borderTop: `2px solid ${tab === t.id ? C.water : "transparent"}`,
                color: tab === t.id ? C.water : C.muted,
                fontFamily: FONT_UI, fontSize: 13, fontWeight: 500, cursor: "pointer",
              }}>
              {t.label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
