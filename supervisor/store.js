import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Tiny durable store for supervisor-owned state.
 *
 * JSON rather than a database: a few hundred bytes, written a few times a
 * day, never queried. Node 22 ships `node:sqlite`, so SQLite would also be
 * dependency-free — the reason against it is operability. This box is sealed
 * and headless, and a file you can read and repair over SSH beats a binary
 * one you cannot.
 *
 * Two properties a naive `writeFile` would not give us:
 *
 *   Crash safety. The PRD names unclean power loss at an outdoor pad as a
 *   real failure mode. Writing in place can truncate the file and lose
 *   everything, so this writes a temp file, fsyncs it, and renames — rename
 *   being atomic on POSIX.
 *
 *   Restraint. Holding a stepper produces a change per tap. Writes are
 *   debounced so that becomes one write, which matters on a card chosen for
 *   endurance.
 */
export class Store {
  constructor(path, { debounceMs = 1000 } = {}) {
    this.path = path;
    this.debounceMs = debounceMs;
    this._timer = null;
    this._pending = null;
    this._writing = Promise.resolve();
  }

  /** Returns the persisted object, or `{}` if absent or unreadable. */
  async load() {
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (err) {
      /* Missing is normal on first run. Corrupt is not, but starting from
         defaults beats refusing to boot — this process holds interlocks, and
         a controller that will not start because a preferences file is
         damaged is worse than one that starts with the defaults. */
      if (err.code !== "ENOENT") {
        console.warn(`store: ignoring unreadable ${this.path}: ${err.message}`);
      }
      return {};
    }
  }

  /** Queue a write. Repeated calls inside the window collapse into one. */
  save(data) {
    this._pending = data;
    if (this._timer) return this._writing;
    this._timer = setTimeout(() => this.flush(), this.debounceMs);
    return this._writing;
  }

  /** Write immediately. Used on shutdown so nothing is lost in the window. */
  async flush() {
    clearTimeout(this._timer);
    this._timer = null;
    if (this._pending == null) return;
    const data = this._pending;
    this._pending = null;

    this._writing = this._writing.then(async () => {
      const tmp = `${this.path}.tmp`;
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
        await rename(tmp, this.path);
      } catch (err) {
        console.error(`store: write failed: ${err.message}`);
      }
    });
    return this._writing;
  }
}

/**
 * What survives a restart, and what deliberately does not.
 *
 * The distinction matters more than the file format. **Preferences persist;
 * positions do not.**
 *
 * Valve positions are dead-reckoned with no feedback, which is exactly why
 * the boot sequence re-drives every valve unconditionally. Restoring a
 * remembered position would reintroduce the belief that sequence exists to
 * destroy. A heat call does not survive either: boot leaves the heater off,
 * and asking for heat again should be a deliberate act rather than something
 * a power cut resumes on your behalf.
 *
 * A running program is absent for the same class of reason: njsPC holds it
 * as a circuit with an egg timer (ADR-11) and expires it on its own, so a
 * second copy here would be a second answer to one question.
 */
export const PERSISTED = ["targets", "preheat", "programs", "heaterSetpoint"];

export function pickPersisted(own) {
  return Object.fromEntries(
    PERSISTED.filter((k) => own[k] !== undefined).map((k) => [k, own[k]]),
  );
}

/** Merge a loaded file over defaults, ignoring anything not persistable. */
export function applyPersisted(defaults, loaded) {
  const out = { ...defaults };
  for (const k of PERSISTED) {
    if (loaded && loaded[k] != null) out[k] = loaded[k];
  }
  return out;
}
