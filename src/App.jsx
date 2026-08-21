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

const THEME_LABEL = { auto: "Auto", dark: "Night", light: "Day" };

/** Sun, moon, or half-and-half for auto. Drawn rather than an emoji so it
    inherits currentColor and stays crisp at any density. */
function ThemeIcon({ theme }) {
  const common = { width: 15, height: 15, viewBox: "0 0 16 16", "aria-hidden": true };
  if (theme === "light") {
    return (
      <svg {...common} style={{ display: "block" }}>
        <circle cx="8" cy="8" r="3.4" style={{ fill: "currentColor" }} />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
          <line key={deg} x1="8" y1="1.2" x2="8" y2="3" transform={`rotate(${deg} 8 8)`}
            style={{ stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" }} />
        ))}
      </svg>
    );
  }
  if (theme === "dark") {
    return (
      <svg {...common} style={{ display: "block" }}>
        <path d="M13 9.8A5.6 5.6 0 0 1 6.2 3a5.8 5.8 0 1 0 6.8 6.8Z"
          style={{ fill: "currentColor" }} />
      </svg>
    );
  }
  return (
    <svg {...common} style={{ display: "block" }}>
      <circle cx="8" cy="8" r="5.4" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.4 }} />
      <path d="M8 2.6a5.4 5.4 0 0 1 0 10.8Z" style={{ fill: "currentColor" }} />
    </svg>
  );
}

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

  /* Rendered by each screen in its header, beside the status badge. It lives
     up here so there is exactly one of it, and top-right on every screen so
     the reason to reach for it — walking into the sun — is one tap away
     wherever you happen to be. */
  const themeControl = (
    <button onClick={cycleTheme}
      aria-label={`Appearance: ${THEME_LABEL[theme]}. Tap to change.`}
      title={`Appearance: ${THEME_LABEL[theme]}`}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 34, height: 34, flexShrink: 0, borderRadius: 999,
        border: `1px solid ${C.line}`, background: C.surface,
        color: C.muted, cursor: "pointer", padding: 0,
      }}>
      <ThemeIcon theme={theme} />
    </button>
  );

  if (pushed === "heat") {
    return (
      <div style={{ background: C.ground, minHeight: "100vh", maxWidth: 460, margin: "0 auto" }}>
        <HeatControl controller={controller} onBack={() => setPushed(null)} />
      </div>
    );
  }

  return (
    <div style={{ background: C.ground, minHeight: "100vh", maxWidth: 460, margin: "0 auto", paddingBottom: 92 }}>
      <Screen controller={controller} themeControl={themeControl} onOpenHeat={() => setPushed("heat")} />

      {/* The mock badge lives inside the nav so it sits on an opaque surface.
          Floating it over the page put it on top of whatever happened to
          scroll underneath. */}
      <nav style={{
        position: "fixed", bottom: 0, left: 0, right: 0, maxWidth: 460, margin: "0 auto",
        background: C.surface, borderTop: `1px solid ${C.line}`,
        paddingBottom: "env(safe-area-inset-bottom)",
      }}>
        <div style={{ textAlign: "center", fontFamily: FONT_DATA, fontSize: 9, color: C.faint, letterSpacing: 1, padding: "7px 0 8px" }}>
          MOCK DATA
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
