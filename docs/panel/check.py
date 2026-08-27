#!/usr/bin/env python3
"""Fail if index.html's figures are stale against plate.py.

emit.py renders the figures, but pasting them into index.html is a manual
step, and a manual step is the one remaining way Figures 1 and 4 can drift
from the geometry they are supposed to share. This closes that: it runs the
emitter and asserts each result appears verbatim in the page.

    python3 check.py        # from docs/panel/
"""
import subprocess, sys, pathlib

here = pathlib.Path(__file__).parent
subprocess.run([sys.executable, "emit.py"], cwd=here, check=True)

html = (here / "index.html").read_text()

# The plate body is a substring of the wired body, so a plain `in` test can be
# satisfied by a match inside the WRONG figure - Figure 1 could be stale and
# still pass. Locate the wired body first, blank its span, and require the
# plate body to survive somewhere else.
stale = []
wired = (here / "fig_wired.svg").read_text()
i = html.find(wired)
if i < 0:
    stale.append("fig_wired.svg")
    rest = html
else:
    rest = html[:i] + html[i + len(wired):]
if (here / "fig_plate.svg").read_text() not in rest:
    stale.append("fig_plate.svg")

for f in ("fig_plate.svg", "fig_wired.svg"):
    (here / f).unlink(missing_ok=True)

if stale:
    print("stale in index.html: " + ", ".join(stale), file=sys.stderr)
    print("run `python3 emit.py` and paste each into its <svg>.", file=sys.stderr)
    sys.exit(1)
print("figures match plate.py")
