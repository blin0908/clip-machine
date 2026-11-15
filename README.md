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

The desktop app does everything the web app does, plus:
- **paste a link** (YouTube, TikTok, Twitch VODs, X…), downloaded with yt-dlp
- faster processing with native ffmpeg and faster-whisper, and 99 speech languages
- use it from your phone over Wi-Fi with a QR code

**Install:** download `Clip-Machine-desktop.zip` from [Releases](../../releases) and unzip it. It needs Python 3.10+ ([python.org](https://www.python.org/downloads/)); ffmpeg is installed for you.

| | Install once | Then start with |
|---|---|---|
| macOS | double-click **Install.command** (if blocked: right-click → Open) | **Start Clip Machine.command** |
| Windows | double-click **Install (Windows).bat** (tick "Add python.exe to PATH" when installing Python) | **Start Clip Machine.bat** |
| Linux | `./install.sh` (Debian/Ubuntu may need `sudo apt install python3-venv`) | `./start.sh` |

Command line: `.venv/bin/python clipper.py <url-or-file> -p tiktok -n 5 --style boxed` (Windows: `.venv\Scripts\python`).

## Fix a clip without starting over

Every clip has **✎ Edit this cut**:
- **Trim** the start or end one word at a time. It always snaps between words, so nothing gets cut mid-word.
- **Fix captions.** Retype any misheard word; the timing is kept.
- **Change the headline** and the **caption style**: *Pop* (active word highlighted), *Clean* (plain phrases) or *Boxed* (black box, easiest to read over busy video).

The cut is re-rendered and goes back through the quality gate. If the new version fails, your old one is kept.

## How it's built

- `docs/`: the web app (GitHub Pages; `sw.js` makes it work offline after the first run). ffmpeg.wasm for editing, transformers.js Whisper for speech, and `formula.js`, a port of the scoring in `clipper.py`. `formula.json` is generated from `clipper.py` by `scripts/export_formula.py` (the release build refuses to package if it has drifted), so both apps score clips the same way.
- `clipper.py`: the engine and CLI. `app.py` + `index.html`: the local server and phone UI for the desktop app.
- `tests/`: `make_media.sh` builds a stress-test media set (portrait, 60 fps, odd sizes, silent, no audio, audio only, corrupt, 25 min…). `engine_stress.py` runs the engine against it; `web-stress.mjs` runs the web app in Chrome, Safari's engine (WebKit) and Firefox via Playwright, plus phone viewports and an offline rerun (`BROWSER=webkit-desktop node web-stress.mjs talk` runs chosen cases in one browser). `harness/` reproduces the Safari memory limit with ffmpeg.wasm alone.

Only clip videos you own or have permission to repost. MIT licensed; see [LICENSE](LICENSE) for third-party notices.
