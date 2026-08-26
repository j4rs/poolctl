# -*- coding: utf-8 -*-
exec(open("plate.py").read())
HR=4.5
CLS={"line":"w4-line","24":"w4-24","lv":"w4-lv","dry":"w4-dry"}
SRC={"line":"w-src-line","24":"w-src-24","lv":"w-src","dry":"w-src"}

def segs(p): return [(p[i],p[i+1]) for i in range(len(p)-1)]

def shell(with_runs):
    o=[]
    o.append('<rect x="%d" y="%d" width="%d" height="%d" rx="6" class="plate-bg"/>'%(PX,PY,PW,PH))
    for cls,y,h,lx,label in BANDS:
        o.append('<rect x="%d" y="%d" width="%d" height="%d" rx="5" class="%s"/>'%(PX+14,y,PW-28,h,cls))
        o.append('<text x="%d" y="%d" class="lbl-band">%s</text>'%(PX+lx,y+16,label))
    for x,y,w,label in RAILS:
        o.append('<line x1="%d" y1="%d" x2="%d" y2="%d" class="rail"/>'%(x,y,x+w,y))
        if label:
            o.append('<text x="%d" y="%d" class="lbl-sm">%s</text>'%(x+108,y+18,label))
    for k,(x,y,w,h,cls,t1,t2) in PARTS.items():
        o.append('<rect x="%d" y="%d" width="%d" height="%d" rx="4" class="%s"/>'%(x,y,w,h,cls))
        o.append('<text x="%d" y="%d" class="lbl">%s</text>'%(x+12,y+22,t1))
        o.append('<text x="%d" y="%d" class="lbl-sm">%s</text>'%(x+12,y+40,t2))
    for lab,y,r in GL_LEFT:
        o.append('<circle cx="%d" cy="%d" r="%d" class="gland"/>'%(LX,y,r))
        o.append('<text x="%d" y="%d" class="dim-t" text-anchor="end">%s</text>'%(LX-14,y+4,lab))
    for lab,x,r in GL_BOT:
        o.append('<circle cx="%d" cy="%d" r="%d" class="%s"/>'%(x,BY,r,"gland" if lab=="vent" else "gland-line"))
        o.append('<text x="%d" y="%d" class="dim-t" text-anchor="middle">%s</text>'%(x,BY+24,lab))
    o.append('<text x="%d" y="%d" class="dim-t" text-anchor="end">LEFT FACE</text>'%(LX-14,110))
    o.append('<text x="%d" y="%d" class="dim-t">BOTTOM FACE</text>'%(PX,BY+44))
    o.append('<text x="%d" y="%d" class="dim-t" text-anchor="middle">11.18 in</text>'%(PX+PW//2,PY-8))
    o.append('<text x="%d" y="%d" class="dim-t" transform="rotate(-90 %d %d)" text-anchor="middle">15.12 in</text>'%(PX+PW+22,PY+PH//2,PX+PW+22,PY+PH//2))
    return o

def wiring():
    R=runs()
    hops={}
    for i in range(len(R)):
        for j in range(len(R)):
            if i==j: continue
            for si,(a,b) in enumerate(segs(R[i]["pts"])):
                if a[1]!=b[1]: continue
                for c,d in segs(R[j]["pts"]):
                    if c[0]!=d[0]: continue
                    vx,y0,y1=c[0],min(c[1],d[1]),max(c[1],d[1])
                    hy,x0,x1=a[1],min(a[0],b[0]),max(a[0],b[0])
                    if x0<vx<x1 and y0<hy<y1: hops.setdefault((i,si),[]).append(vx)
    out=[]
    for ri,r in enumerate(R):
        p=r["pts"]; d=["M %g %g"%p[0]]
        for si,(a,b) in enumerate(segs(p)):
            if a[1]==b[1] and (ri,si) in hops:
                fwd=b[0]>a[0]
                for hx in sorted(set(hops[(ri,si)]),reverse=not fwd):
                    if not(min(a[0],b[0])<hx<max(a[0],b[0])): continue
                    if fwd:
                        d.append("L %g %g"%(hx-HR,a[1])); d.append("A %g %g 0 0 1 %g %g"%(HR,HR,hx+HR,a[1]))
                    else:
                        d.append("L %g %g"%(hx+HR,a[1])); d.append("A %g %g 0 0 0 %g %g"%(HR,HR,hx-HR,a[1]))
            d.append("L %g %g"%b)
        out.append('<path d="%s" class="%s"/>'%(" ".join(d),CLS[r["cls"]]))
    for r in R:
        if r["lab"] and r["label"]:
            out.append('<text x="%d" y="%d" class="lbl-sm">%s</text>'%(r["lab"][0],r["lab"][1],r["label"]))
    leg=BY+62
    for i,(c,t) in enumerate([("w4-line","120 VAC"),("w4-24","24 VAC"),
                              ("w4-dry","dry"),("w4-lv","5 V / signal")]):
        x=PX+i*118
        out.append('<path d="M %d %d L %d %d" class="%s"/>'%(x,leg,x+22,leg,c))
        out.append('<text x="%d" y="%d" class="lbl-sm">%s</text>'%(x+28,leg+4,t))
    return out, sum(len(v) for v in hops.values())

fig1="\n".join("          "+l for l in shell(False))
w,nh=wiring()
fig4="\n".join("          "+l for l in shell(True)+w)
open("fig1_portrait.svg","w").write(fig1)
open("fig4_portrait.svg","w").write(fig4)
print("emitted; hops:",nh,"| viewBox 0 0 %d %d"%(VW,VH))
