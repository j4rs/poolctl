# Project context

DIY pool/spa controller replacing a Pentair IntelliConnect. This file carries
the decisions made during design so they don't have to be rediscovered.

**Status:** UI prototype on mock data. No hardware yet. Phase 1 (Pi + bus
sniffing) is in progress; parts ordered but not all delivered.

---

## The site

Residential pool + raised spa, shared equipment, South Florida.

| Equipment | Detail |
|---|---|
| Pump | Pentair IntelliFlo VSF, RS-485 |
| Heater | Raypak Classic heat pump R8450TI-E, digital board |
| Sanitizer | Pentair iChlor 30 + IntelliChlor Power Center |
| Blower | Silencer Air Blower, 1.5 HP, 120 V, 7.3 A |
| Light | Jandy Color, LED |
| Filter | Cartridge |
| Old controller | Pentair IntelliConnect — being retired |

### Valves — all binary, all hard stops

| Valve | Travel | Position A (de-energized) | Position B |
|---|---|---|---|
| Intake | 180° | Pool main drain | Spa main drain |
| Returns | 90° | Pool + spa (spilling) | Spa only |
| Heater bypass | 90° | Flow through heater | Around heater |

**Pool mode spills continuously through the spa.** The return diverter feeds
a shared pool+spa line in position A. The spa is therefore always full,
filtered and chlorinated. There is no separate "spillover" mode — spilling is
the default state. Spa mode isolates the pool.

There is no third valve position available, so the spill cannot be turned off
while remaining in pool mode.

### Actuators

Intermatic PE24GVA, ×3. Chosen over Jandy JVA 2444 ($231–282) and Pentair
CVA24 (90°/120° variants cost ~2× the 180°). PE24GVA has infinite cam
adjustment, so one part number covers both 90° and 180° valves. ~0.7 A each
at 24 VAC. Three-wire: black = 24 VAC common, red/white = switched lines.
One of the two switched lines is always energized; an SPDT relay selects
which. No position feedback — position is dead-reckoned.

---

## Control hardware

- Raspberry Pi 4 Model B 2 GB. Chosen over Pi 5 for thermal reasons: the
  enclosure is sealed NEMA 4X, so no fan is possible. Passive heatsink only.
- Sequent Microsystems Eight Relays 4A/120V stackable HAT. NO/NC contacts on
  every channel (needed for the actuators), RS-485 port built in with TVS
  protection (so no separate USB adapter), DIN-rail mountable. Powers the Pi
  over the GPIO bus from its own 2-pin connector.
- 5 V DIN-rail supply, 5 A min (Pi 3 A + 8 relays × 80 mA).
- 75 VA 120→24 VAC Class 2 transformer for the actuators.
- Eaton C25CNB130T contactor, 30 A 1-pole 24 V coil, for the blower.
- Non-metallic NEMA 4X enclosure (metal would trigger NEC 680 bonding).

### Relay map

| Ch | Load | Contacts |
|---|---|---|
| 1 | Intake actuator | COM/NO/NC, 24 VAC |
| 2 | Return actuator | COM/NO/NC, 24 VAC |
| 3 | Heater bypass actuator | COM/NO/NC, 24 VAC |
| 4 | Heater POOL | dry, to terminal 23 |
| 5 | Heater SPA | dry, to terminal 24 |
| 6 | Blower | NO → contactor coil |
| 7 | Jandy Color light | NO, direct 120 V (LED, <1 A) |
| 8 | Chlorinator gate | NO, 120 V — Path A only, see below |

The light channel sees far more switching cycles than any other (Jandy color
changes work by counting brief power interruptions). If a channel ever fails
it will be that one; remap in software rather than replacing the board.

---

## Heater control

Raypak digital board, 3-wire remote: terminals 22 (COMMON), 23 (POOL),
24 (SPA). Closing one contact calls for heat at that setpoint.

**Use 3-wire, not 2-wire.** The heater keeps its own thermostat, its own
sensor, and its own hard caps (95 °F pool, 104 °F spa). The scald limit is
therefore enforced in the heater's firmware, not in our code. Do not move
thermostat logic into software.

Other heater facts:
- Anti-short-cycle delay ~5 min after any shutdown. Expected, not a fault.
- Defrost cutoff at ~42–48 °F ambient: compressor stops, fan runs. Expected
  on a handful of Florida winter nights. Do not alert on it.
- Requires 5 psi minimum; throws `FLo`/`FL3` on low flow.
- Pool heating is a multi-day operation (~4 days typical from cold), not a
  button. Model it as a target temperature with a maintenance schedule.

---

## Chlorinator — two paths, undecided

Decision blocked on Phase 1 bus sniffing.

**Path A** — retire IntelliConnect entirely. njsPC reads salt PPM and output
% off the bus, publishes to MQTT, Home Assistant handles alerts with custom
thresholds plus a salt trend line over months. Relay-gate the power center in
spa mode. Preferred if iChlor 30 frames decode cleanly.

**Path B** — IntelliConnect survives wired to nothing but the IntelliChlor
Power Center. Keeps Pentair Home salt alerts and output control. Pump moves
to the Pi. Under Path B, do NOT relay-gate the power center — cutting power
to a device another controller owns invites confusing faults. Channel 8 goes
unused.

njsPC's iChlor 30 support is less mature than its IntelliChlor support.

---

## Sequencer design

**All interlocks live server-side, never in this UI.** The app subscribes to
state and sends intents (`setMode('spa')`). It never sends relay primitives.
A phone loses signal; the state machine must hold regardless.

