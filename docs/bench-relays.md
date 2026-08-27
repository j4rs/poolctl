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

- **One address, 0x38 (or 0x20), and nothing else** — a bare I/O expander.
  No microcontroller, therefore no watchdog, therefore nothing to feed, and
  the rest of ADR-10 has to be built rather than inherited.
- **A second address** — there is an MCU, the product page is right, and the
  watchdog exists. Find its driver before going further: the ADR may already
  be built, which is the outcome worth having.

Also run `8relay -v` and `8relind -v`. Whichever tool reports a version is the
one written for this card, and the other is for a different product.

Record the full grid, not just whether it worked.

---

## Test 1 — the card drives relays at all

```bash
git clone https://github.com/SequentMicrosystems/8relay-rpi.git
cd 8relay-rpi && sudo make install
8relay -list           # expect: 1,0  (one board, stack level 0)
8relay 0 write 1 on    # CH1 energises, LED lights
8relay 0 read 1        # expect: 1
8relay 0 write 1 off   # LED goes out
```

`8relay 0 test` cycles all eight. Do that once and **count the clicks** — eight
distinct relays, no channel dead, none stuck. Note any channel that behaves
differently, especially **relay 4**, which the silkscreen rates apart from the
others.

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
