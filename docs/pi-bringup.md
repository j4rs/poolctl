# Bringing up the Pi

What has to happen on the box, in order, to go from a flashed card to a
controller the phones can use.

Written against a Pi 4 (2 GB, aarch64) running Pi OS Lite on Debian 13
trixie, starting from an OS, a hostname and an SSH key. Everything below
has been run on that box; only REM and the equipment settings wait for the
HAT.

Two things this file is **not**. It is not the equipment checklist: the
settings that live on the pump keypad and inside njsPC are in `CLAUDE.md`
under *Next up*, and several of them are now checked automatically by the
supervisor. And it is not a wiring guide — the 240 V side is an electrician's
job and in most places needs a permit.

Sections 1–5 are done on this box and describe what was actually run.
Section 6 waits for the HAT.

---

## 1. The box itself

**Timezone.** Do this first, and do not skip it.

```bash
timedatectl list-timezones | grep -i <your region>
sudo timedatectl set-timezone <Region/City>
```

njsPC stores schedule times as minutes past midnight and evaluates them
against the Pi's local clock. A box left on UTC runs every schedule hours
out, throws nothing, and looks perfectly healthy on screen — the filtration
window simply happens at the wrong time of day. This is the single easiest
way to make the whole system quietly wrong.

The timezone may already be right — recent Pi OS images ask during imaging.
Check rather than assume.

**Then check the clock itself**, because a Pi has no battery-backed RTC:

```bash
timedatectl
```

Want `System clock synchronized: yes` and a sensible local time. The
supervisor checks both now — an unsynchronised clock and a box left on UTC
each raise a finding on the Water screen — but it can only tell you the zone
looks unset, never which zone is right. That part stays here. Observed on
this box: seconds after boot it reported a time **two days behind**, restored
from the last timestamp written to the filesystem, and corrected itself about
thirty seconds later once NTP answered. Nothing warns you about that window —
which is why the service unit in section 3 waits for `time-sync.target`
rather than merely for the network.

**Give it a fixed address.** A DHCP reservation on the router is better than
static configuration on the Pi — it survives a reflash. The phones need to
find it, and `poolctl.local` depends on mDNS, which is reliable on iOS and
less so elsewhere.

---

## 2. Node

**Node 22, from NodeSource.** Debian 13 (trixie) packages Node 20, which is
enough for the supervisor alone but not for this box:

| | needs |
|---|---|
| supervisor | `node >=20` |
| **njsPC 10.0.1** | **`node >=22.0.0`, `npm >=10`** |

Both run here, so the Pi needs 22. Debian's `npm` package conflicts with the
one NodeSource bundles, so remove it first:

```bash
sudo apt remove -y npm
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v && npm -v
```

This was got wrong once in the obvious way: by reading the supervisor's
`engines` field, finding trixie's Node 20 sufficient, and not checking the
dependency that was going on the same box a few hours later. njsPC's
`prestart` refuses to run below 22 and says so, so the failure is loud — but
only after everything else is installed.

Node is the only runtime dependency this repo adds to the Pi. The supervisor
is plain JavaScript with no build step, which is why the Pi never needs a
toolchain — see section 3.

---

## 3. The supervisor

Built on the laptop, copied as artifacts. The Pi runs; it does not build.

From the laptop. `$PI` is wherever you can SSH to the box &mdash; **the user is
whatever the imager created, not necessarily `pi`**, and this document said
`pi` for months while the box answered to something else:

```bash
export PI=<user>@poolctl.local
./scripts/deploy.sh
```

That builds here, ships `dist/`, `supervisor/` and `src/lib/`, installs the
two runtime dependencies on the Pi — `ws` and `socket.io-client`, both pure
JavaScript, so nothing compiles — restarts the service and waits for
`/health` to answer. `--dry-run` shows what would move without touching
anything.

**Use the script rather than rsync by hand.** The supervisor imports the
shared spec across the repo boundary (`../src/lib/sequences.js` and the
constants in `programs.js`), which is deliberate — sequences.js is the
executable spec and there is one copy of it. A deploy that ships only
`dist/` and `supervisor/` starts and then dies with `ERR_MODULE_NOT_FOUND`
on a box with no screen to tell you. That is exactly how the first deploy
here failed.

