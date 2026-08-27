"""The 24 VAC network on DIN rail B, block by block.

Separate from plate.py on purpose. plate.py is a plan view in real millimetres.
This is a connection map: block order and heights are chosen for legibility, so
anything positional here is a lie about the panel and a truth about the wiring.
Figure 5 is where the cables actually run.

Both buses are drawn as ONE line with taps, because that is what they are: a
comb bridges three blocks into a single node. Every individual conductor is
still drawn - each tap IS a conductor. Only the shared node is collapsed, and
the first attempt at drawing it as nine separate runs produced seven crossings
with no lane ordering that removes them: the spans stagger, so the up-risers
want lanes ordered one way and the down-risers the other. That contradiction is
the reason for this representation, not laziness.
"""
import sys, itertools

# ---- the strip -------------------------------------------------------------
BX, BW, BGAP = 200, 46, 5
BY0, BY1, N  = 330, 390, 15
bx = lambda i: BX + (i-1)*(BW+BGAP)
bc = lambda i: bx(i) + BW/2
lc = lambda i: bx(i) + 11          # lower/left clamp
rc = lambda i: bx(i) + BW - 11     # upper/right clamp

COMBS  = [(1,4), (12,15)]            # 1-4 hot bus, 12-15 common bus
GROUPS = [(1,4,"HOT BUS"), (5,10,"SWITCHED PAIRS"), (11,11,"COIL"),
          (12,15,"COMMON BUS")]

# ---- relays, each directly over the blocks it lands on ----------------------
RY0, RY1 = 150, 250
RELAYS = [("CH1", 5, 6), ("CH2", 7, 8), ("CH3", 9, 10), ("CH6", 11, None)]
COMY, HOTBUS_Y = 180, 110

# ---- what the strip feeds --------------------------------------------------
FY0, FY1 = 540, 600
# the contactor sits left of block 12 so the common bus risers clear it
FIELD = [("g1", 400, 490, "gland 1", "intake",  5, 6),
         ("g2", 500, 590, "gland 2", "return",  7, 8),
         ("g3", 596, 686, "gland 3", "bypass",  9, 10),
         ("kt", 694, 764, "contactor", "blower", 11, None)]
XF        = (170, 310, 540, 620)
COMBUS_Y  = 650
COMBUS_X  = 0                         # unused; risers are per block now
HOT_IN_X  = 212                       # transformer hot -> block 1

CW = {"lbl-sm":6.31, "lbl-t":6.61, "lbl":7.05, "lbl-band":7.35}
FS = {"lbl-sm":10.5, "lbl-t":11.0, "lbl":13.0, "lbl-band":10.5}
VB = (130, 60, 890, 660)

out, late, rects, texts, segs = [], [], [], [], []
def rect(x0,y0,x1,y1,cls,extra=""):
    rects.append((x0,y0,x1,y1,cls))
    out.append('<rect x="%g" y="%g" width="%g" height="%g" class="%s"%s/>'
               % (x0,y0,x1-x0,y1-y0,cls,extra))
def wire(pts, cls="w4-24"):
    for a,b in zip(pts, pts[1:]): segs.append((a,b))
    out.append('<path d="%s" class="%s"/>'
               % (" ".join(("M" if i==0 else "L")+" %g %g"%p for i,p in enumerate(pts)), cls))
def text(x,y,s,cls="lbl-sm",anchor="start",bg=False):
    w = len(s)*CW[cls]; fs = FS[cls]
    x0 = x if anchor=="start" else (x-w/2 if anchor=="middle" else x-w)
    texts.append((x0, y-fs*.78, x0+w, y+fs*.24, s, bg))
    a = '' if anchor=="start" else ' text-anchor="%s"'%anchor
    dest = late if bg else out       # knocked-out labels paint last, over the wires
    if bg:
        dest.append('<rect x="%g" y="%g" width="%g" height="%g" fill="var(--ground)"/>'
                    % (x0-4, y-fs*.86, w+8, fs*1.2))
    dest.append('<text x="%g" y="%g"%s class="%s">%s</text>'%(x,y,a,cls,s))
def dot(x,y,r=3.5,fill="var(--v24)",ring=False):
    out.append('<circle cx="%g" cy="%g" r="%g" fill="%s"%s/>'
               %(x,y,r,fill,' stroke="var(--muted)" stroke-width="1"' if ring else ""))

# ---- strip, with the comb drawn INSIDE the blocks it bridges ----------------
for i in range(1, N+1):
    rect(bx(i), BY0, bx(i)+BW, BY1, "part-24")
    text(bc(i), BY0+16, str(i), "lbl-t", "middle")
for a,b in COMBS:
    rect(bx(a)+6, 356, bx(b)+BW-6, 372, "part-24", ' opacity="0.9"')
