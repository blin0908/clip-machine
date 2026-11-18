# Homepage validation — November 17, 2026

Base `f898bef`; standalone preview only. Shared application, account and routing files are untouched.

- `zsh tests/run_all.sh quick` — passed, including 8/8 cross-platform smoke checks. Existing ResourceWarnings / optional OpenTimelineIO skip did not fail the suite.
- `node tests/web-edge.mjs` — passed, all checks passed, no page errors.
- `node design/check-home.mjs` — 14/14 passed: waveform, accessible motion control, actual animation pause, click-through scroll, reduced motion, visible content, 390/320px overflow, skip link, three app links, actual workspace load, no JavaScript errors.
- Visual inspection: real Chrome desktop hero, full page and mobile captures. Fixed mobile headline overflow. Kept the animation control outside an image-only accessibility role.
- In-app browser: observed Pause/Resume toggle states, workflow scroll ending at 100.23px from viewport top, and Try Clip Machine loading the real app's uploader/settings. Returned the single review tab to the three logo concepts for Benny.
- `git diff --check` — passed.

The images in `previews/` are browser captures of this original homepage illustration. They are not screenshots of a generated video job, final task 14 marketing assets, or proof that the homepage is deployed.

Local-only review: `/tmp/clip-machine-review-server.py` serves this worktree and the separate brand concept folder on 127.0.0.1:8791. It does not touch the running app on 8765. This temporary helper is outside Git; the permanent source lives in this branch. If it stops, serve this repository root with any localhost static server to review `/design/homepage/`.

## Selected identity and marketing assets — November 18, 2026

`codex/graphics` is rebased onto `codex/brand` `8b9784d`, which includes accounts base `aff46fe`. The original homepage commit was replayed as `c6abcb0`. Shared application source remains unchanged.

- `node design/capture-app.mjs` — passed: actual isolated desktop at 127.0.0.1:8790, generated `talk_80s.mp4`, two real native clips, 2× queue/board/studio/find/editor captures, zero page errors. Fresh random local key and scratch jobs/logs only; server and headless Chrome stopped. Production 8765 untouched. Source hash/rights and viewport recorded in `captures/provenance.json`.
- Capture review fixed a sticky tab bar covering the find input, an editor timeline cut off by the layout, a truncated export crop and screenshots taken before video playback frames had loaded. The final capture waits for decoded previews/seek completion and the transient toast to clear. Search input is genuine; it is not presented as a successful search result.
- `python3 design/build_assets.py --version 1.8.4` and `node design/render.mjs` — passed: ten exact-size masters, each with an HTML source; `docs/og-image.png` copied byte-for-byte; separate banner-safe-area preview and 600/800/640/360/1280/98px review gallery. Renderer checks loaded images, font availability and marketing text inside the canvas. Each export gets one fresh page, closed before the next, to avoid stale viewport painting.
- Visual review: all ten master compositions and smallest-display gallery examined, including four feature crops and the 1546×423 all-device banner safe area. Source app text is real. Newly authored text uses the brand's high-contrast text/muted/accent colours. Feature marketing copy stays within 12 words (excluding existing screenshot UI). Profile mark remains legible at 98px.
- `node design/check-home.mjs` — 14/14 passed after applying A. Desktop uses the full outlined lockup; the narrow mobile nav uses the mark to preserve minimum sizes. Three CTA entries open the real workspace. 320/390px layout, keyboard skip, pause, reduced motion and native click-scroll all pass; no JS errors.
- `zsh tests/run_all.sh quick` — passed in this graphics worktree (8/8 smoke; existing optional OpenTimelineIO skip/ResourceWarnings). Shared app files match the brand branch on which `node tests/web-edge.mjs` passed all checks/no page errors this run. It was not repeated for static marketing PNGs. No shared workspace/desktop source changed, so desk-pro was not rerun.
- `node --check design/capture-app.mjs`, `node --check design/render.mjs`, PNG dimensions/OG byte equality and `git diff --check` — passed.

Task 14 deliverables are asset files, not a deployment. Homepage root/workspace migration, visible workspace/desktop mark, icon routes, cache bump, README/OG tags and released-ZIP verification remain in `INTEGRATION.md` / `brand/INTEGRATION.md` for the coordinated shared-source integration. No payments, account changes, channel-art upload or security audit are claimed by this design work.
