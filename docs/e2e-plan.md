# End-to-end testing — the slices

A plan, not a framework. Each slice is independently useful, ships on its own,
and is justified by a bug that actually happened rather than by a category of
bug that might.

## Where we start

Two integration layers already exist, and neither is a mock in the usual
sense: both spawn a real `node index.js` and drive it over a real WebSocket.

| | |
|---|---|
| `index.test.js` | njsPC pointed at a dead port — the rig's actual state today |
| `binding.integration.test.js` | a fake njsPC HTTP server with scriptable state |

So "the system running as a whole" is half-built. What is missing is the
**equipment end** and the **clock**.

## The rule this plan holds to

**Simulate the interfaces, script the physics.**

Every duration and rate in this project is unmeasured — 45 s valve travel, a
3 min purge, 20 °F/hr spa heating, 1900 rpm of flow. A simulator that modelled
them would encode our guesses and then grade our own homework: the suite goes
green because the model agrees with the code, and both may be wrong about the
pool. `binding.integration.test.js` already does the honest version —
`njspc.setTemps({ temp: 73 })` *scripts an input* rather than modelling a
cause, and stays true whatever the real numbers turn out to be.

So: fake the I2C card, fake njsPC's HTTP, compress the clock. Never model
water.

---

## Slice 1 — The card exists in tests — **done, 29 August 2026**

**What.** `hat` is `null` in every test today: `hatAvailable()` looks for
`/dev/i2c-1`, which is absent off the Pi, so `driveRelays()` returns
immediately. Give the harness a fake card the spawned supervisor will use, in
the same idiom as `RELAYS=off` — an env switch, since the supervisor is a real
process and cannot be handed an object.

**Why.** The relay byte is the only output that moves equipment, and no test
has ever looked at one. `byteFor` is unit-tested; the path from intent through
`publish()` to the card is not — and that seam is where 29 August's bug lived,
where `own.bypass` turned out to drive nothing while every unit test passed.

**Done when** a test can assert the byte after an intent, and the purge test
asserts `0x40 → 0x10` rather than reading `valves.bypass` out of the state.

**Shipped.** `supervisor/fake-i2c.js` is a PCA9554 in a JSON file, invoked
through wrappers the harness writes into a temp directory that `I2C_TOOL_DIR`
points at. `hat.js` gained two configurable paths and no test awareness
whatsoever — which is the part worth defending: faking at the *process*
boundary leaves argument construction, output parsing and write serialisation
all running for real, and those are exactly where its bugs have been.

`start({ card: true })` returns a handle with `byte()`, `writes()` and
`poke()` — the last for driving the card behind the supervisor's back, which
slice 6 needs and which is how the drift bug was found by hand.

The purge test now asserts the card rather than `valves.bypass`, which is the
distinction that matters: the state field is what the supervisor believes, the
byte is what the relays are doing, and the first attempt at the purge moved a
field that drove nothing while every unit test passed.

Verified by breaking it: moving `driveRelays()` back out of `publish()` — the
tap-latency bug from 28 August — fails three of the four new tests. A test
that cannot fail is worse than no test.

**Cost** small. **Blocks** slices 2, 4, 5, 6.

---

## Slice 2 — Traces, not snapshots — **done, 29 August 2026**

**What.** Record the ordered sequence of writes, and assert the whole path
rather than the resting state.

**Why.** The order *is* the safety property: valve before contact, purge
before isolation, boot passing through `0x00`. Two bugs this week had the
right end state and the wrong path — the boot flash of `0x40` before the purge
hold engaged, and the drift corrector re-asserting a byte the supervisor had
just stopped wanting. A snapshot assertion sees neither.

**Done when** a test reads like:

```
boot                    0x00
njsPC connects          0x00     (purge holding — not 0x40)
+ purge                 0x40
call pool heat          0x10
water reaches target    0x00
+ purge                 0x40
```

