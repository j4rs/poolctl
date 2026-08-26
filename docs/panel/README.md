# Panel build plan

Every part, where it sits on the backplate, and what connects to what.
Open `index.html` in a browser, or serve this directory.

This is the **source of truth** for the panel drawings. The published artifact
and any PDF are generated *from* here, not the other way round — they drifted
apart once already.

## Files

| | |
|---|---|
| `index.html` | the plan. Images referenced, not embedded, so git can diff it |
| `img/` | nine component photographs, one file each |
| `plate.py` | portrait plate geometry: parts, glands, cable runs |
| `emit.py` | renders Figures 1 and 4 from `plate.py` |
| `build.py` | `--artifact` inlines images as data URIs; `--pdf` renders via Chrome |
| `check.py` | fails if `index.html`'s figures are stale against `plate.py` |

## Regenerating the figures

Figures 1 and 4 share one geometry so they cannot disagree — an earlier pair of
hand-drawn SVGs did, and the plate was landscape in both when the enclosure
mounts portrait.

```bash
python3 emit.py          # writes fig1_portrait.svg and fig4_portrait.svg
```

`emit.py` checks two invariants before writing and will refuse on the first:
no cable run may pass through a part, and every crossing is drawn as a hop so
it can never read as a junction. Paste the output into the matching `<svg>` in
`index.html`.

That paste is a manual step, and manual steps are how the figures drifted the
first time. So it is policed:

```bash
python3 check.py         # re-emits, asserts both appear verbatim in index.html
```

CI runs it before publishing, and a stale page fails the build rather than
going up looking authoritative.

## Derived forms

```bash
python3 build.py --artifact   # panel-artifact.html, for a strict-CSP host
python3 build.py --pdf        # panel-build.pdf, forced light (the page is dark-first)
```

Both are gitignored. Rebuild rather than commit them: base64 does not
delta-compress, so an inlined copy adds its full weight to history on every
figure change.

## Photographs

Manufacturer and distributor product photographs, included to identify parts.
Each is credited in the page beside the component it shows. The Raspberry Pi 4
image is by Laserlicht via Wikimedia Commons, **CC BY-SA 4.0** — keep that
attribution with the image if you reuse it.

## Related

- `../prds/poolctl-v1.md` — the reasoning, the ADRs, the BOM, the open questions
- `../architecture.md` — components, state ownership, failure modes
- `../pi-bringup.md` — what happens on the box, in order

## Publishing

`.github/workflows/pages.yml` publishes **this directory only** as the site
root, so the plan is one URL with no path suffix. The PRD, the bring-up guide
and the architecture notes stay unpublished on purpose: serving `docs/`
wholesale would put them on the public internet while the repo itself stayed
private.

The workflow is committed and inert. GitHub Pages is not enabled — a private
repo needs GitHub Pro for it. Make the repo public or upgrade, and the next
push to `docs/panel/**` deploys.
