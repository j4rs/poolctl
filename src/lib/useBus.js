import { useState, useEffect, useRef, useCallback } from "react";
import { decode, classify, syntheticFrame } from "./rs485";

const CAP = 300; // ring buffer depth — a phone should not hold an hour of bus

/**
 * Bus feed.
 *
 * Mock counterpart to useController: swap the interval for a subscription to
 * the real serial port (or njsPC's socket) and nothing above this changes.
 *
 * Kept separate from useController deliberately. The controller models
 * equipment state; this models the wire. Phase 1 needs the wire before there
 * is any equipment state to speak of.
 */
export function useBus() {
  const [frames, setFrames] = useState([]);
  const [paused, setPaused] = useState(false);
  const [stats, setStats] = useState({ total: 0, decoded: 0, bad: 0, unknown: 0 });

  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const seq = useRef(0);

  useEffect(() => {
    const t = setInterval(() => {
      if (pausedRef.current) return;
      const f = decode(syntheticFrame());
      const kind = classify(f);
      const row = { ...f, kind, id: seq.current++, at: Date.now() };

      setFrames((fs) => [row, ...fs].slice(0, CAP));
      /* Stats count every frame seen, not just the ones still in the ring —
         a decode rate computed over a sliding window would drift as the
         buffer rolled. */
      setStats((s) => ({
        total: s.total + 1,
        decoded: s.decoded + (kind !== "unknown" && kind !== "bad" ? 1 : 0),
        bad: s.bad + (kind === "bad" ? 1 : 0),
        unknown: s.unknown + (kind === "unknown" ? 1 : 0),
      }));
    }, 550);
    return () => clearInterval(t);
  }, []);

  const clear = useCallback(() => {
    setFrames([]);
    setStats({ total: 0, decoded: 0, bad: 0, unknown: 0 });
  }, []);

  return { frames, stats, paused, setPaused, clear };
}
