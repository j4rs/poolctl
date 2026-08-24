# Architecture

How the pieces fit, who owns what state, and what happens when each piece
dies. Companion to `poolctl-v1.md`, which carries the requirements and the
ADRs; this file is the system view.

> **Status:** revised August 2026 after reading njsPC's source, and again as
> the supervisor was built. The earlier draft described a sequencer that owned
> everything; njsPC turned out to already implement most of it. **The
> supervisor now exists** — transport, translation, persistence and the
> interlocks that need no hardware. What remains unbuilt is marked below.

---

## The stack

```mermaid
flowchart TB
  subgraph clients["Clients — send intents, never equipment primitives"]
    UI["poolctl-ui<br/>phone-first web UI"]
    HA["Home Assistant<br/>(Phase 6)"]
    BTN["Physical spa button<br/>(Phase 6)"]
  end

  subgraph pi["Raspberry Pi 4 — sealed NEMA 4X enclosure"]
    SEQ["supervisor<br/>heat/pump floor · bypass policy · cutoffs<br/>programs · service mode · persistence<br/>valve travel NOT BUILT"]
    NJS["njsPC in Nixie mode (the controller)<br/>bodies · circuits · valves · schedules<br/>delays/lockouts · RS-485 · telemetry"]
    REM["relayEquipmentManager<br/>GPIO / relay driver"]
    WD["hardware watchdog<br/>both processes healthy"]
  end

  HAT["Sequent 8-relay HAT<br/>8 relays · RS-485 with TVS"]

  subgraph equip["Equipment"]
    PUMP["IntelliFlo VSF pump"]
    CELL["iChlor 30 + power centre"]
    HTR["Raypak heat pump"]
    VLV["3x PE24GVA actuators"]
    AUX["blower · light"]
  end

  UI -->|intents| SEQ
  HA -->|MQTT| SEQ
  BTN --> SEQ
  SEQ -->|intents + overrides| NJS
  NJS -->|relay operations| REM
  SEQ -.->|conditional heartbeat| WD
  NJS -.->|telemetry| SEQ
  SEQ -.->|state stream| UI
  NJS --> HAT
  REM --> HAT
  WD -.->|de-energise on timeout| HAT
  HAT -->|RS-485| PUMP
  HAT -->|RS-485| CELL
  HAT -->|dry contacts 22/23/24| HTR
  HAT -->|24 VAC SPDT| VLV
  HAT -->|contactor / 120 V| AUX
```

---

## Components

| Component | Responsibility | Status |
|---|---|---|
| **poolctl-ui** | Renders state, sends intents (`setMode('spa')`). Holds no authority. | Built, on mock data |
| **njsPC (Nixie)** | The controller. Bodies, circuits, valves, pumps, schedules, and the delay/interlock manager in `Lockouts.ts`. RS-485 master, chlorinator telemetry, MQTT/REST/WebSocket. | Not installed |
| **supervisor** | The interlocks njsPC lacks, plus translation, intents and durable preferences. The only external writer. | Built; valve travel and preheat outstanding |
| **REM** | GPIO and relay I/O for the HAT. | Not installed |
| **watchdog** | De-energises every relay unless njsPC and the supervisor are both healthy. | Not built |

**njsPC is not a bus library and cannot be treated as one.** Nixie mode is a
full controller: `HeaterCooldownDelay` drives circuits from its own timer,
`PumpValveDelay` gates pump starts, `ManualPriorityDelay` overrides schedules.
Anything layered on top configures and supervises it — see ADR-10, which was
revised after reading the source, and preserves the wrong first draft as a
lesson.

The rule from ADR-7 still holds: **exactly one thing decides what a device
does.** Here that is njsPC, with the supervisor holding the interlocks njsPC
has no concept of. dashPanel remains a diagnostic tool, not an operator
interface — it commands equipment directly, bypassing anything the supervisor
adds.

---

## State ownership

Everything the client currently holds in `useController` is server state
wearing a disguise. This is where each piece belongs.

| State | Owner | Notes |
|---|---|---|
| `mode` (pool/spa) | njsPC bodies/circuits | *pending* — depends on whether `sys.equipment.shared` fits this plumbing |
| sequence progress | supervisor | the step list the UI renders |
| `valves.*` position | njsPC `ValveState.isDiverted` | boolean only |
| valve travel timing and ordering | supervisor | 45 s, one at a time; njsPC has no travel model |
| manual programs | supervisor, becoming njsPC circuits | each is a name, speed and required expiry; `circuit` is null until commissioning |
| running program | njsPC circuit `eggTimer` | expires itself, so no second copy is kept |
| panel mode (auto/service) | njsPC | `toggleServiceMode`; stands the schedules down |
| schedules | njsPC | ADR-11 |
| `targets.pool/spa` | supervisor | cutoffs clamped to `HEATER_CAP`; njsPC assumes it owns setpoints (ADR-4) |
| `heaterCall` | njsPC heaters | supervisor enforces the pump floor and bypass around it |
| bypass position | supervisor | njsPC has no bypass concept (ADR-9) |
| `pumpRpm`, watts | njsPC | telemetry off the bus |
| salt ppm, cell output | njsPC | telemetry, if ADR-6 lands on Path A |
| relay positions | REM | driven by njsPC |
| `waterTemp` | **undecided** | no sensor in the BOM — see open questions |
| tab, expanded rows, filters | client | genuinely client state |

