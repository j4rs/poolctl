# Phase 1 — putting njsPC on the bus

**Goal, in the owner's words: read and control the pump and the chlorinator.**
New hardware is acceptable if it is needed. It mostly is not.

That is ADR-1's end state — njsPC as sole master — so this is not a
reconnaissance exercise. It is the handover, done deliberately and with a way
back.

---

## What was going to be the plan, and why it was dropped

The first draft of this document proposed sniffing the bus read-only,
alongside the still-live IntelliConnect, to find out whether case 22
(temperature) and case 18 (salt) arrive. It argued the IntelliConnect had to
stay for that, because njsPC's case 22 is commented *"temp and output as seen
from IntelliConnect."*

**That was a misreading, and reading the source on the Pi settled both
questions for free.** The full comment is *"Chlorinator->OCP this is actually
an iChlor message and has no bearing on IntelliConnect"* — the cell
originates it. The quoted line describes where the sample came from.

So a capture taken today would observe a configuration we are about to
destroy, and answer nothing that being master does not answer better.
Dropped. See ADR-6 for the corrected reading.

---

## What the source already tells us

From `ChlorinatorStateMessage.ts` and `nixie/chemistry/Chlorinator.ts` on the
Pi, njsPC v10.0.1:

| | Mechanism | Consequence |
|---|---|---|
| **Chlorinator control** | njsPC sends `action: 17` to address 80 with the target output | This is the control path. It exists and is unconditional in Nixie |
| **Case 18** | Declared as the *required response* to 17, `retries: 3` | Not just salt. No 18 → `sendAsync` rejects → `currentOutput = 0`, `status = 128`, persistent comms error |
| **Case 22** | Cell → controller, iChlor's own message | Under Nixie, `payloadByte(2)` → `getBodyIsOn().temp`, floored at 40 °F. This is the water temperature the whole project depends on |
| **Salt fallback** | `chlor.ignoreSaltReading`, comment names REM as an alternate source | A path exists if 18 is unreliable but control still lands |

**The one thing source cannot answer** is whether an iChlor 30 actually emits
18 and 22. That needs the cell on a bus with njsPC talking to it.

---

## The real risk, and the way back

Retiring the IntelliConnect from the bus means the pool's current controller
stops controlling it. If njsPC then cannot drive the pump, circulation stops
— in Florida, in summer, which is how a pool turns green.

**The mitigation is already in the pump.** The IntelliFlo VSF runs Programs
1–8 from its own keypad, and Programs 1–4 support Schedule mode with start
and stop times (Installation and User's Guide, Program Menu Tree). A pump
running its own schedule does not care whether anything is on the bus.

So: **set a standalone filtration schedule on the pump keypad before touching
the bus.** That converts "the pool has no controller" into "the pool has no
*automation*", which is survivable for as long as it takes to put two wires
back.

The other way back is the wires themselves. Both home runs currently land at
the IntelliConnect; moving them to the HAT is reversible in minutes.

---

## Slices

### 1. Standalone pump schedule, before anything else

At the pump keypad, not in any app. A daily filtration window that will run
with the bus dead. Write down what it was set to, and what it is now.

**Done when** the pump has run its own schedule through one cycle with
automation not involved.

### 2. Disable priming — the one thing that must happen with the bus down

`docs/field-heater.md` has the procedure. It has to be done at the pump, and
the RS-485 cable comes off while you do it, so it belongs in the same visit as
the handover rather than in its own trip.

Factory default is Enabled. Until it is off, *"the pump responds to its
internal settings before responding to commands from an automation control
system"* — which is ADR-9's whole reason for existing.

### 3. Move both home runs to the HAT

Pump and cell each home-run to the IntelliConnect today; they are not chained.
Land both on the HAT's two RS-485 terminals, which are one port in parallel,
not two.

- **Termination DIP off.** The panel is mid-bus; the ends are the devices.
- **TX and RX both on** this time. We are the master now.
- IntelliConnect off the bus entirely. Not powered down and still wired —
  off.

### 4. Enable comms and see who answers

`enabled: true` on njsPC's RS-485 port — the commissioning check has been
flagging it off since the beginning, correctly.

Then read, in this order, because each answers a different question:

1. **Does the pump answer?** rpm and watts appear, at 1 rpm resolution. This
   is the one with a fallback already in place from slice 1, so it is the
   safest thing to find broken.
2. **Does `action 17` land?** If the chlorinator shows a comms error and
   `currentOutput: 0`, case 18 is missing — and per ADR-6 that is now a
   control problem, not only a salt one.
3. **Does salt appear?** Only meaningful if 2 succeeded.
4. **Does water temperature appear on the current body?** This is case 22, and
   it is the reading the heater cutoffs, scheduled preheat and the whole
   targets feature have been waiting on.

### 5. Record what the cell actually is

Whatever happens, capture the raw frames while the bus is live — njsPC logs
them, and `src/lib/rs485.js` plus the Bus Monitor screen exist for this.

Two reasons. It is the first real equipment data this repository would hold;
everything else is invented or simulated. And `rs485.js` decodes `0x12` (salt)
but **not `0x16`** (temperature) — a gap in our own tooling, opposite to what
ADR-6's summary implies, and best closed against real bytes.

---

## Outcomes and what each costs

| Outcome | Consequence |
|---|---|
| Pump reads and drives | ADR-1 is delivered. Speed control moves from the keypad to schedules |
| Case 22 present | Water temperature is solved. Preheat and real cutoffs unblock, and the BOM still needs no sensor |
| Case 22 absent | A REM temperature probe becomes required, not optional. Price it before the visit |
| Case 18 present | ADR-6 Path B is available, salt alerts preserved |
| Case 18 absent | Chlorinator control reports failure on every poll even if the cell obeys. Options: `ignoreSaltReading`, feed salt from REM, or patch njsPC to treat 18 as optional for iChlor — a textbook ADR-13 case, and `rs485.js`'s IC decoders would seed it |

---

## Before going out

- [ ] Pump running a standalone schedule, verified through one cycle.
- [ ] Priming procedure to hand — it is in `docs/field-heater.md`.
- [ ] Find the HAT's third DIP. `docs/pi-bringup.md` documents TX and RX and
      not termination.
- [ ] Price a REM temperature probe, so an absent case 22 ends in a decision
      rather than in shopping.
- [ ] Know how to put the two conductors back on the IntelliConnect, in the
      dark, in a hurry.
