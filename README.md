# poolctl-ui

Controller UI and supervisor for a DIY pool/spa automation system replacing a
Pentair IntelliConnect, built on nodejs-poolController. Runs against real
njsPC, or standalone on mock data with no hardware at all.

> ### ⚠️ Safety
>
> This repository documents a system that switches **240 V pool equipment**:
> a heat pump, a variable-speed pump, and a 1.5 HP blower, in a wet
> environment.
>
> - The 240 V side — circuits, disconnects, GFCI, and **NEC 680 equipotential
>   bonding** — is work for a licensed electrician, and in most jurisdictions
>   requires a permit and inspection. Do not treat this repo as a wiring guide.
> - The design deliberately keeps the heater's own thermostat and its hard
>   temperature caps (95 °F pool, 104 °F spa) in the heater's firmware, so no
>   software bug here can produce a scalding spa. **Do not move thermostat
>   logic into software.** See ADR-4.
> - Everything here is specific to one site's plumbing and equipment. Valve
>   travels, relay wiring, and flow thresholds are not transferable. Survey
>   your own system.
>
> Provided as-is, with no warranty — see [LICENSE](LICENSE).

## Status

The whole stack runs on the Pi: njsPC v10.0.1 on loopback, the supervisor on
the LAN behind a password, both as systemd services verified across a reboot,
with a watchdog that restarts a wedged supervisor. The relay HAT arrived on
27 August and its channel map is measured rather than assumed — the card's
routing does not match the driver its own product page names.

**No equipment is connected to the bus**, so njsPC has no serial port and
every reading is null. That has still been enough to settle most of the
design, and null-everywhere is the state the tests are written against.

Implemented in the supervisor: mode changes, heat targets with server-side
clamping, blower and light, pool heat with the bypass interlock, the purge
that holds flow through the exchanger after a call ends, pump run/stop,
service mode, manual programs bound to real njsPC circuits, and relay
driving through the HAT. Not yet: valve travel modelling, scheduled preheat,
and anything needing a real water temperature.

## Run

Standalone, on mock data — no backend needed:

```bash
npm install && npm run dev
```

Against a real njsPC, with the supervisor serving the built app:

```bash
npm run build && cd supervisor && npm install && npm start
```

Then open `http://localhost:4300`.

Set a password before letting it near a network — there is no way to set one
through the app, deliberately:

```bash
node supervisor/passwd.js
```

Without one the supervisor still runs, warns at startup, and says so on the
Water screen. It serves plain HTTP, so a password raises the bar from "anyone
on the wifi" to "anyone who can intercept traffic on it" — it is not a
substitute for TLS, which is not built. `--host` is on in dev, so you can load it
on a phone from the same network — worth doing, since this is a phone-first UI.

## Tests

```bash
npm test
```

Covers the client, the supervisor's pure logic, the njsPC translation layer,
and every screen rendered against state where nothing is known — which is the
case real hardware produces and a mock never does.

It also covers the socket layer end to end. The supervisor is spawned as a
real process on a real port and driven over a real WebSocket, with njsPC
pointed at a dead one — reconnection, the heartbeat, ack correlation,
persistence across a restart, and every refusal. That part takes about 18 s,
and it is where both of this layer's shipped bugs lived.

Above that sit the integration suites, which simulate the interfaces and
script the physics: a PCA9554 relay card that lives in a JSON file and is
invoked exactly as `i2cset`/`i2cget` are, and an njsPC that answers real HTTP
with shapes captured from a real one. Neither the supervisor nor `hat.js`
knows it is being faked. Those suites assert the **trace**, not the resting
state — every fault they found had the right end position and the wrong route
through it.

## Screens

- **Water** — mode switching with a live water-path schematic, transition
  step list, temperatures, blower and light.
- **Heat** — target temperature per body and pool heat on/off. Reached by
  tapping the heater. Targets are cutoffs clamped to the heater's own caps,
  never setpoints — see ADR-4.
