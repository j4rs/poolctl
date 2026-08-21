# Pool/spa smart controller — product requirements

**Status:** design complete, Phase 1 in progress
**Owner:** homeowner (software engineer, working electrical knowledge)
**Site:** residential pool + raised spa, shared equipment, South Florida
**Last updated:** August 2026

> Companion to `CLAUDE.md` at the repo root. That file is the compressed
> operational context an agent needs to work in this codebase. This file is
> the full record: why each decision was made, what was rejected, and what
> is still unknown.

---

## 1. Problem

The pool has a Pentair IntelliConnect. It controls the variable-speed pump
over RS-485, plus two relays currently driving the pool light and the spa
blower. Everything else is manual.

Switching between pool and spa means walking to the equipment pad and turning
three valve handles by hand. Heating the spa means doing that, then waiting.
Heating the pool in winter means the same, repeated over several days.

The IntelliConnect cannot solve this. It supports up to 5 devices and 2
relays, and has no valve actuator support at all — it cannot move water
between pool and spa. That capability requires an IntelliCenter or another
panel-based system.

### Goals

1. Switch pool ↔ spa remotely, with correct and safe sequencing.
2. Control the heat pump remotely for both spa heating and multi-day winter
   pool heating.
3. Control pump speed and schedules remotely, with visible energy cost.
4. Control blower and light remotely.
5. Preserve the chlorinator visibility the owner values today (salt level
   alerts, output percentage).
6. Cost meaningfully less than a factory IntelliCenter i5PS
   (~$1,300–2,000 installed).

### Non-goals

- Chemical automation beyond the existing salt cell (no pH/ORP dosing).
- Cloud service or remote access outside the home network in v1.
- Replacing the pump, heater, or chlorinator.
- Voice control (falls out of Home Assistant for free if wanted later).

---

## 2. Existing system

### Equipment

| Item | Detail |
|---|---|
| Pump | Pentair IntelliFlo VSF, RS-485 |
| Heater | Raypak Classic heat pump R8450TI-E, 140k BTU, digital board |
| Sanitizer | Pentair iChlor 30 + IntelliChlor Power Center |
| Blower | Silencer Air Blower, 1.5 HP, 120 V, 7.3 A, model 1-6315141 |
| Light | Jandy Color, LED |
| Filter | Cartridge |
| Controller | Pentair IntelliConnect EC-523317 (to be retired) |
| Power | Intermatic subpanel at the pad |

### Plumbing

Three gray diverter valves, all binary with hard stops:

| Valve | Travel | Position A | Position B |
|---|---|---|---|
| Intake | 180° | Pool main drain | Spa main drain |
| Returns | 90° | Pool + spa (spilling) | Spa only |
| Heater bypass | 90° | Flow through heater | Around heater |

Suction manifold has individually valved risers labeled `MAIN DRAIN SPA`,
`CLEANER`, `SKIMMER`, `MAIN DRAIN POOL`.

**Critical characteristic:** the pool's default state is spillover. In
position A the return diverter feeds a shared pool+spa line, so the spa
receives flow continuously and cascades back into the pool. Consequences:

- The spa is always full, always filtered, always chlorinated.
- The blower can never run dry — it is not a safety interlock.
- There is no separate "spillover mode." Spilling is the resting state.
- With only two valve positions, the spill cannot be switched off while
  remaining in pool mode. Accepted limitation. It is a real winter heat loss
  when warming the pool, but solving it would need multi-position valve
  control that is not worth the complexity.

---

## 3. Architectural decisions

### ADR-1 — Retire the IntelliConnect rather than build alongside it

**Decision:** the new controller becomes the sole master on the RS-485 bus.

**Rationale:** two masters cannot share the bus. Keeping the IntelliConnect
for the pump while a second box handles valves and heater creates a
distributed state machine with no shared truth. The failure mode is concrete
and bad: valves in spa position while the IntelliConnect executes a schedule
that stops the pump.

**Rejected:** split ownership (cheaper to start, unacceptable failure modes).
Partially revived as the Path B fallback in ADR-6, but scoped to a single
device that nothing else touches.

### ADR-2 — Raspberry Pi running njsPC, not an Arduino

**Decision:** Raspberry Pi 4 running nodejs-poolController (njsPC) in Nixie
mode, with relayEquipmentManager (REM) for GPIO and dashPanel for a web UI.

