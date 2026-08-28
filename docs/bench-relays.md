# Bench test — relay fail-safe and card identity

Run this with the HAT on a Pi on a desk. **Nothing connected to the relay
terminals except the indicator below. No mains, no loads, no actuators.**

It answers ADR-10's open question, and Test 0 first settles which version of
that question applies.

**The evidence on whether this card has a watchdog is contradictory, and the
card in hand is V 7.1.** The `8relay-rpi` driver exposes no watchdog command
and probes a four-register I/O expander at `0x38`, which would mean no
microcontroller and nothing to feed — but that driver's README says it is for
*Ver. 3*. Against it: the product page advertises an on-board hardware
watchdog, Sequent's application note refers to an "onboard MCU", and
`pi-bringup.md` records that with the TX/RX switches off **the card is a MODBUS
RTU slave** — which takes firmware, and firmware can host a watchdog. Do not
assume either way; Test 0 costs one command.

Either way the question underneath is the same, and it is the one that matters:
**does every failure mode end with the relays de-energised?**

---

## What you need

- Pi + the Eight Relays HAT, powered one way only
- A **9 V battery, an LED and a ~470 Ω resistor** in series, clipped across
  **CH1 COM and CH1 N.O.**

The indicator has to be independent of the HAT's own power, because half these
tests observe the contacts while the Pi is off. A multimeter on continuity
works too and beeps, which is easier to watch than an LED.

**LED lit = contact closed on N.O. = relay energised.** That is the state that
must not survive a failure.

---

## Test 0 — what is actually on this card

Settles the watchdog question before any effort goes into feeding one.

```bash
sudo apt install -y i2c-tools
i2cdetect -y 1
```

**Answered, 27 August 2026: `0x27` and nothing else.** That is
`(0 + 0x20) ^ 0x07`, the driver's stack-level-0 address on its alternate base.
A dumb expander, no microcontroller, no watchdog. Keep the step: it is one
command, and it is how you would notice a card that is not the one you think
you have.

**Probe the offsets with relays energised, not idle.** With everything off all
four read `0x00` and prove nothing, because a registerless PCF8574 and a
register-mapped PCA9554 look identical. With four channels on they separate at
once — this card gave `0x00`=`0x63`, `0x01`=`0x63`, `0x02`=`0x00`,
`0x03`=`0x00`, which is input / output-latch / polarity / config, so PCA9554
class with all pins configured as outputs.

**Run Tests 2 and 3 with the HAT fed from its own 5 V input**, not powered
through the Pi's header. In the panel the HDR-60-5 feeds the HAT and the HAT
feeds the Pi, so the expander survives anything that only stops the Pi. Wire
the bench the other way round and it will cheerfully show you relays dropping
on power loss — a true result about the bench and a false one about the
panel.

Record the full grid, not just whether it worked.

---

## Test 1 — which channel drives which relay

**Counting eight clicks is not enough.** Two Sequent drivers detect this card
at the same address and disagree about which bit drives which relay:

| | ch1 | ch2 | ch3 | ch4 | ch5 | ch6 | ch7 | ch8 |
|---|---|---|---|---|---|---|---|---|
| `8relay` (last commit 2021) | 0 | 2 | 1 | 3 | 6 | 4 | 5 | 7 |
| `8relind`, Industrial card (maintained) | 0 | 2 | 6 | 4 | 5 | 7 | 3 | 1 |

They agree on channels 1&ndash;2 and diverge from 3 on. Detection proves the
I2C address, nothing more — so the mapping has to be established by eye, once,
on this card:

```bash
# One bit at a time, straight to the card. No driver, and nothing to be wrong
# about: whichever single LED lights is that bit's relay.
for bit in 0 1 2 3 4 5 6 7; do
  printf -v mask '0x%02x' $((1 << bit))
  i2cset -y 1 0x27 0x01 $mask
  read -p "bit $bit ($mask) — which REL number is lit? " rel
  echo "  bit $bit = REL$rel"
done
i2cset -y 1 0x27 0x01 0x00
```

Record the full table. `ch<n> = REL<n>` throughout means the driver matches the
board; any disagreement means it was written for a different product and the
supervisor must carry its own mapping.

**Read the printed label beside the LED. Do not count positions.** The row is
silkscreened `PWR REL8 R7 R6 R5 R4 R3 R2 REL1`, so counting left to right gives
the numbers *backwards*, and the always-lit `PWR` at one end shifts the count by
one on top of that. A first attempt at this test reported channels 1,3,5,7 as
lighting LEDs "1,3,5,8", which was a counting artefact and not a mapping fault.
The terminal blocks carry the same numbering in much larger text if the LED
labels are unreadable under glare.

## The measured mapping, 27 August 2026

Established by writing **one bit at a time** to register `0x01` and reading the
silkscreen label beside the lit LED. Eight writes, eight labels, no inference.

| Bit | Relay | | Relay | Bit | Mask |
|---|---|---|---|---|---|
| 0 | REL1 | | REL1 | 0 | `0x01` |
| 1 | REL8 | | REL2 | 2 | `0x04` |
| 2 | REL2 | | REL3 | 6 | `0x40` |
| 3 | REL7 | | REL4 | 4 | `0x10` |
| 4 | REL4 | | REL5 | 5 | `0x20` |
| 5 | REL5 | | REL6 | 7 | `0x80` |
| 6 | REL3 | | REL7 | 3 | `0x08` |
| 7 | REL6 | | REL8 | 1 | `0x02` |

Write the mask to register `0x01` at `0x27` and the relay named is the relay
that closes. No driver required.

### It matches 8relind-rpi exactly

