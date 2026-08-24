import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, pickPersisted, applyPersisted, PERSISTED } from "./store.js";

let dir, path;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "poolctl-"));
  path = join(dir, "state.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("Store", () => {
  it("returns empty rather than throwing when the file is absent", async () => {
    expect(await new Store(path).load()).toEqual({});
  });

  it("starts from defaults rather than refusing to boot on a corrupt file", async () => {
    /* This process holds interlocks. Failing to start because a preferences
       file is damaged is worse than starting with defaults. */
    await writeFile(path, "{ this is not json");
    expect(await new Store(path).load()).toEqual({});
  });

  it("round-trips", async () => {
    const s = new Store(path, { debounceMs: 0 });
    s.save({ targets: { pool: 90, spa: 100 } });
    await s.flush();
    expect(await new Store(path).load()).toEqual({ targets: { pool: 90, spa: 100 } });
  });

  it("collapses a burst of saves into one write", async () => {
    const s = new Store(path, { debounceMs: 20 });
    for (let i = 1; i <= 30; i++) s.save({ targets: { pool: i } });
    await new Promise((r) => setTimeout(r, 60));
    await s.flush();
    /* Only the final value should survive — thirty taps, one write. */
    expect(JSON.parse(await readFile(path, "utf8")).targets.pool).toBe(30);
  });

  it("leaves no temp file behind", async () => {
    const s = new Store(path, { debounceMs: 0 });
    s.save({ targets: { pool: 88 } });
    await s.flush();
    await expect(readFile(`${path}.tmp`, "utf8")).rejects.toThrow();
  });
});

describe("what persists", () => {
  const own = {
    targets: { pool: 88, spa: 102 },
    preheat: null,
    programs: [{ id: "skimming", name: "Skimming", rpm: 2100, minutes: 30 }],
    bypass: "flow",
    poolHeatDemand: true,
    activeProgram: { id: "skimming", endsAt: 1 },
    connected: true,
  };

  it("keeps preferences", () => {
    expect(Object.keys(pickPersisted(own)).sort()).toEqual([...PERSISTED].sort());
    expect(pickPersisted(own).targets).toEqual({ pool: 88, spa: 102 });
  });

  it("keeps user-defined programs", () => {
    /* They are preferences, not positions: no hardware coupling, and losing
       them on restart would mean redefining them by hand. */
    expect(pickPersisted(own).programs).toHaveLength(1);
  });

  it("never persists a dead-reckoned valve position", () => {
    /* Boot re-drives every valve precisely because remembered position is not
       trustworthy. Restoring one would undo that. */
    expect(pickPersisted(own).bypass).toBeUndefined();
  });

  it("never resumes a heat call across a restart", () => {
    expect(pickPersisted(own).poolHeatDemand).toBeUndefined();
  });

  it("leaves a running program to njsPC", () => {
    /* njsPC holds it as a circuit with an egg timer and expires it itself. */
    expect(pickPersisted(own).activeProgram).toBeUndefined();
  });

  it("restores preferences over defaults and ignores the rest", () => {
    const defaults = { targets: { pool: 88, spa: 102 }, bypass: "around", poolHeatDemand: false };
    const merged = applyPersisted(defaults, { targets: { pool: 75, spa: 99 }, bypass: "flow", poolHeatDemand: true });
    expect(merged.targets).toEqual({ pool: 75, spa: 99 });
    expect(merged.bypass).toBe("around");
    expect(merged.poolHeatDemand).toBe(false);
  });
});
