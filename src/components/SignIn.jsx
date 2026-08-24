import React, { useState } from "react";
import { C, FONT_UI, FONT_DATA } from "../theme";

/**
 * The whole app, behind one password.
 *
 * Deliberately plain. There is no account to create, nothing to recover and
 * nobody to be but the household — a screen offering any of that would be
 * inventing a system that does not exist. One field and one button.
 *
 * The error is the supervisor's own text rather than a generic line, because
 * "wrong password" and "too many attempts, wait 32s" are different problems
 * and the second one is the only clue that somebody else is trying.
 */
export default function SignIn({ onSignIn }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e?.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    const why = await onSignIn(password);
    setBusy(false);
    if (why) {
      setError(why);
      setPassword("");
    }
  };

  return (
    <div style={{
      minHeight: "100dvh", display: "flex", alignItems: "center",
      justifyContent: "center", padding: "24px 18px",
      fontFamily: FONT_UI, color: C.stone,
    }}>
      <form onSubmit={submit} style={{ width: "100%", maxWidth: 360 }}>
        <div style={{
          fontFamily: FONT_DATA, fontSize: 11, letterSpacing: "0.14em",
          color: C.muted, marginBottom: 6,
        }}>
          POOLCTL
        </div>
        <h1 style={{ fontSize: 26, fontWeight: 600, margin: "0 0 6px" }}>Sign in</h1>
        <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5, marginBottom: 20 }}>
          This controls 240 V equipment. The password is set on the Pi.
        </div>

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-label="Password"
          autoFocus
          autoComplete="current-password"
          style={{
            width: "100%", background: C.ground, border: `1px solid ${error ? C.alert : C.line}`,
            borderRadius: 10, color: C.stone, fontFamily: FONT_UI, fontSize: 16,
            padding: "13px 14px", boxSizing: "border-box",
          }}
        />

        {error && (
          <div style={{ fontSize: 12.5, color: C.alert, marginTop: 10, lineHeight: 1.5 }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={!password || busy}
          style={{
            width: "100%", marginTop: 14, padding: "14px 8px", borderRadius: 10,
            border: `1px solid ${!password || busy ? C.line : C.water}`,
            background: !password || busy ? "transparent" : C.water,
            color: !password || busy ? C.faint : C.ground,
            fontFamily: FONT_UI, fontSize: 15, fontWeight: 600,
            cursor: !password || busy ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
