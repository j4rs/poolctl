# Project context

DIY pool/spa controller replacing a Pentair IntelliConnect, built on
nodejs-poolController.

**Status:** the whole stack runs on the Pi — njsPC v10.0.1 on loopback and
the supervisor on the LAN behind a password, both systemd services verified
across a reboot. Deployed with `scripts/deploy.sh`; see `docs/pi-bringup.md`.
No equipment is attached, so njsPC has no serial port and every reading is
null; that waits on the bus being attached. 666 tests; `npm test`, ~115 s.

**The heater has been driven for real, once — 30 August 2026, then
disassembled.** A temporary rig on CH4/CH5 ran the full path from the phone:
pool call, release, purge, spa call. It is *not* installed; the wires came
off the same afternoon and the heater went back to its own thermostat. What
survives is measurements, not a working installation:
`HEATER_MIN_RPM` is **1600 and sourced** (was 1900, invented), the purge
holds **3 m 02–03 s** against 180 s configured, and ADR-4's three-wire model
is confirmed on the equipment rather than inferred from a manual.
`docs/field-heater.md` has the traces.

**The integration suites are the ones that find things.** `docs/e2e-plan.md`
records eight slices built 29 August and what each caught. Two habits came out
of it and are worth keeping: **assert the trace, not the resting state** —
every fault they found had the right end position and the wrong route through
it — and **a rule enforced at intent time is enforced only when the intent is
what moved.** njsPC takes the body without asking, so the bypass, the pool
heat call and the blower were each wrong in that same way.

**The relay HAT arrived 27 August 2026** — a **V 7.1** card, not the V6.0 every
product photograph in this repo shows. Its silkscreen closed the one blocking
open question (`ALL RELAYS 120VAC/30VDC`, so CH7 drives the light directly) and
revealed that the two connector groups are mirrored: `RELAY 1-4` is
N.C./COM/N.O. and `RELAY 5-8` is N.O./COM/N.C. Bench procedure in
`docs/bench-relays.md`, and its first test is done: the I2C bus holds a single
PCA9554-class port expander at `0x27` and nothing else, so **the card has no
microcontroller and no hardware watchdog** despite the product page. ADR-12
had to be built rather than inherited, and now is: a systemd watchdog that
restarts a wedged supervisor, verified on the Pi. It buys **recovery, not
safety** — the expander latches its outputs, so in the panel, where the HAT is
fed by the HDR-60-5 and feeds the Pi, a wedged Pi leaves every relay exactly
where it was. Measured: relays held through all 51 s of a deliberate wedge.

**Do not address relays by Sequent driver channel.** The card's routing matches
`8relind-rpi`, not the `8relay-rpi` its product page names; that driver's
channels close relays **1, 2, 8, 7, 3, 4, 5, 6**, so writing channel 8 — the
nominal spare — starts the blower. Use the relay→bit table in
`docs/bench-relays.md` and write `0x27` register `0x01` directly.

**This file is the operating manual for working in this repo — nothing more.**
The full record lives elsewhere and is deliberately not duplicated here:

- `docs/prds/poolctl-v1.md` — requirements, thirteen ADRs with their rejected
  alternatives, measurements, BOM, phasing, risks, open questions, backlog.
- `docs/architecture.md` — components, state ownership, control flow, failure
  modes.
- `docs/pi-bringup.md` — what has to happen on the box, in order, from a
  flashed card to a controller the phones can use. Timezone first, and the
  reason why.
- `docs/panel/` — the panel build plan: every part photographed, where each
  sits on the backplate, and what connects to what. Figures 1 and 5 are
  generated from one shared geometry (`plate.py`, `emit.py`) so they cannot
  disagree — an earlier hand-drawn pair did, and both had the plate landscape
  when the enclosure mounts portrait.

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
  lib/sequences.js       site facts, constants, invariants; mock-only steps
  lib/pump.js            rpm/watts/schedule maths
  lib/programs.js        manual pump programs — name, speed, required expiry
  lib/rs485.js           Pentair frame decoders — unverified against a real bus
  lib/useController.js   mock equipment state — swap this for real transport
  lib/useBus.js          mock RS-485 feed
  lib/useSupervisor.js   live transport — same surface as useController
  lib/useConfirm.js      two-tap confirmation for equipment-moving taps
  components/            Schematic, Stat, Toggle, TargetTemp, HoldButton, Sheet,
                         ScheduleEditor, ProgramEditor, PreheatSheet, Toast,
                         DelayProgress, SignIn
  screens/               PoolSpaControl, HeatControl, PumpControl, BusMonitor
