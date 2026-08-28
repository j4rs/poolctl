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
      `PI=j4rs@poolctl.local ./scripts/deploy.sh` if unsure.
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

## 2. Find terminals 22, 23, 24

Per ADR-4 these are COMMON / POOL / SPA on the Raypak's low-voltage strip.
**Confirm against the label inside the heater's door before wiring** — the
numbering is from the manual, and nobody on this project has yet seen the
actual strip.

Two things to establish while the door is open, both currently unknown:

- **Does the heater need a mode setting for external control?** Some units
  want thermostat/remote selected before the dry contacts do anything. If
  there is such a setting, record what it was and what you changed it to.
- **What are the heater's own setpoints?** They are the real thermostat —
  ADR-4 exists so that the 95 °F pool and 104 °F spa caps live in firmware
  rather than in this repository. Write down what they are set to.

If the terminals are not 22/23/24, **stop and update ADR-4** rather than
adapting on the fly. The whole safety argument names those terminals.

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

**COM to the middle screw on both.** Then:

| | relay | block | screw | contact |
|---|---|---|---|---|
| Pool heat | 4 | right edge, 4th from top | **bottom** | N.O. |
| Spa heat | 5 | left edge, bottom | **top** | N.O. |

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
ssh j4rs@poolctl.local 'journalctl -u poolctl -f'
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