**Shipped.** `card.trace()` returns the writes named — `0x25  REL1 REL2 REL5`
rather than `37` — so a failure says which relay differs without anyone
reaching for the map. `card.quiet()` waits until the card stops changing,
which trace tests need and state assertions do not: `settles()` waits on a
published field, and that can be true a beat before the byte following from it
has landed.

**It found three things on the first run**, which is the whole argument for
the slice:

1. **The fake never diverted its valves.** `/state/all` returned `valves: []`,
   so the trace showed the spa heat contact closing while the valves still
   read pool — an ordering fault the real controller cannot produce, because
   `nxps` switches body and both diverters in one tick. The fake now models it.
2. **The fake let both bodies run at once.** Turning the Pool circuit on left
   the Spa circuit on, so `valveMode` never came back to pool. Shared bodies
   are exclusive in njsPC; they are in the fake now too.
3. **The blower survived the mode change.** `sequences.js` has a `blower-off`
   step in the pool path and the invariants say
   `mode !== 'spa' implies blower === false` — and nothing enforced it. The
   invariant that was already watching for this reports rather than corrects,
   so it would have raised a violation and left the blower running. Fixed in
   `setMode`.

The first two are slice 7's concern arriving early, which is worth noting: a
fake that drifts from what it imitates makes a suite *less* trustworthy than
no suite, because it fails confidently.

**Cost** small, given slice 1. **Depends on** 1.

---

## Slice 3 — A compressed clock — **done, 29 August 2026**

**What.** Env-overridable durations **in the supervisor** — `PURGE_MS`,
`HEARTBEAT_MS`, `COMMISSIONING_MS`, spa revert. Not in `sequences.js`: the
browser imports that file and has no `process`.

**Why.** Purge is 3 min, spa timeout 120, actuator cooldown 8, watchdog 60 s.
The purge test today can assert the *hold* and never the *release*, because
releasing takes three real minutes — so the release is verified only by
watching a journal on the Pi, by hand, once.

**Done when** the purge release, the spa auto-revert and the watchdog withhold
are all asserted in a suite that still runs in under two minutes.

**Shipped, with one item moved.** `PURGE_MS` and `COMMISSIONING_MS` are
supervisor-side env knobs, set only when a test asks; production has neither
and keeps the real numbers. `WATCHDOG_USEC` needed no knob — it is systemd's
own variable and the supervisor already reads it.

`HEARTBEAT_MS` is deliberately **not** overridable. The client restates it as
its staleness threshold, and that pair is the only defence against the
threshold-shorter-than-the-heartbeat bug that shipped once already; a test
moving one and not the other would quietly retire the guard.

**The spa auto-revert moved to slice 5.** It is njsPC's egg timer expiring,
not our clock — so it is njsPC acting on its own, and belongs with the rest of
that. Claiming it here would have meant testing our own fake's timer.

Writing the watchdog test found an ordering nobody had noticed: with a short
window the first tick lands *before* the first evaluation, so the watchdog
withholds for "no evaluation has completed yet" and the say-once rule then
hides whatever goes wrong next. Invisible on the Pi, where the window is 60 s
and the first tick is 20 s in. The test now waits for health before breaking
anything — and asserts all three states, since the reason changing is what
makes the journal able to explain a kill.

Suite is 652 tests in about 100 seconds. Verified by breaking it: making the
purge never release fails the boot-hold trace.

**Cost** small. **Independent**, but every other slice gets faster with it.

---

## Slice 4 — Scenarios as tables — **done, 29 August 2026**

**What.** A thin helper for `given state → these intents → expect this trace`.
A table, not a DSL; the moment it needs its own documentation it has failed.

**Why.** Leverage. Once 1–3 exist, the marginal cost of a scenario should be
three lines, because the value is in having *many* — and a trace table is
reviewable as a specification by someone who will not read the test harness.

**Done when** the four `SEQUENCES` paths and the boot resync are each one
table, and adding a fifth is obvious.

**Shipped.** Seven rows, each `given` a starting position, `from` a stated
resting byte, `when` something happens, expect exactly `card`. The runner
waits for the card to reach the stated start before resetting the log, and
waits for the last expected byte before asserting — so a row cannot pass by
inheriting whatever the previous one left. Adding a row is three lines.