supervisor/              runs on the Pi; plain JS, no build step
  index.js               njsPC link, intents, WebSocket, serves dist/
  map.js                 njsPC state -> the shape the UI speaks
  interlocks.js          the rules njsPC lacks — pure, tested
  commissioning.js       njsPC's own settings, checked against what we believe
  invariants.js          the invariants, checked against what is true now
  binding.js             program -> njsPC circuit + pump speed — pure, tested
  schedules.js           njsPC schedules <-> the shape the UI speaks
  targets.js             ADR-4 clamping
  store.js               durable preferences (not positions)
  auth.js                password hashing, signed sessions — pure, tested
  passwd.js              CLI to set the password; there is no network path
```

Tests live beside what they cover (`*.test.js[x]`), run by Vitest from the
repo root and covering `supervisor/` too. They never reach `dist/`.

`supervisor/index.test.js` spawns `node index.js` as a real process on a real
port and drives it over a real WebSocket, rather than importing it. That is
deliberate: the module's side effects at load — the store, the njsPC link, the
heartbeat, the listen — are the part that has gone wrong, so importing it
would test something the Pi never runs. Those tests take ~18 s of the suite.

---

## Rules that constrain code changes

Easy to violate by accident. Each is argued at length in the PRD; the short
form is here so it never gets skipped.

- **The UI sends intents, never primitives.** `setMode('spa')`, never
  `relay3.close()`. A phone loses signal; the state machine must hold
  regardless. (ADR-7)
- **Do not move thermostat logic into software.** The heater owns its
  setpoint, its sensor and its hard caps — 95 °F pool, 104 °F spa, which are
  the **top of the keypad's adjustable range**, not defaults someone can
  raise (Raypak HPPH manual, User menu). That is why no bug in this repo can
  produce a scalding spa. (ADR-4)
- **Targets are cutoffs, not setpoints.** The 3-wire interface carries no
  temperature. `state.targets` says when to *stop* calling for heat. It can
  end a call early; it can never ask for more than the heater allows.
- **Disabled controls state their reason, and never render an active state.**
  If a control is on, its toggle must be actionable. Reasons render as text,
  never as `title` tooltips — phone-first, no hover. (PR-3)
- **Anything that moves an actuator or changes flow asks twice.** That is the
  test — not "is it a big button". `useConfirm` arms on the first tap and acts
  on the second, in place; not a modal, which would move the target and put
  Cancel under the thumb already reaching for it. Currently: pump run/stop,
  program run/stop, service mode, schedule enable/disable, pool heat, blower,
  extend spa, schedule/cancel preheat, and both deletes. Mode changes keep
  `HoldButton` instead — two minutes of uncancellable valve travel earns a
  five-second hold rather than a second tap.

  **`HoldButton` must never cancel on `pointerleave`.** It did, which quietly
  undid the pointer capture meant to tolerate drift: pressing harder spreads
  the contact patch and moves the centroid the browser reports, so a firmer
  thumb slid a pixel past the edge and the hold died. It read as the button
  being pressure-sensitive. The release is watched on the `window` — letting
  go anywhere ends the hold, so leaving the button is not an event it cares
  about. `pointercancel` still ends it: that one means the finger is gone
  with no `pointerup` coming.

  Not guarded, and each for a reason: the **light** (no actuator, no flow, and
  the next tap undoes it), **target steppers** (a cutoff is not a call, the
  call itself is guarded, and confirming every increment of a stepper is
  unusable), **Set up** (writes njsPC config but moves nothing), and anything
  that only opens a sheet or edits a draft. Confirming everything teaches
  people to tap twice without reading, which is worse than confirming nothing.

  An armed control **must not render as switched** — `aria-pressed` stays put
  until the second tap. Arming is not acting, and a toggle that reads as on
  before it is on lies in exactly the way ADR-7 exists to prevent.
- **Live progress comes from njsPC's delay, never from `sequences.js`.**
njsPC flips every valve flag in the same tick — it believes a PE24GVA
diverts instantly — so nothing in its state describes a valve part-way
through travel. What it does report is `delays[]`, with a real `startTime`,
`endTime` and a duration from its configured `valveDelayTime`, and it
genuinely holds the pump off for exactly that long (measured: 20.2 s against
a configured 20). `DelayProgress` renders that and says whose clock it is.

The step-by-step list stays **mock-only**. Replaying `sequences.js` live was
the obvious way to give feedback during a transition, and it is wrong here:
every duration in that file is invented, so the bar would look measured while
being a guess — and the first thing it would teach is to distrust it when the
valve is still moving at 100%. Worse, gating an interlock on that clock would
make "purge has elapsed" a fiction. Revisit when travel is measured; the
honest fix then is to raise njsPC's `valveDelayTime`, not to dead-reckon here.

**`src/lib/sequences.js` is not a program the server runs**, and saying it was
  is a leftover from the design ADR-10 replaced. The supervisor imports
  *constants* from it and nothing else — `SEQUENCES`, `stepsFor` and
  `isSkipped` have no server-side caller, and `activeSequence`/`stepIndex`
  stream as a permanent null and 0. What the file really holds is the site's
  plumbing facts, the named constants, the invariant list, and a mock-only
  step list for the transition display. Re-read against njsPC's model, **13 of
  its 30 steps are njsPC configuration** and only two — the purge and the pump
  floor — are supervisor work still outstanding. The full attribution is in
  `docs/architecture.md`, "Sequence ownership".
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

**The password guards the socket, not the page.** Every intent travels over
the WebSocket, so an auth layer over the HTTP routes alone would be theatre.
The upgrade gets a plain 401 (`noServer` + a manual `upgrade` handler) so the
client can tell "sign in" from "the supervisor is down" — a browser cannot
read the status of a failed upgrade, which is why `/auth/status` exists.

Three things here are easy to "fix" and break:

- **`SameSite=Lax`, never `Strict`.** Chrome withholds a Strict cookie from a
  `ws://` handshake even same-origin, so Strict authenticates every HTTP
  route while refusing every socket — the app signs in and then waits for a
  controller forever. Lax still withholds it from cross-site sub-resources
  and cross-site POSTs, which covers both ways state can change here.
