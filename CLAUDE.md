# Project context

DIY pool/spa controller replacing a Pentair IntelliConnect, built on
nodejs-poolController.

**Status:** UI prototype on mock data. The Pi 4 is up and thermally
characterised; the relay HAT has not arrived, so no equipment is connected and
neither njsPC nor REM is installed.

**This file is the operating manual for working in this repo — nothing more.**
The full record lives elsewhere and is deliberately not duplicated here:

- `docs/prds/poolctl-v1.md` — requirements, thirteen ADRs with their rejected
  alternatives, measurements, BOM, phasing, risks, open questions, backlog.
- `docs/architecture.md` — components, state ownership, control flow, failure
  modes.

Read those before changing anything architectural. Four decisions were
reversed once someone actually read njsPC's source, and the reasoning for each
reversal is recorded there rather than here.

---

## Stack

Vite + React 18, no router, no state library. Inline styles, no CSS framework.
Design tokens in `src/theme.js`. Fonts: Archivo (UI), IBM Plex Mono (all
numeric readouts — this is telemetry, not marketing).

```
src/
  theme.js               design tokens
  lib/sequences.js       transition spec + invariants — the server mirrors this
  lib/pump.js            rpm/watts/schedule maths
  lib/rs485.js           Pentair frame decoders — unverified against a real bus
  lib/useController.js   mock equipment state — swap this for real transport
  lib/useBus.js          mock RS-485 feed
  components/            Schematic, Stat, Toggle, TargetTemp, ScheduleEditor
  screens/               PoolSpaControl, HeatControl, PumpControl, BusMonitor
```

---

## Rules that constrain code changes

Easy to violate by accident. Each is argued at length in the PRD; the short
form is here so it never gets skipped.

- **The UI sends intents, never primitives.** `setMode('spa')`, never
  `relay3.close()`. A phone loses signal; the state machine must hold
  regardless. (ADR-7)
- **Do not move thermostat logic into software.** The heater owns its
  setpoint, its sensor and its hard caps — 95 °F pool, 104 °F spa. That is why
  no bug in this repo can produce a scalding spa. (ADR-4)
- **Targets are cutoffs, not setpoints.** The 3-wire interface carries no
  temperature. `state.targets` says when to *stop* calling for heat. It can
  end a call early; it can never ask for more than the heater allows.
- **Disabled controls state their reason, and never render an active state.**
  If a control is on, its toggle must be actionable. Reasons render as text,
  never as `title` tooltips — phone-first, no hover. (PR-3)
- **`src/lib/sequences.js` is the executable spec.** The server implements the
  same steps in the same order. If they disagree, one of them is a bug.

---

## Invariants — assert continuously, not just at transitions

```
heaterCall !== 'off'       ⟹  pumpRpm >= HEATER_MIN_RPM
heaterCall !== 'off'       ⟹  valves.bypass === 'flow'
valves.bypass === 'around' ⟹  heaterCall === 'off'
bypass moves only when heaterCall === 'off' and purge has elapsed
no valve command while another valve move is in flight
mode !== 'spa'             ⟹  blower === false
spa mode auto-reverts to pool after SPA_TIMEOUT_MIN
```

The two bypass implications are converses and both are needed: one stops a
call being made into a bypassed exchanger, the other stops the valve swinging
away under a live call. The blower rule is preference, not safety — but its
toggle is gated to spa mode, so without it a blower left running is both on
and unreachable.

**Bypass policy:** follows the mode — flow in spa, around in pool — and swings
back to flow whenever pool heat is called. The valve is binary, so a heat call
with the bypass around means *zero* flow through the exchanger. (ADR-9)

**Transitions cannot be cancelled.** `ABORTABLE` is false: aborting mid-travel
leaves a dead-reckoned valve at an unknown angle with no feedback to recover
from.

---

## Architecture in one paragraph

njsPC in Nixie mode **is** the controller, not a bus library. Its `nxps`
shared-body model creates Pool/Spa bodies, Pool/Spa circuits and Intake/Return
valves unprompted — this site, out of the box — and turning the Spa circuit on
switches the body and diverts both valves by itself. It drives circuits from
its own timers and cannot be made passive. So we add a **supervisor**, not a
sequencer: only the six things njsPC lacks — heat-conditional pump floor,
bypass policy, PE24GVA travel modelling (it diverts both valves at once,
instantly), targets-as-cutoffs, purge conditional on compressor idle, and
protecting a spa session from schedule takeover. **dashPanel bypasses whatever
the supervisor adds** — diagnostic tool, not operator interface. Forking njsPC
is a legitimate tactic (ADR-13), but it is AGPL-3.0: keep the supervisor a
separate process or this repo stops being MIT.

**Schedule ownership is unresolved (ADR-11)** and it is the next decision.
A bench test showed a schedule taking the shared body at its start boundary
and switching the spa off, with `manualPriority` enabled and ineffective.
Do not assume njsPC's scheduler is safe to keep.

---

## Next up

Full lists in PRD §10 (open questions) and §11 (backlog). Available without
hardware, highest value first:

1. **Settle ADR-11 — schedule ownership.** Bench-tested and *open*: a schedule
   at its start boundary took the shared body and switched the spa off, and
   `manualPriority` did not prevent it. Three options in the ADR; pick one
   before writing the supervisor, because it decides how big the supervisor is.
   (njsPC runs on a laptop with comms disabled — no hardware needed. `anslq25`
   is *not* the tool; it only mocks an EasyTouch OCP.)
2. **Re-read `sequences.js` against njsPC's body/circuit model.** Some steps
   are probably njsPC configuration rather than code; what survives that pass
   is the supervisor's real scope.
3. **Real connection state.** `connected` is hardcoded `true` and nothing ever
   clears it, so the LIVE indicator is decorative.

Blocked on the relay HAT: bus sniffing, the salt question (case 18), real
`HEATER_MIN_RPM` / `CELL_MIN_RPM`, and thermals with the enclosure sealed.

---

## Upstream

- nodejs-poolController (njsPC) — https://github.com/tagyoureit/nodejs-poolController (AGPL-3.0)
- relayEquipmentManager (REM) — https://github.com/rstrouse/relayEquipmentManager (GPL-3.0)
