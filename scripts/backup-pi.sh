#!/usr/bin/env bash
#
# Pull the Pi's irreplaceable configuration off the box, into a local git
# repository, and commit only when something changed.
#
# Resilience means surviving the SD card dying outright, which no filesystem
# strategy prevents. Almost everything on that card can be rebuilt from this
# repository and docs/pi-bringup.md. These cannot:
#
#   /opt/njspc/data/poolConfig.json   every circuit, pump speed, schedule, valve
#   /opt/njspc/config.json            njsPC's own settings: comms, interfaces
#   /var/lib/poolctl/state.json       programs, targets, the heater's setpoints
#
# Absolute paths since 11 September 2026, when both services moved to their
# own unprivileged users (docs/pi-bringup.md §5). The account this connects as
# reads them through membership of the `poolctl` and `njspc` groups.
#
# Deliberately not copied: auth.json, which is a password hash and a session
# secret that `passwd.js` regenerates, so spreading it buys nothing; and
# poolState.json, which is runtime state that rebuilds itself and would turn
# the history into noise.
#
# The one property that matters: **a backup never faithfully copies
# corruption.** Every file is parsed before it is accepted. A torn or empty
# file on the Pi is logged and the previous good copy is kept, rather than
# replaced by the broken one. njsPC's config.json can still be torn by a power
# cut — the atomic-write patch leaves it alone on purpose — so this is not
# theoretical.
#
# Pull, not push: nothing is installed on the Pi and no credential for this
# machine lives there. The cost is that it only runs while this machine is on
# and on the same network, which is also when config gets edited.
#
# Every run leaves one line, so the log doubles as a record of when the Pi was
# and was not reachable — which, in September 2026, is exactly the thing
# nobody could establish after the fact. It separates a name that does not
# resolve, a box that does not answer, and a key this machine cannot use,
# because those three looked identical then.
#
#   PI=<user>@poolctl.local ./scripts/backup-pi.sh
#   PI=<user>@poolctl.local BACKUP_DIR=~/somewhere ./scripts/backup-pi.sh
#
# The backup repository is local and must never be pushed anywhere public:
# it holds configuration, and njsPC's may carry interface credentials.

set -euo pipefail

PI="${PI:-}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/poolctl-backups}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)

if [ -z "$PI" ]; then
  echo "Usage: PI=<user>@poolctl.local $0" >&2
  exit 2
fi

# remote path : path inside the backup repository
FILES=(
  "/opt/njspc/data/poolConfig.json:njspc/poolConfig.json"
  "/opt/njspc/config.json:njspc/config.json"
  "/var/lib/poolctl/state.json:supervisor/state.json"
)

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*"; }

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
cd "$BACKUP_DIR"

if [ ! -d .git ]; then
  git init -q
  # A local identity, so nothing here is ever attributed to a real address.
  git config user.name "poolctl backup"
  git config user.email "backup@poolctl.invalid"
  log "initialised $BACKUP_DIR"
fi

# Three different failures, told apart, because on 11 September 2026 they
# could not be: the Pi was unreachable by name, and nobody could say whether
# it was off the network, on it with mDNS gone, or fine with SSH refusing.
# Each gets its own line, so this log answers that question next time.
host="${PI#*@}"
if [[ ! "$host" =~ ^[0-9.]+$ ]]; then
  addr="$(dscacheutil -q host -a name "$host" 2>/dev/null | awk '/ip_address/ { print $2; exit }')"
  if [ -z "$addr" ]; then
    log "name does not resolve: $host (mDNS, or the Pi is off the network)"
    exit 0
  fi
else
  addr="$host"
fi
if ! nc -z -G 8 "$addr" 22 2>/dev/null; then
  if [ "$addr" = "$host" ]; then
    log "no answer on port 22: $addr (the box or sshd is down)"
  else
    log "no answer on port 22: $host at $addr (the name resolves; the box or sshd is down)"
  fi
  exit 0
fi
if ! ssh "${SSH_OPTS[@]}" "$PI" true 2>/dev/null; then
  # Not the Pi's fault. Most often the key is passphrase-protected and not in
  # this machine's agent — which is what happens after this machine reboots.
  log "REACHABLE, BUT SSH REFUSED: $PI at $addr — is the key loaded on this machine?"
  exit 1
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
problems=0

for pair in "${FILES[@]}"; do
  remote="${pair%%:*}"
  kept="${pair#*:}"
  mkdir -p "$stage/$(dirname "$kept")"

  if ! scp -q "${SSH_OPTS[@]}" "$PI:$remote" "$stage/$kept" 2>/dev/null; then
    log "missing on the Pi: $remote"
    problems=1
    continue
  fi

  # utf-8-sig: njsPC writes some of its JSON with a byte-order mark.
  if ! python3 -c 'import json, sys; json.load(open(sys.argv[1], encoding="utf-8-sig"))' \
       "$stage/$kept" 2>/dev/null; then
    log "NOT VALID JSON on the Pi, previous backup kept: $remote"
    problems=1
    continue
  fi

  mkdir -p "$(dirname "$kept")"
  cp "$stage/$kept" "$kept"
  chmod 600 "$kept"
done

git add -A
if git diff --cached --quiet; then
  log "reachable, no change"
else
  git commit -q -m "Backup $(date '+%Y-%m-%d %H:%M')"
  log "committed $(git rev-parse --short HEAD): $(git show --stat --format= HEAD | tail -1)"
fi

exit "$problems"
