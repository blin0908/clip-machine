# Validation — November 17, 2026

Base: `f898bef` (v1.8.4). Review concepts only; no selected identity or app icons changed.

- `.venv/bin/python brand/build_concepts.py` — passed, creates three original SVGs and dark/light review HTML.
- `node brand/render.mjs` — passed in installed Chrome. Created actual 16px rasters, enlarged favicon comparison, dark/light size study, circular composition previews and mobile capture. Visually inspected the comparison and favicon silhouettes.
- `zsh tests/run_all.sh quick` — passed (including 8/8 cross-platform smoke checks). Existing ResourceWarnings and optional OpenTimelineIO skip were reported, with no failures.
- `node tests/web-edge.mjs` — passed, “all checks passed”, no page errors.
- `git diff --check` — passed.

Worktree-local `.venv`, `tests/node_modules` and `tests/media` symlinks reuse existing ignored dependencies only; not staged. Main checkout and Claude's account worktree were not edited. Screenshots are real browser rasterizations of these vector concepts.