- **No `Secure` flag.** The supervisor serves plain HTTP; setting it means
  the cookie is never stored at all. It belongs with TLS, which is not built.
- **The password is set over SSH, not in the app.** `node supervisor/passwd.js`.
  A first-run "choose a password" screen is unauthenticated by definition, so
  on a shared network it is a race between the owner and everyone else. There
  is deliberately no network path to setting it.

Sessions are signed rather than stored, so a Pi restart does not sign the
household out; the signature covers the expiry, so a token cannot be extended
by editing it. Rotating the secret — which setting a new password does —
revokes every session at once. `auth.json` is 0600 and gitignored: the
session secret alone would let anyone mint a valid cookie.

Running without a password still works, because bricking a pool mid-season
over a missing file is its own kind of failure — but it raises a commissioning
finding on the Water screen and warns at startup, so it is never silent.

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

`supervisor/invariants.js` checks these on every njsPC reading and on the
heartbeat, and `evaluate()` in `index.js` is the loop — the only part of the
supervisor that runs when nobody is tapping anything. It **reports**: breaches
land in `state.violations` and render on the Water screen under CHECK THE
EQUIPMENT. It does not correct, because reaching into equipment on the
strength of a snapshot is how a supervisor makes things worse.

Two disciplines keep it worth reading. **Unknown is never a violation** — a
null pump speed is a pump not answering, which is every pump on this rig
today, and alarming on it would make the display permanent noise. **Expected
states are not violations** — njsPC holds the pump off during a valve delay
on purpose.

Only the snapshot-checkable invariants are implemented. The rest — no valve
command while another is in flight, actuator cooldown, purge before a bypass
move — describe transitions, cannot be seen in a single state, and belong
with valve driving.