for a,b,s in GROUPS:
    text((bx(a)+bx(b)+BW)/2, 412, s, "lbl-band", "middle", bg=True)
text(bx(1)-10, BY0+22, "rail B", "lbl-sm", "end")
text((bx(1)+bx(3)+BW)/2, 428, "one node · 4-way comb", "lbl-sm", "middle", bg=True)
text((bx(11)+bx(13)+BW)/2, 428, "one node · 4-way comb", "lbl-sm", "middle", bg=True)

# ---- relays ----------------------------------------------------------------
for (rid, nc, no) in RELAYS:
    x0, x1 = bx(nc), bx(no if no else nc)+BW
    rect(x0, RY0, x1, RY1, "part-lv")
    text((x0+x1)/2, RY0+18, rid, "lbl", "middle")
    dot(x0, COMY); text(x0+8, COMY+16, "COM", "lbl-sm")
    wire([(x0, HOTBUS_Y), (x0, COMY)])                       # tap off the hot bus
    dot(x0, HOTBUS_Y)
    for name, blk in (("N.C.", nc), ("N.O.", no)):
        if blk is None: continue
        dot(bc(blk), RY1); text(bc(blk), RY1-12, name, "lbl-sm", "middle")
        wire([(bc(blk), RY1), (bc(blk), BY0)])
text(bx(11)+BW+10, RY0+66, "N.C. unused", "lbl-sm")

# One riser per block. Four COM conductors all head for the HAT, so each takes
# its own block and its own upper clamp - drawing a single riser for the group
# hid exactly the fact that forces the block count.
wire([(rc(1), HOTBUS_Y), (bx(11), HOTBUS_Y)])
for i in (1, 2, 3, 4):
    x = rc(1) if i == 1 else bc(i)
    wire([(x, BY0), (x, HOTBUS_Y)]); dot(x, HOTBUS_Y)
text(rc(1)+10, HOTBUS_Y-9, "HOT BUS · one node · one conductor out of each block", "lbl-sm")

# ---- field -----------------------------------------------------------------
for (fid, x0, x1, lab, sub, ba, bb) in FIELD:
    rect(x0, FY0, x1, FY1, "part-24")
    text((x0+x1)/2, FY0+26, lab, "lbl-t", "middle")
    text((x0+x1)/2, FY0+43, sub, "lbl-sm", "middle")
    for blk, col in ((ba, "#f2f2f2"), (bb, "#c0392b")):
        if blk is None: continue
        wire([(bc(blk), BY1), (bc(blk), FY0)])
        dot(bc(blk), FY0, 5, col, True)
rect(XF[0], XF[2], XF[1], XF[3], "part-line")
text((XF[0]+XF[1])/2, XF[2]+24, "TR100VA001", "lbl-t", "middle")
text((XF[0]+XF[1])/2, XF[2]+41, "24 VAC secondary", "lbl-sm", "middle")
text((XF[0]+XF[1])/2, XF[2]+58, "100 VA · Class 2", "lbl-sm", "middle")

wire([(HOT_IN_X, BY1), (HOT_IN_X, XF[2])])                   # transformer hot in
text(HOT_IN_X-6, (BY1+XF[2])/2, "hot", "lbl-sm", "end")

# common bus: five conductors on four blocks - block 12 carries two, the
# transformer common on its lower clamp and gland 1's black on its upper
wire([(lc(12), COMBUS_Y), (bc(15), COMBUS_Y)])
wire([(270, COMBUS_Y), (lc(12), COMBUS_Y)])
for x in (lc(12), rc(12), bc(13), bc(14), bc(15)):
    wire([(x, BY1), (x, COMBUS_Y)]); dot(x, COMBUS_Y)
for (fid, x0, x1, lab, sub, ba, bb) in FIELD:
    tap = (x0+x1)/2
    wire([(tap, COMBUS_Y), (tap, FY1)]); dot(tap, COMBUS_Y)
    dot(tap, FY1, 5, "#1a1a1a", True)
wire([(270, COMBUS_Y), (270, XF[3])]); dot(270, COMBUS_Y)
text(290, COMBUS_Y+18, "COMMON BUS · one node · three actuator blacks, the coil return, and the transformer common", "lbl-sm")

for i,(col, lab) in enumerate((("#f2f2f2","white  \u2192 N.C."),
                               ("#c0392b","red    \u2192 N.O."),
                               ("#1a1a1a","black  \u2192 common"))):
    y = 170 + i*22
    dot(850, y-4, 5, col, True); text(864, y, lab, "lbl-sm")