---

## Control flow

**Intent path.** Client sends `setMode('spa')` to the supervisor. The
supervisor checks its six interlocks, then asks njsPC to switch bodies — njsPC
runs its own cooldown and valve delays and drives REM. The supervisor watches
the resulting state and holds the extra rules around it: the pump floor while
heat is called, the bypass position, the travel interlock between valve moves.

**Telemetry path.** njsPC publishes pump rpm, watts and cell readings. The
supervisor merges these with the state it owns and streams the union. Clients
never read njsPC directly — one source of truth, one shape.

**Rejection path.** An intent that would violate an invariant is refused with
a reason, and the reason is rendered. The UI already assumes this: the pump
blower's gate, the program that has no circuit yet, and the
disabled-with-reason pattern all expect the server to explain itself. A
refusal that is not shown is indistinguishable from a dead button, so the
client surfaces every one.

---

## Failure modes

| Failure | Detected by | Response |
|---|---|---|
| Supervisor dies or wedges | watchdog stops being fed | all relays de-energise to fail-safe |
| njsPC dies or wedges | supervisor's calls fail; watchdog stops being fed | all relays de-energise to fail-safe |
| REM dies | njsPC relay ops fail | supervisor refuses transitions, stops feeding the watchdog |
| Pi loses power | — | relays de-energise: valves to pool, bypass to flow, heater open, blower off |
| Client loses network | client's own staleness timer | nothing happens to equipment — the entire point of ADR-7 |
| Valve position drifts | nothing; there is no feedback | re-driven to pool on every boot |
| Valve de-energises mid-hold | nothing yet | open question — REM `latch` semantics against a PE24GVA SPDT selector |
| RS-485 corruption | checksum failures, visible in the bus monitor | njsPC retries; persistent failures are a wiring or termination fault |

The fail-safe direction is fixed in hardware by NO/NC selection, not in
software: **valves to pool, bypass to flow, heater contacts open, blower off.**
A heater with flow and no call is harmless; a call with no flow is not.

---

## `sequences.js` against njsPC — what the supervisor actually does

Re-read step by step, August 2026. The conclusion is a cleaner split than
either earlier draft: **njsPC owns the logical model, the supervisor owns the
three valve relays.**

### The unbinding trick

`nixie/valves/Valve.ts:112` drives a diverting valve as
`{ isOn: true, latch: 10000 }`, and REM's latch *inverts* the relay when it
expires. Against an SPDT selector feeding a 3-wire actuator that is simply
wrong — the valve reverses after 10 sec of a 45 sec travel — and it applies to
**every** valve njsPC drives, intake and return included, not just the bypass.

But `Valve.ts:107` returns early when `connectionId` or `deviceBinding` is
empty, recording `isDiverted` without calling REM. So a valve can be
configured in njsPC **with no hardware binding**: njsPC keeps the logical
position, which is what its body model, `valveMode` and pump delays all read,
while the supervisor drives the actual relay through REM with correct timing,
one valve at a time, and no latch.

No fork required, and njsPC's model stays coherent.

### Step-by-step

| Step | Who | Notes |
|---|---|---|
| `heater-off` | **njsPC** | Body switch turns the heater off natively |
| `purge` | **njsPC** (config) | This is `HeaterCooldownDelay` — it holds the circuit on after the heat call stops, then shuts it. Duration is configurable |
| `pump-low` | **njsPC** (accepted deviation) | njsPC gives zero flow, not `VALVE_RPM`. Settled by the priming spec — see ADR-10 |
| `bypass-flow` / `bypass-around` | **supervisor** | njsPC has no bypass concept at all (ADR-9) |
| `intake-*`, `returns-*` | **split** | njsPC decides *whether* diverted; supervisor drives the relay with travel timing and ordering |
| `pump-spa`, `pump-pool` | **njsPC** (config) | Pump circuit speeds |
| `heat-spa`, `heat-pool` | **njsPC**, with a supervisor rule | njsPC owns the heater; targets-as-cutoffs is ours (ADR-4) |
| `blower-off` | **njsPC** circuit, **supervisor** rule | njsPC can switch it; the "off outside spa mode" gate is ours |
| `pump-min` | **supervisor** | The heat-conditional pump floor |
| `boot` re-drive | **supervisor** | njsPC has no unconditional-resync concept |

### What survives as the supervisor (six jobs)

1. **Drive the three valve relays** — travel timing, one at a time, no latch,
   honouring `ACTUATOR_COOLDOWN_MIN`. njsPC's valves are left unbound.
2. **Bypass policy** — position follows mode, with the pool-heat override.
3. **Heat-conditional pump floor** — `HEATER_MIN_RPM` whenever heat is called.
4. **Targets as cutoffs** — end a heat call early; never raise the heater cap.
5. **Conditional purge** — njsPC's cooldown is unconditional; skipping it when
   the compressor has been idle is ours.