**It found the purge's remaining hole.** Releasing pool heat traced
`["0x40  REL3", "0x00  (all off)"]`: the intent published with the demand
cleared while `purgeHolding` was still false, so `map.js` derived `around` and
**the card isolated the exchanger for up to a whole heartbeat** before the
evaluation caught up. The same hole as the boot flash, on the path the purge
was actually written for — and invisible to every state assertion, because the
end position was right and only the route through it wrong. `publish()` now
runs the purge bookkeeping before the byte is computed.

Two things about the instrument, both worth knowing:

- **The fake card's state file was not written atomically.** A plain
  `writeFileSync` truncates first, so the harness reading during that window
  got `SyntaxError: Unexpected end of JSON input` — surfacing as a *different*
  test failing on each run. Writes now go beside the file and rename.
- **Compressing this suite's purge to 300 ms broke two assertions that caught
  the hold at an instant.** Both moved rather than vanished: the release is
  now a trace, `["0x00", "0x40"]`, which asserts the hold *and* the let-go and
  is strictly stronger than a non-null `purgeUntil` read at one moment.

662 tests, about 115 seconds, stable across three consecutive runs.

**Cost** medium. **Depends on** 1, 2, 3.

---

## Slice 5 — njsPC acting on its own — **done, 29 August 2026**

**What.** Script njsPC *initiating* — a schedule firing, an egg timer
expiring (including the spa auto-revert, moved here from slice 3), dashPanel
writing a circuit, a body switching — and assert the supervisor reacts. Today the fake is only ever poked by the test in step with
the supervisor's own intents.

**Why.** This is ADR-11's entire hazard, and it has already produced a real
bug: driving the Spa circuit straight through njsPC's API left the stored
bypass at `around` from pool mode and the card came out `0x65` — spa valves,
spa heat call, exchanger bypassed. A heat call at zero flow. That is the pair
ADR-5's interlock exists to prevent, and it arrived because njsPC changed the
body without asking.

**Done when** a test switches the body behind the supervisor's back and
asserts the byte follows, not the stale intent.

**Shipped, and it found two more of the same bug.**

The fake gained `switchBody()` and `expireSpa()`, both routed through the same
`setCircuitState()` the supervisor's own writes use — deliberately, because if
the driven path and the self-initiated path diverged, the fake would behave
one way when pushed and another when it moved by itself. That asymmetry is
what these tests exist to look for; hiding it inside the instrument would be
the worst possible place for it.

Two rules turned out to live in `setMode` and nowhere else:

- **A pool heat call outlived the body it was made for.** ADR-4 gives the
  heater to spa mode, and `setMode` cleared the call for exactly that reason —
  but a schedule or an egg timer takes the body without going near the intent.
  The call sat suppressed for the session and came back when the spa reverted.
- **The blower outlived the spa session.** Same shape: cleared on the way out
  through `setMode`, not cleared when njsPC's egg timer did the reverting, and
  the toggle is gated to spa mode.

Both are now derived in `map.js` against the observed body, so the bad pairing
is unreachable rather than tidied up afterwards, with `followBody()` clearing
the stored flags so neither resurrects on the way back. Same fix as the bypass
before them.

**That is three for three.** Every rule this project has enforced at intent
time has been wrong in the same way, because njsPC takes the body without
asking. Observe and react; never assert, and never remember.

**Cost** medium. **Depends on** 1, 2. **Highest value after the spine.**

---

## Slice 6 — Faults — **done, 29 August 2026**

**What.** Card write fails, card read fails, njsPC drops mid-intent, the card
drifts, two writes race. Some of this exists — `SIGUSR2` breaks `evaluate()`,
and njsPC-at-a-dead-port is the default.

**Why.** Every recovery path in this process was written from reasoning and
verified, if at all, by breaking something on the Pi by hand. The drift
corrector's race was found that way and could have been found here.

