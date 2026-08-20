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
    <div style={{ background: C.ground, minHeight: "100vh", maxWidth: 460, margin: "0 auto", paddingBottom: 72 }}>
      <Screen controller={controller} />

      <nav style={{
        position: "fixed", bottom: 0, left: 0, right: 0, maxWidth: 460, margin: "0 auto",
        display: "flex", background: C.surface, borderTop: `1px solid ${C.line}`,
        paddingBottom: "env(safe-area-inset-bottom)",
      }}>
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{
              flex: 1, padding: "16px 0", background: "transparent", border: "none",
              borderTop: `2px solid ${tab === t.id ? C.water : "transparent"}`,
              color: tab === t.id ? C.water : C.muted,
              fontFamily: FONT_UI, fontSize: 13, fontWeight: 500, cursor: "pointer",
            }}>
            {t.label}
          </button>
        ))}
      </nav>

      <div style={{
        position: "fixed", bottom: 56, left: 0, right: 0, maxWidth: 460, margin: "0 auto",
        textAlign: "center", fontSize: 9, color: C.faint, letterSpacing: 1, pointerEvents: "none",
      }}>
        MOCK DATA
      </div>
    </div>
  );
}