**Rationale:** roughly 90% of this project is scheduling, state, persistence,
a web UI, and integrations — not GPIO toggling. njsPC already implements the
reverse-engineered Pentair RS-485 protocol, drives IntelliFlo VSF pumps
natively at 1 rpm resolution with energy telemetry, and exposes
MQTT/REST/WebSocket. Nixie mode means njsPC *is* the controller; no Pentair
OCP is required.

**Rejected:**
- *Arduino* — would mean reimplementing the 0xA5 automation frames and the
  iChlor DLE/STX framing from scratch, plus a scheduler, plus persistence.
- *ESP32 + ESPHome* — better than Arduino (WiFi, OTA, native HA), still
  requires writing the protocol stack. Reasonable if the protocol work is
  the point of the exercise; it isn't here.

### ADR-3 — Pi 4 (2GB) over Pi 5

**Decision:** Pi 4 Model B, 2GB.

**Rationale:** thermal. The enclosure must stay sealed (NEMA 4X) against
Florida humidity and insects, so no fan is possible — a fan needs vents and
vents defeat the rating. Raspberry Pi recommends active or enhanced passive
cooling for the Pi 5; the Pi 4 sheds heat adequately through a passive
heatsink at this duty cycle. njsPC + REM + dashPanel is a modest Node
workload and 2 GB is not a constraint. Pi 5 would also push the 5 V supply
requirement from ~5 A to ~7 A.

**Measured, August 2026** — bare board, 3-piece heatsink kit fitted, open air
on a bench at 25 °C ambient, on a 20 W USB-C supply:

| State | Temp | ΔT over ambient | Clock | `get_throttled` |
|---|---|---|---|---|
| Idle | 38.9 °C | +14 °C | 700 MHz | `0x0` |
| 4 cores, 6 min | 81.8 °C | +57 °C | 1800 MHz | `0x80000` |

No undervoltage bits at any point, so the supply is not implicated. Bit 18
never set — it never hard-throttled — but it crossed the 80 °C **soft** limit
at 5½ minutes and was still climbing ~1 °C per 30 s when the test ended, so
81.8 °C is not the steady-state figure.

Two things this changes:

- This Rev 1.5 board clocks at **1800 MHz**, not the 1500 MHz most Pi 4
  passive-cooling guidance assumes. It runs hotter than that guidance implies.
- The decision survives on **workload**, not on cooling. njsPC is nowhere near
  four cores pegged, and +14 °C over ambient is fine in any plausible
  enclosure. Full-load headroom, however, is gone.

**Not yet measured, and worse than the above in three compounding ways:** the
relay HAT mounts on 11 mm standoffs directly over the SoC heatsink, blocking
its convection path; the sealed non-metallic enclosure has no airflow at all;
and the Pi is not the only heat source in that box — the 75 VA transformer
and the 5 V supply likely put total dissipation near 15–25 W inside a sealed
14×12×6. Re-measure in the assembled enclosure before Phase 4.

**Trade-off accepted:** no battery-backed RTC on the Pi 4. NTP over WiFi
covers it.

### ADR-4 — 3-wire heater control, not 2-wire

**Decision:** wire COMMON/POOL/SPA (terminals 22/23/24) and close one of two
dry contacts to call for heat at the corresponding setpoint.

**Rationale:** this is the single most important safety decision in the
project. In 3-wire mode the heater retains its own thermostat, its own
temperature sensor, and its own hard caps (95 °F pool, 104 °F spa). The
scald limit on the spa is therefore enforced in the heater's firmware, not
in application code. No bug in this repository can produce a dangerously hot
spa.

**Rejected:** 2-wire control, where the controller supplies its own sensor
and thermostat logic. Cheaper in wire, far worse in risk profile. Do not
migrate thermostat logic into software later.

### ADR-5 — Automate the heater bypass, but keep it interlocked

**Decision:** third actuator on the bypass diverter.

**Rationale:** originally scoped as manual, since a heat pump costs nothing
when water passes through an idle exchanger. Two reasons changed it:
(a) the owner wants full remote control, and (b) pressure drop across the
exchanger is roughly 9–11 psi — 20+ feet of head the pump pays for on every
filtration hour. Bypassing in summer is real energy savings on a VSF.

**Because the bypass is binary — full flow or full bypass, not a partial
split — a heater call with the valve in bypass means zero flow through the
exchanger.** The interlock is therefore load-bearing in both directions:

