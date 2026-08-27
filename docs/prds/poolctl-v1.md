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
6. Cost meaningfully less than a factory IntelliCenter i5PS. That is
   $1,300–2,000 for the control system alone — valve actuators are extra
   and it needs the same three this build does. Compare like for like; §7
   has both rows.

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

**Revisited, August 2026.** The alternatives were re-surveyed and the source
read. ADR-2 stands, and is on firmer ground than when it was written.

The discriminator is that this site will have **no Pentair OCP** — the
IntelliConnect is being retired and there is no IntelliCenter, EasyTouch,
IntelliTouch, SunTouch or ScreenLogic gateway. Almost every open-source
Pentair project is a *client of* an existing controller, not a replacement
for one:

| Project | Why it does not fit |
|---|---|
| openHAB Pentair binding | Listens on the bus alongside an existing control system; does not replace it |
| OPNpool (ESP32) | Integrates an existing controller into a smart home; tested against a SunTouch |
| Home Assistant ScreenLogic | Requires a ScreenLogic gateway |
| njsPC **Nixie mode** | Explicitly supports *no controller at all* |

So njsPC is not merely the best of several options. In the "be the controller"
category it is the only mature one.

Two corrections to how this ADR describes it:

- **njsPC in Nixie mode is a full controller, not a protocol library.** It has
  its own delay and interlock manager, body switching, and scheduling. This
  matters enormously for how anything is layered on top — see ADR-10.
- It requires **Node.js 22+**.

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

Identical 6-minute 4-core soak in every row. **The last row is the shipping
configuration**; the first three were taken before it was noticed that the
desktop image had been written instead of Lite.

| Image | State | Temp | ΔT over ambient | Clock | `get_throttled` |
|---|---|---|---|---|---|
| Desktop | Idle | 38.9 °C | +14 °C | 700 MHz | `0x0` |
| Desktop | 4 cores, 6 min | 81.8 °C | +57 °C | 1800 MHz | `0x80000` |
| Desktop | 4 cores, 6 min | 73.0 °C | +48 °C | 1500 MHz | `0x0` |
| **Lite** | Idle | 41.3 °C | +16 °C | 600 MHz | `0x0` |
| **Lite** | **4 cores, 6 min** | **71.5 °C** | **+46 °C** | 1500 MHz | `0x0` |

No undervoltage bits in any run, so the supply is never implicated. Bit 18 was
never set either — it never hard-throttled. The one failure is the stock-clock
row: it crossed the 80 °C **soft** limit at 5½ minutes and was still climbing
~1 °C per 30 s when the run ended, so 81.8 °C is not its steady state.

What the numbers say:

- This Rev 1.5 board clocks at **1800 MHz**, not the 1500 MHz most Pi 4
  passive-cooling guidance assumes. It runs hotter than that guidance implies.
- **`arm_freq=1500` is the fix**, and it is applied in
  `/boot/firmware/config.txt`. Worth ~9 °C at full load, enough that the soft
  limit is never approached. The workload cannot tell 1.5 GHz from 1.8 GHz.
- **The image barely matters under saturation** — 71.5 °C on Lite against
  73.0 °C on desktop, both capped. Expected: with four cores pegged, a mostly
  idle compositor is noise. Lite was chosen for RAM, SD writes and attack
  surface, not for peak temperature.
- **Idle figures are the weak row.** Settle times differed between runs, so
  treat them as indicative only. A properly settled Lite idle would be below
  41.3 °C.
- The decision ultimately survives on **workload**, not on cooling. njsPC is
  nowhere near four cores pegged.

Capping does not make sustained full load safe in a hot sealed box — +46 °C
over a 50 °C interior still exceeds the 85 °C hard limit. What it does is
restore margin for the case that actually occurs, and make an unexpected busy
spell degrade gracefully rather than throttle.

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

**Rationale (owner, August 2026):** *"I don't want water flowing through the
heater if I am not using it."* That is the whole reason — a preference about
the equipment, not a calculation, and it does not need one.

An earlier draft justified this on energy: "pressure drop across the exchanger
is roughly 9–11 psi, 20+ feet of head". That figure had no source and looked
high for a heat-pump exchanger. **The argument is withdrawn** — not disproved,
just never the real reason. Chasing a number to defend a decision already made
on other grounds is how this document got over-complicated.

**Behaviour, in the owner's words:** pressing Spa or Heat Pool moves the
actuator to flow; when the heater stops, it moves back. That is exactly what
the `spa`, `heatEngage`, `heatRelease` and `pool` sequences already do — the
retraction is the `bypass-around` step, gated behind the purge so hot water
is not left standing in a dead exchanger.

**Because the bypass is binary — full flow or full bypass, not a partial
split — a heater call with the valve in bypass means zero flow through the
exchanger.** The interlock is therefore load-bearing in both directions:

- Heater contacts stay open unless bypass is confirmed in flow position.
- Bypass does not move until the heater is off and any purge has elapsed.

The heater's water pressure switch is a backstop, not the primary control.

### ADR-6 — Chlorinator: Path A, salt reading treated as expendable

**Resolved August 2026.** Owner's call: *"I can live without the salt."* Path B
existed solely to preserve Pentair Home's salt alerts, so with salt expendable
it has no remaining justification and **Path A is adopted**. The IntelliConnect
is retired entirely.

This is not much of a sacrifice, for three reasons:

- **Chlorination is never at risk.** The iChlor has its own display and buttons
  and the IntelliChlor Power Center supplies it, so the cell runs standalone
  regardless. The loss is monitoring, not sanitation.
- **The cell shows low salt on its own display.** So the actual cost is that
  the warning requires a walk to the pad instead of appearing on a phone.
- **Salt drifts slowly.** It leaves only through splash-out, backwash and rain
  overflow. A test strip every month or two is genuinely adequate; the salt
  trend line Path A promised was a nice-to-have.

And it may not be permanent. If case 18 turns out not to arrive from an
iChlor, that is a textbook ADR-13 case — `src/lib/rs485.js` already carries
IC-framing decoders that could seed an upstream patch.

**Still worth confirming during Phase 1**, since it costs nothing while the
bus is being sniffed anyway. Output %, model identification and water
temperature all decode already; salt is the only open reading.

Original analysis follows.

### ADR-6 (original) — decision deferred to bus sniffing

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

**Deciding evidence — sharpened August 2026 by reading the source.** "iChlor
support is less mature" was too vague to act on. What njsPC actually has, in
`controller/comms/messages/status/ChlorinatorStateMessage.ts`:

| Reading | Status in njsPC | Case |
|---|---|---|
| Model identification | **Yes**, `ichlor-ic30` is an enumerated model (30k capacity, 1.0 lb/day). iChlor does not report a model, so it is inferred from a name beginning `iChlor` | 3 |
| Output % | **Yes** | 17, 21, 22 |
| Water temperature | **Yes**, and in Nixie mode it is assigned to the current body | 22 |
| Keep-alive | Recognised, payload unknown — comment says *"perhaps simply a keep alive"* | 19 |
| **Salt PPM** | **Unproven for iChlor.** Salt is decoded in case 18, the generic IntelliChlor status response, which is not marked iChlor-specific | 18 |

So the real ADR-6 question is narrower than "do the frames decode": **it is
whether an iChlor 30 emits the case-18 salt message.** Everything else already
works. Salt alerts are the one thing the owner values that Path B would
preserve, so that single message decides the path.

Encouragingly, the iChlor clearly participates in the shared protocol — it
answers Get Model — so case 18 probably arrives. Probably is what Phase 1 is
for.

