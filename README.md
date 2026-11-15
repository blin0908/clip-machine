# Clip Machine

A free AI clipper. Give it a long video and it finds the strongest moments and cuts captioned 9:16 clips for TikTok, Instagram Reels, YouTube Shorts, Facebook, Snapchat and X.

**No account, no watermark, no subscription.** It runs on your own device: your video is never uploaded anywhere.

### ▶ Use it now: **https://blin0908.github.io/clip-machine/**

Works best in **Chrome or Edge** on computers and Android phones. Firefox works but is slower. **Safari, and every browser on iPhone/iPad** (they all use Safari's engine), currently handles videos up to about a minute before running out of memory; for longer videos, use a computer or the desktop app. After the first run it also works **offline**. On a phone, *Add to Home Screen* opens it like an app.

---

## What it does

1. **Finds the moments.** Whisper transcribes the speech on your device, then every 10–60 s window that starts and ends on a sentence is scored on:
   - loudness and energy spikes, laughter and hype words
   - how strong the first second and first three seconds are
   - whether it builds to a payoff
   - pace and dead air
   - whether its length fits the platform's test range
2. **Cuts two versions per moment with the same opening:** a short demo cut and a longer cut with a second payoff. Lengths depend on the platform, e.g. TikTok 12–18 s / 20–30 s and Reels 12–18 s / 30–45 s.
3. **Edits lightly for clarity:**
   - cuts dead air and "um/uh"
   - punch-in zooms that hide the jump cuts
   - voice clean-up: rumble filter, noise reduction, presence EQ, gentle compression
   - loudness set to −14 LUFS
   - light sharpening and contrast
   - word-by-word captions and a 3-second headline, kept inside each platform's safe zone
4. **Runs a quality gate on every clip.** It measures the finished file:
   - format, resolution and length
   - loudness and clipping
   - black frames, dead silence, frozen picture
   - clean in/out points

   A clip that fails a hard check is re-rendered in safe mode, and replaced with the next-best moment if it still fails.
5. **Helps you post.** You get per-platform captions and a "before you post" checklist for each platform. A results log tracks the numbers that matter at 24 h and 7 d, with CSV export.

Each clip shows *why* it was picked, with evidence labels: **Official** (the platform documents it), **Data** (an observational study) or **Test** (a hypothesis to try on your own account). See [FORMULA.md](FORMULA.md) for the research and sources.

> Quality gate ≠ virality guarantee. It guarantees a technically clean, upload-ready file. Nobody can promise views.

## Desktop app (Mac, Windows, Linux)

The desktop app opens the same workspace in your browser, but does the work on your computer's native engine, plus:
- **paste a link** (YouTube, TikTok, Twitch VODs, X…), downloaded with yt-dlp
- past videos stay on your computer and reopen with their clips (the previous page is still at `/classic`)
- faster processing with native ffmpeg and faster-whisper, and 99 speech languages
- use it from your phone over Wi-Fi with a QR code

**Install:** download `Clip-Machine-desktop.zip` from [Releases](../../releases) and unzip it. It needs Python 3.10+ ([python.org](https://www.python.org/downloads/)); ffmpeg is installed for you.

| | Install once | Then start with |
|---|---|---|
| macOS | double-click **Install.command** (if blocked: right-click → Open) | **Start Clip Machine.command** |
| Windows | double-click **Install (Windows).bat** (tick "Add python.exe to PATH" when installing Python) | **Start Clip Machine.bat** |
| Linux | `./install.sh` (Debian/Ubuntu may need `sudo apt install python3-venv`) | `./start.sh` |

Command line: `.venv/bin/python clipper.py <url-or-file> -p tiktok -n 5 --style boxed` (Windows: `.venv\Scripts\python`).

## The workspace

Built for clipping every day, not once:
- **Queue.** Drop several videos at once (or keep adding while it works). They run one after another with the same settings.
- **Clips board.** Every clip with its score, why it was picked and its quality report. Keep the good ones (**K**), filter to *Kept*, sort best-first or in video order, and **download all as a .zip** (each cut's .mp4 and .srt, plus a captions file with the post text for every platform).
- **Studio.** Open any clip to edit it with a live preview: what you see is what renders, with the captions drawn over the source and the cuts skipped as it plays.
  - **Timeline** with the waveform, every word, and the cut-out pauses shaded. Drag the yellow in/out handles; they snap between words (hold **Alt** to place them freely). **I** / **O** mark in and out at the playhead.
  - **Captions**: retype misheard words (it fixes the transcript for every clip), change the headline and the end-card question.
  - **Look**: caption style (*Pop*, *Clean*, *Boxed*), highlight colour, size, position, headline on/off, frame (**9:16, 4:5, 1:1, 16:9**), full frame + blur or **fill and drag to reframe**, and pause cutting on/off.
  - **Render** (**⌘/Ctrl + Enter**) queues the edit and lets you move to the next clip (**]**) while it renders. Every render goes back through the quality gate; if it fails, your previous version is kept. **⌘/Ctrl + Z** undoes.
- **Transcript.** Search the whole video, select any stretch of words and **make your own clip** from it.
- **Presets.** Save your settings per show or platform; starter presets cover podcasts → Shorts, talking heads → TikTok, square feed posts and landscape highlights. Your last settings come back next time.
- **Keyboard first.** Press **?** for every shortcut.

## How it's built

- `docs/`: the web app (GitHub Pages; `sw.js` makes it work offline after the first run). ffmpeg.wasm for editing, transformers.js Whisper for speech, and `formula.js`, a port of the scoring in `clipper.py`. `formula.json` is generated from `clipper.py` by `scripts/export_formula.py` (the release build refuses to package if it has drifted), so both apps score clips the same way.
- `docs/app.js` (pipeline, queue, board, transcript, presets), `docs/studio.js` (the studio) and `docs/zip.js` (the .zip export) are the interface for both apps. Served by the desktop app, the same page sends videos and edits to its native engine instead of ffmpeg.wasm.
- `clipper.py`: the engine and CLI. `app.py`: the local server for the desktop app (it serves `docs/`; `index.html` is the previous page, kept at `/classic`).
- `tests/`: run everything with `zsh tests/run_all.sh` (`quick` for the 30-second unit tier, `all` to add Firefox and Safari's engine). Fast tiers: `test_server.py` (access key, input validation, uploads, interrupted edits, file paths, results log), `test_engine_units.py` (pause cutting, quality-gate rules, helpers), `formula.test.mjs` (the web scoring, trimming and caption logic, including checks that it cuts pauses and writes subtitle files exactly like the desktop engine, and that the .zip export is valid) and `ci_smoke.py` (a real engine run on generated media, no Mac voices needed). Slow tiers: `make_media.sh` builds a stress-test media set (portrait, 60 fps, odd sizes, silent, no audio, audio only, corrupt, 25 min…), `engine_stress.py` runs the engine against it, and `web-stress.mjs` runs the web app in Chrome, Safari's engine (WebKit) and Firefox via Playwright, plus phone viewports and an offline rerun; `web-pro.mjs` runs the workspace workflow (queue, board keys, kept filter, .zip, transcript clips, formats, undo, presets, cancel, phone layout). `web-bench.mjs` times each stage of the web app; `harness/` holds the speech-model speed test and the Safari memory-limit reproduction. GitHub Actions runs the fast tiers and the smoke test on Windows, macOS and Linux on every push.

Only clip videos you own or have permission to repost. MIT licensed; see [LICENSE](LICENSE) for third-party notices.