- Heater contacts stay open unless bypass is confirmed in flow position.
- Bypass does not move until the heater is off and any purge has elapsed.

The heater's water pressure switch is a backstop, not the primary control.

### ADR-6 — Chlorinator: decision deferred to bus sniffing

The owner values two things Pentair Home provides today: low-salt
notifications and visible output percentage. Two paths, chosen by evidence
from Phase 1.

**Path A (preferred)** — retire the IntelliConnect entirely. njsPC reads
salt PPM and output percentage from the bus and publishes to MQTT. Home
Assistant provides notifications with custom thresholds *and* a salt trend
line over months — strictly better than a binary low-salt alert, because it
shows cell degradation before failure. Relay-gate the power center to
suppress chlorination during spa mode.

**Path B (fallback)** — the IntelliConnect survives, wired to nothing but
the IntelliChlor Power Center. It keeps Pentair Home alerts and output
control and owns exactly one device. The pump, blower, and light move to the
Pi. Inelegant; the IntelliConnect will likely complain about a missing pump.

Under Path B, do **not** relay-gate the power center — cutting power to a
device another controller believes it owns invites confusing faults. Suppress
spa-mode chlorination by setting a low output percentage instead, or accept
it, since a short soak barely moves the needle.

**Deciding evidence:** njsPC's iChlor 30 support is less mature than its
IntelliChlor support and has known rough edges in Nixie mode. Phase 1
sniffing shows definitively whether chlorinator frames decode.

**Note:** the iChlor has its own buttons and display, and the separate
IntelliChlor Power Center supplies it. So even in the worst case the cell
runs standalone at a fixed percentage. Chlorination is never at risk.

### ADR-7 — All interlocks server-side, never in the client

**Decision:** the UI subscribes to state and sends intents (`setMode('spa')`).
It never sends equipment primitives (`relay3.close()`).

**Rationale:** phones lose signal, tabs get closed, apps get force-quit
mid-transition. A state machine that lives in the client is not a state
machine. `src/lib/sequences.js` is a mirror of the server's spec for display
purposes; if the two disagree, that is a bug in one of them.

### ADR-8 — Intermatic PE24GVA actuators

**Decision:** three Intermatic PE24GVA.

**Rationale:** the site has one 180° valve and two 90° valves. The PE24GVA
has tool-free infinite cam adjustment, so one part number covers every valve
and one spare covers every failure. It is also ~10% narrower than
conventional actuators, which matters on this manifold where the intake
diverter sits close to neighboring risers.

**Rejected:**
- *Pentair CVA24* — sold in fixed-cam variants; the 90° and 120° versions
  cost nearly twice the 180°.
- *Jandy JVA 2444* — good adjustable-cam actuator, but $231–282 each.
- *Intermatic PE24VA* — discontinued predecessor.

All 24 VAC actuators are functionally interchangeable across brands.

### ADR-9 — Bypass follows the mode, with a pool-heat override

**Decision:** the bypass rests in *flow* during spa mode and *around* during
pool mode. Calling for pool heat from the app swings it back to flow for the
duration of the call.

**Rationale:** ADR-5 automated the bypass to recover the 9–11 psi drop across
the exchanger on every filtration hour. Spa mode always heats, so tying the
valve to the mode captures nearly all of that benefit with a single rule.
Winter pool heating is the one case where pool mode needs flow, and it gets
an explicit engage/release pair rather than a conditional buried inside the
mode sequences.

**Consequences:**

- Relay 3's coil is energized throughout pool mode, since the de-energized
  fail-safe is *flow*. The actuator costs nothing either way — it keeps one
  of its two lines energized in both positions — so the standing cost is the
  coil alone, ~80 mA.
- A watchdog trip or power loss swings the bypass toward the heater. That is
  the safe direction: flow with no call is harmless.
- Calling for pool heat costs one 45 sec valve move before the contact
  closes. Releasing it costs a purge plus another 45 sec.

**Rejected:**

- *Resting at flow in both modes* — simpler, and forfeits the savings that
  justified automating the valve in the first place.
- *Bypassing only inside scheduled filtration windows* — fewer coil-hours,
  more states to reason about, marginal gain.

---

## 4. Hardware design

### Relay map

