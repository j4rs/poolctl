#!/usr/bin/env python3
"""Build the two derived forms of the panel plan from index.html.

  build.py --artifact  -> panel-artifact.html, a fragment with images inlined
                          as data URIs, for publishing where a strict CSP
                          blocks external hosts
  build.py --pdf       -> panel-build.pdf via headless Chrome, forced to the
                          light theme because the page is dark-first and a
                          dark PDF is useless on paper

index.html is the source of truth. Figures 1 and 4 come from emit.py, which
reads the shared geometry in plate.py - run `python3 emit.py` and paste the
result if the layout changes, so the two drawings cannot disagree.
"""
import base64, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC  = os.path.join(HERE, "index.html")

def read():
    return open(SRC, encoding="utf-8").read()

def artifact():
    s = read()
    def inline(m):
        p = os.path.join(HERE, m.group(1))
        b = base64.b64encode(open(p, "rb").read()).decode()
        return '<img src="data:image/jpeg;base64,%s"' % b
    s, n = re.subn(r'<img src="(img/[^"]+)"', inline, s)
    # the artifact host supplies its own document shell
    s = re.sub(r'^.*?<title>', '<title>', s, count=1, flags=re.S)
    s = s.replace("</head>\n<body>\n", "").replace("\n</body>\n</html>\n", "\n")
    out = os.path.join(HERE, "panel-artifact.html")
    open(out, "w", encoding="utf-8").write(s)
    print("wrote %s  (%d images inlined, %.0f KB)" % (out, n, len(s)/1024))

PRINT_CSS = """<style>
  @page { size: Letter; margin: 14mm 12mm; }
  @media print {
    html, body { background: #fff !important; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .wrap { max-width: none; padding: 0; gap: 30px; }
    figure, .part, .note, table, .card, ol.steps li { break-inside: avoid; }
    h1, h2, h3 { break-after: avoid; }
    svg { max-height: 235mm; }
    .parts { grid-template-columns: repeat(3, 1fr) !important; gap: 10px !important; }
    .shot { height: 104px !important; padding: 7px !important; }
    .part figcaption { padding: 10px 11px 12px !important; }
    .part h3 { font-size: 13px !important; }
    .part .role { font-size: 11.5px !important; line-height: 1.45 !important; }
    .part .cat, .part .credit, .part .why { font-size: 10px !important; }
    .grid2 { gap: 12px !important; }
  }
</style>"""

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

def pdf():
    s = read().replace('<html lang="en">', '<html lang="en" data-theme="light">', 1)
    s = s.replace("</head>", PRINT_CSS + "\n</head>", 1)
    tmp = os.path.join(HERE, ".print.html")
    open(tmp, "w", encoding="utf-8").write(s)
    out = os.path.join(HERE, "panel-build.pdf")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
                    "--virtual-time-budget=20000", "--run-all-compositor-stages-before-draw",
                    "--print-to-pdf=" + out, "file://" + tmp],
                   check=True, capture_output=True)
    os.remove(tmp)
    print("wrote %s  (%.0f KB)" % (out, os.path.getsize(out)/1024))

if __name__ == "__main__":
    if "--artifact" in sys.argv: artifact()
    if "--pdf" in sys.argv: pdf()
    if len(sys.argv) == 1: print(__doc__)