`src/lib/sequences.js` is the executable spec. The server sequencer must
implement the same steps in the same order. Five named sequences: `spa`,
`pool`, `heatEngage`, `heatRelease`, `boot`.

### Bypass policy

The bypass follows the mode — **flow** in spa, **around** in pool — and
swings back to flow whenever pool heat is called. Spa mode always heats, so
one rule covers nearly every case; winter pool heating gets the explicit
`heatEngage`/`heatRelease` pair instead of a special case inside the mode
sequences.

The valve is binary, so a heat call with the bypass around means **zero**
flow through the exchanger. Both directions of the interlock are load-bearing.

### Invariants — assert continuously, not just at transitions

- `heaterCall !== 'off'` implies `pumpRpm >= HEATER_MIN_RPM`
- `heaterCall !== 'off'` implies `valves.bypass === 'flow'`
- `valves.bypass === 'around'` implies `heaterCall === 'off'`
- Bypass may only move when heater is off and purge has elapsed
- No valve command while another valve move is in flight
- `mode !== 'spa'` implies `blower === false` (preference, not safety —
  see the blower note below; relax the gate and drop this with it)
- Spa mode auto-reverts to pool after timeout (prevents overnight spa mode)

The two bypass implications are converses and both are needed. The first
keeps a call from being made into a bypassed exchanger; the second keeps the
valve from swinging away under a live call. Either alone leaves a hole.

### Transitions cannot be cancelled

`ABORTABLE` is false. Aborting mid-travel would leave a dead-reckoned valve
at an unknown angle with no feedback to recover from, and aborting only at
step boundaries buys little when the bound is a 45 sec move.

### Target temperatures are cutoffs, not setpoints

The 3-wire interface carries no temperature (ADR-4). The heater holds its own
setpoint on its board; the app can neither read nor write it. `state.targets`
tells the controller when to *stop* calling for heat, clamped to the heater's
firmware caps (`HEATER_CAP`: 95 °F pool, 104 °F spa). The app can end a call
early and can never ask for more heat than the heater allows.

A cutoff needs a trusted water temperature. There is no sensor in the BOM
yet — see open items.

### Pump speed under a live heat call

The pump slider clamps at `HEATER_MIN_RPM` while any heat call is active,
with the threshold marker carrying the reason. Spa mode owns the pump.
Silently dropping the heat call because someone dragged a slider is a worse
surprise than a slider that will not go lower.

### Fail-safe states

Choose relay NO/NC so de-energized gives: valves to pool, bypass to **flow**
(a heater with flow and no call is harmless; a call with no flow is not),
heater contacts open, blower off. Hardware watchdog drops relays if njsPC
stops heartbeating.

### Boot behaviour

Valve position is dead-reckoned and persisted. On boot, unconditionally
re-drive all valves to pool position to resynchronize.

### Conditional purge

Skip the purge step entirely if the compressor hasn't run in the last five
minutes — the common case. Makes "Spa now" ~2 minutes instead of 5.

Render a skipped step struck through rather than dropping it, so the short
path and the long path look like the same sequence.

---

## Product decisions worth preserving

- **"Spa now" is the default, not scheduled preheat.** The owner starts the
  spa and gets in immediately. Preheat is an option, not a mandate.
- **The blower is not safety-gated.** The spa is always full, so it can never
  run dry. It's gated to spa mode only as a preference (jets while spilling
  dump heat and noise into the pool). Relax freely — but the `pool` sequence
  must keep clearing it, or the gate strands it on and unreachable.
- **A disabled control never renders an active state.** If it is on, its
  toggle has to be actionable.
- **Blower + heater roughly cancel.** Heat pump gains ~20–25 °F/hr on a
  spa-sized volume in Florida winter air; a 115 CFM blower takes back most of
  it. Surface this as a sentence in the UI, never as a lockout.
- **Disabled controls show their reason.** Hiding teaches nothing.
- **Show the water path, not a spinner.** Transitions take ~2 minutes.
- **Pump power scales with the cube of speed.** Show watts and dollars, not
  just rpm, or schedule decisions are made blind.

---

## Open items

- [ ] Sniff RS-485 bus; decide chlorinator Path A vs B
- [ ] Measure real `HEATER_MIN_RPM` and `CELL_MIN_RPM` (both are placeholders)
- [ ] Confirm spill stops when return diverter goes full-spa
- [ ] Replace `useController` with real njsPC transport
- [ ] Build server-side sequencer service (owns all interlocks)
- [ ] Decide the water temperature source — target cutoffs and the preheat
      estimate both need one, and the BOM has no sensor
- [ ] Scheduled spa preheat — button is a stub
- [ ] Pump speed clamp at `HEATER_MIN_RPM` under a live heat call
- [ ] Render skipped sequence steps struck through
- [ ] Spa auto-revert countdown — `SPA_TIMEOUT_MIN` has no surface yet
- [ ] Daylight theme — this is used poolside in Florida sun
- [ ] RS-485 diagnostics view

---

## Stack

Vite + React 18, no router, no state library. Inline styles, no CSS
framework. Design tokens in `src/theme.js`. Fonts: Archivo (UI), IBM Plex
Mono (all numeric readouts — this is telemetry, not marketing).

## Upstream

- nodejs-poolController (njsPC): https://github.com/tagyoureit/nodejs-poolController
- relayEquipmentManager (REM): https://github.com/rstrouse/relayEquipmentManager
- njsPC runs in "Nixie" mode — it is the controller, there is no Pentair OCP.
