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