**Done when** the drift path is provable without an SSH session, including the
case that broke it: a legitimate write landing during the read-back.

**Shipped.** The fake card gained two fields settable while the supervisor
runs: `fail`, and `readDelayMs` — which also records `readingSince`, so a test
can wait for a read to be *open* and act inside it. That is what makes the
race deterministic rather than hopeful.

Four tests: a drift is noticed, corrected and confirmed on the following pass;
a write landing inside a read is **not** a drift; a card that has gone away
does not take the supervisor with it, and costs one log line rather than one
per heartbeat; and a failed read never becomes an invented drift, because "no
answer" is not "wrong answer".

Verified by breaking it: reintroducing the stale sample — reading
`hat.lastWritten` before the spawn instead of after — fails the race test.
That is the bug that shipped this morning, undid a legitimate relay change and
reported a hardware fault that never happened. It is now caught in nine
seconds without an SSH session.

**Cost** small-medium. **Depends on** 1.

---

## Slice 7 — Keeping the fake njsPC honest — **done, 29 August 2026**

**What.** Compare the fake's route shapes against the real njsPC's, from a
recorded capture or against the Pi directly.

**Why.** The fake is hand-written and has already been wrong. On 29 August its
`/config/all` returned `pumps: []` while every other route in the same fake
served pump 50 — a contradiction that made a real commissioning check fail and
briefly looked like a bug in the check. A fake that drifts from the thing it
imitates makes the suite *less* trustworthy than no suite, because it fails
confidently.

**Done when** a shape mismatch fails a test, or at minimum prints a diff a
person will notice.

**Shipped.** `scripts/capture-njspc.mjs` records the *shape* of a real
njsPC's answers — keys and types, arrays reduced to their first element — into
`supervisor/njspc-shapes.json`, captured from the Pi over an SSH tunnel since
njsPC is bound to loopback on purpose. Shapes rather than values: values are
this pool's configuration, would churn on every equipment change, and would
drag credentials into the repository. Anything matching `pass|secret|token|key`
is redacted at capture; both `screenlogic.password` fields came through as
`"redacted"`.

The rule is narrower than parity, which would be unreadable noise: the fake
serves a deliberate subset, so **whatever it does serve must have njsPC's
shape**, it may not invent keys njsPC has no concept of, and an array it
serves empty where njsPC returns elements is drift.

**It found nine real faults on the first run.** The root of most was one
thing: the fake served a single `circuits` array to both `/state/all` and
`/config/all`, which is exactly njsPC's documented state-versus-config trap —
the one that already cost a live bug when `Number({val:127})` came out `NaN`
and read as *no days at all*. State expands enums into `{val,name,desc}`;
config keeps the number and carries `eggTimer` and `isActive` that state has
no business knowing. The fake now projects the shared record into both.

The same conflation was in the pump: state's `type` carries the speed and flow
ranges, the config-options `pumpTypes` carries `relays` and `hasBody` and no
ranges at all. One fixture served both, and it led me to conclude — wrongly —
that `binding.js`'s `type?.minSpeed` fallback was dead code. `pumpLimits()`
reads the *state* pumps, where that field is present, so the fallback is live.

**What it will not catch:** behaviour. Shared-body exclusivity, valve
diversion, egg timers — none of that is shape, and slice 5's tests are what
cover it. Worth being clear which instrument catches which fault rather than
letting a green check imply more than it checks.

One exception is carried, with a reason and a way to retire it:
`temps.bodies[0].temp`, which njsPC omits on a body it has no source for. The
source is the iChlor's probe (ADR-6), not on the bus yet. Recapture and delete
the line when it is.

Verified by breaking it: serving the config circuit shape from the state route
fails the check.

**Cost** small. **Independent.**

---

## Slice 8 — The client against a real supervisor — **done, 29 August 2026**

**What.** Drive `useSupervisor` against a spawned supervisor rather than the
`FakeSocket` it stubs today.

**Why.** The client has never talked to the real thing. Every state field the
UI reads is a contract nobody checks — `purgeUntil` was added on 29 August and
nothing anywhere asserts the client can see it.