| Ch | Load | Contacts | Notes |
|---|---|---|---|
| 1 | Intake actuator | COM/NO/NC, 24 VAC | 180° |
| 2 | Return actuator | COM/NO/NC, 24 VAC | 90° |
| 3 | Bypass actuator | COM/NO/NC, 24 VAC | 90° |
| 4 | Heater POOL | dry, isolated | terminal 23 |
| 5 | Heater SPA | dry, isolated | terminal 24 |
| 6 | Blower | NO → contactor coil | 30 A DP contactor |
| 7 | Light | NO, direct 120 V | LED, <1 A |
| 8 | Chlorinator gate | NO, direct 120 V | Path A only |

Channels 1–3 require **changeover (COM/NO/NC) contacts**: the actuators keep
one of two lines energized at all times, and an SPDT relay selects which.
NO-only relays cannot drive them — this is precisely why the IntelliConnect's
relays are useless for valves.

Channels 4–5 must be **isolated from the 24 VAC transformer**; the Raypak
supplies its own low voltage on that terminal block.

The blower is 7.3 A running but 30–45 A locked-rotor inrush. Relay-board
contacts are rated for resistive loads; a motor needs a definite-purpose
contactor. The failure mode of a welded contact is a blower stuck **on**,
which is the worst direction.

Channel 7 sees far more switching cycles than any other channel, because
Jandy color changes work by counting brief power interruptions. If a channel
fails it will be that one; remap in software rather than replacing the board.

### Power budget

- 24 VAC transformer, 75 VA: 3 actuators × ~0.7 A (sequenced, never
  simultaneous) + contactor coil. If contactor nameplate inrush VA is high,
  step to 100 VA.
- 5 V DIN supply, 5 A minimum: Pi 4 (3 A) + 8 relays × 80 mA + margin. The
  relay HAT accepts 5 V on its own connector and feeds the Pi over the GPIO
  bus, so no separate USB-C brick is needed in the finished enclosure.

### Fail-safe states

Relay NO/NC selection must place the de-energized state at:

- Valves → pool position (spill running)
- Bypass → **flow through heater** (a heater with flow and no call is
  harmless; a call with no flow is not)
- Heater contacts → open
- Blower → off

A hardware watchdog drops all relays if njsPC stops heartbeating.

### Enclosure

Non-metallic NEMA 4X. A metal enclosure would trigger NEC 680 equipotential
bonding requirements. Sealed, no vents, passive cooling only.

---

## 5. Control logic

### Modes

Two. `pool` (spilling, the resting state) and `spa` (pool isolated).

### Sequences

Canonical definitions live in `src/lib/sequences.js`, which is the spec the
server sequencer must mirror step for step. Five named sequences:

**Pool → Spa:** heater off → purge\* → pump to low → bypass to flow → intake
to spa drain → returns fully to spa → pump to spa rpm → heater to spa
setpoint.

**Spa → Pool:** heater off → purge\* → blower off → pump to low → returns to
spill split → intake to pool drain → bypass around† → pump to pool rpm.
Also the auto-revert path.

**Heat engage** (pool mode): bypass to flow → pump to at least
`HEATER_MIN_RPM` → close the pool heat contact.

**Heat release:** open the contact → purge\* → bypass around → pump back to
schedule.

**Boot resync:** contacts open → blower off → pump to low → returns to spill
split → intake to pool drain → bypass around → pump to pool rpm.

\* Skipped when the compressor has been idle five minutes.
† Skipped when a pool heat call is active. The boot sequence deliberately
carries no skip conditions — every valve is re-driven unconditionally,
which is the whole point of it.

Valves move one at a time, at low pump rpm. Never divert against full flow —
water hammer, and the actuator can stall. Three sequential 45 sec moves
dominate the wall clock of a mode change.

The blower is cleared explicitly on the way out of spa mode. Its toggle is
gated to spa mode, so a blower left running would be both on and unreachable.

A skipped step must be rendered struck through rather than dropped, so the
two-minute path and the five-minute path look like the same sequence.

### Invariants — asserted continuously, not only at transitions

```
heaterCall !== 'off'      ⟹  pumpRpm >= HEATER_MIN_RPM
heaterCall !== 'off'      ⟹  valves.bypass === 'flow'
valves.bypass === 'around' ⟹  heaterCall === 'off'
bypass may move only when heaterCall === 'off' and purge has elapsed
no valve command while another valve move is in flight
mode !== 'spa'            ⟹  blower === false
spa mode auto-reverts to pool after SPA_TIMEOUT_MIN
```

