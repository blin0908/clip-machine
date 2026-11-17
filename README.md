# Clip Machine

A free AI clipper. Give it a long video and it finds the strongest moments and cuts captioned 9:16 clips for TikTok, Instagram Reels, YouTube Shorts, Facebook, Snapchat and X.

**No account, no watermark, no subscription.** It runs on your own device: your video is never uploaded anywhere.

### ▶ Use it now: **https://blin0908.github.io/clip-machine/**

Works best in **Chrome or Edge** on computers and Android phones. Firefox works but is slower. **Safari, and every browser on iPhone/iPad** (they all use Safari's engine), currently handles videos up to about a minute before running out of memory; for longer videos, use a computer or the desktop app. Safari also keeps that memory when you reload, so after a reload Clip Machine offers a fresh tab for the next video. After the first run it also works **offline**. On a phone, *Add to Home Screen* opens it like an app.

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
5. **Helps you post.** You get per-platform captions and a "before you post" checklist for each platform. A results log tracks the numbers that matter at 24 h, 72 h, and 7 d, with CSV export. Import a YouTube Studio export and it shows which scoring signals your best clips share, and whether Clip Machine's own score is predicting your results.

Each clip shows *why* it was picked, with evidence labels: **Official** (the platform documents it), **Data** (an observational study) or **Test** (a hypothesis to try on your own account). See [FORMULA.md](FORMULA.md) for the research and sources.

> Quality gate ≠ virality guarantee. It guarantees a technically clean, upload-ready file. Nobody can promise views.

## Languages

Pick the spoken language under **Speech** (the desktop app can also detect it). The website transcribes 30 languages with the multilingual Whisper models; the desktop app handles 99.
- **Chinese comes in Simplified or Traditional,** whichever you pick (Whisper writes either, so the transcript is converted with OpenCC; auto-detected Chinese becomes Simplified). Traditional captions use Noto Sans TC.
- **Hindi always uses the larger speech model** (the website downloads about 250 MB once): the smaller models write Hindi in Urdu script.
- **Captions are set the way each language is written.** Chinese, Japanese and Thai words are joined without spaces, sentences end on 。！？ and ؟ as well as `.!?`, and Arabic and Hebrew lines read right to left with the highlight on the right word.
- **Every script gets a heavy caption font.** Montserrat Black covers Latin, Cyrillic and Vietnamese; Greek, Arabic, Hebrew, Devanagari, Thai, Japanese, Korean and Chinese (Simplified and Traditional) captions use the matching Noto Sans Black, downloaded the first time a clip needs it (from 50 KB for Hebrew to 10 MB for Chinese) and kept after that. Greek capitals drop their accents, as Greek typesetting does.
- **Hype words and laughter are recognised in 15 languages:** English, Spanish, Portuguese, French, German, Italian, Russian, Turkish, Hindi, Arabic, Indonesian, Vietnamese, Japanese, Korean and Chinese (jajaja, kkkk, mdr, 哈哈, ㅋㅋ and (笑) count as laughter). Other languages are scored on energy, pacing, the opening and structure.

## Desktop app (Mac, Windows, Linux)

The desktop app opens the same workspace in your browser, but does the work on your computer's native engine, plus:
- **paste a link** (YouTube, TikTok, Twitch VODs, X…), downloaded with yt-dlp
- past videos stay on your computer and reopen with their clips (the previous page is still at `/classic`)
- the results log is shared by browsers connected to the same desktop app
- faster processing with native ffmpeg and faster-whisper, and 99 speech languages
- use it from your phone over Wi-Fi with a QR code

**Install:** download `Clip-Machine-desktop.zip` from [Releases](../../releases) and unzip it. It needs Python 3.10+ ([python.org](https://www.python.org/downloads/)); ffmpeg is installed for you.

| | Install once | Then start with |
|---|---|---|
| macOS | double-click **Install.command** (if blocked: right-click → Open) | **Start Clip Machine.command** |
| Windows | double-click **Install (Windows).bat** (tick "Add python.exe to PATH" when installing Python) | **Start Clip Machine.bat** |
| Linux | `./install.sh` (Debian/Ubuntu may need `sudo apt install python3-venv`) | `./start.sh` |

Command line: `.venv/bin/python clipper.py <url-or-file> -p tiktok -n 5 --style boxed --logo logo.png --logo-pos tr` (Windows: `.venv\Scripts\python`).

### Let Claude or Codex clip for you (MCP)

`mcp_server.py` lets an AI agent drive the desktop app: start a job from a file or link, wait for it, read the clips with their scores and reasons, re-render one with a new look, and pack the .zip. It connects to the running app (or starts it in the background if none is running) using the access key in `.access_key`, and needs nothing beyond the normal install.

Tools: `new_job` (file or link; platform, number of clips, version, format, caption style, language, end card…), `job_status` (can wait until done), `list_clips` (scores, reasons, titles, post text, file paths), `rerender_clip` (style, highlight colour, size, position, frame, layout, trim, headline), `export_zip` (returns the .zip path) and `list_jobs`.

Replace `/path/to/Clip Machine` with your folder (on Windows the Python is `.venv\Scripts\python.exe`).

**Claude Code**

```bash
claude mcp add clip-machine -- "/path/to/Clip Machine/.venv/bin/python" "/path/to/Clip Machine/mcp_server.py"
```

**Claude Desktop**: Settings → Developer → Edit Config, then add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "clip-machine": {
      "command": "/path/to/Clip Machine/.venv/bin/python",
      "args": ["/path/to/Clip Machine/mcp_server.py"]
    }
  }
}
```

**Codex**: add to `~/.codex/config.toml`:

```toml
[mcp_servers.clip-machine]
command = "/path/to/Clip Machine/.venv/bin/python"
args = ["/path/to/Clip Machine/mcp_server.py"]
```

Then ask, for example: *"Clip ~/Videos/podcast.mp4 into 5 TikToks, re-render the best one with clean captions, and give me the zip."* To use an app on another computer, set `CLIP_MCP_URL` (e.g. `http://192.168.1.20:8765`) and `CLIP_KEY` in the server's environment. In Claude Code the `-e` flags go after the name:

```
claude mcp add clip-machine -e CLIP_MCP_URL=http://192.168.1.20:8765 -e CLIP_KEY=yourkey -- "/path/to/Clip Machine/.venv/bin/python" "/path/to/Clip Machine/mcp_server.py"
```

Check it with `claude mcp list` (it should say Connected).

## The workspace

Built for clipping every day, not once:
- **Queue.** Drop several videos at once (or keep adding while it works). They run one after another with the same settings.
- **Clips board.** Every clip with its score, why it was picked and its quality report. Keep the good ones (**K**), filter to *Kept*, sort best-first or in video order, and **download all as a .zip**. The ZIP has each cut's .mp4 and .srt, the post text for every platform, and a `youtube.csv` upload sheet with one row per kept clip. The sheet lists the short cut when both cuts are available.
- **Studio.** Open any clip to edit it with a live preview: what you see is what renders, with the captions drawn over the source and the cuts skipped as it plays.
  - **Timeline** with the waveform, every word, and the cut-out pauses shaded. Drag the yellow in/out handles; they snap between words (hold **Alt** to place them freely). **I** / **O** mark in and out at the playhead.
  - **Captions**: retype misheard words (it fixes the transcript for every clip), change the headline and the end-card question.
  - **Look**: caption style (*Pop*, *Clean*, *Boxed*), highlight colour, size, position, headline on/off, frame (**9:16, 4:5, 1:1, 16:9**), full frame + blur or **fill and drag to reframe**, and pause cutting on/off.
  - **Render** (**⌘/Ctrl + Enter**) queues the edit and lets you move to the next clip (**]**) while it renders. Every render goes back through the quality gate; if it fails, your previous version is kept. **⌘/Ctrl + Z** undoes.
