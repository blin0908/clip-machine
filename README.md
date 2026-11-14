# Clip Machine

A free AI clipper. Give it a long video and it finds the strongest moments and cuts captioned 9:16 clips for TikTok, Instagram Reels, YouTube Shorts, Facebook, Snapchat and X.

**No account, no watermark, no subscription.** It runs on your own device: your video is never uploaded anywhere.

### ▶ Use it now: **https://blin0908.github.io/clip-machine/**

Works in Chrome, Edge and Safari on phones and computers. On iPhone, tap Share → *Add to Home Screen* and it opens like an app.

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

## Mac app

The Mac app does everything the web app does, plus:
- **paste a link** (YouTube, TikTok, Twitch VODs, X…), downloaded with yt-dlp
- faster processing with native ffmpeg and faster-whisper
- use it from your phone over Wi-Fi with a QR code

**Install:** download `Clip-Machine-mac.zip` from [Releases](../../releases), unzip it, double-click **Install.command** (needs Python 3.10+ from python.org), then **Start Clip Machine.command**. If macOS blocks it, right-click → Open.

Command line: `.venv/bin/python clipper.py <url-or-file> -p tiktok -n 5`

## Web app vs Mac app

| | Web app | Mac app |
|---|---|---|
| Install | none | one-time installer |
| Input | video file | file **or link** |
| Export | 720p (fast) or 1080p | 1080p |
| Speed | depends on your device; first run downloads ~110 MB of models, cached after | fast |
| Speech | English | 99 languages |

Why no YouTube links on the web or in the App Store? Browsers can't fetch YouTube video directly, and Apple's App Review Guideline 5.2.3 rejects apps that download media from third-party sites.

## How it's built

- `docs/`: the web app (GitHub Pages). ffmpeg.wasm for editing, transformers.js Whisper for speech, and `formula.js`, a port of the scoring in `clipper.py`. `formula.json` is generated from `clipper.py`, so both apps score clips the same way.
- `clipper.py`: the engine and CLI. `app.py` + `index.html`: the local server and phone UI for the Mac app.

Only clip videos you own or have permission to repost. MIT licensed; see [LICENSE](LICENSE) for third-party notices.