The two bypass implications are converses of one another and both are
required. The first keeps a heat call from being made into a bypassed
exchanger; the second keeps the bypass from swinging away under a live call.
Either one alone leaves a hole, and ADR-5 needs the pair.

The blower rule is a preference, not a safety interlock — the spa is always
full, so the blower cannot run dry. It is asserted because the toggle is
gated to spa mode, which means a blower left running on the way out is both
on and unreachable. Relax the gate and this invariant goes with it.

The auto-revert is not optional. It is what saves the system when someone
opens the spa from their phone and forgets.

### Transitions cannot be cancelled

Once a mode change starts, it runs to completion. Aborting mid-travel would
leave a dead-reckoned valve at an unknown angle with no feedback to recover
from, and aborting only at step boundaries buys little when the bound is a
45 sec move. The owner is committed for the duration, and the UI should say
so rather than offer a cancel that lies.

### Target temperatures

The 3-wire interface carries no temperature. The heater holds its own
setpoint on its own board, and the app can neither read it nor write it —
closing a contact only says "call for heat".

So the app's targets are **cutoffs, not setpoints**. They tell the controller
when to stop calling for heat, and they clamp to the heater's firmware caps
(95 °F pool, 104 °F spa). The app can end a call early; it can never ask for
more heat than the heater allows, which keeps ADR-4's guarantee intact — no
bug here produces a scalding spa.

The consequence worth stating plainly: a cutoff needs a trusted water
temperature reading, and the BOM does not currently include a water
temperature sensor. Resolve the source before Phase 3 — see open questions.

### Pump speed under a live heat call

The pump slider clamps at `HEATER_MIN_RPM` whenever a heat call is active,
with the threshold marker carrying the reason. Spa mode owns the pump.
Silently dropping the heat call because someone dragged a slider is a worse
surprise than a slider that will not go lower.

### Position tracking

The actuators provide no position feedback. Position is dead-reckoned and
persisted to disk. **On boot, unconditionally re-drive all valves to pool
position** to resynchronize. Cheap and correct.

### Conditional purge

Skip the purge step entirely if the compressor has not run in the last five
minutes — the common case. This makes "Spa now" about two minutes instead of
five, almost all of it valve travel.

### Heater behaviour to model, not alert on

- Anti-short-cycle delay ~5 min after any shutdown.
- Defrost cutoff at ~42–48 °F ambient: compressor stops, fan continues.
  Happens a handful of nights per year locally. Normal, not a fault.
- `FLo` / `FL3` fault codes indicate low flow.
- Hard caps: 95 °F pool, 104 °F spa.

### Thermal reality

- Heat pump gains roughly 20–25 °F/hr on a spa-sized volume in Florida
  winter air; nominal 140k BTU derates with ambient temperature.
- Spa preheat from ~80 °F to 102 °F: **45–75 minutes**.
- A 115 CFM blower moving ambient air through 100 °F water takes back most
  of the heater's output. Blower + heater is roughly break-even.
- Pool heating is a multi-day operation (~4 days typical from cold), most
  efficient during warm daylight hours. Model it as a target temperature
  with a maintenance schedule, not a button.

### Pump

Power scales with the **cube** of speed (affinity law). 1600 rpm costs about
a tenth of 3450, not half. Any speed 0–3450 in 1 rpm steps; the pump returns
current rpm and energy consumption over RS-485.

Spa mode owns the pump while active and overrides schedules. A schedule
dropping the pump to 1400 rpm mid-soak would be a bad surprise.

A speed set by hand is transient and lasts only until the next schedule
window opens. A **manual hold** pins it instead — open-ended, or on an
egg-timer. The server owns and persists the hold; a phone cannot be what
remembers the pump is pinned. Any sequence clears it, since a mode or heat
change takes the pump. An open-ended hold pauses filtration, so it stays
visible until released rather than being forbidden or silently expiring.

---

## 6. Product requirements

### PR-1 — "Spa now" is the default path