- **Find clips by description.** Type what you're looking for in the box above the clips ("the part about pricing") and press **Enter** (or **/** to jump to the box). The best-matching moments are cut, rendered and quality-checked as new clips, labelled with what they matched. It works in any of the speech languages, even when you describe the moment in another language, and says so when nothing matches well enough. A small multilingual model ranks the transcript's sentences on your device: the website downloads it once (about 135 MB) and keeps it, the desktop app runs the same model natively. In the browser version it doesn't work on Safari or iPhone yet (Safari can't load a second model in a tab after the speech model); the desktop app's search works in any browser.
- **Transcript.** Search the whole video, select any stretch of words and **make your own clip** from it.
- **Brand kit.** Add your logo once (PNG with a transparent background works best) and it's laid over a top corner of every clip, under the captions. Pick the corner, size and opacity, and turn it on or off per clip in the studio. The desktop app keeps the logo on your computer.
- **Presets.** Save your settings per show or platform; starter presets cover podcasts → Shorts, talking heads → TikTok, square feed posts and landscape highlights. Your last settings come back next time.
- **Keyboard first.** Press **?** for every shortcut.

## How it's built

- `docs/`: the web app (GitHub Pages; `sw.js` makes it work offline after the first run). ffmpeg.wasm for editing, transformers.js Whisper for speech, and `formula.js`, a port of the scoring in `clipper.py`. `formula.json` is generated from `clipper.py` by `scripts/export_formula.py` (the release build refuses to package if it has drifted), so both apps score clips the same way.
- `docs/app.js` (pipeline, queue, board, transcript, presets), `docs/studio.js` (the studio) and `docs/zip.js` (the .zip export) are the interface for both apps. Served by the desktop app, the same page sends videos and edits to its native engine instead of ffmpeg.wasm.
- `docs/search.js` + `docs/search-worker.js` (web) and `search.py` (desktop): find clips by description, with the same pinned model ([multilingual-e5-small](https://huggingface.co/Xenova/multilingual-e5-small), 8-bit) and the same windows and thresholds in both apps.
- `clipper.py`: the engine and CLI. `app.py`: the local server for the desktop app (it serves `docs/`; `index.html` is the previous page, kept at `/classic`). `mcp_server.py`: the MCP server for AI agents, a client of `app.py`'s API.
- `tests/`: run everything with `zsh tests/run_all.sh` (`quick` for the 30-second unit tier, `all` to add Firefox and Safari's engine). Fast tiers: `test_server.py` (access key, input validation, uploads, interrupted edits, file paths, results log), `test_engine_units.py` (pause cutting, quality-gate rules, helpers), `formula.test.mjs` (the web scoring, trimming and caption logic in every script, including checks that it cuts pauses and writes subtitle files exactly like the desktop engine, and that the .zip export is valid) and `ci_smoke.py` (a real engine run on generated media, no Mac voices needed). Slow tiers: `test_mcp.py` drives every MCP tool against an isolated app; `make_media.sh` builds a stress-test media set (portrait, 60 fps, odd sizes, silent, no audio, audio only, corrupt, 25 min…), `engine_stress.py` runs the engine against it, and `web-stress.mjs` runs the web app in Chrome, Safari's engine (WebKit) and Firefox via Playwright, plus phone viewports and an offline rerun; `web-pro.mjs` runs the workspace workflow (queue, board keys, kept filter, .zip, transcript clips, formats, undo, presets, cancel, phone layout). `web-find.mjs` checks find-by-description: the browser and desktop engines score the same windows (within a documented tolerance) and offer the same clips for a fixed transcript in English, Spanish and Japanese (`search_parity.py` holds the desktop side's ranking checks), then searches a real run of `talk_40s.mp4` from the clips board. `web-safari-reload.mjs` checks that Safari's engine can clip again after a reload (through the fresh tab it offers), `web-scripts.mjs` renders captions in 11 writing systems through ffmpeg.wasm and fails on any missing glyph; `web-bench.mjs` times each stage of the web app; `harness/` holds the speech-model speed test and the Safari memory-limit reproduction. GitHub Actions runs the fast tiers and the smoke test on Windows, macOS and Linux on every push.

Only clip videos you own or have permission to repost. MIT licensed; see [LICENSE](LICENSE) for third-party notices.