The script never copies `auth.json` or `state.json`. Those exist only on the
Pi, and overwriting them would sign the household out and reset the targets
on every deploy.

**Set a password before it is reachable by anything.**

```bash
node ~/poolctl/supervisor/passwd.js
```

There is deliberately no way to do this over the network. Without it the
supervisor still runs, warns at startup and raises a finding on the Water
screen — but it accepts anyone who can reach the port.

Then a service. `Restart=always` matters because this process holds the
interlocks; `TimeoutStopSec` can be short because shutdown closes its
WebSocket clients explicitly and exits promptly rather than waiting on them.

```ini
# /etc/systemd/system/poolctl.service
[Unit]
Description=poolctl supervisor
# time-sync.target is not decoration. A Pi has no battery-backed clock, so
# it boots with whatever timestamp was last written to the filesystem and
# corrects itself once NTP answers. Measured on this box: it came up
# believing it was two days earlier and jumped forward about thirty seconds
# later. Schedules are minutes past midnight and egg timers are wall-clock
# deadlines, so a supervisor started inside that window is reasoning about
# the wrong day.
After=network-online.target time-sync.target
Wants=network-online.target time-sync.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/poolctl/supervisor
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5
TimeoutStopSec=15
Environment=PORT=4300
Environment=NJSPC_URL=http://localhost:4200
# STATE_FILE and AUTH_FILE default to this directory; set them only to
# move the durable state somewhere else.

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now poolctl
systemctl status poolctl
journalctl -u poolctl -f
```

If anything was started by hand while testing, stop it first — it still holds
port 4300 and the service will fail to bind:

```bash
pkill -x node
```

**The supervisor listens on all interfaces, unlike njsPC.** That is the
point of it: the phones talk to this and nothing else. It is the one process
on the box that is meant to be reachable, which is why it is the one with a
password.

Check it from a phone on the same network — `http://poolctl.local:4300` —
and confirm you get the sign-in screen rather than the app.

---

## 4. Deploying again

```bash
./scripts/deploy.sh          # $PI from section 3
```

The same script, every time. It ends by asking the Pi for `/health` and
reporting what came back, so a deploy that silently failed to restart is not
mistaken for one that worked. A supervisor that is up but cannot reach njsPC
is reported as a note rather than a failure — that is a real state, not a
broken deploy.

---

## 5. njsPC

Installed on the Pi, on the upstream path, from the same tag the laptop
runs. It does not need the serial port to run — only to drive equipment —
which is why this does not wait for the HAT.

```bash
git clone --depth 1 --branch v10.0.1 \
  https://github.com/tagyoureit/nodejs-poolController.git ~/njspc
cd ~/njspc && npm install
```

**Write `config.json` before the first start.** njsPC generates it from
`defaultConfig.json` on first run, and that default is `0.0.0.0` with
`authentication: "none"` — so a first start on a live network is a window
where anyone on the wifi can drive the equipment. Pre-empt it:

```bash
cd ~/njspc && python3 - <<'PYEOF'
import json
d = json.load(open("defaultConfig.json", encoding="utf-8-sig"))
d["web"]["servers"]["http"]["ip"] = "127.0.0.1"
d["web"]["servers"]["https"]["ip"] = "127.0.0.1"
json.dump(d, open("config.json", "w", encoding="utf-8-sig"), indent=2)
PYEOF
```

Note the `utf-8-sig`: njsPC ships `defaultConfig.json` with a byte-order
mark, and a plain `json.load` fails on it.

Its API needs no password and dashPanel bypasses every interlock the
supervisor adds, which is why loopback is not optional. The supervisor
verifies it by trying to reach njsPC on the Pi's own network addresses, so
reopening it raises a warning on the Water screen rather than going
unnoticed. Reach dashPanel through a tunnel instead:

```bash
ssh -L 4200:localhost:4200 $PI    # then browse http://localhost:4200
```

Build, then run it as a service. Build once rather than through `npm start`,
which runs `tsc` first and would rebuild on every boot — about 45 s on a
Pi 4:

```bash
cd ~/njspc && npx tsc
```