The owner starts the spa and gets in immediately. Scheduled preheat ("spa
ready at 7:30") is an option, not a mandate. Do not gate entry on reaching
setpoint.

### PR-2 — Show the water path, not a spinner

Transitions take about two minutes. A spinner over two minutes of silence
produces button-mashing. The schematic shows which valve points where and
where flow is going, making the wait legible. It is also the only honest way
to render the spill.

### PR-3 — Disabled controls state their reason

Hiding a control teaches nothing. The blower toggle is disabled outside spa
mode with the reason shown beneath the label — not on hover: the primary
device is a phone, where hover does not exist, and a `title` tooltip also
replaces the control's accessible name. Pump speeds below a flow threshold
dim the threshold marker and explain the consequence.

A disabled control must never render an active state. If it is on, its
toggle has to be actionable.

### PR-4 — Surface physics as information, not lockouts

Running the blower during preheat changes the estimate copy to say heating
has nearly stalled. The owner keeps the choice and is not surprised by the
outcome.

### PR-5 — Show cost, not just rpm

Watts and dollars alongside rpm; daily kWh totals on the schedule list.
Schedule decisions made on rpm alone are made blind.

### PR-6 — Phone-first

Primary use is poolside on a phone. Max width 460px, safe-area insets, large
tap targets. A daylight theme is an open item — Florida sun.

### Visual direction

Deep water-at-night teal; sodium-lamp amber reserved strictly for heat; mono
face (IBM Plex Mono) for every numeric readout, because this is equipment
telemetry, not marketing copy.

---

## 7. Bill of materials

### Phase 1 — ordered

| Item | Price |
|---|---|
| Raspberry Pi 4 Model B 2GB (board only) | ~$55 |
| Sequent Microsystems Eight Relays 4A/120V HAT | $60 |
| SanDisk High Endurance microSD 32–64GB + reader | ~$20 |
| HanTof M2.5 11mm brass standoffs, 24pc | $6.29 |
| Raspberry Pi 4 heatsink kit | $6.99 |
| 5V 3A USB-C supply with inline switch (bench + diagnostics) | $9.85 |

### Later — not yet ordered

| Item | Est. |
|---|---|
| Intermatic PE24GVA valve actuator × 3 | ~$300 |
| 75 VA 120→24 VAC Class 2 transformer | ~$30 |
| Eaton C25CNB130T contactor, 30 A, 24 V coil | ~$20 |
| 5 V DIN-rail supply, 5 A (Mean Well HDR/MDR) | ~$25 |
| Non-metallic NEMA 4X enclosure ~14×12×6 | ~$60 |
| DIN rail, terminal blocks, ferrules, wire | ~$40 |

**Total ~$650** against $1,300–2,000 for a factory IntelliCenter i5PS.

### Storage note

A microSD is cheaper; an SSD is more reliable. SD cards fail on 24/7 Pis
through write wear and unclean power loss, and an outdoor pad supplies both.
SanDisk's own support position is that retail (non-endurance) cards are not
qualified for Raspberry Pi use. High Endurance cards also raise the
temperature rating from 60 °C to 85 °C, which matters in a sealed box in
Florida sun.

Mitigations if staying on SD: `log2ram`, no swap, journald to volatile
storage. Read-only root via overlayfs is possible but conflicts with
persisting dead-reckoned valve position — it would need a separate writable
partition. Revisit at commissioning; a 2.5" SATA SSD plus an ASM1153E USB
adapter is ~$28 if the answer is yes.

---

## 8. Phasing

**Phase 0 — survey.** Done. Equipment identified, valves mapped and labeled,
travels confirmed, blower nameplate read.

**Phase 1 — read-only.** *In progress.* Pi + HAT sniffing the RS-485 bus
alongside the still-live IntelliConnect. Zero risk, nothing disturbed.
Deliverable: the ADR-6 chlorinator decision, plus confirmation that the pump
responds.

**Phase 2 — bench.** Full controller assembled on a desk: actuators spinning
in free air, relays clicking, sequencer exercised, watchdog tested by killing
the process. Do not debug a state machine at the equipment pad.

**Phase 3 — heater.** 3-wire control wired, valves still manual. Smallest
change with the largest immediate payoff.

**Phase 4 — cutover.** Retire the IntelliConnect, move pump to the Pi,
install the three actuators.

**Phase 5 — blower last.** Highest-current load and the only device whose
safe operation depends on valve position tracking being correct. Prove
position tracking over several weeks of real use before software energizes a
motor conditionally on it.

**Phase 6 — polish.** Home Assistant integration, schedules, scheduled spa
preheat, and a physical weatherproof "spa on" button near the spa itself.
(The physical button will be wanted more than expected.)

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| iChlor doesn't decode in njsPC | Path B fallback; cell runs standalone regardless |
| SD card corruption | High Endurance card, log2ram; SSD upgrade path |
| Dead-reckoned valve position drifts | Re-drive to pool on every boot |
| Software bug overheats spa | Impossible by construction — heater firmware owns the cap (ADR-4) |
| Blower relay welds closed | Definite-purpose contactor sized for inrush |
| Pi crashes mid-transition | Hardware watchdog drops relays to fail-safe |
| Pi overheats in the sealed enclosure | Measured +14 °C over ambient at njsPC-like load, so fine on workload — but untested with the HAT fitted, the box sealed, and the transformer dissipating alongside it. Re-measure assembled; mitigations below |
| Actuator stalls against a valve stop | Verify travel before install; cams set to hard stops |
| Losing Pentair Home features owner values | ADR-6 Path B preserves them |

### Electrical scope boundary

Everything specified here on the low-voltage side is appropriate DIY work.
The 240 V side — the heat pump's 60 A circuit, pump feed, disconnects, GFCI,
and NEC 680 equipotential bonding — should go to a licensed electrician, and
in most jurisdictions requires a permit and inspection. This is not
a liability disclaimer: pool equipment sits in the worst electrical
environment on a residential property, and inspection is a free second set of
eyes on bonding.

---

## 10. Open questions

- [ ] **Chlorinator path.** Blocked on Phase 1 sniffing.
- [ ] **`HEATER_MIN_RPM`.** Currently 1900, a placeholder. Measure by ramping
      the pump and noting where the heat pump's flow fault clears.
- [ ] **`CELL_MIN_RPM`.** Currently 1150, a placeholder. Measure by noting
      where the iChlor begins generating.
- [ ] **Spill confirmation.** Verify the pool returns actually go dead when
      the return diverter moves to full-spa. If they keep flowing, the spill
      is plumbed off an independent tee and the model needs revision.
- [ ] **Enclosure thermals.** Bench figures are in ADR-3; the assembled case
      is untested. Re-measure with the HAT fitted, the box closed, and the
      transformer energised, on a hot afternoon. Mitigations in rough order
      of cost: mount out of direct sun or add a shade; cap `arm_freq=1500`
      in `config.txt`, which costs this workload nothing; move the
      transformer to its own enclosure so the biggest heat source is not
      sharing air with the Pi; add a conduction path from the SoC heatsink
      to a plate through the wall — checking first that it raises no NEC 680
      bonding question, which is why the box is non-metallic to begin with.
- [ ] **Water temperature source.** The BOM has no water temp sensor, and the
      3-wire heater interface reports nothing. Target cutoffs and the preheat
      estimate both need a trusted reading — from the pump bus, a REM probe,
      or elsewhere. Settle before Phase 3.
- [ ] **Spa volume.** Never measured. All preheat estimates assume ~500 gal.
- [ ] **Spa jet rpm.** 2800 is a guess. Tune empirically once speed is
      settable from a phone.
- [ ] **Contactor inrush VA.** Read the nameplate before finalizing the
      transformer at 75 VA vs 100 VA.

---

## 11. Software backlog

- [ ] Replace `useController` with real njsPC transport (MQTT or WebSocket)
- [ ] Build the server-side sequencer service that owns all interlocks
- [x] Schedule editor — add, edit, delete, day selection, overlap warning
- [x] Target temperatures per body, clamped to the heater caps
- [x] Pool heat on/off, driving heatEngage / heatRelease
- [ ] Scheduled spa preheat ("ready at 7:30") — button is a stub
- [x] Pump speed clamp at `HEATER_MIN_RPM` under a live heat call
- [x] Manual pump hold, open-ended or on an egg-timer
- [ ] Render skipped sequence steps struck through
- [ ] Spa auto-revert countdown — `SPA_TIMEOUT_MIN` has no surface yet
- [ ] Daylight theme
- [ ] RS-485 diagnostics view for Phase 1 work
- [ ] Home Assistant / MQTT bridge
- [ ] Salt trend history and threshold alerts (Path A)
- [ ] Winter pool-heating mode: the target and the on/off exist; the
      multi-day maintenance schedule does not

---

## Appendix — upstream projects

- nodejs-poolController (njsPC) — https://github.com/tagyoureit/nodejs-poolController
- relayEquipmentManager (REM) — https://github.com/rstrouse/relayEquipmentManager
- dashPanel — https://github.com/rstrouse/nodejs-poolController-dashPanel

njsPC runs in **Nixie** mode: it is the controller. There is no Pentair
outdoor control panel in this system after cutover.
