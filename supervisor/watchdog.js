/**
 * The systemd watchdog, and what it is allowed to mean.
 *
 * ADR-10 says a liveness ping from a wedged process is worse than no watchdog,
 * because it buys false confidence, and to "tie the heartbeat to the
 * invariants actually holding".
 *
 * **Read literally that is wrong, and this does not do it.** A breached
 * invariant is a fact about the *equipment* — a heat call with the pump below
 * its floor, say. Restarting the supervisor does not move water. The breach is
 * still there when we come back, the next pet fails too, and the result is a
 * restart loop with the equipment in a bad state, each cycle re-asserting the
 * relays. The PRD is explicit elsewhere that invariants **report and never
 * correct**, precisely because acting on a snapshot is how a supervisor makes
 * things worse; a watchdog that restarts on a violation is exactly that, with
 * a blunter instrument.
 *
 * So the health condition here is that **the checking is happening**, not that
 * the checks pass:
 *
 *   - `evaluate()` completed within the staleness window
 *   - it completed without throwing
 *
 * That catches the failures a restart actually fixes — a wedge, a deadlock, an
 * exception loop, an event loop starved by something upstream — and leaves a
 * real equipment breach on the Water screen, where a person belongs.
 *
 * **Why it shells out.** `sd_notify` is a datagram to an `AF_UNIX` socket, and
 * Node's `dgram` does UDP only; there is no unix-datagram socket in the
 * runtime and every binding that adds one is a native module. `systemd-notify`
 * costs a process per pet, which at a third of a 60 s window is three a
 * minute. That is the cheaper of the two prices.
 *
 * Inert when `WATCHDOG_USEC` is unset, so running the supervisor by hand or in
 * a test behaves exactly as it did before.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const NOTIFY = "/usr/bin/systemd-notify";

async function defaultNotify() {
  await run(NOTIFY, ["WATCHDOG=1"]);
}

/**
 * @param isHealthy  () => ({ ok: boolean, why?: string })
 * @param notify     injected for tests; sends WATCHDOG=1
 * @param now        injected for tests
 */
export function createWatchdog({
  isHealthy, log = console, notify = defaultNotify, now = Date.now,
  usec = Number(process.env.WATCHDOG_USEC),
} = {}) {
  const enabled = Number.isFinite(usec) && usec > 0;

  /* A third of the window, not a half. systemd kills at the window; petting at
     half leaves no room for a slow spawn under load, which is exactly when a
     watchdog should not be the thing that fires. */
  const periodMs = enabled ? Math.max(1000, Math.floor(usec / 1000 / 3)) : 0;

  let timer = null;
  let withheld = false;
  let pets = 0;

  async function tick() {
    let verdict;
    try {
      verdict = isHealthy();
    } catch (err) {
      verdict = { ok: false, why: `health check threw: ${err.message}` };
    }

    if (!verdict || !verdict.ok) {
      /* Say it once. systemd will decide what happens next, and the journal
         needs to explain the kill that follows, not bury it in repetition. */
      if (!withheld) {
        withheld = true;
        log.error(
          `watchdog: withholding the ping — ${verdict?.why || "unhealthy"}. ` +
          `systemd will restart this service in at most ${Math.round(usec / 1e6)} s.`,
        );
      }
      return { petted: false, why: verdict?.why };
    }

    if (withheld) { log.log("watchdog: healthy again, resuming"); withheld = false; }
    try {
      await notify();
      pets++;
      return { petted: true };
    } catch (err) {
      /* Failing to *send* is not a reason to claim ill health, but it does
         mean the watchdog is not protecting anything, which is worth saying. */
      log.error(`watchdog: could not send the ping — ${err.message}`);
      return { petted: false, error: err };
    }
  }

  return {
    enabled,
    periodMs,
    get pets() { return pets; },
    get withholding() { return withheld; },
    tick,
    start() {
      if (!enabled || timer) return false;
      timer = setInterval(() => { tick().catch(() => {}); }, periodMs);
      timer.unref?.();
      log.log(`watchdog: systemd window ${Math.round(usec / 1e6)} s, pinging every ${Math.round(periodMs / 1000)} s`);
      return true;
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}

/**
 * The health condition itself, kept separate so it can be argued with in a
 * test without a systemd anywhere near it.
 */
export function evaluationHealth({ lastEvaluatedAt, lastError, now, staleAfterMs }) {
  if (lastError) return { ok: false, why: `last evaluation threw: ${lastError}` };
  if (!lastEvaluatedAt) return { ok: false, why: "no evaluation has completed yet" };
  const age = now - lastEvaluatedAt;
  if (age > staleAfterMs) {
    return { ok: false, why: `last evaluation was ${Math.round(age / 1000)} s ago` };
  }
  return { ok: true };
}