`evaluate()` acts on exactly one thing: **the cutoff**. If the water reaches
`targets.pool` it ends our own heat call, which is the promise the targets
feature is named for and which nothing kept before. Pool only — in spa mode
njsPC holds the heater and reaching in would be a second authority on it. It
ends the call and leaves the bypass alone, because a valve may only move once
a purge has elapsed and the purge duration is unmeasured.

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
from. (That argument assumes 45 sec travel, which is unmeasured — revisit if
it turns out to be much shorter.)

**Pump speed is never set by hand.** It belongs to a schedule, a manual
program (name, speed, required expiry) or spa mode. njsPC has no runtime
pump-speed endpoint because that is how pool controllers model the pump —
the absence was the domain model, not a gap. Run/stop and service mode sit
above all of it.

**A manual run is not cut short by a schedule, and may last most of a day.**
Pentair's app ends a manual override when the next scheduled program starts —
the IntelliCenter manual, quoted inside njsPC's own scheduler, caps it at
"12 hours or whatever that circuit Egg Timer is set to". We do not call
`manualOperationPriority`, so that does not happen here: the program's
circuit and the schedule's circuit are both simply on, and
`setTargetSpeed` takes the faster of them. An algae-recovery run at 3000 rpm
keeps its speed through a filtration window and ends on its own egg timer.

`MAX_MINUTES` is therefore **1439**, not 720. 1440 means `dontStop` to njsPC,
so a minute short of a day is a real boundary rather than a chosen one, and
the old 720 was Pentair's default for a different feature. The long durations
exist for recovery — brushing a green pool after a fortnight away — not for
routine use, and the expiry stays mandatory.

**Extending the spa is a config write, not a state one.** njsPC has no
endpoint that moves an end time, and re-sending "on" to a circuit already on
does nothing — `setEndTime` fires on an off→on transition or when `bForce` is
set, and a circuit *config* write is the only caller that sets it. So
`extendSpa` writes the Spa circuit's configuration back unchanged, which
recomputes its end time as now plus the egg timer with no body switch and no
valve travel. Measured live: 116.3 min remaining became 119.97.

Send every field on that write. njsPC's guard on `showInFeatures` reads
`typeof x !== 'undefined' || typeof x === 'undefined'` — always true — so the
field is written from the request every time and omitting it silently sets it
false. `echoCircuitConfig` exists so nobody has to remember which fields are
safe to leave out.

**Schedules are njsPC's, and a schedule runs a circuit — not a speed.**
There is no rpm field on an njsPC schedule; the pump holds the speed for the
circuit the schedule names. So a manual program and a schedule are now the
same currency: the program owns name/speed/expiry and its circuit, and a
schedule points at one. Anything you can press, you can put on a timer.

Three things that cost a live bug each, all in `schedules.js`:

- **`/state/all` and `/config/all` are different shapes.** State expands
  enums into `{val,name,desc}` and `scheduleDays` into `{val,days:[…]}`; the
  supervisor reads state. `Number({val:127})` is `NaN`, which read as *no
  days at all*.
- **Empty schedule slots are truthy.** njsPC keeps unused slots in the same
  array, with a `circuit` object present but carrying no `id`. Test the id.
- **A new schedule needs `heatSource`.** `setScheduleAsync` inherits it from
  the stored schedule, so editing works and creating fails with "Invalid heat
  source: undefined". Always send 32, *No Change* — which ADR-4 wants anyway,
  alongside `changeHeatSetpoint: false`, so a schedule can never move the
  heater.

**Overlapping schedules are not a conflict, and the fastest wins.** Per
circuit `NixieSchedule` ORs its schedules together, so same-circuit windows
union; across circuits `NixiePumpVS.setTargetSpeed` takes `Math.max`. The old
"the later schedule wins" was a mock-era invention and was wrong on screen.

**Day bitmask: Monday is bit 0, Sunday is bit 6.** `Date#getDay` puts Sunday
at 0. Convert only through `daysToMask`/`maskToDays`, which are round-trip
tested across all 128 masks — an off-by-one here runs the pool a day out and
throws nothing.

**A program is two njsPC writes, not one.** The name and the expiry go on a
circuit (`PUT /config/circuit`, `eggTimer`); the speed goes on the pump
(`PUT /config/pump`, an entry in `pump.circuits`). `supervisor/binding.js`
holds the parts that decide, and three njsPC facts make it what it is:

