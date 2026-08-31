# -*- coding: utf-8 -*-
"""Swap the astrophage bokeh colour ramp across all five pages.

    python set-ramp.py red      Project Hail Mary crimson
    python set-ramp.py gold     fully matched to the logo
    python set-ramp.py hybrid   cream-gold highlights, red-rust depths

The ramp is five anchor colours, ordered from the hot core of a distant
mote to the deep base of a big near one. They get interpolated into 20
stops at runtime, so only these five need editing.
"""
import io, os, re, sys

BASE = os.path.dirname(os.path.abspath(__file__))
PAGES = ["index.html", "helioscale.html", "lostinorbit.html", "launchx.html", "terrafab.html"]

RAMPS = {
    "red":    [[255,219,209],[255,138,128],[255,92,110],[214,46,82],[156,26,58]],
    "gold":   [[255,250,224],[247,231,168],[228,180,108],[168,124,66],[110,78,46]],
    "hybrid": [[255,246,214],[250,212,150],[236,150,110],[196,74,78],[150,34,56]],
}

want = sys.argv[1].lower() if len(sys.argv) > 1 else ""
if want not in RAMPS:
    print(__doc__)
    print("current options: " + ", ".join(RAMPS))
    raise SystemExit(1)

rows = ",".join("[%d,%d,%d]" % tuple(c) for c in RAMPS[want])
new = "var RAMP_ANCHORS = [" + rows + "];"
pattern = re.compile(r"var RAMP_ANCHORS = \[.*?\];", re.S)

for name in PAGES:
    p = os.path.join(BASE, name)
    t = io.open(p, encoding="utf-8").read()
    if not pattern.search(t):
        print("%-18s RAMP_ANCHORS not found - skipped" % name)
        continue
    io.open(p, "w", encoding="utf-8").write(pattern.sub(new, t, count=1))
    print("%-18s -> %s" % (name, want))

print("\nDone. Reload the page to see it.")
print("Note: the published Artifact does not update on its own - ask Claude to republish.")
