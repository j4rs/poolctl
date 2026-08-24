#!/usr/bin/env bash
#
# Build here, ship artifacts there, restart, prove it came back.
#
# The Pi runs; it does not build. This is the whole of that decision made
# executable: `npm run build` happens on the machine with a toolchain, and
# the Pi receives a dist directory, plain-JavaScript supervisor sources, and
# two pure-JS dependencies.
#
#   ./scripts/deploy.sh                 # deploy to $PI
#   PI=pi@poolctl.local ./scripts/deploy.sh
#   ./scripts/deploy.sh --dry-run       # show what would change, touch nothing
#
# Never copies auth.json or state.json. Those are the Pi's own — a password
# and a set of preferences that exist only there — and a deploy that
# overwrote them would sign the household out and reset their targets every
# time somebody shipped a CSS change.

set -euo pipefail

PI="${PI:-}"
DRY_RUN=""
REMOTE_DIR="${REMOTE_DIR:-~/poolctl}"
SERVICE="${SERVICE:-poolctl}"

for arg in "$@"; do
  case "$arg" in
    # -v so a dry run actually shows what it would move; silent output
    # from a dry run tells you nothing and invites skipping it.
    --dry-run) DRY_RUN="--dry-run -v" ;;
    *) PI="$arg" ;;
  esac
done

if [[ -z "$PI" ]]; then
  echo "Usage: PI=pi@poolctl.local $0 [--dry-run]" >&2
  echo "   or: $0 pi@poolctl.local" >&2
  exit 2
fi

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------

say "Checking $PI"
if ! ssh -o ConnectTimeout=8 -o BatchMode=yes "$PI" true 2>/dev/null; then
  echo "Cannot reach $PI over SSH." >&2
  echo "Is the Pi powered on and on this network? Try: ping ${PI#*@}" >&2
  exit 1
fi

remote_node="$(ssh "$PI" 'command -v node >/dev/null && node -v || echo missing')"
if [[ "$remote_node" == "missing" ]]; then
  echo "Node is not installed on the Pi." >&2
  echo "See docs/pi-bringup.md section 2 — Pi OS ships Node 18, which is" >&2
  echo "below the supervisor's >=20, so it needs NodeSource." >&2
  exit 1
fi
# Compare against the engines field rather than a number written twice.
want="$(node -p "require('./supervisor/package.json').engines.node.replace(/[^0-9]/g,'')")"
have="${remote_node#v}"; have="${have%%.*}"
if (( have < want )); then
  echo "Pi has Node $remote_node; the supervisor needs >=$want." >&2
  exit 1
fi
echo "  node $remote_node — ok"

say "Building here"
npm run build

# rsync creates only the final path component, so a first deploy onto a bare
# Pi fails on the nested directory. --mkpath would do it but is rsync 3.2.3+
# on both ends; mkdir is portable and obvious.
ssh "$PI" "mkdir -p $REMOTE_DIR/dist $REMOTE_DIR/supervisor $REMOTE_DIR/src/lib"

# --delete on dist is safe and wanted: it is purely generated, and stale
# hashed asset filenames would otherwise accumulate forever.
say "Copying the built client"
rsync -a $DRY_RUN --delete \
  dist/ "$PI:$REMOTE_DIR/dist/"

# No --delete on the supervisor, and the excludes are load-bearing. This
# directory is where the Pi keeps auth.json and state.json.
say "Copying the supervisor"
rsync -a $DRY_RUN \
  --exclude 'node_modules' \
  --exclude 'auth.json' \
  --exclude 'state.json' \
  --exclude '*.test.js' \
  --exclude 'harness.test-utils.js' \
  supervisor/ "$PI:$REMOTE_DIR/supervisor/"

if [[ -n "$DRY_RUN" ]]; then
  say "Dry run — nothing was changed on the Pi"
  exit 0
fi

# The supervisor imports the shared spec across the repo boundary —
# `../src/lib/sequences.js` and the constants in `programs.js`. That is
# deliberate: sequences.js is the executable spec and the rule is that there
# is one copy of it, not one per process.
#
# Ships the whole directory rather than the two files actually imported.
# Sixty kilobytes of client code that never executes is a cheaper mistake
# than a hand-maintained file list, which is how the first deploy to this Pi
# died — ERR_MODULE_NOT_FOUND at boot, on a box with nothing to tell.
say "Copying the shared spec"
rsync -a $DRY_RUN \
  --exclude '*.test.js' \
  --exclude '*.test.jsx' \
  src/lib/ "$PI:$REMOTE_DIR/src/lib/"

say "Installing runtime dependencies"
ssh "$PI" "cd $REMOTE_DIR/supervisor && npm install --omit=dev --no-audit --no-fund"

say "Restarting $SERVICE"
if ssh "$PI" "systemctl list-unit-files ${SERVICE}.service" >/dev/null 2>&1; then
  ssh "$PI" "sudo systemctl restart $SERVICE"
else
  echo "No $SERVICE service on the Pi yet — see docs/pi-bringup.md section 3." >&2
  echo "Files are in place; nothing is running them." >&2
  exit 1
fi

say "Checking it came back"
port="$(ssh "$PI" "systemctl show -p Environment --value $SERVICE" | tr ' ' '\n' | sed -n 's/^PORT=//p')"
port="${port:-4300}"
for i in $(seq 1 20); do
  if health="$(ssh "$PI" "curl -fsS --max-time 3 http://127.0.0.1:$port/health" 2>/dev/null)"; then
    echo "  $health"
    # A supervisor that is up but cannot see njsPC is a real state, not a
    # failed deploy — say so rather than failing.
    case "$health" in
      *'"njspc":false'*) echo "  note: the supervisor is up but njsPC is unreachable" ;;
    esac
    say "Deployed"
    exit 0
  fi
  sleep 1
done

echo "The service did not answer /health within 20s." >&2
echo "Look at: ssh $PI 'journalctl -u $SERVICE -n 50 --no-pager'" >&2
exit 1
