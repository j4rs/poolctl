import React, { useState } from "react";
import { C, FONT_UI } from "./theme";
import { useController } from "./lib/useController";
import PoolSpaControl from "./screens/PoolSpaControl";
import PumpControl from "./screens/PumpControl";

const TABS = [
  { id: "water", label: "Water", Screen: PoolSpaControl },
  { id: "pump", label: "Pump", Screen: PumpControl },
];

export default function App() {
  const [tab, setTab] = useState("water");
  const controller = useController();
  const { Screen } = TABS.find((t) => t.id === tab);

  return (
    <div style={{ background: C.ground, minHeight: "100vh", maxWidth: 460, margin: "0 auto", paddingBottom: 92 }}>
      <Screen controller={controller} />

      {/* The mock badge lives inside the nav so it sits on an opaque surface.
          Floating it over the page put it on top of whatever happened to
          scroll underneath. */}
      <nav style={{
        position: "fixed", bottom: 0, left: 0, right: 0, maxWidth: 460, margin: "0 auto",
        background: C.surface, borderTop: `1px solid ${C.line}`,
        paddingBottom: "env(safe-area-inset-bottom)",
      }}>
        <div style={{ textAlign: "center", fontSize: 9, color: C.faint, letterSpacing: 1, padding: "7px 0 8px" }}>
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
