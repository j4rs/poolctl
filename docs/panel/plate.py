# -*- coding: utf-8 -*-
"""Portrait plate geometry, shared by Figure 1 (layout) and Figure 4 (wiring).

The enclosure mounts portrait - forced by the mount space - so the plate is
11.18 in wide by 15.12 in tall. Entries split across two faces: low voltage on
the left side, line voltage on the bottom. Ten entries do not fit on one
12.99 in face, and the split puts the two classes through separate walls.

One source for both drawings so they cannot drift apart.
"""
PPI  = 43.0
PX, PY = 110, 24
PW, PH = round(11.18*PPI), round(15.12*PPI)      # 481 x 650
VW, VH = 700, 760

BANDS = [("band-lv",   38, 200, 160, "LOGIC &middot; 5 VDC / SIGNAL"),
         ("band-24",  252, 170, 160, "24 VAC"),
         ("band-line",436, 224, 330, "120 VAC &middot; ELECTRICIAN")]

PARTS = {
 "pihat": (378, 58,196,116,"part-lv",  "Pi 4 + 8-Relay HAT","CH1-8 and RS-485 on HAT"),
 "hdr":   (148, 58, 92,152,"part-lv",  "HDR-60-5",          "5 V 6.5 A"),
 "tb":    (148,296,324, 62,"part-24",  "DIN rail B &middot; 8 in","1-4 hot &middot; 5-10 valves &middot; 11 coil &middot; 12-15 common"),
 "lt":    (148,452,250, 60,"part-line","Line terminals &middot; rail C","L . N &mdash; PE bar bolts to the plate"),
 "xfmr":  (148,530,176,116,"part-line","Transformer",       "TR100VA001 . 100 VA"),
 "cont":  (452,530,122,116,"part-line","Contactor",         "C25CNB130T"),
}

# Rails are drawn behind the parts. Rail A carries the HDR-60-5 and extends
# past it so the spare capacity is visible; rail B is the terminal strip and is
# drawn as its own block below.
RAILS = [(140, 150, 228, "DIN rail A &middot; 5 in"),
         (138, 327, 344, ""),
         (140, 482, 268, "")]        # rail C, under the line terminals

LX, BY = 92, 692
GL_LEFT = [("CH1",150,9),("CH2",206,9),("CH3",262,9),
           ("HTR",300,9),("485-P",352,9),("485-C",398,9)]
GL_BOT  = [("vent",200,7),("IN",360,13),("BLW",500,13),("LT",570,9)]

def runs():
    R=[]
    def r(i,c,l,p,lab=None): R.append(dict(id=i,cls=c,label=l,pts=p,lab=lab))
    # Actuators land ALONG the strip, not on its left end - that end carries the
    # end bracket and has no clamp. They run down the left margin clear of the
    # HDR, then drop onto the strip's top face at three separate blocks.
    # Two lane rules, and they pull in opposite directions: at the gland end the
    # highest entry takes the outermost riser, and at the strip end that same
    # cable must turn first. Hence rx descending while ty ascends.
    for k,(gy,rx,ty,tx) in enumerate(((150,142,264,230),(206,134,272,200),(262,126,280,170))):
        r("act%d"%(k+1),"24","",[(LX,gy),(rx,gy),(rx,ty),(tx,ty),(tx,296)])
    # heater and the two RS-485 cables share the right margin. Ordering rule:
    # further-right riser takes the lower cross-lane, so none crosses another.
    r("485-c","lv","RS-485 to cell",[(LX,398),(126,398),(126,382),(542,382),(542,174)],(300,376))
    r("485-p","lv","RS-485 to pump",[(LX,352),(126,352),(126,404),(554,404),(554,174)],(300,398))
    r("heater","dry","heater 3-wire, dry",[(LX,300),(118,300),(118,426),(566,426),(566,174)],(300,420))
    # light: bottom face, up the outermost right lane to CH7 on the HAT
    r("light","line","light loop to CH7",[(570,BY),(570,666),(578,666),(578,160),(574,160)],(462,686))
    r("feed","line","supply ~2.6 A",[(360,BY),(360,512)],(366,600))
    r("blow","line","blower loop",[(500,BY),(500,646)],(506,666))
    r("xpri","line","primary",[(250,512),(250,530)],(300,526))
    r("sec","24","24 V secondary",[(170,530),(170,522),(130,522),(130,370),(170,370),(170,358)],(176,524))
    r("hdrpri","line","L/N to 5 V supply",[(300,452),(300,440),(122,440),(122,240),(200,240),(200,210)],(206,236))
    r("5v","lv","5 V to HAT",[(240,120),(378,120)],(268,114))
    for k,x in enumerate((384,404,424)): r("ch%d"%(k+1),"24","",[(x,174),(x,296)])
    r("ch6","24","CH6",[(444,174),(444,296)],(450,240))
    r("coil","24","TB5 to coil",[(464,358),(464,530)],(470,470))
    return R
