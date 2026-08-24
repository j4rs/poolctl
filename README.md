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

The UI runs live against njsPC through the supervisor. The Raspberry Pi is
up and thermally characterised. **No equipment is connected** — the relay HAT
has not arrived, so njsPC runs with no serial port and no pump answers on the
bus. That has still been enough to settle most of the design.

Implemented in the supervisor: mode changes, heat targets with server-side
clamping, blower and light, pool heat with the bypass interlock, pump
run/stop, service mode, and manual programs. Not yet: valve relay driving,
scheduled preheat, and anything needing a water temperature.

## Run

Standalone, on mock data — no backend needed:

```bash
npm install && npm run dev
```

Against a real njsPC, with the supervisor serving the built app:

```bash
npm run build && cd supervisor && npm install && npm start
```

Then open `http://localhost:4300`. `--host` is on in dev, so you can load it
on a phone from the same network — worth doing, since this is a phone-first UI.

## Tests

```bash
npm test
```

Covers the client, the supervisor's pure logic, the njsPC translation layer,
and every screen rendered against state where nothing is known — which is the
case real hardware produces and a mock never does.

## Screens

- **Water** — mode switching with a live water-path schematic, transition
  step list, temperatures, blower and light.
- **Heat** — target temperature per body and pool heat on/off. Reached by
  tapping the heater. Targets are cutoffs clamped to the heater's own caps,
  never setpoints — see ADR-4.
- **Pump** — run/stop, manual programs (a name, a speed and a required
  expiry), service mode to stand the schedules down, and schedules with
  add/edit/delete and real energy cost. No speed slider: njsPC drives the pump
  from circuits, and an arbitrary rpm has neither a user nor a lifetime.
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
  components/              Schematic, Stat, Toggle, TargetTemp, HoldButton,
                           Sheet, ScheduleEditor, ProgramEditor, PreheatSheet, Toast
  screens/                 PoolSpaControl, HeatControl, PumpControl, BusMonitor
supervisor/                runs on the Pi; plain JS, no build step
  index.js                 njsPC link, intents, WebSocket, serves dist/
  map.js                   njsPC state -> the shape the UI speaks
  interlocks.js            the rules njsPC lacks — pure, tested
  targets.js               ADR-4 clamping
  store.js                 durable preferences
docs/architecture.md       system view, state ownership, failure modes
docs/prds/poolctl-v1.md    full requirements, ADRs, and open questions
CLAUDE.md                  compressed operating context for agents
```

Tests sit beside what they cover as `*.test.js[x]` and never reach `dist/`.

## Wiring to real hardware

`useSupervisor` already does this; `useController` remains so the app runs
standalone. The original note follows, and still describes the contract:

Replace `useController` with a hook that subscribes to njsPC over MQTT or its
WebSocket, maps payloads into the same state shape, and posts intents.
Nothing else changes.

The UI must never issue equipment primitives. It says `setMode('spa')`; the
server decides what relays that means and enforces every interlock. See the
invariants in [`src/lib/sequences.js`](src/lib/sequences.js) — that file is
the spec the server sequencer has to mirror step for step.

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
