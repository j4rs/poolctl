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

## Slice 1 — The card exists in tests

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

**Cost** small. **Blocks** slices 2, 4, 5, 6.

---

## Slice 2 — Traces, not snapshots

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

**Cost** small, given slice 1. **Depends on** 1.

---

## Slice 3 — A compressed clock

**What.** Env-overridable durations **in the supervisor** — `PURGE_MS`,
`HEARTBEAT_MS`, `COMMISSIONING_MS`, spa revert. Not in `sequences.js`: the
browser imports that file and has no `process`.

**Why.** Purge is 3 min, spa timeout 120, actuator cooldown 8, watchdog 60 s.
The purge test today can assert the *hold* and never the *release*, because
releasing takes three real minutes — so the release is verified only by
watching a journal on the Pi, by hand, once.

**Done when** the purge release, the spa auto-revert and the watchdog withhold
are all asserted in a suite that still runs in under two minutes.

**Cost** small. **Independent**, but every other slice gets faster with it.

---

## Slice 4 — Scenarios as tables

**What.** A thin helper for `given state → these intents → expect this trace`.
A table, not a DSL; the moment it needs its own documentation it has failed.

**Why.** Leverage. Once 1–3 exist, the marginal cost of a scenario should be
three lines, because the value is in having *many* — and a trace table is
reviewable as a specification by someone who will not read the test harness.

**Done when** the four `SEQUENCES` paths and the boot resync are each one
table, and adding a fifth is obvious.

**Cost** medium. **Depends on** 1, 2, 3.

---

## Slice 5 — njsPC acting on its own

**What.** Script njsPC *initiating* — a schedule firing, an egg timer
expiring, dashPanel writing a circuit, a body switching — and assert the
supervisor reacts. Today the fake is only ever poked by the test in step with
the supervisor's own intents.

**Why.** This is ADR-11's entire hazard, and it has already produced a real
bug: driving the Spa circuit straight through njsPC's API left the stored
bypass at `around` from pool mode and the card came out `0x65` — spa valves,
spa heat call, exchanger bypassed. A heat call at zero flow. That is the pair
ADR-5's interlock exists to prevent, and it arrived because njsPC changed the
body without asking.

**Done when** a test switches the body behind the supervisor's back and
asserts the byte follows, not the stale intent.

**Cost** medium. **Depends on** 1, 2. **Highest value after the spine.**

---

## Slice 6 — Faults

**What.** Card write fails, card read fails, njsPC drops mid-intent, the card
drifts, two writes race. Some of this exists — `SIGUSR2` breaks `evaluate()`,
and njsPC-at-a-dead-port is the default.

**Why.** Every recovery path in this process was written from reasoning and
verified, if at all, by breaking something on the Pi by hand. The drift
corrector's race was found that way and could have been found here.

**Done when** the drift path is provable without an SSH session, including the
case that broke it: a legitimate write landing during the read-back.

**Cost** small-medium. **Depends on** 1.

---

## Slice 7 — Keeping the fake njsPC honest

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

**Cost** small. **Independent.**

---

## Slice 8 — The client against a real supervisor

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

---

## Order

**Spine, in order:** 1 → 2 → 3 → 4.
**Then:** 5, which is where the remaining sharp edges are.
**Slot in anywhere:** 6 and 7, both cheap.
**Last, if ever:** 8.

The honest summary is that slices 1, 2 and 5 pay for the whole exercise; 3 is
an enabler; 4 is leverage; 6 and 7 are cheap insurance; and 8 is the one to
drop if the appetite runs out.
