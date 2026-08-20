# poolctl-ui

Controller UI for a DIY pool/spa automation system replacing a Pentair
IntelliConnect. Runs on mock data — no hardware required.

See `CLAUDE.md` for the full hardware context and design decisions.

## Run

```bash
npm install
npm run dev
```

Open the printed URL. `--host` is on, so you can also load it on a phone
from the same network — worth doing, since this is a phone-first UI.

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
```

## Wiring to real hardware

Replace `useController` with a hook that subscribes to njsPC over MQTT or
its WebSocket, maps payloads into the same state shape, and posts intents.
Nothing else changes.

The UI must never issue equipment primitives. It says `setMode('spa')`; the
server decides what relays that means and enforces every interlock. See the
invariants in `CLAUDE.md`.

## Mock timings

Transition steps run ~15× faster than reality so sequences are watchable.
True durations are in the `real` field and shown in the UI.
