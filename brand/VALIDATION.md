# Validation — November 17, 2026

Base: `f898bef` (v1.8.4). Review concepts only; no selected identity or app icons changed.

- `.venv/bin/python brand/build_concepts.py` — passed, creates three original SVGs and dark/light review HTML.
- `node brand/render.mjs` — passed in installed Chrome. Created actual 16px rasters, enlarged favicon comparison, dark/light size study, circular composition previews and mobile capture. Visually inspected the comparison and favicon silhouettes.
- `zsh tests/run_all.sh quick` — passed (including 8/8 cross-platform smoke checks). Existing ResourceWarnings and optional OpenTimelineIO skip were reported, with no failures.
- `node tests/web-edge.mjs` — passed, “all checks passed”, no page errors.
- `git diff --check` — passed.

Worktree-local `.venv`, `tests/node_modules` and `tests/media` symlinks reuse existing ignored dependencies only; not staged. Main checkout and Claude's account worktree were not edited. Screenshots are real browser rasterizations of these vector concepts.

## Selected identity — November 18, 2026

Base: `origin/main` `aff46fe` (accounts merged). Benny selected **A / Peak window**. Concept history is preserved; B and C are retired.

- `/tmp/clip-machine-brand-tools/bin/python brand/build_identity.py` — passed using pinned fontTools tooling in a separate temporary venv. Archivo instantiated at weight 800 and width 125, converted to SVG paths; no font dependency in the wordmark assets.
- `node brand/render.mjs` — passed using installed Chrome. Rebuilt 180/512 icons, separate optical favicon at 16/32, two-entry ICO, full selected-identity desktop/mobile captures and zoomed favicon. Pixel-level mask check: 41,416 foreground pixels; none outside the 80% safe circle. `brand/icon-check.json` contains the result.
- Visually reviewed `identity-preview.png` and `identity-mobile.png`: no clipped labels, horizontal overflow or distorted wordmarks; dark/light versions and circle-crop icons readable. Small light-surface labels were darkened before the final capture.
- `zsh tests/run_all.sh quick` — passed, including 8/8 smoke checks. Existing ResourceWarnings and the optional OpenTimelineIO skip are not failures.
- `node tests/web-edge.mjs` — passed, all checks passed, no page errors.

- `git diff --check` — passed.

Only `brand/**` and the three allowed `docs/icon*` assets changed. The generated desktop `/icon.svg` response still needs the explicit source change in `INTEGRATION.md`; no production route, PWA cache, workspace mark, README, payment or account UI was changed. No push or deployment.