- `PUT /config/pump` **replaces** the pump — `NixiePump.setPumpAsync` assigns
  rather than merges, and blanks `circuits` when the key is missing. Always
  read the pump and send it back whole, or the schedules lose their speeds.
- `eggTimer: 1440` means *never stop*, not twenty-four hours.
- njsPC does not clamp speed. `NixiePumpVS.setTargetSpeed` computes a bounded
  value and discards it without assigning, so an out-of-range rpm reaches the
  pump exactly as typed. Ours is the only check there is.

The pump takes the **highest** speed among the circuits that are on, so a
2100 rpm skim overrides filtration at 1600 without stopping it.

**Valves move at zero flow, one at a time.** Settled against the IntelliFlo
manual: with priming enabled the pump runs 1800 RPM for 3 sec on every restart
and *ignores automation commands while priming*, so a 1000 rpm floor through a
restart is unenforceable by anyone. Disable priming at the pump during
commissioning (Pentair documents the procedure — it must be disabled on the
pump itself, not just in automation); a restart then costs only ramp time, and
njsPC's stop-move-start is both cheap and gentler on the actuator than turning
under load. `VALVE_RPM` survives only for moves with no pump restart.

**Thermal Mode stays enabled.** It starts the pump at 1000 RPM at 40 °F to
protect the drive — not the pool, and not related to anyone using it. So an
uncommanded pump start is expected a few nights a year: never treat "pump
running, nobody asked" as a fault.

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
equipment on the bus, highest value first:

1. **Commissioning — what is checked, and what no check can see.**
   `supervisor/commissioning.js` compares what njsPC reports against what
   this repo believes and surfaces the difference on the Water screen. It
   checks, it never corrects: njsPC owns these settings, dashPanel edits
   them, and a process that quietly reverted a deliberate change would be
   worse than one that says what it found. Ten checks now, including njsPC's
   LAN exposure — verified by trying to reach it on the Pi's own LAN
   address, so reopening it is caught rather than assumed — the valve
   bindings, the pump, the heater, the Spa egg timer, the valve delay, the
   serial port, the clock and the password. Five settings live on the
   equipment itself and are therefore invisible to all of it: **disable
   priming at the pump keypad**, **leave Thermal Mode enabled**, **size
   the transformer at 100 VA**, **set the heater's INSTALLER menu
   `Remote Pool` to Heat or Auto** — it defaults to Cool, and the 3-wire
   control does not behave without it — and **the heater's own pool and spa
   setpoints**, which cannot be changed from Remote mode. Set on 30 August
   2026 to pool 90 °F and spa 100 °F — both had been sitting at 86, so a spa
   call heated to a pool temperature. Those two numbers are load-bearing in
   two directions: targets are cutoffs, so the setpoint caps how warm the app
   can ever ask for, and the relays latch, so it is also where a wedged
   supervisor parks the water (ADR-4, and issue #2).
2. **Authentication — two of four parts done.** njsPC is bound to loopback
   and the supervisor is behind a password. What remains is TLS (deferred
   deliberately — see the PRD) and a separate credential for Home Assistant
   in Phase 6. See PRD §11.
3. **Scheduled preheat.** Still unimplemented, and still refusing with a
   reason rather than doing nothing. It wants a real water temperature,
   which wants the bus.

Blocked on the bus being attached: bus sniffing, the salt question (case
18), `CELL_MIN_RPM`, and thermals with the enclosure sealed. **Not**
`HEATER_MIN_RPM` — that was measured on 30 August and is 1600. What is still
open there is the *floor*: 1600 is the lowest speed seen to work, not the
speed at which the heater refuses, and a satisfied pressure switch is not
proof of the nameplate's 30–60 GPM.

---

## Upstream

**If njsPC is missing a reading or a capability we need, patch it and open a
PR upstream** rather than working around it or forking quietly (ADR-13). A
local patch is a holding position while the PR is in flight, not a
destination. Keep such patches surgical and inside njsPC — our interlocks stay
in our own process, or this repo stops being MIT.

- nodejs-poolController (njsPC) — https://github.com/tagyoureit/nodejs-poolController (AGPL-3.0)
- relayEquipmentManager (REM) — https://github.com/rstrouse/relayEquipmentManager (GPL-3.0)
