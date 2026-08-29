#!/usr/bin/env node
/**
 * Record the *shape* of a real njsPC's responses, so the fake can be checked
 * against it.
 *
 * The fake in `binding.integration.test.js` is hand-written, and on
 * 29 August 2026 it was wrong three times in one sitting: `/config/all`
 * served `pumps: []` while every other route in the same fake served pump 50;
 * `/state/all` served `valves: []`, so the valves never diverted and a trace
 * showed the spa heat contact closing while they still read pool; and shared
 * bodies were not exclusive, so a switch back to pool left both circuits on.
 *
 * A fake that drifts from what it imitates makes a suite *less* trustworthy
 * than no suite, because it fails confidently.
 *
 * Shapes, not values: keys and types, arrays reduced to the shape of their
 * first element. Values would be this pool's configuration, would churn on
 * every equipment change, and would drag secrets into the repository.
 *
 *   NJSPC_URL=http://127.0.0.1:4200 node scripts/capture-njspc.mjs
 *
 * Run it over an SSH tunnel — njsPC is bound to loopback on purpose.
 */
import { writeFileSync } from "node:fs";

const URL_BASE = process.env.NJSPC_URL || "http://127.0.0.1:4200";

/* Only the GETs. The fake's writes are checked by the supervisor using them;
   what cannot be checked any other way is whether njsPC's *answers* still
   look the way the fake claims. */
const ROUTES = [
  "/state/all",
  "/config/all",
  "/config/options/pumps",
  "/config/options/schedules",
  "/config/options/heaters",
];

/** Anything that might be a credential never reaches the file. */
const SECRET = /pass|secret|token|key$/i;

function shapeOf(value, depth = 0) {
  if (depth > 6) return "…";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [shapeOf(value[0], depth + 1)];
  }
  if (typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = SECRET.test(k) ? "redacted" : shapeOf(value[k], depth + 1);
    }
    return out;
  }
  return typeof value;
}

const shapes = {};
for (const route of ROUTES) {
  const res = await fetch(`${URL_BASE}${route}`);
  if (!res.ok) {
    console.error(`${route}: ${res.status} — skipped`);
    continue;
  }
  shapes[route] = shapeOf(await res.json());
  console.error(`${route}: captured`);
}

const out = new URL("../supervisor/njspc-shapes.json", import.meta.url).pathname;
writeFileSync(out, `${JSON.stringify(shapes, null, 2)}\n`);
console.error(`wrote ${out}`);
