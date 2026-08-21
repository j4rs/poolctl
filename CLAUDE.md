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
- **Every number needs a source.** Two figures in the PRD turned out to be
  invented outright — a pool-heating duration and the exchanger pressure drop
  that justifies automating the bypass. If a number cannot say where it came
  from, treat it as fiction. PRD §10 has the audit of what still rests on
  unmeasured values.
- **Nothing in the mock is real.** Every value in `useController.js`,
  `useBus.js` and `PumpControl`'s schedule array is invented to make the UI
  demonstrable — temperatures, salt, rpm, targets, schedules, and the step
  durations in `sequences.js` alike. The PRD is the source of truth. If a
  decision needs a real number and the PRD lacks one, it is unknown; say so
  rather than reading it off the prototype. An ADR was once justified on mock
  schedule data by mistake.

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
an actuator may not be re-driven within ACTUATOR_COOLDOWN_MIN (8) of its last move
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

**njsPC owns schedules, and a schedule may end a spa session (ADR-11).**
Accepted: the spa is used at night with the pool off, and filtration is a
single daily 08:00–18:00 window, so no boundary falls during a session. Any
schedule starting in evening hours reintroduces the collision. Because njsPC owns mode and can change it at any time, the
supervisor **observes and reacts** rather than asserting mode: a body change
is just something to respond to, which is why there is no state to sync.

---

## Next up

Full lists in PRD §10 (open questions) and §11 (backlog). Available without
hardware, highest value first:

1. **Bench whether valves move under full flow.** The safety question, still
   open. `pumpDelay` defaults to false and njsPC delays a pump *start after* a
   valve change rather than stopping it *before* one. Configure a pump, switch
   bodies, watch the rpm. Water hammer and a stalled actuator are the failure
   modes, so settle this before an actuator is wired. (njsPC runs on a laptop
   with comms disabled — no hardware needed. `anslq25` is *not* the tool; it
   only mocks an EasyTouch OCP.)
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
