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
stale = [f for f in ("fig1_portrait.svg", "fig4_portrait.svg")
         if (here / f).read_text() not in html]

for f in ("fig1_portrait.svg", "fig4_portrait.svg"):
    (here / f).unlink(missing_ok=True)

if stale:
    print("stale in index.html: " + ", ".join(stale), file=sys.stderr)
    print("run `python3 emit.py` and paste each into its <svg>.", file=sys.stderr)
    sys.exit(1)
print("figures match plate.py")