6. **Boot re-drive.**

~~Spa auto-revert~~ — **njsPC covers it, verified on the bench.** Every circuit
has an `eggTimer` in minutes, defaulting to **720**, with `dontStop` as the
1440 sentinel. Setting the Spa circuit to 120 gives `SPA_TIMEOUT_MIN` natively
and `endTime` feeds the countdown the UI already renders.

Tested three ways, because this is the safety property the PRD calls "not
optional":

| Scenario | Result |
|---|---|
| Expiry while njsPC is running | fired at 60 s on a 1 min timer |
| njsPC restarted mid-timer | re-armed and fired at 193 s on a 3 min timer |
| njsPC down *across* the expiry | caught up and switched off on restart |

**One unexplained observation, recorded rather than buried:** earlier in the
same session a Spa circuit was found `isOn` with an `endTime` nearly four hours
past. It could not be reproduced by any of the three tests above and was most
likely an artifact of repeatedly restarting and reconfiguring njsPC during
bench work. Since the state was seen once, a cheap supervisor guard is worth
having anyway — on connect, if a circuit is on with an `endTime` in the past,
turn it off. That is a few lines, not a seventh job.

Everything else in `sequences.js` is njsPC configuration rather than code —
which is the answer this re-read was looking for.

---

## Deployment

**The Pi runs artifacts. It does not build our code.** Owner's rule, and the
right one for a sealed box on an endurance SD card: no build toolchain, no
devDependencies, no source tree to keep in sync.

| Component | Built where | Shipped how |
|---|---|---|
| React app | laptop — `npm run build` | copy `dist/` (≈62 KB gzipped) |
| supervisor | laptop | copy the runnable output |
| njsPC | **on the Pi** | `npm install` there — stay on the upstream path |
| REM | **on the Pi** | same |

**Why the split, since it is not what it first looks like.** The obvious
reason — that njsPC's native modules force a build on the Pi — is wrong.
`serialport` ships a `linux-arm64` prebuild, so `npm install` downloads a
binary rather than compiling one, and njsPC's `dist/app.js` is plain
platform-independent JavaScript that could perfectly well be built on the
laptop. Its devDeps (`typescript`, `eslint`, `grunt`, `vitest`) are not
technically required on the Pi at all.

The real reason is that njsPC is a third-party project we do not control.
Following its documented install path exactly — `git clone && npm install &&
npm start` — is worth more than the ~80 MB it would save, because when it
misbehaves you want to be on the path its maintainer assumes. Hand-building
its `dist/` elsewhere adds a step nobody must ever forget and a stale-artifact
failure that presents as a bug.

Our code is the opposite case: 42 MB of Vite and React devDeps on the Pi buys
nothing for a 62 KB output, and the build is entirely ours to define. So the
rule is the same one — avoid dependencies that are not needed — applied to two
situations where "needed" resolves differently.

SD wear does not decide this either way: an occasional build is trivial next to
what journald was doing before it moved to RAM, on a 128 GB card with 111 GB
free.

**One design constraint falls out of this:** the supervisor must be runnable
without a build step on the Pi. Plain JavaScript, or TypeScript compiled on the
laptop and shipped as JS — but never `tsc` at boot on the Pi.

The Pi still needs Node, since it runs all three processes. What it avoids is
every toolchain above that.

### Serving

The supervisor serves the React app as static files from its own process, on
the same origin as the WebSocket the app talks to. That follows from ADR-10 —
the client talks only to the supervisor — and it avoids CORS, a second port,
and a separate web server to keep alive in a box nobody can reach. It is also
what a service worker will require if the PWA item is ever picked up.

| Process | Port |
|---|---|
| njsPC | 4200 |
| REM | 8080 |
| supervisor + UI | 4300 → `http://poolctl.local:4300` |

Deploy is `rsync` over SSH; key auth is already configured.

---

## What exists today

Built: the client UI in full — water path, mode transitions, heat targets,
pump speed and schedules, the RS-485 bus monitor — all against
`useController` and `useBus`, which are mocks.

`src/lib/sequences.js` is the executable spec: five named sequences, declarative
skip conditions, and the invariant list. **It needs re-reading against njsPC's
body and circuit model** — some of its steps are likely njsPC configuration
rather than code anyone writes. What survives that pass is the supervisor's
job.

Built since: the supervisor and its transport, real connection state with a
heartbeat, durable preferences, the pure interlocks, manual programs bound to
njsPC circuits, and 319 tests — including the socket layer end to end, with
the supervisor spawned as a real process against a fake njsPC.

Not built: valve relay driving through REM, scheduled preheat, and the
`extendSpa` intent. All three want hardware or a water temperature.

Not installed **on the Pi**: njsPC, REM, Node. Deliberate — njsPC in Nixie
mode wants its serial port and relay configuration, which arrive with the HAT.
It runs on a laptop meanwhile, which has been enough to settle the design.