```ini
# /etc/systemd/system/njspc.service
[Unit]
Description=nodejs-poolController (njsPC, Nixie mode)
After=network-online.target time-sync.target
Wants=network-online.target time-sync.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/njspc
ExecStart=/usr/bin/node dist/app.js
Restart=always
RestartSec=5
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now njspc
```

`Error opening port 0: ... /dev/ttyUSB0` in the log is expected until the HAT
arrives, and njsPC retries every ten seconds. Everything else works without
it: bodies, circuits, valves, schedules and the delay manager all run.

Copying the pool configuration from another njsPC — circuits, pump, valves —
is just `~/njspc/data/`. Worth doing rather than reconfiguring by hand, and
it keeps the supervisor's program-to-circuit bindings valid.

---

## 6. When the HAT arrives

### I2C first, or nothing on the card responds

The relays are driven over **I2C**, not the UART. This document went to the
pad without saying so, and the omission cost a reboot on the day the card
arrived: the HAT was fitted, the Pi came up clean, and there was no
`/dev/i2c-1` to talk to because I2C is **off by default on Raspberry Pi OS**.
A loaded `i2c_brcmstb` module is not evidence to the contrary &mdash; that is
the SoC's own internal bus, not the GPIO one the HAT sits on.

```bash
sudo raspi-config nonint do_i2c 0     # writes dtparam=i2c_arm=on
sudo usermod -aG i2c "$USER"          # so i2cdetect needs no sudo
sudo reboot
```

Then confirm, before touching any driver:

```bash
ls -l /dev/i2c-1          # must exist
i2cdetect -y 1            # the card must appear, expected at 0x38 (or 0x20)
```

The address matters beyond "it works". A single address and nothing else means
the card is a bare I/O expander with no microcontroller, and therefore no
hardware watchdog whatever the product page claims &mdash; which decides whether
ADR-10 is inherited or has to be built. See `bench-relays.md`.

### The serial bus, before anything else

The pump and the iChlor are reached over RS-485. The heater is not — it is
dry contacts on terminals 22/23/24, which is a relay job — so the bus matters
for exactly two devices, and without it both stay silent while everything
else looks healthy.

The relay HAT carries the RS-485 transceiver (with TVS diodes and a
resettable fuse), and it presents on the **Pi's GPIO UART**, not on USB.
Three things have to be true, and none of them are by default:

**1. The DIP switches.** TX and RX **ON**, so the Pi drives the bus directly.
With them off the transceiver is simply not connected to the Pi's UART and the
pump cannot be reached at all.

*This used to say the card becomes a MODBUS RTU slave with them off. It cannot
— the bus scan on 27 August 2026 found a single PCA9554-class port expander at
`0x27` and no microcontroller, so there is no firmware to run a slave. That
claim came from Sequent's Industrial relay card, a different product.*

*As shipped they are off.* The V 7.1 card photographed on arrival had all six
switches in the off position — the factory default, and wrong for this use.
The bank is `SW1`, labelled `ID2 ID1 ID0` on one side and `485-TX 485-RX
485-TERM` on the other. Set TX and RX on; leave the three ID switches off,
which is stack level 0 and correct for a single card.

**And the third one: termination OFF.** The same switch bank carries a
termination switch alongside TX and RX, and it had no home in this document
until the bus topology was settled. The pump and the cell each home-run to the
panel on their own cable, so the panel is a **mid-bus node** with a device at
either end — and termination belongs at the two physical ends, not in the
middle. Leave it off.

This is the one setting here that flips if the wiring changes: chain the pump
and the cell to each other outside the panel instead, and the panel becomes an
end of the bus, and this switch goes **on**. Check which you actually built
before trusting either answer.

**2. Enable the UART, take the console off it, and take Bluetooth off the good
one.** Linux claims `/dev/serial0` as a login console out of the box, so njsPC
cannot open it. And on a Pi 4 there is a second trap underneath that one.

The Pi 4 has two usable UARTs on GPIO 14/15: the **PL011** (`ttyAMA0`), a real
UART, and the **mini-UART** (`ttyS0`), whose baud rate is derived from the VPU
core clock. By default Bluetooth owns the PL011 and the header gets the
mini-UART — confirmed on this box, where `hciconfig` reports
`hci0: Type: Primary Bus: UART`. A clock-derived baud rate is the classic
source of intermittent serial corruption on Pi 3/4, and this is a bus we are
going to decode Pentair frames off with a decoder (`src/lib/rs485.js`) that has
never been checked against real traffic. Starting on the flaky UART means every
bad frame has two possible causes. Nothing here uses Bluetooth, so give the
header the real UART:

