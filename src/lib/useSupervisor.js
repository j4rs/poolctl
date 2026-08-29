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

/* Human names for intents, so a refusal reads as something the operator did
   rather than something the code called. */
const INTENT_LABEL = {
  setMode: "Change mode",
  setTarget: "Set target",
  setRpm: "Set pump speed",
  setPoolHeat: "Pool heat",
  setPumpRunning: "Run the pump",
  setPanelMode: "Automation mode",
  startProgram: "Run program",
  stopProgram: "Stop program",
  saveProgram: "Save program",
  deleteProgram: "Delete program",
  toggle: "Switch",
  extendSpa: "Extend spa",
  schedulePreheat: "Schedule preheat",
  cancelPreheat: "Cancel preheat",
};

/** Same origin when served by the supervisor; overridable for `vite dev`. */
function socketUrl() {
  const override = import.meta.env?.VITE_SUPERVISOR;
  if (override) return override.replace(/^http/, "ws");
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}

/**
 * `enabled: false` builds the hook but never opens the socket.
 *
 * `App` calls both transports unconditionally, because React needs a stable
 * hook order and the mock's timers are cheap. That was harmless while the
 * only way to reach the mock was `vite dev` on a machine with no supervisor
 * — the socket simply failed once. The demo build published to a static host
 * is different: `socketUrl()` falls back to `location.host`, so the page
 * would reconnect against the CDN serving it, forever, and 404 on
 * `/auth/status` on every attempt. Idle has to be a real state, not an
 * accident of nothing answering.
 */