svg = ('<svg viewBox="%d %d %d %d" role="img" aria-label="%s">\n  %s\n</svg>' % (
    VB[0], VB[1], VB[2], VB[3],
    "Connection map of the 24 volt AC network on DIN rail B. Fifteen terminal "
    "blocks in a row. Blocks 1 to 4 are the hot bus, bridged into one node by a "
    "four-way comb, and one conductor leaves each of them for the COM screw of "
    "relay channels 1, 2, 3 and 6 - four conductors all heading to the HAT, so "
    "four blocks. Blocks 5 to 10 are the six switched conductors of the three "
    "valve actuators, two blocks per actuator. Block 11 is the blower contactor "
    "coil. Blocks 12 to 15 are the common bus, bridged by a second four-way comb. "
    "The transformer's hot leg lands on block 1 and its common leg on block 12. "
    "Each relay drops its N.C. and N.O. contacts onto its own pair of blocks, "
    "which leave through glands 1 to 3 as the white and red conductors of each "
    "actuator cable. The three black conductors return to the common bus, along "
    "with the second leg of the contactor coil.",
    "\n  ".join(out + late)))

# ---- invariants ------------------------------------------------------------
fail = []
X0, Y0, X1, Y1 = VB[0], VB[1], VB[0]+VB[2], VB[1]+VB[3]
for t in texts:
    if t[0]<X0 or t[1]<Y0 or t[2]>X1 or t[3]>Y1: fail.append("TEXT OUT OF FRAME %r"%t[4])
for r in rects:
    if r[0]<X0 or r[1]<Y0 or r[2]>X1 or r[3]>Y1: fail.append("RECT OUT OF FRAME %s"%r[4])
ins  = lambda t,r: t[0]>=r[0] and t[2]<=r[2] and t[1]>=r[1] and t[3]<=r[3]
disj = lambda t,r: t[2]<=r[0] or t[0]>=r[2] or t[3]<=r[1] or t[1]>=r[3]
for t in texts:
    for r in rects:
        if not ins(t,r) and not disj(t,r): fail.append("TEXT STRADDLES %s: %r"%(r[4],t[4]))
for a,b in itertools.combinations(texts,2):
    if not(a[2]<=b[0] or a[0]>=b[2] or a[3]<=b[1] or a[1]>=b[3]):
        fail.append("LABELS OVERLAP %r <-> %r"%(a[4],b[4]))
def thru(a,b,r):
    e=1.0; rx0,ry0,rx1,ry1 = r[0]+e,r[1]+e,r[2]-e,r[3]-e
    if abs(a[1]-b[1])<.01:
        lo,hi=sorted((a[0],b[0])); return ry0<a[1]<ry1 and lo<rx1 and hi>rx0
    lo,hi=sorted((a[1],b[1]));     return rx0<a[0]<rx1 and lo<ry1 and hi>ry0
for a,b in segs:
    for r in rects:
        whole = (r[0]-.5<=min(a[0],b[0]) and max(a[0],b[0])<=r[2]+.5
             and r[1]-.5<=min(a[1],b[1]) and max(a[1],b[1])<=r[3]+.5)
        if not whole and thru(a,b,r): fail.append("WIRE THROUGH %s: %s->%s"%(r[4],a,b))
# a wire struck through a label is invisible to a box-vs-text check, and the
# first render had two of them
for a,b in segs:
    lo_x,hi_x = sorted((a[0],b[0])); lo_y,hi_y = sorted((a[1],b[1]))
    for t in texts:
        if hi_x < t[0] or lo_x > t[2] or hi_y < t[1] or lo_y > t[3]: continue
        if t[5]: continue                      # has a knockout plate
        fail.append("WIRE THROUGH LABEL %r"%t[4])

def cross(s1,s2):
    (a,b),(c,d) = s1,s2
    hz = lambda p,q: abs(p[1]-q[1])<.01
    if hz(a,b)==hz(c,d): return False
    (h1,h2),(v1,v2) = ((a,b),(c,d)) if hz(a,b) else ((c,d),(a,b))
    xlo,xhi = sorted((h1[0],h2[0])); ylo,yhi = sorted((v1[1],v2[1]))
    return xlo+.01 < v1[0] < xhi-.01 and ylo+.01 < h1[1] < yhi-.01
for s1,s2 in itertools.combinations(segs,2):
    if cross(s1,s2): fail.append("CROSSING %s x %s"%(s1,s2))

print("blocks %d  rects %d  texts %d  segments %d"%(N,len(rects),len(texts),len(segs)))
if fail:
    for f in sorted(set(fail))[:20]: print("  FAIL", f)
    print("  (%d total)"%len(set(fail))); sys.exit(1)
open("fig_rail.svg","w").write(svg)
print("clean: 0 crossings, nothing through a part, no label collisions")
