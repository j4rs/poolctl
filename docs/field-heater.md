# Wiring the heater — field procedure

Phase 3: the Raypak's 3-wire control onto CH4 and CH5. Valves stay manual;
the pump is untouched. This is the smallest change in the project with the
largest payoff, and it is the first time this panel drives real equipment.

Companion to `docs/bench-relays.md`, which is the bench work this rests on.
Everything about which screw is which was measured on 28 August 2026 — see
Test 1b there if you want to re-derive it rather than trust it.

---

## Before leaving the bench

- [ ] The card is labelled 1–8 in marker. If it is not, do Test 1b first.
      Nothing below is safe to follow from position alone.
- [ ] `git log` on the Pi matches what you think is deployed —
      `PI=<user>@poolctl.local ./scripts/deploy.sh` if unsure.
- [ ] The end-to-end call works. **Done 28 August 2026**: tapping *Heat the
      pool* produced `relays -> 0x10  REL4`, with CH3 releasing at the same
      moment. If that ever stops being true, fix it here, not at the pad.

Take: the meter, a phone on the pool wifi, the Raypak I&O manual, and this
page. The board map is reproduced at the bottom.

---

## 1. Everything off, and prove it

The heater has its own supply. Kill it at the breaker and **confirm dead with
the meter** — the terminal strip is low voltage but it is not de-energised
just because the display is dark.

Also power down the panel. There is no reason to land a wire on a live card,
and the relays latch, so "the supervisor says it is off" is not the same
statement as "the contact is open".

---

## 2. Find terminals 44, 45, 46

Per ADR-4 these are **COMMON / POOL / SPA** on the Raypak's low-voltage
terminal strip, inside the cabinet. From the HPPH Installation & Operation
manual, p.47:

> **3-Wire Controllers.** Install wires from the automation controller for
> "Heat" on the terminal strip inside the HPPH on the terminals: # 44(Com),
> # 45 (Pool) & # 46 (Spa).

**This ADR said 22/23/24 until 30 August 2026 and those numbers were wrong.**
Confirm against the label inside the door anyway — the manual covers a model
range, and the point of this step is to stop trusting a number nobody has
seen.

**What you are looking for** is neither circuit board. Manual Fig. 16,
*Heater Wiring Block*, photographs it: a beige barrier strip screwed to the
chassis, two screws per row, with **40–49 printed on the panel beside it**
rather than on the strip. The numbers are bracketed into groups:

| Terminals | Panel label |
|---|---|
| 41–43 | 3-WAY VALVE |
| **44–46** | **REMOTE** |
| 47–48 | AUX SENSOR |

It sits low in the control box near where the existing field wiring enters,
and it will already have wires on it. Hunt for the printed numbers, not for
the block.

Do not confuse it with the small board carrying `P1` and `P2` screw terminals
under an `RS-485` legend with green/yellow pairs — that is a separate comms
board and has nothing to do with the heat call.

Two things that were open questions here are now answered, and both are
required before a contact does anything:

- **Remote mode must be enabled at the keypad.** Hold UP and DOWN together
  for 3+ seconds. The top line then reads `Remote`, and a live call shows as
  `Remote Pool <setpoint>F` or `Remote Spa <setpoint>F`. Exiting remote
  **defaults the board to OFF** — so if the heater ever stops responding
  after someone touches the keypad, check this first.
- **The INSTALLER menu has a `Remote Pool` setting**, and its factory default
  is **Cool**. The manual's 3-wire procedure says to set it to `Heat` or
  `Auto`. Record what it was before you change it.

While the door is open, also write down:

- **The heater's own POOL and SPA setpoints, and POOL MAX TEMP / SPA MAX
  TEMP.** These are the real thermostat. ADR-4 exists so the caps live in
  firmware rather than in this repository, and in remote mode it is those two
  MAX values that bind.
- **Which terminals the outgoing IntelliConnect pair lands on.** If it is
  44/46, that install has been heating at the *spa* setpoint every time it
  called — see ADR-4.
- **The run length from the panel to this strip**, which is not recorded
  anywhere and which you need before buying cable.

If the terminals are not 44/45/46, **stop and update ADR-4** rather than
adapting on the fly. The whole safety argument names those terminals.

### Do not wire to the board's REMOTE header

The main control board (Raypak `H000302`; silkscreen `1204-100`,
`47-103748-02`, `HSCI 1204-83-102A`) carries a 5-pin header marked **REMOTE**
along its top edge, between `EXV` and `POWER`. That is the factory link from
the board to the numbered terminal strip. Field wiring goes on the **strip**,
not on that header — the manual is explicit that the automation controller
lands on "the terminal strip inside the HPPH".

This is also why no harness kit exists for these units. The illustrated parts
list for models 5450/6450/8450 (Raypak catalogue 9100.74) lists every control
box part — board, display, transformer, contactor, relays, sensors — and
contains **no remote harness of any kind**, because the strip is already
there and takes bare conductors. Harness kits like `080349F` are for the Avia
**gas** heaters, a different product line with a different control box.

**If there is no numbered strip in your cabinet**, stop. That would mean the
REMOTE header is the only connection point, the DIY cable plan is wrong, and
the right next step is Raypak service on 800-260-2758 with the board numbers
above — not improvising a connector.

---

## 2b. Prove the two calls before wiring anything

Ten minutes, no panel involved, and it is the difference between believing
the 3-wire model works on this unit and knowing it.

With the heater in Remote and its supply **off at the breaker**:

1. Jumper **44 – 45**. Restore power. The display should read
   `Remote Pool <setpoint>F`.
2. Kill power. Move the jumper to **44 – 46**. Restore power. It should read
   `Remote Spa <setpoint>F`.

