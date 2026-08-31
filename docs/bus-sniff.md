# Phase 1 — sniffing the bus

The next test. It answers one question the project has been deferring since
it started, and one it has been quietly getting wrong.

**Where does water temperature come from?** PRD §11 marks it `[x]`, and the
text says *"Likely answered"* and *"Confirm the reading appears in Phase 1"*
and *"Settle before Phase 3."* Phase 3 ran on 30 August. This never settled.
The answer, from reading njsPC's source, is that **case 22 carries the
iChlor's own temperature probe** and Nixie mode assigns it to the current
body — which is why the BOM has no temperature sensor in it. If that is
wrong, scheduled preheat and targets-as-real-cutoffs have no input, and the
fallback is a REM probe nobody has bought.

**And does an iChlor 30 emit case 18?** That is the salt message, and it is
the whole of ADR-6's remaining question.

Both are answered by listening. Neither needs anything bought.

---

## The problem with Phase 1 as written

Three statements in the PRD, all load-bearing, which cannot all hold:

- **ADR-1:** *"two masters cannot share the bus."*
- **Phase 1:** *"read-only. Pi + HAT sniffing the RS-485 bus alongside the
  still-live IntelliConnect. Zero risk, nothing disturbed."*
- **§5:** *"njsPC in Nixie mode is not passive and cannot be made passive."*

njsPC transmits. The IntelliConnect is master and is running the pool today.
Put both on the bus and the failure is not theoretical.

**The resolution is that njsPC does not need to be passive — the transceiver
does.** The HAT carries TX and RX as separate switches. With TX off the Pi
cannot drive the line whatever software believes, which is a guarantee of a
different kind than a configuration flag: nothing in a config file, a code
path or a race can undo it.

So the rule for every slice below: **TX off at the HAT, verified before the
Pi is powered, and njsPC not running at all.**

Not running njsPC is the second half. Even mute, it would be receiving frames
addressed to another master and forming beliefs from them — and its beliefs
are what drive equipment the moment TX comes back. A capture wants a reader,
not a controller.

---

## Why now, and not after the IntelliConnect is retired

njsPC's case 22 handler is commented *"temp and output as seen from
IntelliConnect"* (njsPC issue #157), and case 21 notes the packet *"coming
through differently on the IntelliConnect."* This pad currently **is** an
IntelliConnect installation. Sniffing now reproduces the exact conditions the
decoder was written against.

Retire the IntelliConnect first and that is gone. Worse, it is gone
*silently* — a missing case 22 would then be indistinguishable from a case 22
that only ever appears in response to an IntelliConnect poll.

---

## Slices

### 1. Land the bus, mute, and capture raw

Temporary rig at the pad, as the heater test was. The two RS-485 home runs —
pump and cell — already terminate at the IntelliConnect. Tap in parallel
there; do not move them.

- **TX off. RX on. Termination DIP off** — the panel is a mid-bus stub, and
  the two physical ends are the devices themselves.
- njsPC stopped. `systemctl stop poolctl` too; nothing should be writing.
- Capture raw bytes off the UART to a file, timestamped, for long enough to
  cover several poll cycles. Ten minutes is generous at 9600 baud.

**Verification that we are genuinely mute**, in order of strength: the DIP
silkscreen, then continuity at the transceiver's driver-enable, then the
Pentair app continuing to work normally throughout. The last is the weakest —
absence of a symptom — and it is the only one available once the lid is on.

**Deliverable:** a raw capture file. Which is, notably, the first real
equipment data this repository has ever held.

### 2. Decode it offline

Zero risk, repeatable, no pad. Run the capture through `rs485.js`, which is
already pure functions over byte arrays.

Looking for frames from `0x50`, and specifically:

| cmd | case | what it means | decoded by `rs485.js` today |
|---|---|---|---|
| `0x11` | 17 | output % | yes |
| `0x12` | **18** | **salt PPM** — ADR-6's whole question | yes |
| `0x16` | **22** | **temperature** — the gap above | **no** |

That last row is a gap in *our* tooling, not njsPC's. The PRD sentence
*"water temperature decodes already"* is about njsPC's
`ChlorinatorStateMessage.ts`. Ours stops at salt. So a case-22 frame will
arrive at the Bus Monitor as undecoded hex — which the screen shows rather
than hides, deliberately, for exactly this reason.

### 3. Teach `rs485.js` case 22, against real bytes

Add the decoder, and test it against the capture rather than against
something invented. Every fixture in this repo today is either a guess or a
simulation; this would be the first one that came off a wire.

Keep the raw capture in the repo alongside it. It is a few kilobytes and it
is not reproducible without another trip to the pad.

### 4. The question this test cannot answer

**A successful capture does not prove temperature will work.**

If case 22 is emitted *in response to an IntelliConnect poll*, then seeing it
today proves only that the IntelliConnect asks for it. Whether njsPC asks the
same question, once it is master and the IntelliConnect is gone, is a
different fact and this test cannot reach it.

So slice 2 has two possible successes and they are not equal:

- **Unsolicited case 22** — the cell volunteers it. Safe; njsPC will see it.
- **Case 22 only after a poll** — then the open question moves rather than
  closes, and becomes *"does njsPC issue that poll in Nixie mode?"* which is
  answerable by reading its source, and finally by Phase 2 on the bench.

Record which one it is. Reading a capture and writing "temperature confirmed"
without that distinction is how this project got four decisions it had to
reverse.

---

## What each outcome costs

| Outcome | Consequence |
|---|---|
| Case 22 present, unsolicited | Temperature is solved. Preheat and real cutoffs unblock |
| Case 22 present, only when polled | Question moves to njsPC's polling behaviour. Read the source; settle on the bench |
| Case 22 absent | The BOM needs a REM temperature probe, and ADR-4's cutoffs have no input until it exists. Price it before the trip so the decision is not blocked on shopping |
| Case 18 present | ADR-6 Path B becomes available — salt alerts preserved |
| Case 18 absent | ADR-6 Path A stands, salt stays expendable, and `rs485.js`'s IC decoders seed an upstream patch (ADR-13) |

---

## Before going out

- [ ] Find the HAT's TX/RX/termination DIP and confirm which position is off.
      `docs/pi-bringup.md` previously covered only TX and RX.
- [ ] Decide how to tap: wire nuts at the IntelliConnect's terminals, or a
      short jumper. Either way the existing conductors stay where they are.
- [ ] `systemctl stop poolctl` and confirm njsPC is not running.
- [ ] Have the capture command ready and tested against a loopback, so the
      first time it runs is not at the pad.
- [ ] Price a REM temperature probe, so an absent case 22 does not end the
      afternoon in a shopping decision.
