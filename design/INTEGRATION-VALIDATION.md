# Logo and homepage integration — November 18, 2026

Branch: `codex/homepage-integration`, based on `codex/graphics` `21101d3` and merged accounts `aff46fe`. Local changes only; no push or deployment.

## Result

- Static website root / `docs/index.html` is the animated homepage. `docs/workspace.html` is the existing editor with Peak window in the top bar. All imports remain in the same directory; the optional accounts meta, account UI and editor modules are preserved.
- Try it out opens `workspace.html`. Previous root links with editor options keep their complete query/fragment and redirect into the editor. Tracking-only queries stay on the homepage. Local storage stays on the same origin.
- Desktop `/` remains the native editor; `/index.html` is the homepage, and its CTA returns to native `/workspace.html`. All three entries remove a supplied access key after setting the existing HttpOnly cookie. Private routes still require authentication.
- `/icon.svg` serves the actual selected asset instead of generating the old yellow icon. Exact icon/brand filenames are explicitly allowed, including PNG install icons. Unknown brand paths and traversal remain blocked.
- Website manifest keeps its previous root install identity with `id: ./`, starts at `workspace.html`, and declares the safe 512 PNG maskable. `cm-shell-v14` caches both pages and the new brand/home assets; offline navigation returns the proper page. Existing model/CDN caches are preserved.
- Built desktop ZIP includes both pages, home assets, favicon/mark files, privacy page and actual selected SVG/PNG icons. README entry, hero/studio references and OG metadata are integrated.

## Verification

| Command | Result |
|---|---|
| `zsh tests/run_all.sh quick` | Passed, 8/8 cross-platform smoke checks; existing optional OpenTimelineIO skip and ResourceWarnings |
| `.venv/bin/python -m unittest tests/test_server.py` | 37 passed, including routes, exact icon bytes, public/private boundaries, traversal and key stripping |
| `node tests/web-edge.mjs` | All checks passed; rendering, editor, captions, metrics and import; no page errors |
| `node tests/desk-pro.mjs` | All checks passed; native link/file jobs, editor render, transcript cut, search, shared results log, ZIP/upload sheet, reload/cancel/delete |
| `node tests/homepage.mjs` | Passed in Chrome: GitHub Pages subpath, entry/return, legacy URL, storage, mobile 320px, reduced motion, SW offline pages, manifest and actual desktop assets/auth |
| `sh scripts/build_release.sh` | Passed; extracted ZIP entries checked |
| `DESKTOP_ROOT=<extracted Clip Machine folder> node tests/homepage.mjs` | Passed against the packaged desktop app on isolated 8790 |
| `node tests/web-account.mjs` | All checks passed: two-device sync, sign-in/out/delete, existing account button behavior, no page errors or CSP violations |
| JS syntax / `git diff --check` | Passed |

Browser suites were run sequentially. Chrome is the browser used here; actual Firefox/Safari/Windows installations and physical phone/PWA installation were not exercised. Offline page/assets were tested, not a new model download while offline.

Visual checks: integrated homepage and packaged native editor reviewed. Captures are `design/previews/homepage-integrated.png` and `desktop-release-integrated.png`; generated/scratch state only. Production app on 8765 was not changed or restarted. Test servers and headless browsers were closed.

Claude's uncommitted root `index.html` and `tests/web-edge.mjs` in the main checkout were not edited. Backend `server/**`, `docs/account.js`, `docs/app.js`, `docs/studio.js` and `clipper.py` match `aff46fe` exactly. Future workspace markup edits belong in `docs/workspace.html` on this branch. The original asset handoff snippets are retained as history, marked already implemented locally.