**The reverse engineering was done against an IntelliConnect.** Case 22 is
commented *"temp and output as seen from IntelliConnect"* (issue #157), and
case 21 notes the packet "coming through differently on the IntelliConnect."
That is this site's current configuration, so Phase 1 sniffing with the
IntelliConnect still live reproduces exactly the conditions this code was
written for.

**Before the HAT arrives:** njsPC ships an equipment simulator at `anslq25/`
with a `MockChlorinator`. It covers cases 0, 17, 19 and 20 — but *not* 18 or
22, the two that matter here. Useful for standing njsPC up and exercising the
plumbing on a laptop; it cannot answer the salt question.

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

**Specifications, from the Intermatic manual (PE24VA — the PE24GVA is the
next-generation successor and should be confirmed against its own sheet):**

| Spec | Value | Consequence |
|---|---|---|
| Supply | 24 VAC, 60 Hz, **0.75 A** | PRD previously said ~0.7 A. Three sequenced actuators draw 18 VA at a time; 75 VA is ample |
| **Duty cycle** | **1 min ON max, 8 min OFF min** | **New constraint — see below** |
| Circuit rating | Class 2, 24 V, 4 A / 100 VA max | the 100 VA transformer sits exactly at the Class 2 ceiling, which is where it must stay |
| Operating temp | −10 °C to 75 °C | Actuators sit outside the enclosure; not a factor |
| Wiring | black common, red/white switched; rear toggle AUTO 1 / OFF / AUTO 2 | Matches the SPDT selection design |

**The duty cycle is a real constraint and the design does not honour it.**
Nothing in `sequences.js` or the invariants prevents an actuator being
re-driven inside eight minutes. A user toggling spa → pool → spa, each
transition completing normally, would do exactly that. Needs an invariant:

```
an actuator may not be re-driven within ACTUATOR_COOLDOWN_MIN of its last move
```

It also bounds travel: a 180° swing must finish inside the 1-minute ON limit,
so travel is **under 60 sec**. That is consistent with the assumed 45 sec but
does not confirm it — the figure still wants timing.

Note the motor stops itself at the cam limit switch (see the manual's wiring
diagram), so holding a line energised after the valve has arrived does not run
the motor. ADR-9's standing energisation of relay 3 through pool mode is
therefore fine; the duty cycle governs *movement*, not *position holding*.

**Revisited, August 2026.** Reconsidered whether Jandy or Pentair actuators
would reduce the driver-side risk found in ADR-10 — REM inverting a latched
relay mid-travel. They would not. Every actuator in this class is a three-wire
24 VAC cam-limited motor with no position feedback, held in place by gearing
rather than by power, and driven by an SPDT relay selecting which line is
energised. A brand change cannot fix a driver bug, and the interchangeability
noted above cuts both ways.

The one hardware change that *would* buy something is **position feedback**.
Dead reckoning is what forces `ABORTABLE = false`, the unconditional boot
re-drive, and the "valve position drifts — detected by: nothing" row in the
failure table. An actuator with auxiliary position contacts would retire all
three. Whether one exists as a drop-in at this price is unverified; do not
assume it without checking.

Keeping the PE24GVA on merit rather than price: the infinite cam adjustment is
what lets one part number cover the 180° intake and both 90° valves, with one
spare covering any failure.

### ADR-9 — Bypass follows the mode, with a pool-heat override

**Decision:** the bypass rests in *flow* during spa mode and *around* during
pool mode. Calling for pool heat from the app swings it back to flow for the
duration of the call.

**Rationale:** ADR-5 automates the bypass so water does not pass through an
idle heater. Spa mode always heats, so tying the
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

### Bench findings — njsPC on a laptop, August 2026

njsPC 10.0.1 built and run with **no serial port and no REM**
(`controller.comms.enabled = false`). It auto-selected Nixie mode when no OCP
answered. `nixie/valves/Valve.ts` returns success without calling REM when a
valve has no `deviceBinding`, so the whole control layer exercises in
software. **The entire state machine can be developed and tested on a laptop**
— worth knowing for Phase 2, which the PRD schedules as bench work.

What the `nxps` shared-body model creates unprompted: bodies **Pool** and
**Spa**, circuits **Pool** and **Spa**, valves **Intake** and **Return**. That
is this site, out of the box.

| Observed | Consequence |
|---|---|
| Turning the Spa circuit on switched the body **and diverted both valves** | Mode switching is njsPC's job, not ours |
| Both valves diverted **simultaneously and instantly** | Travel time and one-at-a-time ordering are ours (ADR-10 item 3) |
| Model provisions exactly 2 valves | The bypass is ours (ADR-10 item 2) |
| Every circuit has `eggTimer`, default 720 min | Spa auto-revert is configuration, not code |
| A schedule at its start boundary took the body and turned the spa off | See ADR-11 — the serious one |

**A correction to an earlier recommendation:** `anslq25` is not the right tool
for this. `MockBoardFactory` only implements `MockEasyTouch`; the other boards
are commented out. It simulates a Pentair OCP for testing njsPC as a *client*,
which is the opposite of this topology. Nixie with comms disabled is the way
to bench this, and it works better than anslq25 would have.

### ADR-10 — The sequencer supervises njsPC; it does not replace it

**Status: proposed.** Revised August 2026 after reading njsPC's source. The
first draft of this ADR is preserved at the bottom because it was wrong in an
instructive way.

**Decision:** configure njsPC's Nixie control panel to own bodies, circuits,
valves, pumps, schedules and its delay manager. Add a **small supervisor
service** implementing only the interlocks njsPC does not have. The supervisor
is the only external writer.

**Evidence.** `controller/Lockouts.ts` (549 lines) is a delay and interlock
manager that already implements much of what the first draft proposed to
build:

| njsPC already has | Maps to |
|---|---|
| `PumpValveDelay` — pump start waits `valveDelayTime` | "never divert against full flow" |
| `HeaterCooldownDelay(bodyOff, bodyOn)` — switches bodies with a cooldown between | our spa→pool purge step, almost exactly |
| `HeaterStartupDelay` | anti-short-cycle handling |
| `ManualPriorityDelay` — *"will override future schedules until expired/cancelled"*, with an `endTime` | ~~`state.pumpHold`~~, now a running program's expiry |

`controller/nixie/` carries `bodies/`, `valves/`, `circuits/`, `schedules/`,
`heaters/`, `pumps/` and `chemistry/`. `SystemBoard.ts` has `spillway` and
`spadrain` circuit functions gated on `sys.equipment.shared` — a shared-equipment
pool and spa that spills, which is this site's topology.

**What njsPC does not have, and the supervisor therefore owns:**

1. `heaterCall !== 'off' ⟹ pumpRpm >= HEATER_MIN_RPM`. `minSpeed`/`minFlow` in
   `nixie/pumps/Pump.ts` are pump-type limits, not a heat-conditional floor.
2. The bypass policy of ADR-9. Confirmed on the bench: the `nxps` model
   provisions exactly **two** valves, Intake and Return. There is no third.
3. PE24GVA travel modelling. Confirmed by observation: turning on the Spa
   circuit diverted **both valves at once, instantly**. No 45-second travel,
   no one-at-a-time ordering, no dead reckoning.
4. Targets as cutoffs (ADR-4). njsPC assumes it owns heater setpoints; ours
   are held on the heater's own board and are unreadable.
5. Purge conditional on compressor idle. njsPC's cooldown is duration-based.
6. **Protecting a spa session from schedule takeover** — see ADR-11. This
   replaces "spa auto-revert", which turned out to be configuration: every
   circuit has an `eggTimer`, defaulting to 720 minutes. Setting the Spa
   circuit's to `SPA_TIMEOUT_MIN` is the whole feature.

**Consequences:**

- **Resolved, and it keeps the supervisor small.** njsPC stops the pump for a
  body switch (bench-verified), which conflicts with the owner's `VALVE_RPM`
  rule. The priming spec settles it: with priming enabled the pump runs
  1800 RPM for three seconds on every restart *and ignores automation
  commands while it does*, so low flow through a restart is not achievable by
  anyone — not njsPC, not a supervisor. With priming disabled at the pump
  (Pentair's documented procedure), a restart costs only ramp time, which
  makes njsPC's zero-flow behaviour cheap and gentler on the actuator than
  moving under load. **So: accept zero flow during valve travel, disable
  priming at commissioning, and the supervisor does not need to own the
  transition.** The `VALVE_RPM` constant survives only for moves the
  supervisor makes without a pump restart.
- The supervisor is otherwise far smaller than the first draft assumed — six
  rules, not a whole state machine.
- **njsPC in Nixie mode is not passive and cannot be made passive.**
  `HeaterCooldownDelay` calls `setCircuitStateAsync` from its own timer. Any
  design that treats njsPC as a bus library will fight it.
- **dashPanel remains a diagnostic tool, not an operator interface.** It
  commands equipment directly and bypasses whatever the supervisor adds.
- `src/lib/sequences.js` needs re-reading against njsPC's body/circuit model
  before the supervisor is written. Some of its steps may already be njsPC
  configuration rather than code we write.

**Rejected:** the first draft — a standalone sequencer owning modes,
sequences, valve reckoning, targets, hold and schedules, driving njsPC and REM
as dumb outputs. It would have duplicated a large tested subsystem and then
fought it for control. It was written before anyone had read njsPC, which is
the actual lesson.

Forking njsPC is *not* rejected outright — see ADR-13 for when it is the right
tool. What is rejected is treating a fork as the architecture.

### ADR-13 — Forking njsPC is a tactic, not an architecture

**Decision:** patching or forking njsPC is available and sometimes correct.

**Standing commitment, owner's call:** where njsPC turns out to be missing a
reading or a capability this project needs, the default is to **patch it and
open a PR upstream**, not to work around it locally and not to fork quietly.
We are taking an AGPL project and building on it; sending fixes back is both
the decent return and the cheapest long-run maintenance position, because
anything merged is something we stop carrying. A local patch is a holding
position while a PR is in flight, not a destination.

Apply this ladder, cheapest first:

1. **Route around it.** If we can simply not use the component, do that. It
   costs nothing and carries no maintenance. The valve latch (ADR-10 item 3)
   is this case: we don't need njsPC's valve model at all.
2. **Upstream a patch.** `CONTRIBUTING.md` explicitly invites third-party
   patches. If the change is generally useful, this is the best outcome — the
   fork dissolves on merge.
3. **Pinned local patch** while a PR is in flight, or for something too
   site-specific to upstream. Bounded and visible; pin the version.
4. **Reconsider njsPC** only if the needed change is pervasive rather than
   surgical.

**The case where a fork is genuinely likely is ADR-6.** If iChlor 30 frames
do not decode, that cannot be routed around — decoding happens inside njsPC's
comms layer, and the telemetry either reaches MQTT or it does not. That is
step 2 or 3 territory, and `src/lib/rs485.js` already carries IC-framing
decoders that could seed the patch.

**Licensing consequence, and a real reason to keep the supervisor separate.**
njsPC is **AGPL-3.0-only**; REM is **GPL-3.0**. A supervisor running as its own
process and talking to njsPC over its network API is a separate program, and
this repository stays MIT. Fold our logic *into* njsPC and that code becomes
AGPL, taking the MIT licence with it. So keep forks surgical: fix njsPC's bugs
inside njsPC, keep our interlocks in our own process. (Not legal advice —
confirm before relying on it.)

### ADR-11 — njsPC owns schedules; a schedule may end a spa session

**Resolved August 2026**, after a bench test and an owner decision. Third and
final revision of this entry; the earlier drafts are summarised below because
the sequence is instructive.

**Decision:** njsPC keeps its scheduler. A schedule reaching its start boundary
takes the shared body and ends a spa session. **This is accepted.**

**The bench test.** njsPC 10.0.1, Nixie `nxps`, `manualPriority = true`, spa
held on manually, schedule on the Pool circuit starting two minutes later. At
the boundary the Pool circuit came on and the spa went off;
`manualPriorityActive` was never set. Holding the *same* circuit the schedule
targets fared no better — it flipped to `priority: 'scheduled'` and lost its
manual egg timer.

**Why it is acceptable here.** Both facts below are from the owner, not from
the prototype: the spa is used **at night, with the pool off**, and filtration
today is a **single daily 08:00–18:00 window**. No schedule therefore has a
start boundary during spa hours. The collision needs a boundary to fall
*inside* a session, which this usage does not produce. The consequence is
bounded in any case — the spa cannot run dry, so a takeover means the spill
resumes and the pump changes speed. Interrupted soak, not a hazard.

**The trap:** any schedule that starts during evening or night hours
reintroduces this exactly. Adding an evening skim window, or extending
filtration past dusk, puts a boundary back inside spa time.

**Correction worth recording.** The first version of this justification cited
"08:00–20:00", read off the prototype's `INITIAL` schedule array — which is
invented demo data. Nothing in the mock describes this site. The reasoning
happened to survive contact with the real schedule, but it was sourced from
fiction, and the mock now says so in three places.

**Design consequence, and it simplifies things.** Since njsPC owns mode and may
change it at any time, the supervisor **observes and reacts** rather than
asserting mode itself. A schedule-driven body change is then just a mode change
the supervisor responds to — clear the blower, drop the heat call, re-apply the
bypass. There is no state to keep in sync and no veto to arbitrate, which
removes the distributed-lock problem the first draft was worried about.

**Superseded drafts:** the first said the sequencer must own schedules, on the
theory that njsPC could not check `heaterCall` before firing. The second
reversed it after reading `ManualPriorityDelay` and assuming its semantics.
The bench test contradicted the second, and the owner's usage made the first
unnecessary. Reading beat reasoning; running beat reading.

### ADR-12 — Watchdog health spans both processes

**Status: proposed.** Revised alongside ADR-10.

**Decision:** the hardware watchdog is fed only while **both** njsPC and the
supervisor are alive and the supervisor's invariant check passes. Feeding is
conditional on health, never on mere liveness.

**Rationale:** the first draft moved the watchdog from njsPC to the sequencer
on the theory that the sequencer held all the interlocks. Under the revised
ADR-10 the interlocks are split — njsPC holds the delays and body logic, the
supervisor holds the six rules above — so either process dying is dangerous
and neither alone is the right thing to watch.

A liveness ping from a wedged process is worse than no watchdog, because it
buys false confidence. Tie the heartbeat to the invariants actually holding.

**Consequence:** Phase 2 bench testing kills each process in turn. Both cases
must end with every relay de-energised.

**Closed, 27 August 2026, and the answer is that there is nothing to inherit.**
This ADR assumed the relay HAT carries a hardware watchdog, because the product
page advertises one. The card does not. With the HAT fitted and I2C enabled,
the bus holds exactly one device:

```
20: -- -- -- -- -- -- -- 27 -- -- -- -- -- -- -- --      (nothing else, -r rescan)
```

`0x27` is what the driver computes for stack level 0 — `(0 + 0x20) ^ 0x07`.
Probing the offsets with four relays energised gives `0x00`=`0x63`,
`0x01`=`0x63`, `0x02`=`0x00`, `0x03`=`0x00`: input port, output latch,
polarity inversion, configuration — a **PCA9554-class register-mapped
expander**, with configuration `0x00` meaning all eight pins are outputs.

*(A first pass read all four offsets as `0x00` and called that a PCF8574,
which has no register pointer so returns the same byte for any offset. That
was read with every relay off, when a PCA9554 reads all zeros too. The
inference was unsound; energising four channels separated the two in one
command.)*

**A dumb port expander either way. No microcontroller, so no firmware, so no
watchdog**,
whatever the product page says — and by the same token the card cannot be the
MODBUS RTU slave that `pi-bringup.md` claimed it becomes with the TX/RX
switches off. Both statements appear to be inherited from Sequent's
*Industrial* relay card, which is a different product with an MCU.

**So this ADR has to be built, and one detail decides how.** The expander
latches its output byte and holds it for as long as *it* is powered. Which
means the fail-safe depends on which direction power flows, and the bench and
the panel differ:

- **On the bench**, the Pi is mains-powered and the HAT draws 5 V from the
  GPIO header. Cutting the Pi drops the expander, and the relays fall open.
- **In the panel as designed**, the HDR-60-5 feeds the *HAT*, which feeds the
  Pi over GPIO. The HAT stays powered through anything that only stops the Pi
  — so a wedged Pi, a killed process, or a hypothetical watchdog that
  power-cycles only the Pi all leave every relay exactly where it was.

A bench result proving relays drop on power loss therefore **does not
generalise to the panel**, and it would be easy to be reassured by the wrong
test. Options are a supervisor that de-energises on its way out (no help when
wedged), Sequent's separate Super-Watchdog card cutting the **coil** supply
rather than the Pi, or accepting it on the strength of ADR-9's wiring, where
de-energised is the safe rest position for every channel. Not yet decided.

What remains to measure is in `docs/bench-relays.md`: energise a channel, then
take it through a clean shutdown, an abrupt power cut, a killed process and a
reboot, and record which of those end de-energised. **Run the power tests with
the HAT fed from its own 5 V input, not through the Pi**, or the result
describes a bench that is wired the opposite way round from the panel.

**What softens the bad case.** A trip reboots the Pi, and boot re-drives the
valves to pool and leaves the heater off — so even if relays hold through the
trip, a safe state is re-established within a boot. That turns the question
from "is this unsafe" into "how long is too long to hold a bad combination",
which is answerable: the dangerous one is a heat call with the pump stopped,
and it wants a number rather than a shrug.

Do not build a feeder before that measurement. The health condition already
exists in `evaluate()` and the invariant check; what is missing is the relay
it would act on, and code that feeds nothing cannot be tested by anything.

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
| 8 | *spare* | — | gate dropped, see below |

Channels 1–3 require **changeover (COM/NO/NC) contacts**: the actuators keep
one of two lines energized at all times, and an SPDT relay selects which.
NO-only relays cannot drive them — this is precisely why the IntelliConnect's
relays are useless for valves.

**Screw order, and the two groups are mirrored.** Read off the card in hand
(V 7.1, photographed August 2026), not from a product shot:

| Group | Terminal order |
|---|---|
| `RELAY 1`–`RELAY 4` | **N.C. · COM · N.O.** |
| `RELAY 5`–`RELAY 8` | **N.O. · COM · N.C.** |

The actuators are CH1–3, so they sit in the first group and take N.C. first.
Getting this backwards inverts which position a valve rests in with the coil
off, and ADR-9 turns on relay 3's de-energized rest being *flow* — so the
mirroring is worth checking twice on a board where the halves disagree. The
panel plan draws one valve end to end for exactly this reason (`docs/panel/`,
Figure 4).

Channels 4–5 must be **isolated from the 24 VAC transformer**; the Raypak
supplies its own low voltage on that terminal block.

**The channel numbers in this table are relay numbers on the board, and the
Sequent driver does not agree with them.** Measured on the V 7.1 card, 27
August 2026: `8relay` channels 1–5 close relays 1–5, but 6, 7 and 8 close
relays **7, 8 and 6**. So `8relay 0 write 8 on` — nominally the spare, and
therefore the least-tested channel — closes REL6 and **starts the blower**,
whose welded-contact failure mode is stuck-on and which Phase 5 defers for
exactly that reason.

Anything driving this card must use the measured relay→bit table in
`docs/bench-relays.md` and write `0x27` register `0x01` directly, rather than
passing a channel number to that binary. The whole card is one byte; the
indirection buys nothing and costs a rotation nobody would see until a motor
ran.

**Contact rating, settled from the card in hand.** The V 7.1 board is marked
`ALL RELAYS 120VAC/30VDC`, with per-channel current limits silkscreened beside
each connector group:

| Channel | Rated | Load in this design | Margin |
|---|---|---|---|
| 1, 3 | 10 A | actuator, 0.75 A | 13× |
| 2 | 8 A | actuator, 0.75 A | 10× |
| 4 | 3 A | heater dry contact, mA | large |
| 5 | 3 A | heater dry contact, mA | large |
| 6, 8 | 10 A | contactor coil ~80 mA / spare | 100×+ |
| 7 | 5 A | pool light, < 1 A | 5× |

**120 VAC is explicitly rated, so CH7 drives the light directly and no
interposing relay is needed.** This closes §10's blocking question — see there
for why the earlier reading said otherwise.

**Channel 8 is spare: the chlorinator gate is dropped.** *Owner's answer on the
existing wiring:* the chlorinator has its own transformer fed from the
Intermatic subpanel, and **the only thing entering this panel from it is the
RS-485 cable**. So there is no 120 V circuit here to gate, and adding one would
mean a new cable pull, a gland, and possibly a second contactor.

Its only stated purpose was ADR-6's *"relay-gate the power center to suppress
chlorination during spa mode"* — not flow protection and not safety, since the
cell has its own supply and its own flow detection. ADR-6 already records the
cheaper alternatives: command a low output percentage over the bus, *"or accept
it, since a short soak barely moves the needle."*

**Owner's call:** if njsPC and the iChlor cannot hold separate pool and spa
percentages, or cannot change output on demand per mode, then we simply do not
change it. Either way the channel comes out of the hardware. Whether njsPC
exposes a writable chlorinator setpoint is unverified and no longer blocking —
and if it turns out to be missing, ADR-13's standing commitment applies: patch
it and open a PR.

**This panel switches; it does not distribute.** Light and blower are branch
circuits from the **Intermatic T40004RT3** — a 100 A subpanel with eight
breaker spaces — looped out to a contact here and back, exactly as they are
looped through the IntelliConnect today. Each load keeps its breaker and its
protection there. The consequence for this panel is that its own 120 V feed
carries only the transformer and the 5 V supply, about **2.6 A**, rather than
the ~11 A it would need if the blower's 7.3 A ran through it.

*Two things this leaves open.* The T40004RT3 also contains a **300 W
transformer**; it is tempting as a substitute for the TR100VA001, but 300 VA is
three times the Class 2 ceiling ADR-8 requires for the PE24GVA, so read its
nameplate before assuming anything. And CH7 drives the light directly from a
HAT relay, which drags a 120 V pair up into the logic band — within the card's
4 A rating, but the one place the voltage-band layout breaks down.

The blower is 7.3 A running but 30–45 A locked-rotor inrush. Relay-board
contacts are rated for resistive loads; a motor needs a definite-purpose
contactor. The failure mode of a welded contact is a blower stuck **on**,
which is the worst direction.

Channel 7 sees far more switching cycles than any other channel, because
Jandy color changes work by counting brief power interruptions. If a channel
fails it will be that one; remap in software rather than replacing the board.

### Power budget

- 24 VAC transformer, **100 VA**: 3 actuators × ~0.7 A + contactor coil.
  75 VA works only if the actuators are strictly sequenced, and njsPC
  diverts both valves at once — measured on the bench, not assumed. 54 VA of
  simultaneous actuators plus contactor inrush plausibly exceeds 75 VA, and
  the contactor's inrush figure is still unread. 100 VA is ~$10 more, is
  still within the Class 2 limit the PE24GVA requires, and removes the
  dependency on both the datasheet and on njsPC never doing that again.

  *Settled by the part.* The chosen TR100VA001 is **Class 2 UL5085-3 listed**
  and carries its own manual-reset circuit breaker, so the ADR-8 requirement
  is met by the transformer's own listing rather than by arithmetic about
  where 100 VA sits. Its datasheet also adds a number the thermal work will
  need: **operating range -30 to 140 °F (-34 to 60 °C)**. That is a second
  documented ceiling inside the sealed box. The Pi's 50 °C is still the
  tighter of the two, so it stays the binding constraint — but the margin
  between them is 10 °C, not the comfortable gap one might assume.
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

A hardware watchdog drops all relays if the **sequencer** stops asserting
health — see ADR-12. Earlier drafts pointed this at njsPC, which was correct
while njsPC was going to be the entire controller and is not correct under
ADR-10.

### Enclosure

Non-metallic NEMA 4X. A metal enclosure would trigger NEC 680 equipotential
bonding requirements. Sealed, no vents, passive cooling only.

**The backplate is ABS too, and that changes how grounding works.** Nothing
inside the box is bonded by accident: there is no metal can and no steel
plate, so a DIN rail mounted on that plate is floating. Equipment grounding
conductors — line feed in, blower out, light out — land on a ground bar that
must be **deliberately** wired back to the incoming EGC.

The failure mode is quiet. Every conductor on the bar is continuous with every
other one whether or not the bar reaches earth, so a continuity check between
EGCs proves nothing. The only check that means anything is bar-to-incoming-
ground.

The enclosure's own metal is 304 stainless hinge pins, two latches and four
wall brackets, all isolated from live parts by 3.5 mm of ABS. Whether NEC 680
wants any of it bonded depends on proximity to the water and on the AHJ; it is
a question for the electrician, not a decision this document makes.

Mount to the detachable plate, never through the enclosure body — the only
holes in that shell should be the bottom-face entries and the breather. Heavy
parts (transformer, contactor) want through-bolts or threaded inserts rather
than self-tappers: the plate is ABS, and it will sit hot.

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

**Valves move one at a time, at low flow — not at speed, and not at zero.**
`VALVE_RPM` is 1000. Owner's decision, August 2026, and the reasoning is worth
keeping:

- Never at speed. Water hammer, and the actuator has to fight hydraulic force
  on the diverter. At 1000 rpm the pump is at roughly 8% of full pressure
  (pressure scales with rpm²) and 2% of full power, so both problems mostly
  disappear.
- Not at zero either. Stopping the pump for every transition adds a stop/start
  cycle and an IntelliFlo priming cycle to a sequence that already takes
  minutes, for no benefit — these are three-way diverters, not shutoffs, so
  mid-travel both ports are partially open and there is no deadhead to avoid.

The consequence is that **the pump must be held at low speed across the whole
transition**, which is a stronger requirement than "don't divert at full
flow" and may not be expressible by delegating the body switch to njsPC. Three sequential 45 sec moves
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
an actuator may not be re-driven within ACTUATOR_COOLDOWN_MIN of its last move
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

**This decision rests on an unmeasured number.** The 45 sec travel is an
assumption, not a measurement. If a PE24GVA actually swings in 15 sec, the
argument weakens considerably and abort-at-step-boundary becomes worth
revisiting. Re-examine once travel is timed.

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

A heat call floors the pump at `HEATER_MIN_RPM`. Clamp rather than dropping
the call: silently stopping the heat to honour a speed is the worse surprise,
and the heater's own flow switch is a backstop rather than the primary
control.

*Superseded in the UI.* This originally described a live speed slider, which
has been removed — see the pump-speed open question. The floor now applies to
whatever speed a program or schedule asks for, and lives in
`supervisor/interlocks.js` as `floorRpm`.

### Position tracking

The actuators provide no position feedback. Position is dead-reckoned and
persisted to disk. **On boot, unconditionally re-drive all valves to pool
position** to resynchronize. Cheap and correct.

### Conditional purge

Skip the purge step entirely if the compressor has not run in the last five
minutes — the common case. This makes "Spa now" about two minutes instead of
five, almost all of it valve travel.

### Heater behaviour to model, not alert on

*All confirmed against the Raypak Installation & Operation manual, August 2026,
unless noted.*

- Anti-short-cycle delay after any shutdown. **The manual gives two figures:**
  the Delay Timer description says *"approximately 5 minutes"*, while the
  Compressor Delay Active lamp is described as *"the fan will run but the
  compressor will be OFF for 6 to 8 minutes"*. `PURGE_SKIP_AFTER_MIN` is 5,
  which is the optimistic reading — 8 would be the safe one. Time it on the
  real unit before trusting the short path.
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
- Pool heating is slow — **about 4 days from cold, up to a week in cold
  weather** — and most efficient during warm daylight hours. Model it as a
  target temperature with a maintenance schedule, not a button. Raypak also
  gives the steady-state figure: once at temperature, **8–10 hours per day**
  of operation maintains it.

  *Source, and a correction.* This was struck from the document as fabricated,
  on the basis that nobody could say where it came from. It turns out to be
  Raypak's own: the Installation & Operation manual, Troubleshooting, p.14 —
  *"During initial pool heating in cold weather, it may require a week to
  elevate the water temperature to a comfortable level. Normally, it takes
  about 4 days."* Restored with its citation.

  The lesson cuts the other way from the one recorded below. "Where did this
  number come from" is the right question, but *absence of a remembered source
  is not evidence of fabrication* — the manual had it all along, and ten
  minutes of reading would have found it before anything was deleted.

### Pump

Power scales with the **cube** of speed (affinity law). 1600 rpm costs about
a tenth of 3450, not half. Any speed 0–3450 in 1 rpm steps; the pump returns
current rpm and energy consumption over RS-485.

Spa mode owns the pump while active and overrides schedules. A schedule
dropping the pump to 1400 rpm mid-soak would be a bad surprise.

**Speed is never set by hand.** It belongs to a schedule (a window plus a
speed), to a **manual program** (a name, a speed and a required expiry), or to
spa mode. njsPC has no runtime pump-speed endpoint precisely because this is
how pool controllers model the pump, and Pentair's own app has no slider for
the same reason.

A manual program overrides the schedule while it runs, via njsPC's
`ManualPriorityDelay`, and stops on its own — the expiry is mandatory, since
njsPC's default egg timer is 720 minutes and a manual run you walk away from
is what it exists to prevent.

Two coarser controls sit above all of this: **run/stop** for the pump itself,
and **service mode**, njsPC's panel mode, which stands every schedule down at
once without disabling them one by one.

*Superseded.* An earlier draft described a transient hand-set speed pinned by
a "manual hold". Both went with the slider — see the pump-speed open question
for why the absence of an endpoint was the domain model rather than a gap.

---

## 6. Product requirements

### PR-1 — "Spa now" is the default path

The owner starts the spa and gets in immediately. Scheduled preheat ("spa
ready at 7:30") is an option, not a mandate. Do not gate entry on reaching
setpoint.

### PR-2 — Show the water path, not a spinner

Transitions take about two minutes — an estimate built on assumed valve
travel, not a measurement. A spinner over two minutes of silence produces
button-mashing. The schematic shows which valve points where and
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

### Later — in the cart, priced

*Actual prices, August 2026. Lines still marked ~ are estimates.*

| Item | Price |
|---|---|
| Intermatic PE24GVA valve actuator × 3 | **$473.10** |
| Functional Devices **TR100VA001**, 100 VA 120→24 VAC, Class 2 UL5085-3, breaker | **$61.01** |
| Eaton C25CNB130T contactor, 30 A, 24 V coil | **$32.50** |
| Mean Well HDR-60-5 DIN-rail supply, 5 V 6.5 A | **$24.46** |
| IP68 breather screw, M12×1.5, dual-port, 2-pack | **$6.99** |
| VEVOR outdoor junction box **SP-CAG-334318**, 16.93×12.99×7.09 in — ABS, IP67/IK08, hinged, 304 stainless latches, detachable **ABS** backplate | ~$70 |
| DIN rail, terminal blocks (**20**: 16 on rail B, 4 on rail C, plus a 4-way, a 5-way and two 2-way combs), ferrules, wire | ~$40 |
| Liquid-tight cable glands / cord grips, ~9 | ~$22 |
| Ground bar / PE terminal strip, plus the jumper to the incoming EGC | ~$10 |

**Total ~$898**, plus $2.40 shipping on the HDR-60-5; every other line ships free.

**The estimates were wrong in both directions, and it is worth seeing how.**
The actuators came in at $157.70 rather than the ~$193 assumed — that one line
is $107 under, and it is most of the saving. Against it, the transformer ran
$21 over and the contactor $12.50 over. So the **total dropped ~$79 while the
control system alone rose ~$28**: the part that got cheaper was the part that
is not the control system. An estimate that had been right on the total would
still have been wrong about both halves.

*Two notes on quantities.* The enclosure ships with one cable sealing sleeve
(3/8 / 1/2 in); it does not displace any of the nine glands above, being one
part offered in two sizes and smaller than the 3/4 in entries. The breather
comes two to a pack, so there is a spare.

**Against an IntelliCenter, compared honestly.** An earlier draft of this
table put ~$650 against "$1,300–2,000 for a factory IntelliCenter i5PS",
which flattered this project by mixing two different things: our figure
includes three valve actuators, and that one is the control system alone —
an IntelliCenter needs the same three actuators bolted to the same valves.

| | control system | + 3 actuators |
|---|---|---|
| This build | ~$425 | ~$898 |
| IntelliCenter i5PS | $1,300–2,000 | ~$1,900–2,600 |

Either row is a fair comparison; mixing them is not. The case is strong
enough on the honest numbers that it never needed the flattering ones.

Note also that the actuator line was ~$300 for a long time, which was ~$100
each. They are ~$194. That single line is most of the difference between the
old total and this one, and it is the one item worth ordering early —
stock is intermittent.

**On the enclosure, and why this one.** The line said "non-metallic NEMA 4X,
~$60", which was never priced: a genuinely UL-listed NEMA 4X *polycarbonate*
box in this size is an industrial part at $150–250. Three honest positions
existed, decided by whether the pad is shaded and whether the install is
inspected:

| | ~cost | gives up |
|---|---|---|
| UL-listed NEMA 4X polycarbonate | $150–250 | nothing |
| IP67 ABS, unlisted | $50–90 | UV stability, third-party listing |
| UL-listed PVC, NEMA 3R | $40–80 | watertight and corrosion rating |

**Chosen: IP67 ABS, one size up from the spec.** A shaded pad and an
uninspected panel make the listing worth less than the room and the money.
IP67 with a PU gasket, 304 stainless latch and an included backplate is
adequate hardware; ABS under UV is the accepted risk, and it is accepted
because of the shade rather than in spite of the sun.

**Sized for thermals, not for wiring comfort.** This is the part worth
recording, because a future reader will otherwise see an oversized box and
trim it. §10 still carries *enclosure thermals* as open: the bench measured
+14 °C over ambient **without** the HAT and **unsealed**, and the assembled
box holds four heat sources — Pi, relay HAT, 100 VA transformer, 5 V supply.
A sealed enclosure sheds heat only through its walls, so dissipation tracks
external surface area:

| VEVOR size | internal | plate | ext. surface |
|---|---|---|---|
| 13.78×9.84×5.90 | 12.51 × 8.58 × 4.96 | 107 in² | 550 in² |
| **16.93×12.99×7.09** | **15.12 × 11.18 × 6.29** | **169 in²** | **864 in²** |
| 20.87×16.92×7.87 | 19.01 × 15.08 × 7.12 | 287 in² | 1300 in² |

The middle size buys 1.6× the smallest box's dissipating area for a few
dollars — the cheapest mitigation available for the one thermal risk still
untested, and cheaper than discovering at commissioning that it needs a vent
or a fan. The largest was rejected as 21×17 inches of wall for benefit beyond
what the load needs. Its internal footprint also slightly exceeds the
original 14×12×6, so this is ahead of the spec rather than a compromise.

**It mounts portrait, and that decides the layout.** *Owner's constraint:
the mount space.* So the plate is **11.18 in wide by 15.12 in tall**, not the
other way round — `430 × 330 × 180 mm` is height × width × depth. Two
consequences.

The three-band voltage stack suits portrait better than landscape: the Pi and
the transformer end up 15.12 in apart instead of 11.18, which is free margin
on both the heat and the Wi-Fi arguments in ADR-3. Thermal sizing is
unaffected — that rested on external surface area, which does not care about
orientation.

**But the entries no longer fit on one face.** Ten entries need roughly
13.25 in of hole plus locknut clearance; the bottom wall offers about 11.5 in
usable once corner radii and wall thickness come off. So they split: **low
voltage down the left face, line voltage along the bottom.** Forced by
arithmetic, but better practice than one row — the two classes now pass
through different walls rather than sharing one.

A third consequence shows up only in the wiring drawing: on a portrait plate
the **right margin is the only path** from the bottom face or the lower left
up to the HAT. It carries four risers — both RS-485 cables, the heater
three-wire and the light loop — and there is little room left for a fifth.
Anything later that needs to reach the HAT competes for it.

**Internal depth: 6.29 in, not 4.84.** *Resolved against the manufacturer
datasheet for SP-CAG-334318, which gives 384 × 284 × 160 mm internal.* The
retail listing's 4.84 in was the sloppy figure this document suspected, and
the arithmetic says which one to believe: against a 180 mm external depth and
3.5 mm walls, 160 mm leaves 20 mm for the base wall and the lid, while 123 mm
leaves 57 mm unaccounted for on a flat-top cover.

That is 1.45 in more than was assumed, and it matters where it was assumed to
hurt: a ~3.5 in transformer now leaves ~2.8 in to route conductors over rather
than ~1.3. **Still measure the base on arrival** — the two figures may differ
because one is base-only and the other base-plus-lid, and a layout committed
to vendor copy is a layout committed to marketing.

**Non-metallic is not a preference.** Steel NEMA 4 enclosures are often
cheaper than polycarbonate and will dominate any price search. A metal box is
a Faraday cage and the Pi reaches the house over WiFi, so choosing one means
adding an external antenna and a bulkhead gland — spending money and adding a
leak path to save less than the antenna costs.

**On the two smallest lines.** A NEMA 4X rating is a property of the whole
assembly, not the box: every cable entry needs a liquid-tight gland or the
rating is void, and this panel has a lot of entries — 120 V supply, **two**
RS-485 runs, 24 VAC to three actuators, the heater's three-wire, the blower
contactor and the light. And a sealed box outdoors in Florida
breathes: it warms in sun, cools at night, and pulls in humid air through
whatever gap it has. A breather-drain equalises that and lets condensate out
while keeping the rating. Both are the kind of $15 part that holds up an
install for a week because nobody listed it.

### RS-485 bus topology

**Two cables, and the panel sits in the middle of the bus.** *Owner's
answer, confirming the physical layout:* the pump and the cell are both in
front of the panel and **each home-runs on its own cable**. They are not
chained to one another.

Electrically this is still one bus. The HAT carries a single transceiver on
the Pi's GPIO UART, and its two RS-485 terminals are wired in parallel to it —
two places to land wire on one port, not two ports. njsPC distinguishes the
devices by address, not by conductor.

Three consequences, none of them optional:

- **Two glands, not one.** A cord grip seals one round cable inside a stated
  diameter range; two cables in one grip leaves voids either side and voids
  IP67 for the whole assembly. The entry list carries nine entries, not eight.
- **The HAT's termination DIP stays OFF.** With a device at each end and the
  panel between them, the panel is a mid-bus node. Termination belongs at the
  two physical ends. This is the third of the HAT's three RS-485 switches and
  `docs/pi-bringup.md` previously covered only TX and RX.
- **It is the better topology anyway.** Panel-in-the-middle is a proper linear
  bus. Chaining the two devices outside instead would make the panel an end —
  one gland saved, the termination switch flipped **on**, and a cable joint
  created at the pad that does not exist today. Both existing cables already
  run to the IntelliConnect being retired, so two home runs is also the
  wiring that is already in the ground.

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

- [x] **The relay HAT's contact rating.** *Resolved 27 August 2026, from the
      card in hand.* The board that arrived is **V 7.1**, not the V6.0 the
      product photograph showed, and its silkscreen is different in exactly
      the place that mattered:

      | Source | Rating |
      |---|---|
      | Sequent product page and this BOM | 4 A at 120 VAC / 24 VDC, all eight channels |
      | Silkscreen, V6.0 product photograph | `RELAYS 1–3: 5A/48VAC/DC`, `RELAYS 5–8: 5A/48VAC/DC`, `RELAY4: 3A/48V` |
      | **Silkscreen, the V 7.1 card in hand** | **`ALL RELAYS 120VAC/30VDC`**, with per-channel current: `REL1,3: 10A`, `REL2: 8A`, `REL4: 3A`, `REL5: 3A`, `REL6,8: 10A`, `REL7: 5A` |

      **120 VAC is rated outright, so CH7 drives the light directly and the
      interposing relay this BOM lacked is not needed.** Every channel has at
      least 5× margin on current; the table is in §4.

      The lesson is the one this document keeps relearning: the V6.0 figure was
      never wrong, it was a fact about a *different board*. A photograph found
      on the internet is not the part you own. Two revisions of the same
      product disagreed about whether a mains load may land on the card, and
      only the one in the box counts.

      *Still worth asking Sequent* — not blocking anything — why v6 was marked
      48 V and v7 is marked 120 V. If it is a creepage change, the answer bears
      on any spare bought later; if it is a correction to v6's marking, older
      cards in circulation are mismarked.

- [x] **Chlorinator path.** *Resolved* — Path A (ADR-6). What remains is
      narrower and tracked there: whether an iChlor 30 emits the case-18 salt
      message. Salt has been accepted as expendable either way.
- [ ] **`HEATER_MIN_RPM`.** Currently 1900, a placeholder. Measure by ramping
      the pump and noting where the heat pump's flow fault clears.
- [ ] **`CELL_MIN_RPM`.** Currently 1150, a placeholder. Measure by noting
      where the iChlor begins generating.
- [ ] **Spill confirmation.** Verify the pool returns actually go dead when
      the return diverter moves to full-spa. If they keep flowing, the spill
      is plumbed off an independent tee and the model needs revision.
- [x] **Does the microSD come out with the HAT fitted?** *Answered 27 August
      2026 on the bench — yes, there is enough clearance.* The card sits on
      11 mm standoffs over the SoC, and the concern was that reflashing would
      mean dismantling the panel. It does not.

- [ ] **Enclosure thermals.** Bench figures are in ADR-3; the assembled case
      is untested. Re-measure with the HAT fitted, the box closed, and the
      transformer energised, on a hot afternoon. Mitigations in rough order
      of cost: mount out of direct sun or add a shade; `arm_freq=1500` is
      already applied and worth ~9 °C; move the
      transformer to its own enclosure so the biggest heat source is not
      sharing air with the Pi; add a conduction path from the SoC heatsink
      to a plate through the wall — checking first that it raises no NEC 680
      bonding question, which is why the box is non-metallic to begin with.
- [x] **Does njsPC's shared-equipment model fit this plumbing?** *Answered on
      the bench* — yes. The `nxps` model creates Pool/Spa bodies, Pool/Spa
      circuits and Intake/Return valves unprompted, and turning the Spa circuit
      on switches the body and diverts both valves. Mode switching is njsPC's.
      The residual — whether the spill actually stops in full-spa — is the
      separate spill-confirmation question below.
- [x] **REM latch semantics against the PE24GVA.** *Answered by reading the
      source.* `SequentIO.ts` sets `state: !newState` when the latch timer
      expires — it **inverts** the relay. njsPC hardcodes `latch: 10000` for
      valves, so a divert command would reverse after 10 sec, against 45 sec
      of travel, while `isDiverted` still read true. Not an actuator problem:
      any 24 VAC three-wire actuator behaves the same. **Resolution:** the
      supervisor drives the three valve relays through REM directly with no
      latch, per ADR-10 item 3. njsPC's Nixie valve model is not used for
      these actuators.
- [x] **Does `manualPriorityActive` survive a schedule boundary?** *Answered
      on the bench* — **no.** The schedule took the shared body and switched
      the spa off; the flag was never set, with `manualPriority` enabled. See
      ADR-11, which is resolved on the strength of this.
- [x] **Water temperature source.** *Likely answered.* njsPC case 22 assigns
      the iChlor's own temperature probe to the current body when running in
      Nixie mode, so the BOM needs no sensor. Caveats: one byte, so 1 °F
      resolution; a sanity floor of 40 °F; it reads at the cell on the return
      line rather than in the pool; and it arrives only in iChlor case-22
      messages. Adequate for heat cutoffs and the preheat estimate, not a
      precision instrument. Confirm the reading appears in Phase 1.
      Fallback if it does not: a REM temperature probe, which is the only
      option left, since the 3-wire heater interface reports nothing and the
      pump does not measure water. Settle before Phase 3.
- [x] **What does the pump do during an njsPC body switch?** *Answered on
      the bench, and the answer is "neither of the two acceptable outcomes".*

      Configured a VSF pump (Pool 1600, Spa 2800), set `pumpDelay = true` and
      `valveDelayTime = 20`, then switched bodies. At t=0 both valves diverted
      and a `pumpValveDelay` appeared, holding `pumpOnDelay = true` for the
      full 20 sec. `nixie/pumps/Pump.ts` settles what that means:

      ```js
      let _newSpeed = 0;
      if (!pState.pumpOnDelay) { /* …compute speed… */ }
      ```

      **The commanded speed is zero.** njsPC stops the pump for the valve
      move and restarts it afterwards.

      And turning `pumpDelay` off is worse, not better. Pool goes off and Spa
      comes on in the same instant, so without the delay the commanded speed
      steps straight from 1600 to 2800 *while the valves are travelling* —
      full flow, the thing §5 exists to prevent.

      **So njsPC offers zero flow or full flow through a valve move. The
      1000 rpm the owner asked for is not expressible in its model.**

      Consequences, all recorded against ADR-10:

      - The supervisor **cannot delegate the body switch to njsPC**. It has to
        own the choreography: hold the pump at `VALVE_RPM`, move one valve at
        a time, then hand speed control back.
      - Or the requirement changes. Zero flow is *safer* for the actuator —
        no hydraulic load at all — and the reason to avoid it was the pump
        stop/start and the IntelliFlo priming cycle, not safety. That is a
        real trade to weigh, not an obvious loss.
      - Either way this is a decision, not a detail: it is the difference
        between a supervisor that watches njsPC and one that takes the wheel
        for two minutes per transition.

- [x] **IntelliFlo priming across a pump restart.** *Answered from the
      IntelliFlo VSF Installation and User's Guide, pp. 17–19.* Defaults:

      | Setting | Default |
      |---|---|
      | Priming | **Enabled** |
      | Startup check | ramp to **1800 RPM, pause 3 sec** |
      | Priming Speed (if prime not detected) | **3450 RPM** |
      | Priming Delay | **20 seconds** |
      | Max Priming Duration | **11 minutes** |
      | Loss of Prime | Enabled — 1 min pause, then re-prime |

      The 3-second check runs on *every* start; the 3450 RPM cycle only when
      prime is not detected, which is why it looks intermittent.

      **The decisive line, p.19:** *"the priming feature on the pump cannot be
      disabled by the external automation control system only. It must also be
      disabled on the pump itself"*, because *"if priming is enabled on start
      up, the pump responds to its internal settings **before** responding to
      commands from an automation control system."*

      So across any pump restart the pump runs 1800 RPM for three seconds
      regardless of what njsPC commands — **above `VALVE_RPM` (1000)**. With
      priming enabled the low-flow rule is unenforceable through a restart,
      whoever owns the choreography.

      Pentair documents the fix (p.19): disable priming on the automation
      system, disconnect RS-485, disable priming at the pump keypad, reconnect.
      **Do this at commissioning.** The cost is that genuine air — after filter
      service — needs a manual prime instead of a self-heal.

- [x] **Thermal Mode.** *Decided: leave it enabled.* It is on by default and
      starts the pump at **1000 RPM at 40 °F**, outside njsPC's control. It is
      not a comfort feature and has nothing to do with whether anyone is using
      the pool — the sensor is in the drive on top of the motor and the manual
      is explicit that it *"is for protection of the pump. Do not depend on
      the Thermal Mode feature for freeze protection of the pool."* Disabling
      it to keep the state model tidy would trade a pump for neatness.

      **The consequence the software must absorb:** on a handful of winter
      nights the pump starts with nothing having commanded it. Harmless in
      itself — pool mode already has the valves settled and the bypass around
      the heater — but any "pump running unexpectedly" check must treat this
      as normal, or it will cry wolf every cold snap. Pool freeze protection
      is a separate concern and is deliberately out of scope for v1.

- [x] **How the pump gets a speed.** *Answered, and it changed the UI.* njsPC
      has no runtime pump-speed endpoint: it drives the pump from circuits,
      and `/config/pumpCircuit` only rewrites what a circuit runs at.

      That absence was the domain model talking, not a gap. Pentair's own app
      has no speed slider either, for the same reason — nobody dials an rpm,
      they pick a program. The slider was a fabricated nice-to-have; it has
      been removed along with `setRpm`, the preset row, and the threshold
      markers that decorated it.

      Speed now lives in exactly two places, both of which njsPC already
      models: **a schedule** (window plus speed) and **a program** (name,
      speed, and a required expiry). Each program is one circuit with a pump
      speed and an `eggTimer`. "Hold this speed" went with the slider — it
      only meant anything when there was an arbitrary speed to hold.

      Commissioning gains: create a circuit per program.

- [ ] **Valve travel time.** Bounded **under 60 sec** by the manual's 1-minute
      duty cycle, but not stated exactly. `sequences.js` assumes 45 sec per move
      and three of them dominate a transition. Never measured. Three things
      lean on it: the "about two minutes" figure in PR-2, the conditional
      purge's payoff, and — most importantly — the `ABORTABLE = false`
      decision, whose whole argument is that a 45 sec bound makes
      abort-at-boundary pointless. Time one actuator before trusting any of
      the three.
- [ ] **Purge duration.** `sequences.js` assumes 3 min. The Raypak's real
      requirement after a compressor stop is unconfirmed; the ~5 min
      anti-short-cycle figure is a different thing. Overstating it makes
      "Spa now" slower than it needs to be; understating it pushes hot water
      through a stopped exchanger.
- [ ] **Blower airflow.** "115 CFM" underpins the break-even claim in PR-4 and
      the estimate copy. Read the nameplate.
- [ ] **IntelliFlo VSF power curve.** `pump.js` uses `WATTS_MAX = 2400` at
      3450 rpm, marked "approximate". Every watt and dollar the UI shows
      derives from it, and njsPC reports real consumption off the bus once
      connected — so this is a placeholder with a known replacement.
- [ ] **Pool volume.** Never measured, and not previously listed. Needed
      before winter pool-heating can be modelled as anything more precise
      than "slow".
- [x] **Exchanger pressure drop.** *Closed — not decision-bearing.* It existed
      only to test ADR-5's energy justification, which is withdrawn. Nice to
      know, never needed.
- [ ] **Spa jet rpm.** 2800 is a guess. Tune empirically once speed is
      settable from a phone.
- [ ] **Contactor inrush VA.** Still unread — the Eaton datasheet did not
      retrieve. The arithmetic mostly settles it anyway, and exposes a
      dependency worth knowing:

      | Load | VA at 24 V |
      |---|---|
      | One actuator moving | 18 |
      | Three actuators moving **simultaneously** | 54 |
      | Contactor coil inrush | unknown; tens of VA for this class |

      Sequenced, one actuator plus a contactor pull-in is comfortably inside
      75 VA. **Simultaneous, it is not** — 54 VA of actuators plus inrush
      plausibly exceeds it. So the "sequenced, never simultaneous" note in the
      power budget is not a stylistic preference, it is what makes 75 VA work.
      And njsPC violates it by default: the bench test showed it diverting
      both valves at once. Same finding as the water-hammer concern, second
      consequence.

      **Recommendation: buy the 100 VA transformer.** It is roughly $10 more,
      it removes the dependency on an unread datasheet, and it survives a
      future mistake where two actuators do move together.
- [ ] **Boot resync vs the actuator duty cycle.** The boot sequence re-drives
      all three valves unconditionally. If njsPC or the supervisor restarts
      repeatedly — a crash loop — that violates the 8-minute rule every cycle.
      Needs a guard, or a persisted last-moved timestamp that survives restart.

---

### Claims resting on unmeasured values

An audit prompted by finding that ADR-11 had been justified on the
prototype's invented schedule data. Everything below is a statement in this
document that depends on a number nobody has measured, and should not be
cited as fact until the corresponding open question above is closed.

Two were challenged for having no source, and they ended differently, which is
the more useful lesson. **"Pool heating ~4 days from cold"** was struck as
invented — then found verbatim in Raypak's manual, and restored. **ADR-5's
"9–11 psi"** genuinely had no source, and was withdrawn rather than chased,
because the decision it appeared to support turned out to rest on an owner
preference that needs no figure at all.

So the test — ask where the number came from — is right, but it has two
failure modes, not one. A number with no *remembered* source may still have a
real one, and deleting on suspicion destroys facts. A number nobody relies on
does not need investigating at all. Any figure in this document that cannot answer that should be
treated as fiction until it can.

| Claim | Rests on | Would change if wrong |
|---|---|---|
| `ABORTABLE = false` — abort-at-boundary "buys little" | 45 sec valve travel | **A decision.** Short travel makes abort worth reconsidering |
| PR-2 — "transitions take about two minutes" | 45 sec × 3 valve moves | The case for a water-path view over a spinner |
| Conditional purge — "two minutes instead of five" | 45 sec travel + 3 min purge | The payoff that justifies the skip logic |
| ADR-9 — pool heat costs "one 45 sec valve move" | 45 sec travel | How expensive engaging pool heat feels |
| PR-4 — blower and heater "roughly cancel" | 115 CFM, 20–25 °F/hr | The estimate copy, and whether the advice is right |
| Spa preheat 45–75 min | 20–25 °F/hr; volume now **measured** at 458 gal | Every preheat estimate, and scheduled preheat later |
| Pool heating ~4 days from cold | **Raypak I&O manual p.14** | Restored — was wrongly struck as invented before the manual was read |
| ~~ADR-5(b) — exchanger drop "9–11 psi"~~ | **no source** | Withdrawn. ADR-5 now rests on the owner's stated preference, which needs no figure |
| Watts and dollars shown in the UI | `WATTS_MAX = 2400` | Every cost figure — though njsPC replaces it with real telemetry |

**Verified, for contrast** — these look like assumptions and are not:
heater caps 95/104 °F (Raypak firmware, ADR-4), Pi thermals (measured, ADR-3),
`latch` inverting the relay (read from REM source), the `nxps` shared-body
model (observed on the bench), and njsPC decoding iChlor output and
temperature (read from source).

---

## 11. Software backlog

- **Warnings should reach the phone, not wait on the screen.** Owner's
      call, August 2026: deferred deliberately, not rejected. Everything the
      supervisor has learned to notice — commissioning findings, invariant
      breaches, "a schedule will start the pump at 15:24" — is only visible to
      someone already looking at the app. The alarming cases are exactly the
      ones where nobody is: a valve delay too short for the travel, a spa with
      no expiry, a pump about to restart into an open filter housing. A screen
      is the wrong channel for those.

      **Blocked on TLS, not on push infrastructure.** Measured against the
      Pi's own origin rather than assumed: over plain HTTP,
      `isSecureContext` is false, `navigator.serviceWorker` is absent
      entirely, and `Notification.requestPermission()` returns `denied`
      without even prompting. Browsers refuse notifications from an insecure
      origin — so there is no cheap in-page first version to ship ahead of
      TLS. Every form of this needs a secure context first.

      That reorders the list: TLS is not a separate nicety, it is the
      prerequisite for the notification channel, and it brings the `Secure`
      cookie flag with it. Two decisions turn out to be one, which also makes
      TLS considerably easier to justify than when it was weighed on
      interception risk alone.

      After TLS, the remaining cost is real but smaller: a manifest, a
      service worker and VAPID keys. Note that iOS delivers web push only to
      a site installed to the Home Screen, so the phone needs that step;
      desktop and Android get notifications from TLS alone.

      Home Assistant remains the cheaper route for the phone specifically:
      it already has notifications, per-device and reliable, and the
      supervisor will be speaking to it in Phase 6 anyway. Publishing these
      as events and letting HA decide who gets told avoids building a second
      delivery path — worth weighing against a PWA install once TLS exists.

- [~] **Authentication. Two of four parts done.** Anyone who joins the wifi —
      a guest, a compromised smart bulb, a neighbour with the password — can
      reach the supervisor on 4300 and drive 240 V equipment: switch to spa,
      call for heat, stop the pump, rewrite schedules. Owner's requirement,
      August 2026. Four things make it more than "add a password":

      - [x] **njsPC's own port was the wider hole.** 4200 accepted anything
        from anyone, and dashPanel deliberately bypasses every interlock we
        add. Now bound to `127.0.0.1`, verified refused from the LAN address,
        and the supervisor probes its own network addresses each commissioning
        review so reopening it raises a warning rather than going unnoticed.
        dashPanel is reached over an SSH tunnel.
      - **Plain HTTP over the LAN means credentials in clear.** Deferred once
        on interception risk alone, and now reopened: a secure origin turns
        out to be the prerequisite for notifications as well, so this buys
        two things rather than one. Owner is buying a domain for it,
        August 2026. The route is a real certificate over a **DNS-01**
        challenge — the Pi has no inbound internet access and should not —
        which makes the DNS provider's API the thing that matters when
        choosing a registrar, more than the name. Terminate in a reverse
        proxy with the supervisor moved to loopback beside njsPC, so
        renewal and reload stay out of this codebase, and add `Secure` to
        the session cookie once it holds. Note if the name is under `.app`:
        that TLD is HSTS-preloaded, so there is no `http://` fallback on it
        ever — a failed renewal means reaching the Pi by raw IP instead.
        The original reasoning still stands for why it waited this long: a
        password raises the bar from "anyone who joins the wifi" to "anyone
        who can intercept traffic on it", which addresses the realistic
        threat — the
        guest phone, the compromised bulb — and is not a substitute for TLS.
        The session cookie omits `Secure` for exactly this reason; setting it
        before TLS would mean the cookie is never stored at all. Decide
        between a self-signed cert the phone trusts once, a real certificate
        via a local domain, or continuing to accept this.
      - [x] **Phone-first rules out a login every time.** A signed session
        cookie lasting a fortnight, stateless so a Pi restart does not sign
        the household out, and revoked wholesale by rotating the secret —
        which is what setting a new password does. `HttpOnly`, so a script
        on the page cannot read it. The WebSocket upgrade is checked the same
        as the HTTP routes: `noServer` plus a 401 on the upgrade, verified by
        spawning a real supervisor and attacking it with no cookie, an
        invented signature, and a real signature with the expiry edited.

        `SameSite=Lax`, not `Strict`, and this is not a weakening: Chrome
        withholds a Strict cookie from a `ws://` handshake even same-origin,
        so Strict authenticates every HTTP route while refusing every socket.
        Observed directly — the upgrade arrived carrying other localhost
        cookies and not ours.

        The password is set over SSH with `supervisor/passwd.js`, never
        through a screen: a first-run "choose a password" page is
        unauthenticated by definition, so on a shared network it is a race
        between the owner and everyone else.
      - **Home Assistant (Phase 6) needs its own credential**, not the
        owner's. Whatever is built should issue more than one token.

      Not a reason to delay the interlocks, but it belongs before anything is
      reachable from outside the LAN, and before the relays are live.

- [x] Stand njsPC up on a laptop and test ADR-10's assumptions. Done — see
      the bench findings under ADR-10. `anslq25` was the wrong tool (it only
      mocks an EasyTouch OCP); Nixie with comms disabled is the way
- [ ] Bench the pump through a body switch — the one safety question left
      that needs no hardware. Configure a pump, switch bodies, watch the rpm.
      Pass is "holds ~1000 rpm"; "stopped" means the supervisor cannot
      delegate the switch to njsPC. Do this before designing the supervisor
- [ ] Re-read `sequences.js` against njsPC's body/circuit model. Some steps
      are likely njsPC configuration rather than code; what survives that pass
      is the supervisor's actual scope
- [ ] Build the supervisor — the six interlocks njsPC lacks (ADR-10), not a
      sequencer that owns everything
- [ ] Replace `useController` with real njsPC transport (MQTT or WebSocket)
- [x] Real connection state. `connected` is hardcoded `true` and nothing ever
      clears it, so the LIVE indicator is decorative — a phone out of range
      would show LIVE beside frozen state, which is exactly what ADR-7 says
      cannot be trusted. Prerequisite for any PWA or installable client
- [x] Schedule editor — add, edit, delete, day selection, overlap warning
- [x] Target temperatures per body, clamped to the heater caps
- [x] Pool heat on/off, driving heatEngage / heatRelease
- [x] Scheduled spa preheat ("ready at 7:30")
- [x] Pump speed clamp at `HEATER_MIN_RPM` under a live heat call
- [x] Manual pump hold, open-ended or on an egg-timer
- [x] Render skipped sequence steps struck through
- [x] Spa auto-revert countdown, with an Extend action
- [x] Daylight theme — CSS custom properties, auto/dark/day
- [x] RS-485 diagnostics view for Phase 1 work — decode rate, per-frame hex
      and checksum, undecoded frames surfaced as the ADR-6 evidence
- [ ] Verify the decoders in `src/lib/rs485.js` against the real bus. They
      are transcribed from public reverse-engineering and unconfirmed on this
      equipment; the iChlor 30 is the least well covered of the lot
- [ ] Home Assistant / MQTT bridge
- [ ] Salt trend history and threshold alerts (Path A)
- [ ] Winter pool-heating mode: the target and the on/off exist; the
      multi-day maintenance schedule does not

---

## Appendix — upstream projects

- nodejs-poolController (njsPC) — https://github.com/tagyoureit/nodejs-poolController
- relayEquipmentManager (REM) — https://github.com/rstrouse/relayEquipmentManager
- dashPanel — https://github.com/rstrouse/nodejs-poolController-dashPanel
- 8relay-rpi, Sequent's driver for the relay HAT — https://github.com/SequentMicrosystems/8relay-rpi

### Reported upstream

ADR-13 commits this project to patching upstream rather than working around.
Open:

- **SequentMicrosystems/8relay-rpi#7** — the channel remap table is wrong for
  V 7.1 hardware; channels 6, 7 and 8 close relays 7, 8 and 6. Affects the C
  tool and the Python library alike, and no sibling repo carries the correct
  table. Filed 27 August 2026 with the measured mapping and an offer to PR the
  fix. https://github.com/SequentMicrosystems/8relay-rpi/issues/7

  *Not blocking us.* The supervisor addresses relays by the measured bit mask
  written to `0x27` directly, so it does not depend on the fix landing — which
  is just as well on a repo whose last commit was June 2021.

njsPC runs in **Nixie** mode: it is the controller. There is no Pentair
outdoor control panel in this system after cutover.