```bash
sudo tee -a /boot/firmware/config.txt >/dev/null <<'CFG'

# RS-485 on GPIO 14/15: give the header the PL011, not the mini-UART
enable_uart=1
dtoverlay=disable-bt
CFG

# remove console=serial0,115200 from /boot/firmware/cmdline.txt,
# leaving the rest of that single line intact
sudo sed -i 's/console=serial0,[0-9]* //' /boot/firmware/cmdline.txt

# Older images attach BT via hciuart, which has nothing to do once BT is off.
# Trixie and later have no such unit - "does not exist" here is fine, not an error.
sudo systemctl disable hciuart 2>/dev/null || true

sudo reboot
```

After the reboot `/dev/serial0` should point at `ttyAMA0`, not `ttyS0`:

```bash
ls -l /dev/serial0        # -> ttyAMA0
```

**Verifying the UART with no bus attached.** Transmitting and listening for an
echo proves nothing: most RS-485 transceivers mute the receiver while driving,
so silence is the expected result either way. What does prove it is **timing a
blocking write**, because a UART clocking bits out takes exactly as long as the
baud rate says it should:

```bash
python3 - <<'EOF'
import os, time
fd = os.open("/dev/serial0", os.O_RDWR | os.O_NOCTTY)
t = time.time(); n = os.write(fd, bytes([0x55, 0xAA] * 32)); os.close(fd)
print("%d bytes in %.1f ms" % (n, (time.time() - t) * 1000))
EOF
```

64 bytes at 9600 8N1 is 640 bits, so 66.7 ms. Measured here: **71.5 ms**. A
buffer swallowing the write and discarding it would return in microseconds, and
the mini-UART running off an unfixed core clock would come back at the wrong
figure. This checks the Pi half of the path &mdash; the right UART, the right
pins, the right baud &mdash; and it can be done on a desk.

It does **not** check the transceiver. Whether TX reaches A/B and A/B reaches
RX needs either a meter across the terminals or a device on the bus. The pump
chattering away is the real test, and it arrives the moment the bus is landed.

Afterwards `/dev/serial0` should exist and nothing should be holding it:

```bash
ls -l /dev/serial0 && sudo fuser -v /dev/serial0 || echo "free"
```

**3. Point njsPC at it.** njsPC ships configured for `/dev/ttyUSB0` — the
path a USB dongle would take, not the HAT's. In dashPanel this is under
RS-485 settings, or set `rs485Port` to `/dev/serial0` in its `config.json`
and restart.

The supervisor checks the result rather than trusting it: if njsPC's
configured port does not exist on the box, it raises **"njsPC cannot open
/dev/…"** on the Water screen and names the three fixes.

**Done, 27 August 2026.** `baudRate` was already `9600`, correct for a Pentair
bus; only the path was wrong.

Change it through njsPC, not by editing the file. njsPC holds its configuration
in memory and writes it out, so editing `config.json` under a running instance
is a race it wins. `PUT /app/rs485Port` applies the change live, reopens the
port and persists it:

```bash
# send the WHOLE comms object with one field changed, not a patch:
# setPortAsync keys off portId and fills unlisted fields from defaults
curl -s http://127.0.0.1:4200/config/all \
  | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["controller"]["comms"]))' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); d["rs485Port"]="/dev/serial0"; print(json.dumps(d))' \
  | curl -s -X PUT -H "Content-Type: application/json" --data-binary @- \
      http://127.0.0.1:4200/app/rs485Port
```

**Echoing every field is necessary here and still not sufficient.** The write
above sends the whole comms object, and njsPC *still* altered a field that was
sent unchanged: `screenlogic.password` went from `1234` to `""`. It also added
`portSettings.flowControl: false`, which is harmless normalisation.

The first reading of this was that the endpoint fails to round-trip whatever
you hand it. Reading the source is worse than that. `Comms.ts` `setPortAsync`
resets the whole block before it looks at the request at all:

```ts
if (portId === 0) {
    pdata.screenlogic = {
        connectionType: "local",
        systemName: "Pentair: 00-00-00",
        password: ""
    }
}
```

`data.screenlogic` is read back only under `if (pdata.type === 'screenlogic')`,
and this box is `type: 'local'`. So **every** `PUT /app/rs485Port` against port
0 destroys the ScreenLogic password, whatever the body says, and no amount of
echoing prevents it. Echo the rest of the object anyway — `pdata.mock` and
`pdata.type` are assigned unconditionally from the request, so omitting either
sets it `undefined` — but treat the ScreenLogic block as collateral you cannot
protect, and **diff the config before and after any write to this endpoint**.
`binding.js` documents the opposite trap for circuit writes, where omitting a
field silently sets it false; this is the same lesson from the other side.

None of it matters on this box &mdash; ScreenLogic is dormant, `systemName` was
already the placeholder `Pentair: 00-00-00`, njsPC's own `/app/screenlogic`
route is commented out, and `1234` is that feature's factory default. Somebody
running ScreenLogic for real loses a credential silently, so it is filed
upstream as
[njsPC#1236](https://github.com/tagyoureit/nodejs-poolController/issues/1236),
with the one-guard fix in
[njsPC#1237](https://github.com/tagyoureit/nodejs-poolController/pull/1237)
&mdash; `setPortAsync` already uses the guarded
`if (portId === 0 && !cfg.screenlogic)` form further down the same function,
so the patch only makes the two consistent. Until that lands, treat the
ScreenLogic block as collateral of any write to this endpoint.

**What "working" looks like before the bus exists.** njsPC opens the port, sees
nothing for `inactivityRetry` seconds, closes it and reopens:

```
Serial port: /dev/serial0 request to open successful 9600b 8-none-1
Inactivity timeout for 0 serial port /dev/serial0 after 10 seconds
Serial Port 0 - /dev/serial0 has been closed.
```

That cycle is the correct signal, not a fault. It says the port is real and
openable and nobody is talking, which is exactly true on a bench. It stops on
its own the moment a pump is on the other end.

**Once a pump is configured, it stops being quiet.** njsPC then has something
to say on the bus and says it — `requestPumpStatus` every few seconds,
`setDriveState` on every change — and each one fails against an absent
IntelliFlo:

```
warn:  Message aborted after 2 attempt(s): 165,0,96,33,6,1,10,1,55
error: Error sending setDriveState for IntelliFlo: Message aborted after 2 attempt(s)
```

Measured 28 August 2026: **1165 error lines an hour**, which buries anything
real in the journal and writes to the SD card for no purpose. This was the
foreseeable cost of pointing njsPC at `/dev/serial0` and it was dismissed at
the time; pointing it at a port it can actually open is what let it start
transmitting.

On a bench with no bus, turn the port off rather than the pump — the pump
config is wanted, the transmitting is not:

```bash
# read comms, flip `enabled`, send the whole object back
curl -s http://127.0.0.1:4200/config/all \
  | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["controller"]["comms"]))' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); d["enabled"]=False; print(json.dumps(d))' \
  | curl -s -X PUT -H "Content-Type: application/json" --data-binary @- \
      http://127.0.0.1:4200/app/rs485Port
```

njsPC closes the port and does not reopen it. Everything that does not need
the bus carries on: Nixie bodies, circuits, valves, schedules and egg timers
are internal, the supervisor's link stays up, and the relays keep being driven
&mdash; verified with `/health` reporting `njspc: true` throughout.

> **This must be undone before the bus is attached.** With
> `comms.enabled: false` njsPC will never talk to the pump, the chlorinator or
> anything else on RS-485, and the symptom is silence rather than an error —
> the worst kind of setting to forget. It is not yet on the supervisor's
> commissioning checklist.

### Give njsPC a heater

Without this the Heat screen is decorative. `heaterCall` is derived from
njsPC's `heatStatus`, the heat contacts follow `heaterCall`, and a body with
no heater configured reports `Off` for ever — so the call is accepted, the
intent succeeds, and CH4 never closes. The supervisor now raises a
commissioning warning for it rather than leaving you to find it with a meter.

```bash
curl -sS -X PUT -H "Content-Type: application/json" -d '{
  "id": 0,
  "type": "heatpump",
  "name": "Raypak",
  "body": "poolspa",
  "isActive": true,
  "heatingEnabled": true,
  "coolingEnabled": false
}' http://127.0.0.1:4200/config/heater
```

`id: 0` means *add* — Nixie heaters are assigned an id above 256, and the
response says which (`256` on this box). `body: "poolspa"` is one heater
serving both, which is the physical truth: one Raypak with two call terminals.
Leave `address` and any device binding unset — the heat pump is not on the
RS-485 bus and the contacts are the supervisor's to close, not REM's.

**Done, 28 August 2026.** Both bodies then report `heaterOptions.heatpump: 1`.

Two things this does *not* do, and they matter:

- It does not set a **heat mode** or a **setpoint** on either body. njsPC
  leaves both at `Off` / `0`, so `heatStatus` is still `Off`.
- It therefore does not, on its own, make any heat relay close.

Neither of those matters any more, and that is the point of the next section:
the heat contacts do not follow njsPC's heat status.

### Who closes the heat contacts

**The supervisor, both of them.** Decided 28 August 2026, after reading how
njsPC actually drives a heater here.

njsPC's Nixie heater is configured with no `connectionId` and no
`deviceBinding` — the same choice made for the valves — and in that case
`setHeaterStateAsync` assigns `hstate.isOn` and returns. It actuates nothing.
Wiring CH4 to `heatStatus` would be a physical contact following a simulation,
and it would give one Raypak two authorities that swap on a mode change njsPC
can trigger by itself, which is the split ADR-7 forbids.

So `heaterCall` is derived in `map.js` from this process's own state:

| contact | closes when | cut off by |
|---|---|---|
| CH5 spa heat | the spa is the active body | the heater's own thermostat, capped at 104 °F |
| CH4 pool heat | `poolHeatDemand`, set by the Heat screen | `targets.pool`, via `applyCutoff` |

Spa is implied by the mode because the 3-wire carries no temperature: the
contact only says *you may heat toward the spa setpoint*, and the Raypak
regulates from there. That is ADR-4 working as designed rather than a
shortcut.

**Nothing was given up.** `NixieHeatpump.getCooldownTime()` returns 0 —
*"There is no cooldown delay at this time for a heatpump"* — so njsPC's
`HeaterCooldownDelay` never constructs for this heater type and there was no
cooldown to lose. What njsPC's heatpump does have is a `minCycleTime`
short-cycle deferral, default 2 min, which we do not currently reimplement;
the Raypak has its own anti-short-cycle protection in firmware, and that is
the layer ADR-4 relies on anyway.

**`targets.spa` still does nothing**, exactly as before this change:
`applyCutoff` is pool-only. Cutting the spa call at our own target would fight
the heater's thermostat rather than help it — the heater is already holding
that temperature — so it stays display-only until there is a reason.

### The rest

- Install REM per its own documentation.
- Work through the equipment settings in `CLAUDE.md` under *Next up* — pump
  priming, Thermal Mode, `valveDelayTime`, the Spa egg timer, valve device
  bindings, and a configured pump. Several of these the supervisor now
  checks and reports; the rest are still on you.

---

## Not done, and known

- **No TLS.** The supervisor serves plain HTTP, so the password crosses the
  LAN readable by anything that can intercept traffic. Deferred deliberately;
  PRD §11 has the options and the reasoning.
- **Nothing de-energises the relays when software fails.** The systemd
  watchdog below restarts a wedged supervisor, and that is all it does. The
  card has no hardware watchdog — the I2C scan found one PCA9554-class
  expander at `0x27` and no microcontroller, whatever the product page says —
  and the expander latches, so a wedged, killed or rebooting Pi leaves every
  relay where it was. In the panel the HDR-60-5 feeds the HAT upstream of the
  Pi, so even pulling the Pi's power does not drop them. Recovery, not safety;
  `docs/architecture.md` has the failure table.

---

## Verified: the watchdog kills a wedged supervisor and it comes back

Enabled with a drop-in, because the pet arrives from a `systemd-notify` child
rather than from the main PID — with the default `NotifyAccess=main` systemd
would discard every ping and kill a perfectly healthy supervisor at 60 s:

```
# /etc/systemd/system/poolctl.service.d/watchdog.conf
[Service]
WatchdogSec=60
NotifyAccess=all
```

Tested 28 August 2026 by freezing the process outright — `kill -STOP` on the
main PID, which stops the pets without giving the supervisor any chance to
shut down tidily:

```
10:55:58  SIGSTOP, relay byte 0x40
10:56:49  poolctl.service: Watchdog timeout (limit 1min)!
10:56:49  Killing process 1681 (node) with signal SIGABRT
10:56:49  Main process exited, code=killed, status=6/ABRT
10:56:54  Scheduled restart job, restart counter is at 1
10:56:55  relays -> 0x00 (all off) — boot
10:56:55  njsPC link up
10:56:55  relays -> 0x40  REL3
```

Fifty-one seconds from the wedge to detection — the window is measured from
the last successful ping, not from the wedge, so anything up to 60 s is
expected on a 20 s cadence. Fifty-seven seconds from wedge to healthy again.

Two details worth keeping. **SIGABRT killed a stopped process**: Linux wakes a
`SIGSTOP`ped task to take a fatal signal, so the 15 s `TimeoutStopSec`
escalation to SIGKILL never ran — it died 13 ms after the signal. And **the
relays held `0x40` for the whole 51 s**, which is the latching behaviour above,
observed rather than argued.

### The other half: alive, and no longer thinking

A frozen process is the easy case. The condition in `evaluationHealth` was
written for the subtler one — a supervisor that still binds the port, still
answers HTTP and still holds every socket open, whose evaluation loop has
died. `kill -STOP` cannot produce that, so the supervisor can produce it on
demand: **`kill -USR2` makes every subsequent `evaluate()` throw**, and only a
restart clears it. There is no network path to it, deliberately.

`/health` gained a second field for the same reason. `ok: true` alone reports
a process, not a supervisor:

```
before   {"ok":true,"njspc":true,"thinking":true}
after    {"ok":true,"njspc":true,"thinking":false,
          "why":"last evaluation threw: fault injected by SIGUSR2"}
```

Run 28 August 2026:

```
11:53:00  kill -USR2, relay byte 0x40
11:53:13  watchdog: withholding the ping — last evaluation threw: ...
11:53:54  poolctl.service: Watchdog timeout (limit 1min)!  SIGABRT
11:53:59  restarted — relays 0x00 (boot), then 0x40
```

Thirteen seconds to notice (the watchdog ticks every 20 s), 54 s to the kill,
59 s to healthy. The withholding line appeared **exactly once** across the
whole minute, which is the "say it once" rule doing its job — the journal has
to explain the kill that follows, not bury it.

One thing this exposed. `evaluate()` is not the only caller of `publish()` —
the njsPC link publishes on every reconnect attempt — so **a phone goes on
receiving state frames from a supervisor that has stopped supervising**. The
stream never went quiet. That is why the state needed reporting somewhere a
human can read it, rather than being inferred from traffic; it is asserted in
`index.test.js` so nobody later "fixes" it by assuming silence.

---

## Verified on a reboot

Both services come back unattended, and the clock ordering holds:

```
time-sync.target reached   08:50:32
njspc + poolctl started    08:50:48
```

Sixteen seconds. That gap is the whole reason both units want
`time-sync.target` — without it they would start on the stale clock the Pi
boots with and compute schedules against the wrong day, silently. njsPC came
back bound to `127.0.0.1` only, the supervisor came back on the LAN behind
its password, and the session survived because sessions are signed rather
than stored.

**The UART change, verified 27 August 2026 after its own reboot:**

```
/dev/serial0 -> ttyAMA0        the PL011 is on the header, not the mini-UART
fuser /dev/serial0             nothing holding it; the console is off
hciconfig                      no adapter, so disable-bt took
i2cdetect -y 1                 0x27 still present; the overlay did not disturb I2C
njspc, poolctl                 both active, no failed units
```

Permissions are already right and need no step of their own: `njspc.service`
runs as the login user, that user is in `dialout`, and `/dev/ttyAMA0` is
`root:dialout 660`. Worth checking on a fresh image, because a port that
exists but cannot be opened fails in a way that looks like a wiring problem
and gets debugged at the equipment pad instead of on a desk.