export function useSupervisor({ enabled = true } = {}) {
  const [state, setState] = useState(null);
  const [link, setLink] = useState({ up: false, lastMessage: null, error: null });

  /* The last refused intent. Every control here is a request that can be
     turned down — by an interlock, by a lost link, or because the supervisor
     has not learned it yet. A refusal that is not shown is indistinguishable
     from a dead button. */
  const [problem, setProblem] = useState(null);

  /* Whether the supervisor wants a password, and whether we have given it
     one. Null while unknown, so the app can wait rather than flashing a
     login screen at somebody who is already signed in.

     A browser cannot read the reason a WebSocket upgrade failed — `onclose`
     carries no HTTP status — so a refused socket is indistinguishable from a
     dead supervisor from inside the callback. `/auth/status` is what tells
     the two apart, and it is asked whenever the socket will not open. */
  const [auth, setAuth] = useState({ required: null, authenticated: null });

  const ws = useRef(null);
  const seq = useRef(0);
  const pending = useRef(new Map());
  const retry = useRef(null);
  /* Set by the effect below so signing in can reconnect at once. */
  const reconnect = useRef(() => {});

  const send = useCallback((intent, args = {}) => {
    const sock = ws.current;
    if (!sock || sock.readyState !== WebSocket.OPEN) {
      /* Refused rather than queued. Replaying a mode change after a
         reconnect could fire it minutes late, against different state. */
      return Promise.reject(new Error("not connected"));
    }
    const id = ++seq.current;
    /* Arguments are nested, not spread. Flattening them let an intent
       parameter called `id` overwrite the envelope's correlation id, so acks
       matched the wrong request — silently, and only for the intents that
       happen to take an id. */
    sock.send(JSON.stringify({ reqId: id, intent, args }));
    return new Promise((resolve, reject) => {
      pending.current.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.current.delete(id)) reject(new Error("no acknowledgement"));
      }, 10000);
    });
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    let closed = false;

    const connect = () => {
      if (closed) return;
      const sock = new WebSocket(socketUrl());
      ws.current = sock;

      sock.onopen = () => {
        setLink((l) => ({ ...l, up: true, error: null }));
        /* Getting in is proof enough; no need to ask. */
        setAuth((a) => ({ ...a, authenticated: true }));
      };

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
          const p = pending.current.get(msg.reqId);
          if (p) {
            /* `reqId`, not `id` — the envelope has no `id`, so this deleted
               nothing and left every settled request in the map for the
               timeout to sweep ten seconds later. Harmless only because
               rejecting a resolved promise is a no-op. */
            pending.current.delete(msg.reqId);
            msg.ok ? p.resolve() : p.reject(new Error(msg.error || "refused"));
          }
        }
      };

      const down = () => {
        setLink((l) => ({ ...l, up: false }));
        /* Ask why. A 401 on the upgrade and a supervisor that has stopped
           look identical here; only this call separates them. */
        fetch("/auth/status", { credentials: "same-origin" })
          .then((r) => r.json())
          .then((a) => !closed && setAuth(a))
          .catch(() => {});
        if (!closed) retry.current = setTimeout(connect, 2000);
      };
      sock.onclose = down;
      sock.onerror = () => sock.close();
    };

    /**
     * Reconnect now rather than waiting out the retry.
     *
     * Not `ws.current.close()`: after a refused upgrade the socket is
     * already closed, so closing it again fires no `onclose` and schedules
     * nothing. Signing in cleared the pending retry and then waited forever
     * on a socket that was never going to reopen — the app got past the
     * login screen and sat on "Waiting for the controller".
     */
    reconnect.current = () => {
      clearTimeout(retry.current);
      if (ws.current?.readyState === WebSocket.OPEN) return;
      connect();
    };

    connect();
    return () => {
      closed = true;
      reconnect.current = () => {};
      clearTimeout(retry.current);
      ws.current?.close();
    };
  }, [enabled]);

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
        /* The supervisor phrases refusals as "intent 'setPoolHeat' not
           implemented in v0" — fine in a log, redundant beside a label. */
        const why = err.message.replace(/^intent '[^']+' /, "");
        setProblem({ text: `${INTENT_LABEL[name] ?? name} — ${why}`, at: Date.now() });
        /* Swallowed deliberately: the refusal is now on screen, and rethrowing
           would make every call site handle something already handled. */
      }),
    [send],
  );

  /**
   * Sign in, then reconnect immediately rather than waiting out the retry.
   *
   * Returns the supervisor's own words on failure — "wrong password" or the
   * throttle's countdown — because a login screen that says "something went
   * wrong" is the least useful screen there is.
   */
  const signIn = useCallback(async (password) => {
    let res;
    try {
      res = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ password }),
      });
    } catch {
      return "Cannot reach the controller.";
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) return body.error ?? "Wrong password.";

    setAuth({ required: true, authenticated: true });
    reconnect.current();
    return null;
  }, []);

  const signOut = useCallback(async () => {
    await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
    setAuth({ required: true, authenticated: false });
    ws.current?.close();
  }, []);

  return {
    state: state ? { ...state, connected, offlineReason: reason } : null,
    /* True only when we know a password is wanted and we have not given one.
       Never true while the answer is still unknown. */
    needsSignIn: auth.required === true && auth.authenticated === false,
    signIn,
    signOut,
    linkError: link.error,
    problem,
    dismissProblem: () => setProblem(null),

    setMode: (mode) => intent("setMode", { mode }),
    /* Absolute set. The stepper uses adjustTarget instead — see below. */
    setTarget: (body, degrees) => intent("setTarget", { body, degrees }),
    /* Relative. A function cannot cross JSON, and resolving one here against
       state that may be a frame behind would drop taps. The supervisor
       accumulates and clamps. */
    adjustTarget: (body, delta) => intent("setTarget", { body, delta }),
    setRpm: (rpm) => intent("setRpm", { rpm }),
    setPoolHeat: (on) => intent("setPoolHeat", { on }),
    setPumpRunning: (on) => intent("setPumpRunning", { on }),
    setPanelMode: (mode) => intent("setPanelMode", { mode }),
    startProgram: (id) => intent("startProgram", { id }),
    /* Create the njsPC circuit this program's speed lives on. Saving already
       attempts it; this is the retry for when njsPC was down at the time. */
    bindProgram: (id) => intent("bindProgram", { id }),
    stopProgram: () => intent("stopProgram"),
    saveProgram: (program) => intent("saveProgram", { program }),
    deleteProgram: (id) => intent("deleteProgram", { id }),
    /* Schedules live in njsPC, which owns and evaluates them. These write
       through; the list comes back from njsPC's own state. */
    saveSchedule: (schedule) => intent("saveSchedule", { schedule }),
    deleteSchedule: (id) => intent("deleteSchedule", { id }),
    setScheduleEnabled: (id, on) => intent("setScheduleEnabled", { id, on }),
    toggle: (key) => intent("toggle", { key }),
    /* No argument: njsPC can only reset the egg timer to a full session, not
       add an arbitrary amount, and a full session is what the button means. */
    extendSpa: () => intent("extendSpa"),
    schedulePreheat: (readyAt) => intent("schedulePreheat", { readyAt }),
    cancelPreheat: () => intent("cancelPreheat"),
  };
}
