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

Want `System clock synchronized: yes` and a sensible local time. Observed on
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

From the laptop. `$PI` is wherever you can SSH to the box:

```bash
export PI=pi@poolctl.local
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
PI=j4rs@poolctl.local ./scripts/deploy.sh
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
User=j4rs
WorkingDirectory=/home/j4rs/njspc
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
- **No watchdog.** Nothing de-energises the relays when njsPC or the
  supervisor is unhealthy. `docs/architecture.md` carries it as not built.
- **No automatic timezone check.** The supervisor could compare njsPC's idea
  of local time against its own and say so, the way it does for the spa egg
  timer. It does not yet, which is why section 1 leads with it.

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
