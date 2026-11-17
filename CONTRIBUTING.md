# Working on Clip Machine

## Set up

```bash
./install.sh            # Mac/Linux: makes .venv and installs requirements.txt (Windows: Install (Windows).bat)
cd tests && npm install # Playwright, for the browser suites
zsh tests/make_media.sh # test media (gitignored), needed by the slow tiers
```

Run the desktop app with `./start.sh`. To keep a test run away from your real jobs and port, set
`CLIP_PORT`, `CLIP_JOBS` (a scratch folder) and `CLIP_KEY` (20+ characters).

## Tests

`zsh tests/run_all.sh quick` runs in about 30 seconds. Run it before every commit. Then run
`zsh tests/run_all.sh` before a release: it adds the engine stress set, the Chrome web suites and the
desktop workflow. Run the browser suites one at a time; parallel Playwright runs can hang Firefox.

## Rules that keep the two engines honest

There are two engines: the desktop one (`clipper.py`) and the web one (`docs/formula.js`).
- **Any scoring, trimming or caption change goes into both.** Add a parity test to
  `tests/formula.test.mjs` that runs the same input through both and compares the results.
- **Constants live in `clipper.py`.** After changing one, run `.venv/bin/python scripts/export_formula.py`
  to regenerate `docs/formula.json`. CI fails if it is out of date.
- **A new file in `docs/` that the page loads must be listed in three places:**
  - `UI_FILES` in `app.py`, with a route, so the desktop app serves it;
  - `FILES` in `docs/sw.js` (also bump `SHELL`), so it works offline;
  - `scripts/build_release.sh`, so it ships in the zip.

  `test_server.py` checks the first two.
- **Syntax-check ES modules as `.mjs`.** `node --check` on a `.js` file does not parse it as a module, so
  it can pass a broken file.
- **Open text files with `encoding="utf-8"`.** Windows CI catches anything that doesn't.

## Releases

1. Bump `VERSION` in `clipper.py` and regenerate `formula.json`.
2. Push, and wait for CI to pass on all three systems.
3. Build from a clean export, not your working tree:
   ```bash
   git archive HEAD | tar -x -C /tmp/rel   # symlink .venv into it
   sh scripts/build_release.sh
   ```
4. Unzip the package, start its `app.py` on a spare port, and check it loads with no console errors.
