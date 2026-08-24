# Bringing up the Pi

What has to happen on the box, in order, to go from a flashed card to a
controller the phones can use.

Written against a Pi 4 (2 GB, aarch64) running Pi OS Lite on Debian 13
trixie, bare: an OS, a hostname and an SSH key, and nothing else. Node,
njsPC and REM are all uninstalled, deliberately — njsPC in Nixie mode wants
its serial port and relay configuration, which arrive with the HAT.

Two things this file is **not**. It is not the equipment checklist: the
settings that live on the pump keypad and inside njsPC are in `CLAUDE.md`
under *Next up*, and several of them are now checked automatically by the
supervisor. And it is not a wiring guide — the 240 V side is an electrician's
job and in most places needs a permit.

Sections 1–4 can be done today. Section 5 waits for the HAT.

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

Debian 13 (trixie), which current Pi OS images are built on, packages Node
20. That satisfies the supervisor's `>=20`, so no third-party repository is
needed:

```bash
sudo apt update && sudo apt install -y nodejs npm
node -v
```

Prefer this over NodeSource. It is Debian-maintained, it gets security
updates with everything else on the box, and it keeps the Pi on the upstream
path — the same reasoning that puts njsPC and REM here rather than in a
container.

**The test suite needs Node 22 and the Pi does not.** Vitest's bundler calls
`styleText` with an array, which is Node 22+, so `npm test` will not run on
20. That is a development toolchain requirement, not a runtime one: the Pi
never runs the tests. Verified by running the supervisor itself on 20.12.2 —
njsPC link, state, schedules, commissioning checks and `passwd.js` all
behave.

Node is the only runtime dependency this repo adds to the Pi. The supervisor
is plain JavaScript with no build step, which is why the Pi never needs a
toolchain — see section 3.

---

## 3. The supervisor

Built on the laptop, copied as artifacts. The Pi runs; it does not build.

On the laptop. `$PI` is wherever you can SSH to the box — set it once:

```bash
export PI=pi@poolctl.local
```

```bash
npm run build
rsync -a --delete dist/ $PI:~/poolctl/dist/
rsync -a --exclude node_modules supervisor/ $PI:~/poolctl/supervisor/
```

On the Pi, install the two runtime dependencies — `ws` and
`socket.io-client`, both pure JavaScript, so nothing compiles:

```bash
cd ~/poolctl/supervisor && npm install --omit=dev
```

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

**The supervisor listens on all interfaces, unlike njsPC.** That is the
point of it: the phones talk to this and nothing else. It is the one process
on the box that is meant to be reachable, which is why it is the one with a
password.

Check it from a phone on the same network — `http://poolctl.local:4300` —
and confirm you get the sign-in screen rather than the app.

---

## 4. Deploying again

Every later deploy is the same two rsyncs plus a restart:

```bash
npm run build
rsync -a --delete dist/ $PI:~/poolctl/dist/
rsync -a --exclude node_modules supervisor/ $PI:~/poolctl/supervisor/
ssh $PI 'sudo systemctl restart poolctl'
```

`auth.json` and `state.json` live in the supervisor directory and are
excluded from the repo, so the rsync above leaves them alone — but check
that before adding `--delete` to the second one.

---

## 5. When the HAT arrives

njsPC and REM install here, on the upstream path, because both want the
serial port and the relay configuration.

- Install njsPC and REM per their own documentation.
- **Bind njsPC to loopback** before it ever starts on a live network:
  `web.servers.http.ip` = `127.0.0.1` in its `config.json`, then restart it.
  Its API needs no password and dashPanel bypasses every interlock the
  supervisor adds. The supervisor checks this by trying to reach njsPC on the
  Pi's own LAN address, so getting it wrong raises a warning on the Water
  screen rather than going unnoticed.
- Reach dashPanel over a tunnel instead of exposing it:
  `ssh -L 4200:localhost:4200 $PI`, then browse
  `http://localhost:4200`.
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
