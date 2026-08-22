# Architecture

How the pieces fit, who owns what state, and what happens when each piece
dies. Companion to `poolctl-v1.md`, which carries the requirements and the
ADRs; this file is the system view.

> **Status:** revised August 2026 after reading njsPC's source. The earlier
> draft described a sequencer that owned everything; njsPC turned out to
> already implement most of it. The supervisor described here does not exist
> yet. Sections below mark what is real today.

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
    SEQ["supervisor<br/>heat/pump floor · bypass policy<br/>valve travel · cutoffs · auto-revert<br/>NOT BUILT"]
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
| **supervisor** | Only the six interlocks njsPC lacks — heat-conditional pump floor, bypass policy, PE24GVA travel, targets-as-cutoffs, conditional purge, spa auto-revert. The only external writer. | **Not built** |
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
| `pumpHold` | njsPC `ManualPriorityDelay` | already carries an `endTime` — ADR-11 |
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
slider's floor, the blower's gate, and the disabled-with-reason pattern all
expect the server to explain itself rather than silently clamp.

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

~~Spa auto-revert~~ — **njsPC covers it.** Every circuit has an `eggTimer`
(minutes), defaulting to **720**, with `dontStop` as the 1440 sentinel. Setting
the Spa circuit to 120 gives `SPA_TIMEOUT_MIN` natively, and njsPC's
`setEndTime` exposes the countdown the UI already renders. Six jobs, not seven
— and one more line on the commissioning checklist, because the 720 default is
a twelve-hour spa session if nobody changes it.

Everything else in `sequences.js` is njsPC configuration rather than code —
which is the answer this re-read was looking for.

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

Not built: the supervisor, the transport, and real connection state — the
client's `connected` flag is hardcoded `true` and nothing ever clears it.

Not installed: njsPC, REM, Node itself. Deliberate — njsPC in Nixie mode wants
its serial port and relay configuration, which arrive with the HAT.