Two distinct calls, each showing the heater's own setpoint, is ADR-4
confirmed end to end. If only one of them lands, stop — spa heating to a spa
temperature is then not available through contacts, and that is a design
change rather than a wiring problem.

Remove the jumper before going any further.

---

## 3. Keep the heater's voltage away from the transformer

CH4 and CH5 carry **the Raypak's own low voltage**, supplied on its terminal
strip. They must not share anything with the panel's 24 VAC actuator supply —
no shared common, no shared bus.

This is the one wiring mistake here that damages equipment rather than merely
misbehaving. Two sources tied together through a relay common is a fault
looking for a path.

---

## 4. Land the wires

Three conductors, and the two ends are not symmetrical — so name them before
you strip anything:

| conductor | heater end | panel end |
|---|---|---|
| Com | terminal **44** | COM screw on **both** CH4 and CH5 |
| Pool | terminal **45** | CH4, **N.O.** |
| Spa | terminal **46** | CH5, **N.O.** |

Terminal 44 lands on two screws — it is the common return for both calls.

![Where the heater's three conductors land on the HAT](img/hat-heater.svg)

Both channels sit at the **bottom** of the card on **opposite edges** — the
right edge runs 1-2-3-4 downward, the left edge runs 5-6-7-8 *upward*. Drawn
from Test 1b in `bench-relays.md`, measured 28 August 2026.

**COM to the middle screw on both.** Then:

| | relay | block | screw | contact |
|---|---|---|---|---|
| Pool heat | 4 | right edge, 4th from top | **bottom** | N.O. |
| Spa heat | 5 | left edge, bottom | **top** | N.O. |

> **CH4/CH5 is a hold, not a conclusion.** The two channels are on opposite
> edges of the card, so a single jacketed cable cannot reach both without
> fanning conductors across it — past the 24 VAC channels the heater pair is
> supposed to stay clear of. Moving the heater to CH5+CH6 fixes that, and is
> tracked in
> [#1](https://github.com/j4rs/poolctl/issues/1). It is deliberately **not**
> being done before the first test: a bench rig uses loose leads that reach
> either edge, and renumbering costs the same tomorrow as today. Do it before
> wire goes in a gland.

**The pair does not wire symmetrically.** CH4 and CH5 straddle the boundary
between the board's two connector groups, which are mirrored — so the same
job takes opposite screws. This is the easiest mistake available on this card
and it fails in the worst direction: wire them alike and one contact sits
closed while the supervisor believes the heater is idle. A heat call nobody
made, that nothing in software can see.

Both are **N.O.**, so no call exists when the coil is de-energised. That is
the fail-safe: `0x00` means every contact open.

**Verify with the meter before energising anything.** Card unpowered, probe
COM to the wire you just landed on each channel: both should read open. If
either beeps, it is on N.C. and must move.

---

## 5. Power up and test

Panel first, heater second. Watch the journal:

```bash
ssh <user>@poolctl.local 'journalctl -u poolctl -f'
```

Expect `relays -> 0x00 (all off) — boot`, then `relays -> 0x40  REL3` once
njsPC answers.

### Pool heat

1. Tap **Heat the pool**, confirm twice (`useConfirm` arms on the first tap).
2. Journal should show `relays -> 0x10  REL4`.
3. **CH3 goes off and CH4 comes on, together.** CH3 releasing is the bypass
   swinging to *flow through the heater* — de-energised is flow, which is why
   a heat call releases relay 3 rather than driving it.
4. The heater should acknowledge a call. It will not necessarily start: the
   anti-short-cycle delay is 5–8 minutes, and there is no flow yet because
   the pump is not on this panel until Phase 4.
5. Tap again to stop. Journal returns to `relays -> 0x40  REL3`.

### Spa heat

Spa heat is implied by spa mode, not by a separate control — the supervisor
owns both contacts, and entering spa mode asserts CH5. Hold **Spa** for five
seconds and expect `relays -> 0x05` plus CH5. Valves are still manual, so
this is a contact test only.

### What to record

- Time from tap to contact close (should be immediate — `publish()` drives
  the relays, not the 5 s heartbeat).
- Whether the heater's display acknowledges the call, and how.
- **Time the anti-short-cycle delay.** The manual gives two figures — 5
  minutes in one place, 6–8 in another. `PURGE_SKIP_AFTER_MIN` is 5, the
  optimistic reading. This is a real number the project currently guesses at.

---

## Stop conditions

**Both heat contacts closed at once.** Should be impossible — `byteFor` sets
one or the other from a single `heaterCall` value — but if the meter says
otherwise, stop. That is a wiring fault or a relay fault, and it means the
heater is being told two things.

**A contact closed with the supervisor reporting idle.** Almost certainly
N.C./N.O. reversed. Check `curl http://127.0.0.1:4300/health` for
`thinking:true` first — a supervisor that has stopped evaluating still serves
and still looks alive.

**`FLo` or `FL3` on the heater.** Low flow. Expected here, since no pump is
running, but do not leave a call standing against it.

---

## Board map

Landscape, GPIO header along the top, screws vertical in each block.

```
                      top
   +-----------------------------------+
 8 |                                   | 1
 7 |          header, DIP              | 2
 6 |                                   | 3
 5 |                                   | 4
   +-----------------------------------+
```

Right edge runs 1-2-3-4 top to bottom. Left edge runs 5-6-7-8 **bottom to
top**. Contact order: `RELAY 1-4` is N.C./COM/N.O. top to bottom, `RELAY 5-8`
is N.O./COM/N.C. COM is the middle screw on all eight.

---

## What this does not cover

The valves. CH1–CH3 are Phase 4, and one rule there is not implemented yet:
*no valve command while another valve move is in flight*. It describes a
transition, cannot be seen in a state snapshot, and belongs with valve
driving. Do not land actuator wires on the assumption that it is enforced.
