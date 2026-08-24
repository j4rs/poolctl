import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Tap once to arm, tap again to act.
 *
 * These controls move 240 V equipment. A pump that stops because a thumb
 * landed while scrolling is not a UI annoyance — it is circulation ending
 * with nobody aware of it, and on the heat side it is a call left standing
 * into a pump that is no longer running.
 *
 * `HoldButton` already covers the mode switch, where the consequence is two
 * minutes of uncancellable valve travel and a five-second hold is
 * proportionate. This is the lighter counterpart, for actions that are
 * consequential but reversible: one extra tap, no modal, no hover.
 *
 * A modal was the obvious alternative and is worse here. This is a phone
 * held one-handed at a pool edge; a dialog moves the target somewhere else
 * on screen and puts "Cancel" under the thumb that was reaching for the
 * button. Arming in place keeps the target still and makes the second tap
 * the same motion as the first.
 *
 * Only one control is armed at a time — arming another disarms the first, so
 * a half-finished confirmation cannot sit waiting behind an unrelated one.
 * Arming lapses on its own, because a control left armed is a control that
 * will fire on the next stray tap, which is the thing being prevented.
 */
export function useConfirm({ windowMs = 4000 } = {}) {
  const [armed, setArmed] = useState(null);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const disarm = useCallback(() => {
    clearTimeout(timer.current);
    setArmed(null);
  }, []);

  /**
   * An onClick that arms on the first tap and runs `action` on the second.
   * `key` names the control, so two of them cannot be armed at once.
   */
  const guard = useCallback(
    (key, action) => () => {
      clearTimeout(timer.current);
      if (armed === key) {
        setArmed(null);
        action();
        return;
      }
      setArmed(key);
      timer.current = setTimeout(() => setArmed(null), windowMs);
    },
    [armed, windowMs],
  );

  const isArmed = useCallback((key) => armed === key, [armed]);

  return { armed, isArmed, guard, disarm };
}
