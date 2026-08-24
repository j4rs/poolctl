import { SPA_TIMEOUT_MIN } from "../src/lib/sequences.js";
import { DONT_STOP_MINUTES } from "./binding.js";

/**
 * Settings that live on njsPC rather than in this repo, checked against what
 * we believe they are.
 *
 * The commissioning list in CLAUDE.md opens by saying that forgetting one of
 * these is a silent fault. It was: a Spa circuit left with `eggTimer: 1` from
 * an afternoon of testing produced a one-minute spa session, and the screen
 * reported the resulting countdown perfectly accurately without ever
 * suggesting anything was wrong. Being right about the wrong configuration is
 * not much use at the side of a pool.
 *
 * These are checks, not corrections. The supervisor does not quietly rewrite
 * equipment configuration to match its own expectations — njsPC owns it,
 * dashPanel edits it, and a process that silently reverted a deliberate
 * change would be worse than one that says what it found.
 *
 * Everything here is a pure function of what njsPC reported, so each rule can
 * be argued with in a test rather than only observed in the wild.
 */

/** njsPC's own default, and far too long to be anybody's intent. */
export const NJSPC_DEFAULT_EGG_TIMER = 720;

/**
 * `circuits` is `{ [id]: { name, eggTimer, dontStop } }` as read from
 * `/config/circuit/:id`. Missing entries produce no findings: not knowing is
 * not the same as knowing something is wrong.
 */
export function checkCommissioning({ spaCircuit } = {}) {
  const findings = [];
  if (!spaCircuit) return findings;

  const egg = spaCircuit.eggTimer;

  if (spaCircuit.dontStop || egg >= DONT_STOP_MINUTES) {
    findings.push({
      id: "spa-egg-never",
      severity: "warn",
      what: "Spa sessions never end on their own",
      detail:
        `njsPC reads ${DONT_STOP_MINUTES} minutes or more as "don't stop", so ` +
        `nothing will switch the spa back to pool. Set the Spa circuit egg ` +
        `timer to ${SPA_TIMEOUT_MIN}.`,
    });
    return findings;
  }

  if (egg === NJSPC_DEFAULT_EGG_TIMER) {
    findings.push({
      id: "spa-egg-default",
      severity: "warn",
      what: `Spa sessions last ${NJSPC_DEFAULT_EGG_TIMER / 60} hours`,
      detail:
        `That is njsPC's untouched default rather than a choice. Set the Spa ` +
        `circuit egg timer to ${SPA_TIMEOUT_MIN}.`,
    });
    return findings;
  }

  /* A session shorter than the transition it takes to get there is not a
     session. Spa -> pool -> spa is roughly two minutes of valve travel. */
  if (Number.isFinite(egg) && egg > 0 && egg < 5) {
    findings.push({
      id: "spa-egg-tiny",
      severity: "warn",
      what: `Spa sessions end after ${egg} minute${egg === 1 ? "" : "s"}`,
      detail:
        `njsPC will switch back to pool that soon after the spa starts — ` +
        `less time than the transition that gets you there. Set the Spa ` +
        `circuit egg timer to ${SPA_TIMEOUT_MIN}.`,
    });
    return findings;
  }

  if (Number.isFinite(egg) && egg > 0 && egg !== SPA_TIMEOUT_MIN) {
    /* Not wrong, just not what this repo believes. `SPA_TIMEOUT_MIN` is used
       by the mock and named in the invariants, so a divergence means two
       numbers describing one fact — the duplication ADR-10 exists to avoid. */
    findings.push({
      id: "spa-egg-differs",
      severity: "note",
      what: `Spa sessions end after ${egg} min, not ${SPA_TIMEOUT_MIN}`,
      detail:
        `njsPC's egg timer is the one that actually runs. If ${egg} is ` +
        `deliberate, change SPA_TIMEOUT_MIN to match.`,
    });
  }

  return findings;
}