**Cost** medium-high: it needs jsdom and a real socket in one test
environment, which is the least pleasant combination here.

**Independent**, and honestly the weakest of the eight. The shared
`src/lib` types make the contract mostly self-enforcing, so this earns its
place only once the others are done.

**Shipped, and it was the weakest — that estimate held.** Four tests, no bugs
found. The value is the field-contract check: a hand-written list of
everything the screens destructure, asserted against a live frame. Dropping
`purgeUntil` from the map fails it with *"the supervisor no longer sends:
purgeUntil"*, which is the failure mode this was built for — a field renamed
on the server and rendering as a blank on somebody's phone.

Two shims, named rather than hidden. In production the client is *served by*
the supervisor, so `location.host` is the supervisor and relative `/auth/*`
fetches reach it; jsdom fixes its URL before a test knows which port was free.
So the socket uses the `VITE_SUPERVISOR` override — a real code path, used in
development — and `fetch` resolves relative paths against the supervisor's
origin, which is what a browser does when the page came from there. **The
`location.host` derivation itself stays untested.**

The harness needed one change to be importable at all: `fileURLToPath` throws
under jsdom, because vite serves modules over http rather than from disk. It
now falls back to a path relative to the repo root.

One assertion changed on contact with reality. `state.connected` is an AND of
three things — socket up, state fresh, *and the supervisor able to reach
njsPC* — so with njsPC at a dead port the honest answer is `false` with
`offlineReason: "Controller cannot reach njsPC"`. That is a better assertion
than the one I set out to write: a single boolean would be ADR-7 in miniature,
a phone showing OFFLINE while the equipment is fine.

---

## A note on runtime

660 tests, and the suite is now about **125 seconds** — four over the two
minutes slice 3 set as the budget. Most of it is the integration files, which
spawn real processes and wait on real heartbeats; the fault tests alone are
~40 s because several of them must wait two full evaluation passes.

Not yet worth fixing, but worth watching. The lever, when it is needed, is
making `HEARTBEAT_MS` overridable — deliberately refused in slice 3 because
the client restates it as its staleness threshold and moving one without the
other retires a real guard. Doing it properly means moving both together and
keeping the pair asserted.

## Order

**Spine, in order:** 1 → 2 → 3 → 4.
**Then:** 5, which is where the remaining sharp edges are.
**Slot in anywhere:** 6 and 7, both cheap.
**Last, if ever:** 8.

The honest summary is that slices 1, 2 and 5 pay for the whole exercise; 3 is
an enabler; 4 is leverage; 6 and 7 are cheap insurance; and 8 is the one to
drop if the appetite runs out.

---

## All eight, done — 29 August 2026

666 tests, about 115 seconds. What the exercise actually caught, which is the
only measure that matters:

| Slice | Found |
|---|---|
| 2 | the blower surviving a mode change; the fake never diverting its valves; both bodies able to run at once |
| 4 | the purge's last hole — an intent isolating the exchanger for a heartbeat before the hold engaged |
| 5 | a pool heat call outliving the body it was made for; the blower outliving a spa session njsPC ended |
| 6 | *(confirmed the drift race, already fixed)* |
| 7 | nine fake-fidelity drifts, most from serving one `circuits` array as both state and config |
| 1, 3, 8 | no bugs — enablers and a contract check |

Five of eight found something. Three findings were the same bug wearing
different clothes: **a rule enforced at intent time is enforced only when the
intent is what moved**, and njsPC moves the body without asking. The bypass,
the pool call and the blower were all written that way. That is now a smell to
grep for rather than a lesson to relearn.

The other pattern worth keeping: **every fault the traces found had the right
end state and the wrong path.** Snapshot assertions saw nothing wrong in any
of them.

The estimate that held: slice 8 was called the weakest at planning time and
found nothing. The estimate that did not: slice 7 was filed as cheap
insurance, and turned up nine real drifts in an instrument the other seven
slices depend on.