- **Pump** — run/stop, manual programs (a name, a speed and a required
  expiry), service mode to stand the schedules down, and schedules with
  add/edit/delete and real energy cost. Schedules are njsPC's own, read and
  written through; each one runs a circuit, so a manual program is also the
  thing a schedule can put on a timer. No speed slider: njsPC drives the pump
  from circuits, and an arbitrary rpm has neither a user nor a lifetime. Each
  program becomes an njsPC circuit with a pump speed and an egg timer; the
  supervisor creates it, and a program that has none says why it cannot run.
- **Bus** — RS-485 frame monitor for Phase 1 sniffing. Decode rate, per-frame
  hex and checksum, and undecoded frames surfaced rather than hidden, since
  those are what decide the chlorinator path (ADR-6).

## Structure

```
src/
  theme.js / theme.css     design tokens, light and dark
  lib/sequences.js         transition spec + invariants — the supervisor mirrors it
  lib/programs.js          manual pump programs
  lib/pump.js              rpm/watts/schedule maths
  lib/rs485.js             Pentair frame decoders — unverified against a real bus
  lib/useController.js     mock state, for running standalone
  lib/useSupervisor.js     live transport — same surface as the mock
  lib/useConfirm.js        two-tap confirm for taps that move equipment
  components/              Schematic, Stat, Toggle, TargetTemp, HoldButton,
                           Sheet, ScheduleEditor, ProgramEditor, PreheatSheet,
                           Toast, DelayProgress
  screens/                 PoolSpaControl, HeatControl, PumpControl, BusMonitor
supervisor/                runs on the Pi; plain JS, no build step
  index.js                 njsPC link, intents, WebSocket, serves dist/
  map.js                   njsPC state -> the shape the UI speaks
  interlocks.js            the rules njsPC lacks — pure, tested
  invariants.js            the invariants, checked against what is true now
  commissioning.js         njsPC settings checked against what we believe
  binding.js               program -> njsPC circuit + pump speed
  schedules.js             njsPC schedules <-> the shape the UI speaks
  targets.js               ADR-4 clamping
  store.js                 durable preferences
  auth.js                  password hashing and signed sessions
  passwd.js                CLI to set the password
  hat.js                   the I2C relay card, driven through i2cget/i2cset
  relays.js                the measured relay -> bit map, and byte naming
  watchdog.js              systemd sd_notify, so a wedged process is restarted
docs/architecture.md       system view, state ownership, failure modes
docs/pi-bringup.md         flashed card -> running controller, in order
docs/prds/poolctl-v1.md    full requirements, ADRs, and open questions
CLAUDE.md                  compressed operating context for agents
```

Tests sit beside what they cover as `*.test.js[x]` and never reach `dist/`.

## Wiring to real hardware

`useSupervisor` already does this; `useController` remains so the app runs
standalone on mock data. Both present the same surface, so a screen cannot
tell which one it is talking to.

The UI must never issue equipment primitives. It says `setMode('spa')`; the
supervisor decides what that means and enforces every interlock. A phone
loses signal mid-tap and the state machine has to hold regardless — see
ADR-7.

`src/lib/sequences.js` is **not** a program the server runs, and an earlier
version of this file said it was. The supervisor imports named constants and
the invariant list from it and nothing else; the step-by-step transition list
is mock-only, because every duration in it is invented and a progress bar
that looks measured while being a guess is worse than none. Live progress
comes from njsPC's own `delays[]`, which has a real clock behind it. The
attribution is in [`docs/architecture.md`](docs/architecture.md) under
"Sequence ownership".

## Mock timings

Transition steps run compressed so sequences are watchable during
development. True durations are in each step's `real` field and shown in the
UI.

## Upstream

- [nodejs-poolController](https://github.com/tagyoureit/nodejs-poolController) (njsPC)
- [relayEquipmentManager](https://github.com/rstrouse/relayEquipmentManager) (REM)
- [dashPanel](https://github.com/rstrouse/nodejs-poolController-dashPanel)

## License

MIT — see [LICENSE](LICENSE).
