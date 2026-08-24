import { useState, useEffect, useRef, useCallback } from "react";

/**
 * Live transport. The real counterpart to `useController`.
 *
 * Same surface, so screens do not know or care which one they were given:
 * `{ state, setMode, setRpm, ... }`. The difference is that nothing here
 * mutates state locally. Every call is an intent sent to the supervisor, and
 * the UI only changes when the supervisor says it changed.
 *
 * That is ADR-7 made literal. A control that moves because you touched it is
 * lying if the equipment did not move — and on a phone that has lost signal,
 * it would lie constantly.
 *
 * Unknown is not zero. Fields njsPC cannot answer for arrive as `null` and
 * stay `null`; the UI renders those differently. A pump reading 0 rpm and a
 * pump we cannot hear from are not the same fact.
 */

/* Three missed heartbeats. The supervisor sends a frame every 5 s regardless
   of njsPC activity, so this tolerates ordinary jitter and only trips on a
   link that has genuinely stopped.

   This was 12 s against a 15 s poll, which guaranteed a false "not connected"
   banner in every quiet stretch. A staleness threshold must always be a
   multiple of the heartbeat it measures, never shorter than it. */
const HEARTBEAT_MS = 5000;
const STALE_MS = HEARTBEAT_MS * 3;

/** Same origin when served by the supervisor; overridable for `vite dev`. */
function socketUrl() {
  const override = import.meta.env?.VITE_SUPERVISOR;
  if (override) return override.replace(/^http/, "ws");
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}

export function useSupervisor() {
  const [state, setState] = useState(null);
  const [link, setLink] = useState({ up: false, lastMessage: null, error: null });

  const ws = useRef(null);
  const seq = useRef(0);
  const pending = useRef(new Map());
  const retry = useRef(null);

  const send = useCallback((intent, args = {}) => {
    const sock = ws.current;
    if (!sock || sock.readyState !== WebSocket.OPEN) {
      /* Refused rather than queued. Replaying a mode change after a
         reconnect could fire it minutes late, against different state. */
      return Promise.reject(new Error("not connected"));
    }
    const id = ++seq.current;
    sock.send(JSON.stringify({ id, intent, ...args }));
    return new Promise((resolve, reject) => {
      pending.current.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.current.delete(id)) reject(new Error("no acknowledgement"));
      }, 10000);
    });
  }, []);

  useEffect(() => {
    let closed = false;

    const connect = () => {
      if (closed) return;
      const sock = new WebSocket(socketUrl());
      ws.current = sock;

      sock.onopen = () => setLink((l) => ({ ...l, up: true, error: null }));

      sock.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === "state") {
          setState(msg.state);
          setLink((l) => ({ ...l, up: true, lastMessage: Date.now() }));
        } else if (msg.type === "ack") {
          const p = pending.current.get(msg.id);
          if (p) {
            pending.current.delete(msg.id);
            msg.ok ? p.resolve() : p.reject(new Error(msg.error || "refused"));
          }
        }
      };

      const down = () => {
        setLink((l) => ({ ...l, up: false }));
        if (!closed) retry.current = setTimeout(connect, 2000);
      };
      sock.onclose = down;
      sock.onerror = () => sock.close();
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry.current);
      ws.current?.close();
    };
  }, []);

  /* Staleness needs its own clock. Deriving it only during render meant the
     offline state appeared whenever something else happened to re-render —
     late, and at unpredictable moments. This makes the transition prompt and
     deterministic. */
  const [, forceTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  /* Two independent ways to be offline: the browser cannot reach the
     supervisor, or the supervisor cannot reach njsPC. Both mean the screen is
     not to be trusted, so both collapse to `connected: false` — but the
     reason is kept, because "which one" is the first thing you need. */
  const fresh = link.lastMessage != null && Date.now() - link.lastMessage < STALE_MS;
  const connected = link.up && fresh && Boolean(state?.connected);
  const reason = !link.up
    ? "No link to the controller"
    : !fresh
      ? "No update from the controller"
      : !state?.connected
        ? "Controller cannot reach njsPC"
        : null;

  /* Intents are fire-and-report. A rejection is surfaced, never swallowed —
     a refused mode change that looks like a successful one is the exact
     failure the UI is built to avoid. */
  const intent = useCallback(
    (name, args) =>
      send(name, args).catch((err) => {
        setLink((l) => ({ ...l, error: `${name}: ${err.message}` }));
        throw err;
      }),
    [send],
  );

  return {
    state: state ? { ...state, connected, offlineReason: reason } : null,
    linkError: link.error,

    setMode: (mode) => intent("setMode", { mode }),
    setTarget: (body, degrees) => intent("setTarget", { body, degrees }),
    setRpm: (rpm) => intent("setRpm", { rpm }),
    setPoolHeat: (on) => intent("setPoolHeat", { on }),
    toggle: (key) => intent("toggle", { key }),
    holdPump: (minutes) => intent("holdPump", { minutes }),
    releasePump: () => intent("releasePump"),
    extendSpa: (minutes) => intent("extendSpa", { minutes }),
    schedulePreheat: (readyAt) => intent("schedulePreheat", { readyAt }),
    cancelPreheat: () => intent("cancelPreheat"),
  };
}
