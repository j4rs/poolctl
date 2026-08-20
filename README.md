# poolctl-ui

Controller UI for a DIY pool/spa automation system replacing a Pentair
IntelliConnect. Runs on mock data — no hardware required.

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

UI prototype on mock data. No hardware is connected yet; Phase 1 (Raspberry
Pi + RS-485 bus sniffing) is in progress. The server-side sequencer that will
own every interlock does not exist yet.

## Run

```bash
npm install
npm run dev
```

Open the printed URL. `--host` is on, so you can also load it on a phone from
the same network — worth doing, since this is a phone-first UI.

## Screens

- **Water** — mode switching with a live water-path schematic, transition
  step list, temperatures, blower and light.
- **Pump** — speed with flow-constraint markers, presets, and schedules with
  real energy cost.

## Structure

```
src/
  theme.js                 design tokens
  lib/sequences.js         transition spec + invariants — mirrors the server
  lib/useController.js     mock state — THE ONLY FILE TO SWAP for real data
  components/              Schematic, Stat, Toggle
  screens/                 PoolSpaControl, PumpControl
docs/prds/poolctl-v1.md    full requirements, ADRs, and open questions
CLAUDE.md                  compressed operating context for agents
```

## Wiring to real hardware

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