`relayChRemap` in [8relind-rpi](https://github.com/SequentMicrosystems/8relind-rpi),
the driver for Sequent's *8-Relay-Industrial* card, is `[0, 2, 6, 4, 5, 7, 3, 1]`
— **all eight entries identical to the measurement above.** One chance in
40,320, so it is not chance.

So the card bought as *Eight RELAYS 8-Layer Stackable HAT* (Amazon B07KRKS67G)
carries the Industrial card's pin routing, and the driver named by that
product's README, `8relay-rpi`, is simply the wrong one for it.

Two consequences worth keeping. **The measurement is independently
corroborated** — a table read off LEDs by one person on one board is a
measurement; the same table appearing in a vendor driver written for different
hardware is confirmation. And **the upstream report needed retracting**:
issue #7 was filed against `8relay-rpi` claiming a stale table, which was wrong
twice over, and has been corrected and retitled. #8 was withdrawn.

### What Sequent's driver actually does

Its `relayChRemap` is `[0, 2, 1, 3, 6, 4, 5, 7]`. Against the copper above,
its channel numbers reach:

| driver channel | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| relay that closes | 1 | 2 | **8** | **7** | **3** | **4** | **5** | **6** |

Only channels 1 and 2 land where the driver claims. Against this project's map
the worst row is unchanged from the first analysis: `8relay 0 write 8 on` is
nominally the **spare** — the channel least likely to be exercised — and it
closes REL6, the **blower contactor**. A 7.3 A motor whose welded contact fails
stuck-on, started by writing the channel everyone believes is unused.

### How this was got wrong, twice

Worth recording at length, because both mistakes were mine and both looked
like verification at the time.

**The first attempt lit four channels at once.** Channels 1, 3, 5 and 7 went
on, four LEDs lit, and the set was read correctly as `{1, 3, 5, 8}`. The error
was pairing that set with the channels *in order* — assuming ch1→REL1,
ch3→REL3, ch5→REL5, ch7→REL8. The set was evidence; the pairing was an
assumption, and it was false. Five of the eight entries were wrong.

**Reading the latch back felt like corroboration and was not.** After each
write the output register was read and always agreed with the driver's table.
That only ever proves the code set the bit it intended. It says nothing about
which relay the bit reaches, which is the entire question — and it made the
wrong table feel twice-checked.

**The owner's readings were right every time.** "1, 3, 5, 8" was correct.
"Now 5 is ON" for channel 7 was correct. "LED 8" for bit 1 was correct. Each
was argued with, on the strength of a silkscreen order inferred from a
photograph and a mapping derived from the bad pairing. The annotated photo
settled in one image what three rounds of reasoning had got wrong.

**The rule this leaves:** one bit, one LED, one label. A single lit relay is
the only observation that cannot be misassigned, and eight of them cost less
than one wrong table.

### Installing it, or not

`sudo make install` copies the binary to `/usr/bin` and sets it **setuid root**
(`chmod 4755`). That is unnecessary here: you are in the `i2c` group, and the
binary already runs fine as an ordinary user straight out of the build
directory. Setuid root on a CLI that drives pool equipment gives every local
account the ability to move valves. Install without it, or do not install it at
all — the supervisor has better options than shelling out to a five-year-old
binary whose channel mapping was written for a different card. One I2C write to
`0x27` sets all eight relays at once.

While CH1 is energised, confirm the **N.C. contact opens**: move the indicator
to CH1 COM–N.C. and check it is lit when the relay is off and dark when on.
This is the check that catches a swapped connector, and on CH1&ndash;3 a swap
inverts the fail-safe direction of a valve.

---

## Test 2 — clean shutdown

```bash
8relay 0 write 1 on     # LED lit
sudo shutdown -h now
```

Watch the LED through the shutdown and after the Pi is fully down.

- **Goes out** — good. De-energised is the safe direction for every channel in
  this design.
- **Stays lit** — the coil is held from a rail that survives shutdown. Record
  exactly when it drops, if ever.

---

## Test 3 — abrupt power loss

The one that models a tripped breaker.

```bash
8relay 0 write 1 on     # LED lit
```

Now pull the power. The LED must go out **immediately**. If it lingers, note
for how long — that is stored energy somewhere, and it is worth knowing.

---

## Test 4 — the process dies, the Pi does not

The failure ADR-10 exists for, and the one with no hardware answer.

```bash
8relay 0 write 1 on
sudo systemctl stop poolctl-supervisor   # or kill the process by PID
```

Expect the LED to **stay lit**: nothing commands the expander, so it holds its
output register. That is not a bug, it is the gap. Record it, because it is the
evidence that the fail-safe has to come from somewhere else — a supervisor that
de-energises on its own way out, an external watchdog cutting the **coil**
supply rather than the Pi, or an accepted risk documented against ADR-9's
de-energised-is-safe wiring.

Repeat with njsPC stopped instead of the supervisor.

---

## Test 5 — reboot transient

```bash
8relay 0 write 1 on
sudo reboot
```

Watch the LED across the whole reboot, including the moment the kernel brings
I²C up and again when our services start.

- Does it drop at power-down and stay dark until software drives it?
- **Any flicker while booting** is a relay pulsing with nobody asking, which on
  CH1&ndash;3 is an actuator movement and counts against the PE24GVA's 8-minute
  duty cycle.

---

## Recording

Write the result of each test back into PRD §10 against ADR-10, with the date
and the observed behaviour. Tests 2 and 3 dropping and Test 4 holding is the
expected shape for a PCA9554-class expander; anything else is more interesting
than the expectation and worth writing up at length.
