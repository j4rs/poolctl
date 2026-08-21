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

**Rationale:** originally scoped as manual, since a heat pump costs nothing
when water passes through an idle exchanger. Two reasons changed it:
(a) the owner wants full remote control, and (b) pressure drop across the
exchanger is roughly 9–11 psi — 20+ feet of head the pump pays for on every
filtration hour. Bypassing in summer is real energy savings on a VSF.

> **⚠ Reason (b) is unsourced and may be wrong.** The 9–11 psi figure has no
> citation, and it is high for a heat-pump exchanger — published drops for
> this class are commonly quoted in low single-digit psi at typical flow. If
> the real figure is 1–2 psi, the head the pump pays is a few feet rather than
> twenty, the summer saving is marginal, and **reason (b) does not survive**.
>
> That matters because a great deal was built on it: a third actuator and its
> relay channel, the whole of ADR-9, two of the seven invariants, and one of
> the supervisor's six responsibilities. Reason (a) — the owner wants remote
> control of every valve — is independent and still stands on its own, so the
> decision does not necessarily reverse. But the energy argument should not be
> repeated until the Raypak spec sheet confirms it.
>
> Found the same way as the fabricated pool-heating figure: by asking where a
> number came from and finding no answer.

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
| Circuit rating | Class 2, 24 V, 4 A / 100 VA max | 75 VA transformer complies |
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
| `ManualPriorityDelay` — *"will override future schedules until expired/cancelled"*, with an `endTime` | `state.pumpHold`, including the `expiresAt` semantics |

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

- The supervisor is far smaller than the first draft assumed — six rules, not
  a whole state machine.
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

A hardware watchdog drops all relays if the **sequencer** stops asserting
health — see ADR-12. Earlier drafts pointed this at njsPC, which was correct
while njsPC was going to be the entire controller and is not correct under
ADR-10.

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
- Pool heating is slow — **order of days, not hours** — and most efficient
  during warm daylight hours. Model it as a target temperature with a
  maintenance schedule, not a button.

  An earlier draft said "~4 days typical from cold". **That figure was
  invented.** It had no source and should never have been written down. The
  qualitative claim survives on physics — a 140k BTU heat pump against a
  pool-sized volume raises temperature roughly an order of magnitude slower
  than it does the spa, and overnight losses eat into each day's gain — but
  the design consequence rests on "slow", not on any particular number. Pool
  volume has never been measured either, so nobody can currently compute it.

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
change takes the pump. Moving the slider under a hold retunes the hold rather
than dropping back to schedule control. An open-ended hold pauses filtration,
so it stays visible until released rather than being forbidden or silently
expiring.

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
- [ ] **Do valves move under full flow?** The safety question the schedule test
      did not answer, because no pump was configured. njsPC *does* implement
      `setPumpValveDelays` in `NixieBoard.ts`, but it is gated on
      `sys.general.options.pumpDelay`, which **defaults to false**, and it
      delays a pump *start after* a valve change rather than stopping the pump
      *before* one. Whether a body switch drops the pump first is untested.
      This is the one bench test that matters before an actuator is wired:
      configure a pump, enable `pumpDelay`, switch bodies, watch the rpm
      through the transition. Water hammer and a stalled actuator are the
      failure modes.
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
- [ ] **Exchanger pressure drop.** ADR-5's energy justification cites 9–11 psi
      with no source. Get it from the Raypak spec sheet. If it is low
      single-digit psi, that half of ADR-5 falls away.
- [ ] **Spa volume.** Never measured. All preheat estimates assume ~500 gal.
- [ ] **Spa jet rpm.** 2800 is a guess. Tune empirically once speed is
      settable from a phone.
- [ ] **Contactor inrush VA.** Read the nameplate before finalizing the
      transformer at 75 VA vs 100 VA. Actuator draw is now confirmed at
      0.75 A each, so three sequenced actuators need 18 VA; the contactor coil
      is the only remaining unknown.
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

Two of them turned out to be worse than unmeasured — they were **invented**,
with no source at all: "pool heating ~4 days from cold", now removed, and
ADR-5's "9–11 psi" exchanger drop, now flagged in place because a decision
rests on it. Both were found by the same simple test: ask where the number
came from. Any figure in this document that cannot answer that should be
treated as fiction until it can.

| Claim | Rests on | Would change if wrong |
|---|---|---|
| `ABORTABLE = false` — abort-at-boundary "buys little" | 45 sec valve travel | **A decision.** Short travel makes abort worth reconsidering |
| PR-2 — "transitions take about two minutes" | 45 sec × 3 valve moves | The case for a water-path view over a spinner |
| Conditional purge — "two minutes instead of five" | 45 sec travel + 3 min purge | The payoff that justifies the skip logic |
| ADR-9 — pool heat costs "one 45 sec valve move" | 45 sec travel | How expensive engaging pool heat feels |
| PR-4 — blower and heater "roughly cancel" | 115 CFM, 20–25 °F/hr | The estimate copy, and whether the advice is right |
| Spa preheat 45–75 min | 20–25 °F/hr, ~500 gal | Every preheat estimate, and scheduled preheat later |
| ~~Pool heating ~4 days from cold~~ | **nothing — invented** | Removed. The qualitative "order of days" survives on physics |
| ADR-5(b) — exchanger drop "9–11 psi, 20+ ft head" | **no source, and looks high** | The energy case for automating the bypass. ADR-5(a) is independent and holds |
| Watts and dollars shown in the UI | `WATTS_MAX = 2400` | Every cost figure — though njsPC replaces it with real telemetry |

**Verified, for contrast** — these look like assumptions and are not:
heater caps 95/104 °F (Raypak firmware, ADR-4), Pi thermals (measured, ADR-3),
`latch` inverting the relay (read from REM source), the `nxps` shared-body
model (observed on the bench), and njsPC decoding iChlor output and
temperature (read from source).

---

## 11. Software backlog

- [ ] Stand njsPC + REM up against the `anslq25` simulator. Tests the two
      assumptions ADR-10 rests on — whether njsPC can be supervised, and
      whether `manualPriorityActive` survives a schedule boundary. No hardware
      needed; do this before writing the supervisor
- [ ] Re-read `sequences.js` against njsPC's body/circuit model. Some steps
      are likely njsPC configuration rather than code; what survives that pass
      is the supervisor's actual scope
- [ ] Build the supervisor — the six interlocks njsPC lacks (ADR-10), not a
      sequencer that owns everything
- [ ] Replace `useController` with real njsPC transport (MQTT or WebSocket)
- [ ] Real connection state. `connected` is hardcoded `true` and nothing ever
      clears it, so the LIVE indicator is decorative — a phone out of range
      would show LIVE beside frozen state, which is exactly what ADR-7 says
      cannot be trusted. Prerequisite for any PWA or installable client
- [x] Schedule editor — add, edit, delete, day selection, overlap warning
- [x] Target temperatures per body, clamped to the heater caps
- [x] Pool heat on/off, driving heatEngage / heatRelease
- [ ] Scheduled spa preheat ("ready at 7:30") — button is a stub
- [x] Pump speed clamp at `HEATER_MIN_RPM` under a live heat call
- [x] Manual pump hold, open-ended or on an egg-timer
- [ ] Render skipped sequence steps struck through
- [ ] Spa auto-revert countdown — `SPA_TIMEOUT_MIN` has no surface yet
- [ ] Daylight theme
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

njsPC runs in **Nixie** mode: it is the controller. There is no Pentair
outdoor control panel in this system after cutover.
