"""Clip Machine engine: link/file -> transcript + loudness -> scored moments -> vertical clips.

Everything runs locally. No API keys, no paid services.
  download  : yt-dlp (YouTube, TikTok, Twitch VODs, X, etc.)
  transcribe: faster-whisper (local model, word timestamps)
  score     : loudness spikes + hype language + laughter + pace + hook strength
  render    : ffmpeg -> 1080x1920 MP4 with word-by-word burned captions
"""
from __future__ import annotations

import json
import math
import os
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
from collections import Counter
from dataclasses import dataclass, field, asdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
IS_WIN = os.name == "nt"
BIN = HERE / ".venv" / ("Scripts" if IS_WIN else "bin")
EXE = ".exe" if IS_WIN else ""


def _tool(name: str) -> str:
    for cand in (BIN / (name + EXE), Path.home() / ".local" / "bin" / (name + EXE)):
        if cand.exists():
            return str(cand)
    found = shutil.which(name)
    if not found and name in ("ffmpeg", "ffprobe"):
        try:  # portable ffmpeg from the static-ffmpeg package (macOS, Windows, Linux)
            import static_ffmpeg
            static_ffmpeg.add_paths(weak=True)
            found = shutil.which(name)
        except Exception:
            pass
    if not found:
        raise RuntimeError(f"{name} not found. Run the installer again, or install {name} and put it on PATH.")
    return found


FFMPEG = _tool("ffmpeg")
FFPROBE = _tool("ffprobe")


def _ytdlp_cmd() -> list[str]:
    """How to run yt-dlp. Prefer `python -m yt_dlp` from this interpreter: the venv's yt-dlp launcher script has the
    venv's absolute path baked into its first line, so it breaks ("No such file or directory") when the app folder is
    moved or renamed. The module form works wherever the folder lives."""
    try:
        import importlib.util
        if importlib.util.find_spec("yt_dlp"):
            return [sys.executable, "-m", "yt_dlp"]
    except Exception:
        pass
    return [_tool("yt-dlp")]


YTDLP = None   # resolved on first download (kept for anything that imported the name)
# Captions use the bundled Montserrat Black (OFL) so output looks the same on macOS, Windows, Linux and the web app.
FONT_DIR = str(next((d for d in (HERE / "docs" / "fonts", HERE / "fonts") if (d / "Montserrat-Black.ttf").exists()),
                    HERE / "fonts"))
VERSION = "1.8.4"            # shown in the app; the desktop app compares it with the latest GitHub release
CAP_FONT = "Montserrat Black"   # the family name stored inside Montserrat-Black.ttf (libass matches on it)
# Other scripts use the matching Noto Sans Black (OFL), fetched the first time a clip needs it. The web app reads this
# table from formula.json, so both engines pick the same font. Montserrat covers Latin (every European accent),
# Cyrillic and Vietnamese; each Noto font also covers basic Latin, so mixed text stays in one face.
_NOTO = "https://cdn.jsdelivr.net/npm/@expo-google-fonts"
CAPTION_FONTS = {
    "latin":      {"name": CAP_FONT, "file": "Montserrat-Black.ttf"},
    "greek":      {"name": "Noto Sans Black", "file": "NotoSans_900Black.ttf", "label": "Greek", "mb": 0.6,
                   "url": f"{_NOTO}/noto-sans@0.4.2/900Black/NotoSans_900Black.ttf"},
    "arabic":     {"name": "Noto Sans Arabic Black", "file": "NotoSansArabic_900Black.ttf", "label": "Arabic", "mb": 0.2,
                   "url": f"{_NOTO}/noto-sans-arabic@0.4.3/900Black/NotoSansArabic_900Black.ttf"},
    "hebrew":     {"name": "Noto Sans Hebrew Black", "file": "NotoSansHebrew_900Black.ttf", "label": "Hebrew", "mb": 0.05,
                   "url": f"{_NOTO}/noto-sans-hebrew@0.4.1/900Black/NotoSansHebrew_900Black.ttf"},
    "devanagari": {"name": "Noto Sans Devanagari Black", "file": "NotoSansDevanagari_900Black.ttf", "label": "Hindi", "mb": 0.2,
                   "url": f"{_NOTO}/noto-sans-devanagari@0.4.2/900Black/NotoSansDevanagari_900Black.ttf"},
    "thai":       {"name": "Noto Sans Thai Black", "file": "NotoSansThai_900Black.ttf", "label": "Thai", "mb": 0.05,
                   "url": f"{_NOTO}/noto-sans-thai@0.4.2/900Black/NotoSansThai_900Black.ttf"},
    "ja":         {"name": "Noto Sans JP Black", "file": "NotoSansJP_900Black.ttf", "label": "Japanese", "mb": 5.6,
                   "url": f"{_NOTO}/noto-sans-jp@0.4.4/900Black/NotoSansJP_900Black.ttf"},
    "ko":         {"name": "Noto Sans KR Black", "file": "NotoSansKR_900Black.ttf", "label": "Korean", "mb": 6.0,
                   "url": f"{_NOTO}/noto-sans-kr@0.4.4/900Black/NotoSansKR_900Black.ttf"},
    "zh":         {"name": "Noto Sans SC Black", "file": "NotoSansSC_900Black.ttf", "label": "Chinese", "mb": 10.3,
                   "url": f"{_NOTO}/noto-sans-sc@0.4.4/900Black/NotoSansSC_900Black.ttf"},
    "zhtc":       {"name": "Noto Sans TC Black", "file": "NotoSansTC_900Black.ttf", "label": "Chinese (Traditional)", "mb": 7.1,
                   "url": f"{_NOTO}/noto-sans-tc@0.4.4/900Black/NotoSansTC_900Black.ttf"},
}
FONT_CACHE = Path(os.environ.get("CLIP_FONT_CACHE") or HERE / "fonts-cache")   # Montserrat + any script fonts fetched
_font_lock = threading.Lock()


_font_failed = {}


def _fetch_font(url, dst):
    tmp = dst.with_name(dst.name + ".part")
    try:
        import urllib.request
        with urllib.request.urlopen(url, timeout=60) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
    except Exception:
        tmp.unlink(missing_ok=True)
        if not shutil.which("curl"):        # some Python installs lack the CA certificates urllib needs; curl has its own
            raise
        try:
            subprocess.run(["curl", "-fsSL", "--max-time", "180", "-o", str(tmp), url], check=True, capture_output=True)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise
    head = tmp.read_bytes()[:4]
    if tmp.stat().st_size < 10_000 or head not in (b"\x00\x01\x00\x00", b"OTTO", b"true"):
        tmp.unlink(missing_ok=True)
        raise ValueError(f"not a font: {url}")
    os.replace(tmp, dst)


def font_dir(entry):
    """The folder libass loads caption fonts from: the bundled one, or (for other scripts) a cache holding Montserrat and
    the script's Noto font, downloaded the first time. Offline, it falls back to the bundled folder and system fonts."""
    if not entry.get("url"):
        return FONT_DIR
    if time.time() - _font_failed.get(entry["file"], 0) < 600:   # failed recently: don't stall every render retrying
        return FONT_DIR
    try:
        with _font_lock:
            FONT_CACHE.mkdir(parents=True, exist_ok=True)
            mont = FONT_CACHE / "Montserrat-Black.ttf"
            if not mont.exists():
                shutil.copyfile(Path(FONT_DIR) / "Montserrat-Black.ttf", mont)
            dst = FONT_CACHE / entry["file"]
            if not dst.exists():
                _fetch_font(entry["url"], dst)
        return str(FONT_CACHE)
    except Exception as e:  # noqa: BLE001 - captions still render with system fonts
        _font_failed[entry["file"]] = time.time()
        print(f"[fonts] couldn't get the {entry.get('label', '')} caption font ({e}); using system fonts", file=sys.stderr)
        return FONT_DIR


# checked in this order: Japanese text mixes kana with Chinese characters, so kana decides it. Mirrors scriptOf in formula.js.
_SCRIPTS = [("ko", "[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]"), ("ja", "[\u3040-\u30FF]"),
            ("zh", "[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]"),
            ("arabic", "[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]"),
            ("hebrew", "[\u0590-\u05FF]"), ("devanagari", "[\u0900-\u097F]"), ("thai", "[\u0E00-\u0E7F]"),
            ("greek", "[\u0370-\u03FF\u1F00-\u1FFF]")]
_SCRIPTS = [(k, re.compile(rx)) for k, rx in _SCRIPTS]


# common characters written differently in Traditional and Simplified Chinese: mostly Traditional → the TC font.
# Mirrors ZH_TRAD / ZH_SIMP in formula.js.
_ZH_TRAD = "這們說時國會對來為無麼後過還現開關點體發應實學問經長頭見讓話車東門書裡個樣嗎習邊錢員氣電動區專業務場總結據歡謝愛覺聽寫買賣讀認識號錯難歲鐘頁視腦網線戲聲魚鳥馬飛雲風廣漢語萬億兩幾誰"
_ZH_SIMP = "这们说时国会对来为无么后过还现开关点体发应实学问经长头见让话车东门书里个样吗习边钱员气电动区专业务场总结据欢谢爱觉听写买卖读认识号错难岁钟页视脑网线戏声鱼鸟马飞云风广汉语万亿两几谁"


def script_of(text):
    text = text or ""
    k = next((k for k, rx in _SCRIPTS if rx.search(text)), "latin")
    if k == "zh" and sum(text.count(c) for c in _ZH_TRAD) > sum(text.count(c) for c in _ZH_SIMP):
        return "zhtc"
    return k


def caption_font(m):
    """The caption font entry for a cut, from the script of its headline and spoken words."""
    words = " ".join(w["w"] for w in (m.words or []) if m.start - 0.05 <= w["s"] <= m.end)
    return CAPTION_FONTS[script_of(f"{m.title or ''} {words}")]

SR = 16000          # analysis sample rate
HOP = 0.5           # loudness resolution (seconds)


def _noop(stage, pct, msg=""):
    pass


# ---------------------------------------------------------------- download
class DownloadError:
    TOOL = ("The link downloader couldn't start.\n\n"
            "Clip Machine uses a helper called yt-dlp to fetch videos from links, and it's missing or broken. This "
            "usually happens after the app folder is moved or renamed. Run the installer in the app folder again "
            "(Install.command on Mac, Install (Windows).bat on Windows), then restart the app. Uploading the file "
            "itself still works in the meantime.")


# (pattern in yt-dlp's output, headline, what it means and what to do). First match wins.
_DL_REASONS = [
    (r"Sign in to confirm you.re not a bot|confirm your age|age.restricted|inappropriate for some users",
     "YouTube wants a signed-in viewer for this video.",
     "It's either age-restricted or YouTube is asking this computer to prove it isn't a bot. Clip Machine can't sign "
     "in for you. Download the video yourself (or wait an hour and try again), then upload the file."),
    (r"Private video|This video is private|members.only|Join this channel|requires payment|premium",
     "That video isn't public.",
     "It's private, members-only or paid, so it can only be watched while signed in. Use a public link, or upload "
     "your own copy of the file."),
    (r"video (is )?(currently )?unavailable|no longer available|has been removed|does not exist|HTTP Error 404|404: Not Found|account.*terminated",
     "That video can't be found.",
     "It may have been deleted, or the link is incomplete. Open the link in your browser to check it plays, then "
     "copy it again from the address bar."),
    (r"not available in your country|geo.?restrict|blocked it in your country",
     "That video is blocked in your region.",
     "The uploader limited where it can be watched. Use a different video, or upload a copy you're allowed to use."),
    (r"is live|live event|Premieres in|will begin in|This live stream",
     "That's a live stream or a premiere that hasn't finished.",
     "Wait until the stream has ended and the replay is up, then paste the link again."),
    (r"Unsupported URL|is not a valid URL|No video formats found|no suitable formats",
     "Clip Machine can't find a video at that link.",
     "Paste the link to the video page itself (for example youtube.com/watch?v=… or a TikTok video link), not a "
     "channel, playlist, search page or profile."),
    (r"HTTP Error 429|Too Many Requests|rate.limit",
     "The site is limiting downloads right now.",
     "Too many requests came from this network in a short time. Wait 10–30 minutes and try again, or upload the file."),
    (r"Unable to download webpage|Failed to resolve|getaddrinfo|Name or service not known|timed out|"
     r"Connection (refused|reset)|Network is unreachable|SSL|CERTIFICATE",
     "Clip Machine couldn't reach the site.",
     "Check that this computer is online (open the link in a browser). A VPN, school or work network can also block "
     "video sites. Try again once the page loads in your browser."),
    (r"HTTP Error 403|Forbidden|nsig|signature extraction|Requested format is not available|player response",
     "The site changed how it serves videos.",
     "This normally needs a newer yt-dlp. Restart Clip Machine — it updates yt-dlp each time it starts — and try "
     "the link again. If it still fails, upload the file."),
    (r"ffmpeg.*not found|merging.*failed|Postprocessing",
     "The video downloaded but couldn't be put together.",
     "The audio and video arrived separately and joining them failed. Try again; if it repeats, upload the file."),
]


def explain_download(log: str, source: str = "") -> str:
    """Turn yt-dlp's output into what happened and what to do, with the raw lines kept as details."""
    errs = [l for l in log.splitlines() if "ERROR" in l] or log.splitlines()[-4:]
    details = "\n".join(l.replace("ERROR: ", "") for l in errs[-3:]).strip()
    for pat, head, body in _DL_REASONS:
        if re.search(pat, log, re.I):
            return f"{head}\n\n{body}\n\nDetails: {details}"
    return ("The download didn't work.\n\nThe site refused or the link isn't a video page Clip Machine recognises. "
            "Check the link plays in your browser, restart Clip Machine (it updates its downloader on start), or "
            f"upload the file instead.\n\nDetails: {details}")


def explain_error(e: BaseException) -> str:
    """A job error a person can act on. Messages already written for people pass through unchanged."""
    msg = str(e).strip() or e.__class__.__name__
    if "\n\n" in msg:                       # already explained (download errors, etc.)
        return msg
    low = msg.lower()
    if isinstance(e, FileNotFoundError) or "no such file or directory" in low:
        if "yt-dlp" in low:
            return DownloadError.TOOL + f"\n\nDetails: {msg}"
        if "ffmpeg" in low or "ffprobe" in low:
            return ("The video tool (ffmpeg) is missing.\n\nClip Machine needs ffmpeg to read and cut video. Run the "
                    f"installer in the app folder again, then restart the app.\n\nDetails: {msg}")
        return ("A file Clip Machine needed has gone missing.\n\nIt may have been moved or deleted while the job ran. "
                f"Add the video again.\n\nDetails: {msg}")
    if isinstance(e, MemoryError) or "out of memory" in low or "cannot allocate" in low:
        return ("This computer ran out of memory.\n\nClose other apps, or use a shorter video or a smaller speech model "
                f"(Settings → Speech model: base).\n\nDetails: {msg}")
    if "no space left" in low:
        return ("The disk is full.\n\nDelete old jobs in Clip Machine (or other files) to free space, then try again."
                f"\n\nDetails: {msg}")
    if isinstance(e, PermissionError) or "permission denied" in low:
        return ("Clip Machine wasn't allowed to read or write a file.\n\nMove the video somewhere you own (like "
                f"Downloads or Desktop) and try again.\n\nDetails: {msg}")
    if "huggingface" in low or "hf.co" in low or ("model" in low and ("connection" in low or "resolve" in low)):
        return ("The speech model couldn't download.\n\nThe first run fetches it from the internet (once). Check this "
                f"computer is online and try again.\n\nDetails: {msg}")
    if "calledprocesserror" in e.__class__.__name__.lower() or "returned non-zero exit status" in low:
        return ("The video tool stopped partway.\n\nThe file may be damaged or in an unusual format. Try converting it "
                f"to MP4, or use another copy.\n\nDetails: {msg}")
    return msg


def fetch(source: str, workdir: Path, progress=_noop) -> tuple[Path, str]:
    """Return (video_path, title). `source` is a URL or a local file path."""
    workdir.mkdir(parents=True, exist_ok=True)
    p = Path(os.path.expanduser(source))
    if p.exists():
        progress("download", 100, "Using local file")
        return p, p.stem

    progress("download", 0, "Starting download")
    out_tmpl = str(workdir / "source.%(ext)s")
    cmd = [
        *_ytdlp_cmd(), "--no-playlist", "--newline", "--no-warnings",
        "--js-runtimes", "node",
        "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b",
        "--merge-output-format", "mp4",
        "--ffmpeg-location", str(Path(FFMPEG).parent),
        "--print", "before_dl:TITLE:%(title)s",
        "-o", out_tmpl, source,
    ]
    title = "video"
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                encoding="utf-8", errors="replace")
    except OSError as e:
        raise RuntimeError(DownloadError.TOOL + f"\n\nDetails: {e}") from None
    tail = []
    for line in proc.stdout:
        line = line.strip()
        tail = (tail + [line])[-15:]
        if line.startswith("TITLE:"):
            title = line[6:].strip() or title
        m = re.search(r"\[download\]\s+([\d.]+)%", line)
        if m:
            progress("download", float(m.group(1)), "Downloading")
    if proc.wait() != 0:
        raise RuntimeError(explain_download("\n".join(tail), source))
    vids = sorted(workdir.glob("source.*"), key=lambda f: f.stat().st_size, reverse=True)
    vids = [v for v in vids if v.suffix in (".mp4", ".mkv", ".webm", ".mov")]
    if not vids:
        raise RuntimeError("Download finished but no video file was found.")
    progress("download", 100, "Downloaded")
    return vids[0], title


def probe(path: Path) -> dict:
    r = subprocess.run([FFPROBE, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
                       capture_output=True, text=True)
    try:
        info = json.loads(r.stdout)
        assert r.returncode == 0 and info.get("streams")
    except Exception:
        raise RuntimeError("Couldn't read that file. It may be corrupt, still downloading, or an unsupported format. "
                           "Try an MP4 or MOV.")
    v = next((s for s in info["streams"] if s["codec_type"] == "video"
              and s.get("disposition", {}).get("attached_pic") != 1), None)   # ignore album-art "video"
    a = next((s for s in info["streams"] if s["codec_type"] == "audio"), None)
    return {
        "has_audio": a is not None,
        "duration": float(info["format"].get("duration", 0)),
        "width": int(v["width"]) if v else 0,
        "height": int(v["height"]) if v else 0,
        "has_video": v is not None,
        "fps": _fps(v.get("avg_frame_rate") or v.get("r_frame_rate")) if v else 30,
    }


def _fps(r):
    try:
        a, b = (r or "30/1").split("/")
        return float(a) / float(b or 1) if float(b or 1) else 30.0
    except Exception:
        return 30.0


# ---------------------------------------------------------------- audio analysis
def extract_audio(video: Path, wav: Path):
    subprocess.run([FFMPEG, "-y", "-v", "error", "-i", str(video), "-vn", "-ac", "1",
                    "-ar", str(SR), "-f", "s16le", str(wav)], check=True)   # headerless PCM: no WAV-header guessing


def loudness_curve(wav: Path) -> np.ndarray:
    """Per-HOP loudness in dB, z-scored against the whole video."""
    raw = np.fromfile(wav, dtype=np.int16).astype(np.float32) / 32768.0
    hop = int(SR * HOP)
    n = len(raw) // hop
    if n == 0:
        return np.zeros(1)
    frames = raw[: n * hop].reshape(n, hop)
    rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-10)
    db = 20 * np.log10(rms)
    db = np.maximum(db, np.percentile(db, 5))          # ignore dead silence floor
    sd = db.std() or 1.0
    return (db - np.median(db)) / sd


def quiet_map(wav: Path, step=0.05) -> dict:
    """Level every 50 ms in dB (the studio draws its waveform from this) + the 'quiet' threshold."""
    raw = np.fromfile(wav, dtype=np.int16).astype(np.float32) / 32768.0
    hop = int(round(SR * step)); n = len(raw) // hop
    if n == 0:
        return {"step": step, "thr": -60.0, "db": []}
    db = 10 * np.log10(np.mean(raw[: n * hop].reshape(n, hop) ** 2, axis=1) + 1e-12)
    speech = float(np.sort(db)[int(n * 0.7)])
    return {"step": step, "thr": round(speech - 25, 2), "db": [round(float(x), 1) for x in db]}


def audio_peak_db(wav: Path) -> float:
    raw = np.fromfile(wav, dtype=np.int16)
    return float(20 * np.log10(max(int(np.abs(raw).max()) if raw.size else 0, 1) / 32768))


# ---------------------------------------------------------------- transcription
_MODEL_CACHE = {}


# Whisper language codes accepted from the page ("auto" = detect from the audio first).
LANGUAGES = ("auto", "af", "ar", "bg", "bn", "ca", "cs", "cy", "da", "de", "el", "en", "es", "et", "fa", "fi", "fr", "he", "hi", "hr", "hu",
             "id", "it", "ja", "ko", "lt", "lv", "ms", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sl", "sr", "sv", "sw", "ta", "th", "tl",
             "tr", "uk", "ur", "vi", "zh", "zh-Hant")   # zh = Simplified Chinese, zh-Hant = Traditional (same speech model)
EN_PROMPT = "Umm, let me think, uh, like, hmm... Okay, so, um, here's what I'm thinking."


# Chinese, Japanese, Thai, Lao, Khmer and Burmese don't put spaces between words; everything else does.
# Mirrors joinWords in docs/formula.js: captions and subtitle files must come out identical in both engines.
_NOSPACE = re.compile("[\u0E00-\u0EFF\u1000-\u109F\u1780-\u17FF\u2E80-\u2FFF\u3000-\u303F\u3040-\u30FF\u3100-\u312F"
                      "\u3190-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFF60]")


# A sentence ends on . ! ? (or 。！？ ؟ ।), optionally followed by closing quotes or brackets. Mirrors SENT_END in formula.js.
SENT_END = re.compile("[.!?\u3002\uFF01\uFF1F\u061F\u0964][\"'\u2019\u201D)\\]\u300D\u300F\u00BB]*$")


def join_words(raw, parts=None):
    """Join words (raw), or display parts built from them (e.g. with highlight tags), spacing by the raw words."""
    parts = list(raw) if parts is None else list(parts)
    out = ""
    for i, p in enumerate(parts):
        if i:
            a, b = str(raw[i - 1]), str(raw[i])
            tight = (a and _NOSPACE.match(a[-1])) or (b and _NOSPACE.match(b[0])) or (a and b and (b[0] in "'\u2019" or a[-1] in "'\u2019"))
            out += "" if tight else " "   # no space by an apostrophe split off by the speech model (s'est, l'équipe)
        out += p
    return out


# Languages the smaller models can't write properly (base writes Hindi in Urdu script): always use this size.
# Mirrors BIG_MODEL in docs/app.js.
BIG_MODEL = {"hi": "small"}
_SIZES = ("tiny", "base", "small", "medium", "large-v3")


# Whisper writes Chinese in either script, often Traditional even for Mainland speech. Convert to the one asked for
# (auto-detected Chinese → Simplified). Pure-Python OpenCC, installed on first use if an older install lacks it.
ZH_CONVERT = {"zh": "t2s", "zh-Hant": "s2tw"}


def _zh_words(words, conv):
    """Convert a segment's words together (one word alone loses context: 周 → 週 only in 一周), then cut the result
    back into the same words; the conversion keeps the character count. Mirrors zhWords in docs/app.js."""
    raw = "".join(w["w"] for w in words)
    out = conv(raw)
    if len(out) != len(raw):
        for w in words:
            w["w"] = conv(w["w"])
        return
    i = 0
    for w in words:
        n = len(w["w"])
        w["w"], i = out[i:i + n], i + n


def _zh_converter(cfg):
    try:
        import opencc
    except ImportError:
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "opencc-python-reimplemented==0.1.7"],
                       capture_output=True, timeout=300)
        import opencc
    return opencc.OpenCC(cfg)


_DEVICE = None   # where Whisper runs: "mps" (Apple GPU) or "cpu"; decided on first use


def _whisper_device():
    """Apple Silicon: the GPU (Metal) backend, 1.3-3x faster than the CPU and the same words (measured 16 Nov 2026 on
    5 min of speech: base 720/720 words identical, small 3.3x faster). CLIP_DEVICE=cpu forces the CPU."""
    want = os.environ.get("CLIP_DEVICE", "").strip().lower()
    if want in ("cpu", "mps"):
        return want
    if sys.platform == "darwin" and platform.machine() == "arm64":
        try:
            import ctranslate2
            if "float16" in ctranslate2.get_supported_compute_types("mps"):
                return "mps"
        except Exception:  # noqa: BLE001 - an older ctranslate2 or macOS without Metal: the CPU it is
            pass
    return "cpu"


def _cpu_fallback(err):
    global _DEVICE
    print(f"[speech] the Apple GPU backend failed ({err}); using the CPU", file=sys.stderr)
    _DEVICE = "cpu"


def _whisper(size):
    global _DEVICE
    from faster_whisper import WhisperModel
    if _DEVICE is None:
        _DEVICE = _whisper_device()
    key = (size, _DEVICE)
    if key not in _MODEL_CACHE:
        try:   # the GPU backend runs float16 (it turns int8 into float16 anyway)
            _MODEL_CACHE[key] = WhisperModel(size, device=_DEVICE, compute_type="float16" if _DEVICE == "mps" else "int8")
        except Exception as e:  # noqa: BLE001
            if _DEVICE == "cpu":
                raise
            _cpu_fallback(e)
            return _whisper(size)
    return _MODEL_CACHE[key]


def transcribe(wav: Path, model_size="base", progress=_noop, duration=None, language="auto") -> list[dict]:
    audio = np.fromfile(wav, dtype=np.int16).astype(np.float32) / 32768.0

    def run(language):
        progress("transcribe", 0, f"Loading speech model ({model_size})")
        model = _whisper(model_size)
        if language not in LANGUAGES or language == "auto":
            # detect first, so the English filler prompt below can't pull other languages towards English
            language, _, _ = model.detect_language(audio, vad_filter=True, language_detection_segments=3)
        big = BIG_MODEL.get(language)
        if big and model_size in _SIZES and _SIZES.index(model_size) < _SIZES.index(big):
            progress("transcribe", 0, f"Loading the {big} speech model: smaller ones can't write this language correctly")
            model = _whisper(big)
        segs_iter, info = model.transcribe(audio, language="zh" if language in ZH_CONVERT else language, word_timestamps=True,
                                           vad_filter=True, beam_size=1, condition_on_previous_text=False,
                                           # nudges Whisper to write out "um/uh" instead of silently dropping them (English only)
                                           initial_prompt=EN_PROMPT if language == "en" else None)
        total = duration or info.duration or 1
        segs = []
        for s in segs_iter:
            words = [{"w": w.word.strip(), "s": w.start, "e": w.end, "p": round(float(getattr(w, "probability", 1) or 0), 3)}
                     for w in (s.words or []) if w.word.strip()]
            segs.append({"s": s.start, "e": s.end, "text": s.text.strip(), "words": words})
            progress("transcribe", min(99, 100 * s.end / total), f"Transcribing {fmt_t(s.end)} / {fmt_t(total)}")
        return segs, info, language

    try:
        segs, info, language = run(language)
    except Exception as e:  # noqa: BLE001 - the GPU backend is experimental: redo the whole video on the CPU
        if _DEVICE != "mps":
            raise
        _cpu_fallback(e)
        segs, info, language = run(language)
    if language in ZH_CONVERT:
        try:
            cc = _zh_converter(ZH_CONVERT[language])
            for s in segs:
                s["text"] = cc.convert(s["text"])
                _zh_words(s["words"], cc.convert)
        except Exception as e:  # noqa: BLE001 - the transcript is still usable as Whisper wrote it
            print(f"[chinese] couldn't convert the script ({e}); keeping Whisper's characters", file=sys.stderr)
    progress("transcribe", 100, f"Transcribed ({info.language})")
    return segs


# ---------------------------------------------------------------- platform formulas
# Each platform gets two test lengths: a SHORT cut (the demo/payoff) and a LONG cut (same opening + a second payoff).
# Length ranges are "Data → Test": observational studies, not platform rules (see FORMULA.md, Nov 13 2026 research).
# Hard limits and ranking signals are "Official" where the platform documents them.
# Safe zones (1080x1920 px) are conservative estimates; no platform publishes organic pixel specs. Preview on a phone.
PLATFORMS = {
    "all": dict(
        name="All platforms", short=(12, 18), long=(30, 45), hard_max=140,
        cap_bottom=700, hook_top=300, right=180, tags=3,
        note="One export for TikTok, Reels and Shorts: a 12–18s cut and a 30–45s cut with the same opening. "
             "Captions are kept clear of every app's buttons.",
        judge=["Stayed to watch (Shorts)", "Sends per reach (Reels)", "Full watches + shares (TikTok)"],
        publish=[]),
    "tiktok": dict(
        name="TikTok", short=(12, 18), long=(20, 30), hard_max=600,
        cap_bottom=700, hook_top=280, right=180, tags=3,
        note="Official: For You weighs interactions such as watching in full, skips, time spent, shares and comments. "
             "In Search, how well the post matches the query matters most. Data: under 15s led plays per follower for small "
             "accounts, and 15–30s led interactions per play. Use 45–90s only for a real build story.",
        judge=["Average watch time", "Full watches %", "Shares"],
        publish=["Write the caption the way someone would search for it (check Creator Search Insights).",
                 "Use 2–3 relevant tags. #FYP works like any other hashtag (TikTok).",
                 "Promoting your own product? Turn on commercial disclosure. TikTok says it doesn't affect feed distribution.",
                 "Use original or cleared audio, and record the real sound up close.",
                 "Check post visibility and For You eligibility in the app."]),
    "reels": dict(
        name="Instagram Reels", short=(12, 18), long=(30, 45), hard_max=180,
        cap_bottom=620, hook_top=300, right=160, tags=3,
        note="Official/reported: Mosseri highlighted watch time, likes per reach and sends per reach. Sends matter most for "
             "people who don't follow you. Skip rate can affect distribution. Reels over 3 min aren't recommended to new audiences. "
             "Data: 30–60s and under 30s had similar reach rates, so let the creative decide.",
        judge=["Average watch time", "Sends per reach", "Skip rate"],
        publish=["Public, recommendation-eligible account. Check Account Status.",
                 "Turn on highest-quality uploads, and upload the clean export (no other app's watermark).",
                 "Pick a readable cover frame.",
                 "Try Trial Reels to test a new concept on non-followers first.",
                 "Give people a reason to send it to a friend."]),
    "shorts": dict(
        name="YouTube Shorts", short=(15, 30), long=(30, 60), hard_max=180,
        cap_bottom=560, hook_top=260, right=150, tags=2,
        note="Official: Shorts are matched by watch and search history, topics and sampled audio. YouTube reports "
             "'chose to view', average view duration and percent viewed. Data: 11–30s led median views in two large samples. "
             "Use 30–60s for a story. Public views have counted replays since Mar 2025, so judge by engaged views.",
        judge=["Stayed to watch %", "Engaged views", "Average % viewed"],
        publish=["Write a title someone who's never heard of you would understand in Search.",
                 "Set the audience (made for kids or not) and visibility. Uploads from 13–17 year-olds default to private.",
                 "Over 1 minute with an active Content ID claim = blocked worldwide. Use owned audio on long cuts.",
                 "Add a related video linking to the full version if you have one.",
                 "No minimum posting cadence. Post when your audience is active."]),
    "facebook": dict(
        name="Facebook Reels", short=(15, 30), long=(30, 60), hard_max=300,
        cap_bottom=620, hook_top=300, right=160, tags=2,
        note="Official: all Facebook video uploads are now Reels, with no separate length cap. Original footage and real "
             "transformations get priority over reposted or lightly edited clips (Mar 2026). No proven length optimum.",
        judge=["Watch time", "Shares", "Comments"],
        publish=["Set the Reel audience to Public.",
                 "Write a caption that explains the payoff to someone who doesn't know the project.",
                 "Use owned or licensed audio."]),
    "snapchat": dict(
        name="Snapchat Spotlight", short=(10, 20), long=None, hard_max=60,
        cap_bottom=620, hook_top=300, right=160, tags=2,
        note="Official: Spotlight scores expected watch time, favourites, shares and skips. Since Apr 2026 it favours footage "
             "shot on Snapchat's own camera, and since Jul 2026 fully AI-generated video isn't recommended. Test 10–20s. "
             "There's a 5s minimum. Treat it as a separate experiment.",
        judge=["Watch time", "Favourites", "Shares"],
        publish=["Spotlight favours footage shot in Snapchat's own camera. For a real test, film a fresh take in the app.",
                 "Posting is open to ages 16+ in eligible regions.",
                 "Use owned or licensed audio."]),
    "x": dict(
        name="X / Twitter", short=(15, 30), long=(30, 45), hard_max=140,
        cap_bottom=380, hook_top=160, right=70, tags=1,
        note="Free accounts are capped at 2:20 and 512 MB. Not covered by the Nov 2026 research, so the lengths are a guess.",
        judge=["Views", "Reposts", "Watch-through"],
        publish=["Keep it under 2:20 if you don't have Premium."]),
}
for _p in PLATFORMS.values():   # back-compat: the "sweet" range = the main (long if present) version
    _p["sweet"] = _p["long"] or _p["short"]

# ---------------------------------------------------------------- scoring
# Phrases only where a common word would match ordinary speech: "what the" alone hit "what the space shuttle could
# carry", and "what", "why", "yes", "wait" or "you need to" turn up in almost every sentence of a real interview, so
# they ranked answers by word count instead of excitement (17 Nov 2026 eval on real interviews). An opening question
# still counts through HOOK_RX.
HYPE = {
    # reaction / arousal (high-arousal emotion is the best-supported sharing driver)
    "oh my god": 3, "omg": 2, "no way": 3, "what the hell": 3, "what the heck": 3, "what the f": 3, "let's go": 3, "lets go": 3,
    "insane": 2.5, "crazy": 2, "holy": 2.5, "unbelievable": 2.5, "oh no": 2.5, "shut up": 2,
    "are you serious": 3, "i can't believe": 3, "wow": 1.5, "whoa": 2, "bro": 1, "dude": 1,
    "clutch": 2, "wait what": 2, "wait wait": 1.5, "damn": 1.5, "hell": 1, "screaming": 2,
    # story / curiosity-gap language
    "here's the thing": 2.5, "the truth": 2, "nobody": 1.2, "secret": 2, "mistake": 1.5,
    "biggest": 1.2, "worst": 1.5, "best": 0.8, "never": 0.8, "million": 1.5, "money": 1,
    "you need to see": 1.5, "you need to know": 1.5, "you need to hear": 1.5, "stop": 1, "the reason": 1.5, "plot twist": 3, "honestly": 0.8,
    "i was wrong": 2.5, "changed my life": 2.5, "the craziest": 3, "scared": 1.5, "died": 1.5,
    "turns out": 2, "the problem": 1.5, "nobody talks about": 3, "how to": 1.2,
    # the same reactions and story hooks in other languages (lowercase; matched as whole words,
    # or anywhere in the text for Chinese, Japanese, Korean and Thai, which don't separate words)
    # es
    "dios mío": 3, "no puede ser": 3, "qué locura": 3, "increíble": 2.5, "madre mía": 3, "qué fuerte": 2.5,
    "no me lo puedo creer": 3, "en serio": 2, "el secreto": 2, "nadie": 1.2, "la verdad es": 2,
    # pt
    "meu deus": 3, "não acredito": 3, "que loucura": 3, "inacreditável": 2.5, "caramba": 2, "o segredo": 2,
    "ninguém": 1.2,
    # fr
    "mon dieu": 3, "c'est pas possible": 3, "c'est fou": 3, "j'y crois pas": 3, "incroyable": 2.5, "de ouf": 2.5,
    "sérieux": 1.5, "le secret": 2, "personne ne": 1.2,
    # de
    "oh mein gott": 3, "das gibt's doch nicht": 3, "krass": 2.5, "wahnsinn": 2.5, "unglaublich": 2.5,
    "verrückt": 2, "ernsthaft": 1.5, "geheimnis": 2, "niemand": 1.2,
    # it
    "mamma mia": 3, "non ci credo": 3, "pazzesco": 2.5, "incredibile": 2.5, "assurdo": 2, "il segreto": 2,
    "nessuno": 1.2,
    # ru
    "боже мой": 3, "не может быть": 3, "офигеть": 2.5, "невероятно": 2.5, "капец": 2, "серьёзно": 1.5,
    "серьезно": 1.5, "секрет": 2, "никто": 1.2, "вау": 1.5,
    # tr
    "aman allahım": 3, "inanamıyorum": 3, "inanılmaz": 2.5, "çılgın": 2, "kimse": 1.2,
    # hi
    "हे भगवान": 3, "क्या बात है": 3, "कमाल": 2.5, "गज़ब": 2.5, "गजब": 2.5, "अविश्वसनीय": 2.5, "पागल": 2,
    "सच में": 1.5, "वाह": 1.5, "कोई नहीं": 1.2,
    # ar
    "يا إلهي": 3, "لا أصدق": 3, "مستحيل": 2.5, "مجنون": 2, "رهيب": 2, "واو": 1.5, "والله": 1.5, "السر": 2,
    "لا أحد": 1.2,
    # id
    "ya ampun": 3, "nggak mungkin": 3, "gak mungkin": 3, "gila": 2, "luar biasa": 2, "rahasia": 2, "anjir": 1.5,
    # vi
    "trời ơi": 3, "không thể tin": 3, "quá đỉnh": 2.5, "bí mật": 2, "không ai": 1.2,
    # ja
    "信じられない": 3, "嘘でしょ": 3, "やばい": 2.5, "ヤバい": 2.5, "マジで": 2.5, "まじか": 2.5, "すごい": 2,
    "最高": 1.5, "秘密": 2, "誰も": 1.2,
    # ko
    "말도 안 돼": 3, "세상에": 2.5, "대박": 2.5, "미쳤다": 2.5, "최고": 1.5, "비밀": 2, "아무도": 1.2,
    # zh
    "我的天": 3, "真的假的": 3, "太离谱": 3, "太離譜": 3, "天哪": 2.5, "不可能": 2.5, "绝了": 2.5, "厉害": 1.5,
    "厲害": 1.5, "没有人": 1.2, "沒有人": 1.2,
}
# no word spaces in these scripts, so their phrases match anywhere. Mirrors NOSPACE_KEY in formula.js.
_NOSPACE_KEY = re.compile("[\u0E00-\u0EFF\u1000-\u109F\u1780-\u17FF\u3040-\u30FF\u3400-\u4DBF"
                          "\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]")


def _word_ch(c):
    return c == "_" or unicodedata.category(c)[0] in "LMN"


def has_key(low, k):
    """Is phrase k in lowercased text low as a whole word? (Unicode-aware; plain \\b is ASCII-only in JavaScript.)"""
    if _NOSPACE_KEY.search(k):
        return k in low
    i = low.find(k)
    while i >= 0:
        j = i + len(k)
        if (i == 0 or not _word_ch(low[i - 1])) and (j >= len(low) or not _word_ch(low[j])):
            return True
        i = low.find(k, i + 1)
    return False


def _hype(text):
    low = text.lower().replace("\u2019", "'").replace("i\u0307", "i")   # either apostrophe; Turkish İ lowercases to i + dot
    return [(k, w) for k, w in HYPE.items() if has_key(low, k)]
HOOK_RX = re.compile(r"[?？؟]|\b(you|your|why|how|what if|imagine|never|stop|nobody|secret|here's|this is|the \w+est)\b|\d", re.I)
MIDSTART = {"and", "but", "so", "because", "cause", "or", "then", "which", "that", "also", "um", "uh", "like"}
SPONSOR = ["sponsored by", "use code", "link in the description", "smash that like", "subscribe",
           "today's sponsor", "promo code", "patreon", "this video is brought"]
LAUGH = re.compile(r"\b(ha(ha)+|lol|lmao)\b|\[(laugh|laughter|laughing)[^\]]*\]|\((laugh|laughs|laughter|laughing)\)"
                   # laughter as other languages write it: jajaja, kkkk, rsrs, mdr, хаха, 哈哈, 呵呵, ㅋㅋ, 하하, ههه, हाहा, ฮ่าๆ, (笑)
                   r"|(?:ja){3,}|k{4,}|(?:rs){2,}|\bmdr\b|(?:ха){2,}|哈{2,}|呵{2,}|[ㅋㅎ]{2,}|(?:하){2,}|ه{3,}|(?:हा){2,}"
                   r"|(?:ฮ่า){2,}|ฮ่าๆ|[（(]笑[)）]", re.I)
STOP = set("""the a an and or but if so to of in on at for with is are was were be been it this that
these those i you he she we they me my your our their his her its not no yes do does did have has had
just like really very can could would should will gonna wanna yeah okay right know think going
what when where who why how there here then than them about from into out up down get got one all
some because also well even still back over only much more most other""".split())


WEAK = set("""actually basically literally really pretty maybe probably something everything anything nothing
things thing stuff little finally start started starting theres about around always never anyway gonna
because before after again every these those would could should their there where which while being doing
going getting making saying thinking talking trying looking wanted wants first second right sorta kinda
other another yourself myself someone everyone people""".split())


@dataclass
class Moment:
    start: float
    end: float
    score: float = 0.0
    text: str = ""
    reasons: list = field(default_factory=list)
    checklist: list = field(default_factory=list)
    title: str = ""
    hashtags: list = field(default_factory=list)
    captions: dict = field(default_factory=dict)
    words: list = field(default_factory=list)
    signals: dict = field(default_factory=dict)   # each scoring signal relative to this video (z-score), for learning from results
    rel: float = 1.0                                # rank among this video's moments (0 = weakest picked, 1 = best)
    title_sure: bool = True                         # False when every sentence it could use was transcribed with low confidence
    short_note: str = ""                            # why there's no short cut, when there isn't one
    norm: dict = field(default_factory=dict, repr=False)   # this video's signal baseline, so a short cut can be scored the same way


CLAUSE_END = re.compile("[,;:\uFF0C\u3001\uFF1B\uFF1A][\"'\u2019\u201D)\\]\u300D\u300F\u00BB]*$")


def _split_long(seg):
    """Whisper can return one long segment for a stretch of speech with only commas in it (common in Chinese and
    Japanese). Clip boundaries snap to segments, so split anything over 12 s at sentence ends, clauses and pauses.
    Mirrors splitLong in formula.js."""
    ws = seg.get("words") or []
    if seg["e"] - seg["s"] <= 12 or not ws:
        return [seg]
    out, cur = [], []

    def flush():
        if cur:
            out.append({"s": cur[0]["s"], "e": cur[-1]["e"], "text": join_words([w["w"] for w in cur]), "words": list(cur)})
            cur.clear()
    for w in ws:
        if cur and (w["s"] - cur[-1]["e"] > 1.0 or w["s"] - cur[0]["s"] > 12):
            flush()
        cur.append(w)
        if SENT_END.search(w["w"]) or (CLAUSE_END.search(w["w"]) and w["e"] - cur[0]["s"] >= 5):
            flush()
    flush()
    return out


def _units(segs, duration):
    """Sentence-ish units to snap clip boundaries to. Falls back to 5 s blocks (with their words) when there are
    too few, e.g. for a video without speech."""
    units = [u for s in segs if s["e"] > s["s"] for u in _split_long(s)]
    if len(units) < 4:
        words = [w for s in segs for w in (s.get("words") or [])]
        units = []
        for t in np.arange(0, max(duration - 1, 1), 5.0):
            t = float(t)
            ws = [w for w in words if t <= w["s"] < t + 5]
            units.append({"s": t, "e": min(duration, t + 5), "text": join_words([w["w"] for w in ws]), "words": ws})
    return units


def _first_word(text):
    m = re.match(r"\W*([a-zA-Z']+)", text or "")
    return m.group(1).lower() if m else ""


def _features(s, e, text, words, loud, first_text, plat):
    lo, hi = int(s / HOP), max(int(e / HOP), int(s / HOP) + 1)
    seg = loud[lo:hi] if lo < len(loud) else np.zeros(1)
    if len(seg) == 0:
        seg = np.zeros(1)
    top = np.sort(seg)[-max(1, len(seg) // 3):]
    head = loud[lo: lo + int(3 / HOP)] if lo < len(loud) else np.zeros(1)
    tail = seg[-max(1, len(seg) // 4):]
    first1 = loud[lo: lo + int(1 / HOP)] if lo < len(loud) else np.zeros(1)
    first_words = " ".join(w["w"] for w in words if w["s"] < s + 1.5)
    low = text.lower()
    kw_hits = _hype(text)
    dur = max(e - s, 1)
    # first ~3 s of speech: the hook window
    head_words = " ".join(w["w"] for w in words if w["s"] < s + 3.0) or first_text[:60]
    hook_lang = len(HOOK_RX.findall(head_words)) + sum(w for _, w in _hype(head_words))
    # dead air: silence between words longer than 0.7 s
    gaps = [b["s"] - a["e"] for a, b in zip(words, words[1:]) if b["s"] - a["e"] > 0.7]
    lead = (words[0]["s"] - s) if words else 0
    lo_sw, hi_sw = plat["sweet"]
    fit = 1.0 if lo_sw <= dur <= hi_sw else max(0.0, 1 - min(abs(dur - lo_sw), abs(dur - hi_sw)) / 20)
    return {
        "energy": float(top.mean()),
        "peak": float(seg.max()),
        "swing": float(seg.std()),
        "hype": sum(w for _, w in kw_hits),
        "laugh": len(LAUGH.findall(text)),
        "exclaim": text.count("!"),
        "pace": len(words) / dur,
        "hook": float(head.mean() if len(head) else 0) + 0.8 * min(hook_lang, 4),
        "first1": float(first1.mean() if len(first1) else 0),
        "payoff": float(tail.mean() - seg.mean()),
        "ends_clean": 1.0 if SENT_END.search(text.strip()) else 0.0,
        "midstart": 1.0 if _first_word(first_text) in MIDSTART else 0.0,
        "deadair": (sum(gaps) + max(lead, 0)) / dur,
        "fit": fit,
        "sponsor": sum(1 for k in SPONSOR if k in low),
        "_kw": [k for k, _ in sorted(kw_hits, key=lambda x: -x[1])[:4]],
        "_hook_lang": hook_lang,
        "_first_hook": bool(HOOK_RX.search(first_words)) or bool(_hype(first_words)),
    }


# Weights encode the formula. Z-scored features compete inside one video; raw ones are absolute.
# Desktop only: how clip-worthy the words are, from the search model (search.interest_curve). On real interviews
# (4 NASA videos, 30 moments marked blind) it took picks on a marked moment from 6/20 to 9/20 and right top picks
# from 0/4 to 2/4; weights 1-3 all helped. Not in WEIGHTS, so formula.js and the short-cut rescoring are unchanged.
INTEREST_WEIGHT = 2.0
WEIGHTS = {"energy": 1.0, "peak": 0.5, "swing": 0.3, "hype": 0.8, "laugh": 0.8, "exclaim": 0.3,
           "pace": 0.4, "hook": 1.2, "first1": 0.6, "payoff": 0.5, "ends_clean": 0.5,
           "midstart": -0.9, "deadair": -0.6, "fit": 0.9, "sponsor": -1.5}
RAW = {"midstart", "fit", "sponsor", "ends_clean"}   # used as-is, not z-scored


def find_moments(segs, loud, duration, n=5, min_len=None, max_len=None, platform="all", progress=_noop,
                 version="both", interest=None) -> list[Moment]:
    """interest: optional per-HOP curve of how clip-worthy the words are (search.interest_curve, desktop only). It adds
    INTEREST_WEIGHT x its z-score to each candidate; without it the ranking is exactly formula.js's."""
    base = PLATFORMS.get(platform, PLATFORMS["all"])
    rng = base["long"] if (version in ("both", "long") and base["long"]) else base["short"]
    if min_len or max_len:
        rng = (min_len or rng[0], max_len or rng[1])
    plat = dict(base, sweet=rng)
    min_len = rng[0]
    max_len = min(rng[1] + 2, plat["hard_max"])
    min_len = min(min_len, max_len - 3)
    progress("score", 0, "Scoring moments")
    units = _units(segs, duration)
    cands = []
    for i in range(len(units)):
        for j in range(i, len(units)):
            words = [w for u in units[i:j + 1] for w in u["words"]]
            # snap to speech: start just before the first word, end just after the last
            s = max(0.0, (words[0]["s"] - 0.12) if words else units[i]["s"])
            e = min(duration, (words[-1]["e"] + 0.35) if words else units[j]["e"])
            d = e - s
            if d > max_len:
                break
            if d < min_len:
                continue
            text = " ".join(u["text"] for u in units[i:j + 1]).strip()
            cands.append((s, e, text, words, _features(s, e, text, words, loud, units[i]["text"], plat)))
    if not cands:  # video shorter than min_len: take the whole thing
        words = [w for u in units for w in u["words"]]
        text = " ".join(u["text"] for u in units)
        e = min(duration, plat["hard_max"])
        cands = [(0.0, e, text, words, _features(0, e, text, words, loud, text, plat))]

    keys = list(WEIGHTS)
    mat = np.array([[c[4][k] for k in keys] for c in cands], dtype=float)
    mu, sd = mat.mean(0), mat.std(0)
    # a signal that doesn't vary across candidates is neutral; float32 rounding leaves a ~1e-9 spread that would
    # otherwise be blown up into a ranking (and disagree with formula.js, which works in float64)
    flat = sd <= 1e-6 * np.maximum(1, np.abs(mu))
    sd[flat] = 1
    z = (mat - mu) / sd
    z[:, flat] = 0
    for k in RAW:
        z[:, keys.index(k)] = mat[:, keys.index(k)]
    scores = z @ np.array([WEIGHTS[k] for k in keys])
    zi = np.zeros(len(cands))
    if interest is not None and len(interest):
        iv = np.array([_curve_mean(interest, c[0], c[1]) for c in cands])
        if iv.std() > 1e-6:
            zi = (iv - iv.mean()) / iv.std()
            scores = scores + INTEREST_WEIGHT * zi

    order = np.argsort(-scores, kind="stable")   # ties keep candidate order, like the stable sort in formula.js
    def moment(idx):
        s, e, text, words, f = cands[idx]
        zrow = dict(zip(keys, z[idx]))
        reasons = _reasons(zrow, f)
        if zi[idx] >= 1:
            reasons.insert(0, "a standout story or fact")
        sig = {k: round(float(v), 2) for k, v in zrow.items()}
        if interest is not None:
            sig["interest"] = round(float(zi[idx]), 2)
        return Moment(start=round(s, 2), end=round(e, 2), score=float(scores[idx]), text=text,
                      words=words, reasons=reasons, checklist=_checklist(zrow, f, e - s, plat),
                      signals=sig,
                      norm={"mu": mu.tolist(), "sd": sd.tolist(), "flat": flat.tolist(), "plat": plat})

    picked: list[Moment] = []
    for idx in order:
        s, e = cands[idx][0], cands[idx][1]
        if any(not (e + 2 <= m.start or s >= m.end + 2) for m in picked):
            continue
        picked.append(moment(idx))
        if len(picked) >= n:
            break
    if 0 < len(picked) < n:   # the greedy pass can strand the gaps (a middle pick leaves no room for another clip)
        ranked = [(cands[i][0], cands[i][1], float(scores[i])) for i in order]
        best = _best_set(ranked, n)
        if len(best) > len(picked):
            picked = [moment(order[j]) for j in best]

    if picked:
        hi, lo = picked[0].score, min(m.score for m in picked)
        for m in picked:  # 0-100 score relative to this video, nudged by how many checks pass
            passed = sum(c["ok"] for c in m.checklist) / max(len(m.checklist), 1)
            rel = (m.score - lo) / (hi - lo) if hi > lo else 1
            m.rel = round(float(rel), 4)
            m.score = _score(rel, m.checklist)
            m.title, m.title_sure = _title(m, segs, with_confidence=True)
            m.hashtags = _tags(m.text, plat["tags"])
    progress("score", 100, f"Found {len(picked)} moments")
    return picked


def _curve_mean(curve, s, e):
    x = curve[int(s / HOP): int(e / HOP) + 1]
    x = x[~np.isnan(x)]
    return float(x.mean()) if len(x) else 0.0


def _best_set(ranked, n, gap=2.0):
    """Positions (into `ranked`: (start, end, score) sorted best first) of the most clips, up to n, that keep the best
    moment and sit at least `gap` s apart, with the highest total score among sets that size. Used when the greedy
    pick comes up short. Mirrors bestSet in formula.js."""
    s0, e0, _ = ranked[0]
    ok = sorted((j for j in range(1, len(ranked)) if ranked[j][1] + gap <= s0 or ranked[j][0] >= e0 + gap),
                key=lambda j: (ranked[j][1], ranked[j][0], j))
    k, L = n - 1, len(ok)
    ends = [ranked[j][1] for j in ok]
    NEG = float("-inf")
    dp = [[0.0] + [NEG] * k]
    prev = []
    for t, j in enumerate(ok):
        p, hi = 0, t   # ends are sorted, so the clips that finish in time are a prefix: binary search for its length
        while p < hi:
            mid = (p + hi) // 2
            if ends[mid] + gap <= ranked[j][0]:
                p = mid + 1
            else:
                hi = mid
        prev.append(p)
        row = list(dp[t])
        for c in range(1, k + 1):
            if dp[p][c - 1] > NEG and dp[p][c - 1] + ranked[j][2] > row[c]:
                row[c] = dp[p][c - 1] + ranked[j][2]
        dp.append(row)
    c = max(c for c in range(k + 1) if dp[L][c] > NEG)
    out, t = [0], L
    while c and t:
        if dp[t][c] == dp[t - 1][c]:
            t -= 1
        else:
            out.append(ok[t - 1])
            t, c = prev[t - 1], c - 1
    return sorted(out)


def _reasons(z, f):
    out = []
    if z["energy"] > 0.8 or z["peak"] > 1.0:
        out.append("loud / high-energy spike")
    if f["_kw"]:
        out.append("hype words: " + ", ".join(f['_kw']))
    if f["laugh"]:
        out.append("laughter")
    if z["hook"] > 0.8:
        out.append("strong opening hook")
    if z["payoff"] > 0.8:
        out.append("builds to a payoff")
    if z["pace"] > 1.0:
        out.append("fast, punchy delivery")
    if f["sponsor"]:
        out.append("⚠ may contain an ad read")
    return out or ["steady, complete thought"]


def _checklist(z, f, dur, plat):
    """Each check carries an evidence label: Official (platform documents it), Data (observational study),
    Test (sensible hypothesis to A/B on your own account)."""
    lo, hi = plat["sweet"]
    items = [
        {"k": "Something happens in the first second", "ev": "Official + Test",
         "ok": bool(z["first1"] > 0 or f["_first_hook"]),
         "tip": "Swipe / skip rate is a documented signal" if (z["first1"] > 0 or f["_first_hook"]) else "Slow first second: open on the action"},
        {"k": "Hook in the first 3 seconds", "ev": "Official", "ok": bool(z["hook"] > 0 or f["_hook_lang"] >= 2),
         "tip": "Opens loud or with a question / bold claim" if z["hook"] > 0 else "Weak opener: the headline overlay helps"},
        {"k": "Starts on a fresh thought", "ev": "Test", "ok": not f["midstart"],
         "tip": "Doesn't open mid-sentence" if not f["midstart"] else "Opens on 'and/so/but', may feel mid-thought"},
        {"k": f"Length in {plat['name']} test range ({lo}–{hi}s)", "ev": "Data", "ok": lo - 1 <= dur <= hi + 1, "tip": f"{dur:.0f}s"},
        {"k": "High emotional energy", "ev": "Data", "ok": bool(z["energy"] > 0 or f["laugh"] or f["hype"] >= 3),
         "tip": "Above this video's average" if z["energy"] > 0 else "Calmer than average"},
        {"k": "Builds to a payoff / clean ending", "ev": "Test", "ok": bool(f["ends_clean"] and z["payoff"] > -0.5),
         "tip": "Full payoff on the first pass. Loop bonuses are unverified."},
        {"k": "Little dead air", "ev": "Test", "ok": f["deadair"] < 0.12, "tip": f"{f['deadair'] * 100:.0f}% silence (Cut dead air removes it)"},
        {"k": "No ad read", "ev": "Test", "ok": not f["sponsor"], "tip": "" if not f["sponsor"] else "Contains sponsor language"},
    ]
    return [dict(c, ok=bool(c["ok"])) for c in items]


def _score(rel, checklist):
    """The 0-100 moment score: rank among this video's moments, nudged by how many checks pass. Mirrors formula.js."""
    passed = sum(c["ok"] for c in checklist) / max(len(checklist), 1)
    return int(round(45 + 30 * rel + 24 * passed))


LOW_CONF = 0.55       # mean word probability under this = probably misheard


def _sure(sent):
    """False when Whisper was unsure of this sentence (mean word probability low, or many shaky words)."""
    ps = [w["p"] for w in sent.get("words") or [] if "p" in w]
    if not ps:
        return True                       # no confidence data (older transcripts): don't guess
    shaky = sum(p < 0.35 for p in ps) / len(ps)
    return sum(ps) / len(ps) >= LOW_CONF and shaky <= 0.3


def _title(m, segs, with_confidence=False):
    # long segments split into sentences/clauses first, or a clip inside one long segment would have no title
    pool = [s for s in (u for sg in segs for u in _split_long(sg))
            if s["s"] >= m.start - 0.3 and s["e"] <= m.end + 0.5 and s["text"]]
    sure = [s for s in pool if _sure(s)]
    sents = [s["text"] for s in (sure or pool)]   # a misheard sentence is never the headline when a clear one exists
    if not sents:
        return ("Wait for it…", True) if with_confidence else "Wait for it…"
    def strength(t):
        return (sum(w for _, w in _hype(t)) + len(HOOK_RX.findall(t)) * 0.7
                + t.count("!") - abs(len(t) - 45) / 25)
    best = max(sents, key=strength).strip(" .,-")
    best = re.sub(r"\b(um+|uh+m?|erm|er|hmm+|ah+|mhm)\b,?\s*", "", best, flags=re.I).strip()
    best = re.sub(r"^(and|but|so|because|like)[,\s]+", "", best, flags=re.I)
    best = best[0].upper() + best[1:] if best else best
    if _NOSPACE.search(best) and len(best) > 30:   # Chinese/Japanese/Thai: ~2x wider per character, no spaces to cut at
        cut = best[:30]
        i = max(cut.rfind(c) for c in (",", "，", "、", "；", ";"))
        if i >= 10:
            cut = cut[:i]
        best = cut.rstrip(",，、；;:： -\t\n") + "…"
    elif len(best) > 60:
        best = best[:60].rsplit(" ", 1)[0].rstrip(",;:-") + "…"
    return (best, bool(sure) or not pool) if with_confidence else best


def _tags(text, k):
    """Relevant topic tags from the transcript. No #fyp: TikTok says it works like any other hashtag."""
    words = [w for w in re.findall(r"[a-z]+(?:'[a-z]+)?", text.lower())
             if len(w) >= 5 and "'" not in w and w not in STOP and w not in WEAK]
    ranked = sorted(Counter(words).items(), key=lambda x: (-x[1] * (1 + len(x[0]) / 10), x[0]))
    return ["#" + w for w, _ in ranked[: max(k, 1)]]


def _post_copy(m, platform, source_title=""):
    t, tags = m.title, m.hashtags
    ctx = f" (from {source_title[:60]})" if source_title else ""
    return {
        # TikTok search weighs query match: descriptive words people would type, then a few relevant tags
        "tiktok": f"{t} " + " ".join(tags[:3]),
        # Shorts title must make sense in Search to someone who's never heard of you
        "shorts": t[:100],
        # Reels: sends drive unconnected reach, so give a reason to send
        "reels": f"{t}\n\n" + " ".join(tags[:3]),
        # Facebook: explain the payoff to someone unfamiliar
        "facebook": f"{t}{ctx}",
        "snapchat": t[:80],
        "x": f"{t} " + " ".join(tags[:1]),
    }


PAYOFF_MARGIN = 1.0   # loudness is z-scored per video: a later sentence end one SD punchier is the payoff (checked on podcasts + GeoGuessr reveals)


def _punch(loud, e):
    """Energy in the last 2 s before a cut point: where the payoff lands."""
    i = int(e / HOP)
    return float(loud[max(0, i - int(2 / HOP)): i + 1].mean()) if i < len(loud) else 0.0


def shorten(m: Moment, segs, loud, lo, hi):
    """Short cut with the SAME opening, ending on the strongest sentence end between lo and hi seconds. If the long
    cut's payoff lands later than a short can reach, there's no short (a short that stops before the payoff is a worse
    clip, not a shorter one): returns None and says why in m.short_note. Mirrors formula.js shorten."""
    m.short_note = ""
    if m.end - m.start <= hi + 1:
        return None
    ends = [sg["e"] for sg in segs if m.start + lo <= sg["e"] <= min(m.start + hi, m.end)]
    if not ends:
        ends = [w["e"] for w in m.words if m.start + lo <= w["e"] <= m.start + hi]
    if not ends:
        ends = [m.start + (lo + hi) / 2]
    e = max(ends, key=lambda x: _punch(loud, x))
    later = [sg["e"] for sg in segs if m.start + hi < sg["e"] <= m.end + 0.05]
    if later:
        peak = max(later, key=lambda x: _punch(loud, x))
        if _punch(loud, peak) - _punch(loud, e) >= PAYOFF_MARGIN:
            m.short_note = (f"No short cut: the payoff lands {peak - m.start:.0f}s in, and a short with the same opening "
                            f"has to end by {hi}s.")
            return None
    words = [w for w in m.words if w["e"] <= e + 0.05]
    end = min(m.end, (words[-1]["e"] + 0.35) if words else e)
    sm = Moment(start=m.start, end=round(end, 2), score=m.score, text=join_words([w["w"] for w in words]),
                title=m.title, words=words, title_sure=m.title_sure, rel=m.rel)
    if m.norm:   # score the short on its own: its length, ending and dead air differ from the long cut's
        keys = list(WEIGHTS)
        plat = dict(m.norm["plat"], sweet=(lo, hi))
        first = next((sg["text"] for sg in segs if sg["s"] >= m.start - 0.3), sm.text)
        f = _features(sm.start, sm.end, sm.text, words, loud, first, plat)
        mu, sd, flat = (np.array(m.norm[k], dtype=float) for k in ("mu", "sd", "flat"))
        row = np.array([f[k] for k in keys], dtype=float)
        z = np.where(flat.astype(bool), 0.0, (row - mu) / sd)
        for k in RAW:
            z[keys.index(k)] = row[keys.index(k)]
        zrow = dict(zip(keys, z))
        sm.checklist = _checklist(zrow, f, sm.end - sm.start, plat)
        sm.reasons = _reasons(zrow, f)
        sm.score = _score(m.rel, sm.checklist)
    return sm


# ---------------------------------------------------------------- dead-air + filler removal
FILLERS = {"um", "umm", "uh", "uhh", "uhm", "erm", "er", "hmm", "hm", "mm", "mhm", "ah"}


def is_filler(w):
    return re.sub(r"[^a-z]", "", w["w"].lower()) in FILLERS


def spoken(words):
    """Words that should appear in captions/titles (fillers dropped)."""
    return [w for w in words if not is_filler(w)]


def keep_intervals(m: Moment, tighten: bool):
    """Intervals (relative to clip start) to keep. Cuts pauses > 0.6 s down to ~0.3 s and removes um/uh."""
    dur = m.end - m.start
    ws = [w for w in m.words if m.start <= w["s"] <= m.end]
    if not tighten or len(ws) < 2:
        return [(0.0, dur)]
    cut = []
    for a, b in zip(ws, ws[1:]):
        gs, ge = a["e"] - m.start + 0.18, b["s"] - m.start - 0.12
        if ge - gs > 0.35:
            cut.append((gs, ge))
    for w in ws:
        if is_filler(w):
            cut.append((w["s"] - m.start - 0.02, w["e"] - m.start + 0.04))
    cut = sorted((max(0.0, a), min(dur, b)) for a, b in cut if b > a)
    merged = []
    for a, b in cut:
        if merged and a <= merged[-1][1] + 0.12:      # merge cuts that leave slivers between them
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    keep, cur = [], 0.0
    for a, b in merged:
        if a > cur:
            keep.append((cur, a))
        cur = max(cur, b)
    if cur < dur:
        keep.append((cur, dur))
    keep = [(round(a, 3), round(b, 3)) for a, b in keep if b - a > 0.08]
    return keep or [(0.0, dur)]


def remap(t, keep):
    """Clip-relative time -> output time after cuts."""
    out = 0.0
    for a, b in keep:
        if t < a:
            return out
        if t <= b:
            return out + (t - a)
        out += b - a
    return out


# ---------------------------------------------------------------- captions
def _ass_time(t):
    t = max(t, 0)
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"


_GREEK = re.compile("[\u0370-\u03FF\u1F00-\u1FFF]")
_GREEK_CAP_MARKS = re.compile("[\u0300\u0301\u0313\u0314\u0342]")


def _upper(w):
    # Greek capitals drop their accents and breathings (ΚΌΣΜΕ is written ΚΟΣΜΕ); the diaeresis stays.
    w = w.upper()
    return unicodedata.normalize("NFC", _GREEK_CAP_MARKS.sub("", unicodedata.normalize("NFD", w))) if _GREEK.search(w) else w


def _clean(w):
    return _upper(w.replace("\\", "").replace("{", "(").replace("}", ")"))


def _ass_safe(text):
    """Headline / end-card text: braces would start an override tag, a backslash an escape (\\N = line break),
    and a newline would start a new subtitle event."""
    return re.sub(r"[\r\n]+", " ", str(text)).replace("\\", "/").replace("{", "(").replace("}", ")")


CAPTION_STYLES = ("pop", "clean", "boxed")
FORMATS = {"9:16": (9, 16), "4:5": (4, 5), "1:1": (1, 1), "16:9": (16, 9)}
LAYOUTS = ("fit", "crop", "auto", "split")   # auto = follow the speaker's face, split = two people stacked (reframe.py)
SIZES = {"s": 0.82, "m": 1.0, "l": 1.2}
_rnd = lambda x: int(math.floor(x + 0.5))   # JavaScript's Math.round, so both engines place captions identically


def frame_size(fmt="9:16", short=1080):
    a, b = FORMATS.get(fmt, (9, 16))
    even = lambda x: _rnd(x / 2) * 2
    return (short, even(short * b / a)) if a <= b else (even(short * a / b), short)


def ass_colour(hexs, fallback="#FFF000"):
    """'#ffd400' -> '&H0000D4FF&' (ASS stores blue, green, red)."""
    h = hexs if isinstance(hexs, str) and re.fullmatch(r"#?[0-9a-fA-F]{6}", hexs or "") else fallback
    h = h.lstrip("#")
    return f"&H{h[4:6]}{h[2:4]}{h[0:2]}&".upper()


def caption_layout(plat, fmt="9:16", size="m", pos="bottom"):
    PX, PY = frame_size(fmt)
    tall = fmt == "9:16"
    scale = min(1, max(0.62, PY / 1920 * 1.45)) * SIZES.get(size, 1)
    hook_top = plat["hook_top"] if tall else _rnd(PY * 0.07)
    lr = plat["right"] if tall else _rnd(PX * 0.07)
    align = 8 if pos == "top" else 5 if pos == "middle" else 2
    mv = hook_top + _rnd(PY * 0.11) if pos == "top" else 0 if pos == "middle" else plat["cap_bottom"] if tall else _rnd(PY * 0.1)
    return dict(PX=PX, PY=PY, align=align, marginV=mv, marginLR=lr, hookTop=hook_top, scale=scale)


LOGO_SIZES = {"s": 0.09, "m": 0.12, "l": 0.15}   # logo box, as a share of the frame's short side
LOGO_OPACITY = (0.5, 0.7, 1.0)


def logo_box(fmt="9:16", look=None, short=1080):
    """Where the brand logo sits: a square box (px) in a top corner. Mirrors logoBox in formula.js."""
    look = look or {}
    W, H = frame_size(fmt, short)
    m = min(W, H)
    box = _rnd(m * LOGO_SIZES.get(look.get("lsize"), LOGO_SIZES["m"]) / 2) * 2
    mx = _rnd(m * 0.05)
    my = _rnd(H * 0.045) if fmt == "9:16" else mx
    return dict(W=W, H=H, box=box, mx=mx, my=my, right=look.get("lpos") == "tr")


def logo_opacity(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return 0.7
    return min(LOGO_OPACITY, key=lambda o: abs(o - v)) if math.isfinite(v) else 0.7


def logo_chain(fmt, look, in_label, idx, short=1080):
    """Filtergraph piece that scales the logo (input #idx) into its box and lays it over in_label.
    Mirrors logoChain in formula.js (tests/formula.test.mjs checks they match)."""
    b = logo_box(fmt, look, short)
    x = f"W-w-{b['mx']}" if b["right"] else str(b["mx"])
    return (f"[{idx}:v]scale=w={b['box']}:h={b['box']}:force_original_aspect_ratio=decrease,format=rgba,"
            f"colorchannelmixer=aa={logo_opacity((look or {}).get('lop')):.2f}[lg];{in_label}[lg]overlay=x={x}:y={b['my']}")


def clean_look(d, base=None):
    """Validate the per-cut look a client sends (studio edits): unknown or bad values fall back to base."""
    base = dict(base or {})
    d = d if isinstance(d, dict) else {}
    out = {"format": base.get("format", "9:16"), "hl": base.get("hl", "#FFF000"), "size": base.get("size", "m"),
           "pos": base.get("pos", "bottom"), "cy": base.get("cy", 0.5)}
    out.update({k: base[k] for k in ("logo", "lpos", "lsize", "lop") if k in base})   # an edit keeps the run's brand settings
    if d.get("format") in FORMATS: out["format"] = d["format"]
    if isinstance(d.get("hl"), str) and re.fullmatch(r"#[0-9a-fA-F]{6}", d["hl"]): out["hl"] = d["hl"].upper()
    if d.get("size") in SIZES: out["size"] = d["size"]
    if d.get("pos") in ("bottom", "middle", "top"): out["pos"] = d["pos"]
    for k in ("cx", "cy"):
        try:
            v = float(d[k])
            if math.isfinite(v): out[k] = min(1.0, max(0.0, v))
        except (KeyError, TypeError, ValueError):
            pass
    if d.get("style") in CAPTION_STYLES: out["style"] = d["style"]
    if d.get("layout") in LAYOUTS: out["layout"] = d["layout"]
    for k in ("tighten", "captions", "hook"):
        if isinstance(d.get(k), bool): out[k] = d[k]
    if isinstance(d.get("logo"), bool): out["logo"] = d["logo"]
    elif d.get("logo") in ("1", "0", "true", "false"): out["logo"] = d["logo"] in ("1", "true")
    if d.get("lpos") in ("tl", "tr"): out["lpos"] = d["lpos"]
    if d.get("lsize") in LOGO_SIZES: out["lsize"] = d["lsize"]
    if d.get("lop") not in (None, ""): out["lop"] = logo_opacity(d["lop"])
    return out


def write_ass(m: Moment, path: Path, plat: dict, keep, captions=True, hook=True, cta="", style="pop", look=None):
    """Word-by-word captions (3-word groups, active word highlighted) + a top headline for the first 3 s.
    look: {format, hl, size, pos} from the studio (same layout rules as the web app's buildASS)."""
    look = look or {}
    font = caption_font(m)["name"]
    L = caption_layout(plat, look.get("format", "9:16"), look.get("size", "m"), look.get("pos", "bottom"))
    k = L["scale"]; R = L["marginLR"]
    n = lambda x: _rnd(x * k)
    hk = min(1, k / SIZES.get(look.get("size", "m"), 1)); nh = lambda x: _rnd(x * hk)
    # Boxes (headline, end card, Boxed captions) use BorderStyle 4: one box per line in BackColour, with a transparent
    # glyph outline setting the padding. BorderStyle 3 boxes each glyph, so tall Arabic and Devanagari glyphs notch the edge.
    # Encoding -1 makes libass run full Unicode bidi across override tags; with 1 it
    # splits Arabic/Hebrew lines at each highlight and lays the pieces out left to right.
    tail = f"{L['align']},{R},{R},{L['marginV']},-1"
    style = style if style in CAPTION_STYLES else "pop"
    cap_style = {
        "pop":   f"Style: Cap,{font},{n(84)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,{n(7)},{n(3)},{tail}",
        "clean": f"Style: Cap,{font},{n(70)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,{n(4)},{n(2)},{tail}",
        "boxed": f"Style: Cap,{font},{n(72)},&H00FFFFFF,&H00FFFFFF,&HFF000000,&H00000000,0,0,0,0,100,100,0,0,4,{n(16)},0,{tail}",
    }[style]
    HL = ass_colour(look.get("hl"))
    hdr = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {L['PX']}
PlayResY: {L['PY']}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
{cap_style}
Style: Hook,{font},{nh(58)},&H00111111,&H00111111,&HFFFFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,4,{nh(20)},0,8,{R + 20},{R + 20},{L['hookTop']},-1
Style: Cta,{font},{nh(58)},&H00111111,&H00111111,&HFF00E6FF,&H0000E6FF,0,0,0,0,100,100,0,0,4,{nh(20)},0,8,{R + 20},{R + 20},{L['hookTop']},-1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = []
    if hook and m.title:
        lines.append(f"Dialogue: 1,{_ass_time(0)},{_ass_time(3.2)},Hook,,0,0,0,,{{\\fad(120,250)}}{_ass_safe(m.title)}")
    if cta:
        total = sum(b - a for a, b in keep)
        lines.append(f"Dialogue: 1,{_ass_time(max(3.4, total - 2.8))},{_ass_time(total)},Cta,,0,0,0,,{{\\fad(150,0)}}{_ass_safe(cta)}")
    words = spoken([w for w in m.words if m.start - 0.05 <= w["s"] <= m.end]) if captions else []
    T = lambda t: remap(t - m.start, keep)
    per = 4 if style == "clean" else 3
    groups = [words[i:i + per] for i in range(0, len(words), per)]
    hi, lo = (("{\\c" + HL + "}", r"{\c&HFFFFFF&}") if style == "boxed"
              else ("{\\c" + HL + r"\fscx112\fscy112}", r"{\c&HFFFFFF&\fscx100\fscy100}"))
    for gi, g in enumerate(groups):
        g_end = groups[gi + 1][0]["s"] if gi + 1 < len(groups) else g[-1]["e"] + 0.3
        if style == "clean":   # one event per phrase, no per-word highlight
            s0 = T(g[0]["s"]); e0 = min(T(g_end), s0 + 3.5)
            text = join_words([x["w"] for x in g], [x["w"].replace("{", "(").replace("}", ")") for x in g])
            lines.append(f"Dialogue: 0,{_ass_time(s0)},{_ass_time(max(e0, s0 + 0.05))},Cap,,0,0,0,,{text}")
            continue
        for wi, w in enumerate(g):
            s = T(w["s"])
            e = T(g[wi + 1]["s"] if wi + 1 < len(g) else g_end)
            if e - s > 1.6:
                e = s + 1.6
            parts = [(hi + _clean(x["w"]) + lo) if k == wi else _clean(x["w"]) for k, x in enumerate(g)]
            lines.append(f"Dialogue: 0,{_ass_time(s)},{_ass_time(max(e, s + 0.05))},Cap,,0,0,0,,{join_words([x["w"] for x in g], parts)}")
    path.write_text(hdr + "\n".join(lines) + "\n", encoding="utf-8")


def write_srt(m: Moment, path: Path, keep):
    words = spoken([w for w in m.words if m.start - 0.05 <= w["s"] <= m.end])
    def ts(t):
        t = remap(t - m.start, keep)
        h, r = divmod(t, 3600); mi, s = divmod(r, 60)
        return f"{int(h):02d}:{int(mi):02d}:{int(s):02d},{int((s % 1) * 1000):03d}"
    out = [f"{n}\n{ts(g[0]['s'])} --> {ts(g[-1]['e'])}\n{join_words([x['w'] for x in g])}\n"
           for n, g in enumerate((words[i:i + 7] for i in range(0, len(words), 7)), 1)]
    path.write_text("\n".join(out), encoding="utf-8")


# ---------------------------------------------------------------- render
def render(video: Path, m: Moment, out: Path, layout="fit", captions=True, crop_x=0.5, info=None,
           platform="all", hook=True, tighten=True, cta="", enhance=True, style="pop", look=None):
    info = info or probe(video)
    look = look or {}
    W, H = frame_size(look.get("format", "9:16"))
    plat = PLATFORMS.get(platform, PLATFORMS["all"])
    dur = m.end - m.start
    keep = keep_intervals(m, tighten)
    src_fps = info.get("fps") or 30
    fps = int(round(min(max(src_fps, 23), 60)))   # keep the source frame rate (YouTube encoding guidance)

    pre = f"fps={fps}"
    if enhance and info.get("height") and info["height"] < 720:
        pre = "hqdn3d=2:1.5:3:3," + pre          # clean up compression noise on low-res sources
    apre = "anull"
    if len(keep) > 1:
        sel = "+".join(f"between(t,{a:.3f},{b:.3f})" for a, b in keep)
        pre += f",select='{sel}',setpts=N/FRAME_RATE/TB"
        apre = f"aselect='{sel}',asetpts=N/SR/TB"

    # light clarity grade: gentle sharpen + a touch of contrast/colour
    sharpen = ",unsharp=5:5:0.45:5:5:0,eq=contrast=1.04:saturation=1.07" if enhance and layout != "original" else ""
    rf = None
    if layout in ("auto", "split") and info.get("has_video"):
        rf = reframe_plan(video, m, W / H, layout, out.parent)
    to_out = lambda ts: remap(ts - m.start, keep)
    if rf and rf["mode"] == "split":
        import reframe
        stacked = rf["stack"] == "v"
        if stacked:
            sizes = [(W, _rnd(H / 4) * 2)]
            sizes.append((W, H - sizes[0][1]))
        else:
            sizes = [(_rnd(W / 4) * 2, H)]
            sizes.append((W - sizes[0][0], H))
        parts = []
        for k, (p, (pw, ph)) in enumerate(zip(rf["panels"], sizes)):
            xe = f"clip(({reframe.expr(p['keys'], 1, to_out)})*iw-ow/2,0,iw-ow)"
            ye = f"clip(({reframe.expr(p['keys'], 2, to_out)})*ih-oh/2,0,ih-oh)"
            parts.append(f"[r{k}]crop=w='trunc(iw*{p['rw']}/2)*2':h='trunc(ih*{p['rh']}/2)*2':x='{xe}':y='{ye}',"
                         f"scale={pw}:{ph}{sharpen}[s{k}]")
        vf = f"split[r0][r1];{parts[0]};{parts[1]};[s0][s1]{'vstack' if stacked else 'hstack'}"
    elif layout in ("crop", "auto", "split"):
        cx = min(max(float(look.get("cx", crop_x)), 0), 1)
        cy = min(max(float(look.get("cy", 0.5)), 0), 1)
        xe, ye = f"(iw-ow)*{cx:.3f}", f"(ih-oh)*{cy:.3f}"
        if rf and rf["mode"] == "auto" and rf.get("keys"):    # follow the speaker: crop position changes over time
            import reframe
            xe = f"'clip(({reframe.expr(rf['keys'], 1, to_out)})*iw-ow/2,0,iw-ow)'"
            ye = f"'clip(({reframe.expr(rf['keys'], 2, to_out)})*ih-oh/2,0,ih-oh)'"
        vf = f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}:{xe}:{ye}" + sharpen
    elif layout == "original":
        vf = "scale=trunc(iw/2)*2:trunc(ih/2)*2"
    else:  # fit: full frame over a blurred fill
        # the fill is blurred at 1/8 size and scaled up (looks the same, ~3.5x faster than blurring 1080x1920),
        # and only the visible video is sharpened, since sharpening a blur is wasted work
        bw, bh = _rnd(W / 16) * 2, _rnd(H / 16) * 2
        vf = (f"split[a][b];[a]scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh},boxblur=3:2,"
              f"scale={W}:{H}:flags=bilinear,eq=brightness=-0.08[bg];"
              f"[b]scale={W}:{H}:force_original_aspect_ratio=decrease{sharpen}[fg];"
              "[bg][fg]overlay=(W-w)/2:(H-h)/2")
    if enhance and layout != "original":
        if len(keep) > 1:
            # alternate 100% / 108% framing at each cut so jump cuts read as intentional punch-ins
            edges, t = [], 0.0
            for a, b in keep:
                edges.append((t, t + (b - a)))
                t += b - a
            zoomed = [f"between(on,{int(a * fps)},{max(int(b * fps) - 1, int(a * fps))})"
                      for k, (a, b) in enumerate(edges) if k % 2 == 1]
            if zoomed:
                vf += (f",zoompan=z='if({'+'.join(zoomed)},1.08,1)':d=1:x='iw/2-(iw/zoom/2)':"
                       f"y='ih/2-(ih/zoom/2)':s={W}x{H}:fps={fps}")
    ass = out.with_suffix(".ass")
    overlay = layout != "original" and ((captions and m.words) or (hook and m.title) or cta)
    subs = ""
    if overlay:
        write_ass(m, ass, plat, keep, captions, hook, cta, style, look)
        subs = f",ass='{_ffesc(str(ass))}':fontsdir='{_ffesc(font_dir(caption_font(m)))}'"
    # brand logo: laid over the picture under the captions, so a long headline draws on top of it
    lp = look.get("logo_path")
    logo = lp if look.get("logo") and layout != "original" and lp and Path(lp).is_file() else None
    fmt = look.get("format", "9:16")

    if info["has_video"]:
        cmd = [FFMPEG, "-y", "-hide_banner", "-v", "info", "-ss", f"{m.start:.3f}", "-t", f"{dur:.3f}", "-i", str(video)]
        if logo: cmd += ["-i", logo]
        lg = f"[pv];{logo_chain(fmt, look, '[pv]', 1)}" if logo else ""
        vchain = f"[0:v]{pre},{vf}{lg}{subs},setsar=1[v]"   # square pixels: scale/crop rounding otherwise leaves SAR 10240:10239
    clean = ("highpass=f=80,afftdn=nr=10:nf=-40,equalizer=f=3200:t=q:w=1.2:g=2.5,"
             "acompressor=threshold=-20dB:ratio=2.5:attack=10:release=150:makeup=2,") if enhance else ""
    if info["has_video"]:
        achain = f"[0:a]{apre},{clean}loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a]"
    else:  # audio-only source (podcast, voice memo): audiogram = moving waveform on a dark card + captions
        cmd = [FFMPEG, "-y", "-hide_banner", "-v", "info", "-ss", f"{m.start:.3f}", "-t", f"{dur:.3f}", "-i", str(video),
               "-f", "lavfi", "-i", f"color=c=0x101018:s={W}x{H}:r={fps}:d={dur:.3f}"]
        if logo: cmd += ["-i", logo]
        lg = f"[pv];{logo_chain(fmt, look, '[pv]', 2)}" if logo else ""
        vchain = (f"[0:a]{apre},asplit[am][aw];[aw]showwaves=s={W}x{_rnd(H * 0.22)}:mode=cline:rate={fps}:colors=0xF2C230,"
                  f"format=yuva420p[w];[1:v][w]overlay=0:(H-h)/2-{_rnd(260 * H / 1920)}:shortest=1{lg}{subs},setsar=1[v]")
        achain = f"[am]{clean}loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a]"
    # quality detectors ride along on the render (final picture + final audio), so the clip isn't decoded twice
    taps = (";[v]split[vo][vq];[vq]blackdetect=d=0.5:pix_th=0.10,freezedetect=n=-60dB:d=2,nullsink"
            ";[a]asplit[ao][aq];[aq]silencedetect=n=-45dB:d=2,ebur128=peak=true,anullsink")
    cmd += ["-nostats", "-sws_flags", "lanczos", "-filter_complex", f"{vchain};{achain}{taps}", "-map", "[vo]", "-map", "[ao]",
            # H.264 High, 8-12 Mbps ceiling, 2 s GOP, AAC 48 kHz: accepted everywhere, well under size caps
            "-c:v", "libx264", "-profile:v", "high", "-preset", "veryfast", "-crf", "19",
            "-maxrate", "12M", "-bufsize", "24M", "-g", str(fps * 2), "-r", str(fps), "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-shortest", str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg failed: " + "\n".join(l for l in r.stderr.splitlines() if not re.search(r"\bt: ", l))[-800:])
    detect_log = "\n".join(l for l in r.stderr.splitlines()
                           if re.search(r"black_|freeze_|silence_|I:\s|Peak:", l) and not re.search(r"\bt: ", l))
    thumb = out.with_suffix(".jpg")
    subprocess.run([FFMPEG, "-y", "-v", "error", "-ss", "0.6", "-i", str(out),
                    "-frames:v", "1", "-vf", "scale=360:-2", str(thumb)])
    fillers = sum(1 for w in m.words if m.start <= w["s"] <= m.end and is_filler(w)) if tighten else 0
    return {"final_duration": round(sum(b - a for a, b in keep), 1), "cuts": len(keep) - 1, "fps": fps,
            "size_mb": round(out.stat().st_size / 1e6, 1), "fillers_cut": fillers, "enhanced": enhance,
            "_audiogram": not info["has_video"], "W": W, "H": H,
            "_expected": sum(b - a for a, b in keep), "_layout": layout, "_detect_log": detect_log,
            **({"reframe": rf} if rf else {})}


def render_workers():
    """How many clips render at once. CLIP_RENDER_JOBS overrides; otherwise 1 per 3 cores, 1 to 3."""
    try:
        return max(1, int(os.environ["CLIP_RENDER_JOBS"]))
    except (KeyError, ValueError):
        return max(1, min(3, (os.cpu_count() or 2) // 3))


def reframe_plan(video, m, out_aspect, layout, jobdir):
    """Face plan for one cut (reframe.py), cached per job. Never fails a render: problems become a centred crop + note."""
    try:
        import reframe
        faces = reframe.Faces.for_job(video, FFMPEG, Path(jobdir) / "faces.json")
        return reframe.plan(faces, m.start, m.end, m.words, out_aspect, layout)
    except Exception as e:  # noqa: BLE001
        print(f"[reframe] {e}", file=sys.stderr)
        return {"mode": "none", "note": "Face reframing failed on this clip, so the crop stays centred."}


# ---------------------------------------------------------------- quality gate
def quality_check(out: Path, stats: dict, m: Moment, captions=True, size_cap_mb=250) -> list[dict]:
    """Measure the finished file. 'hard' failures trigger a re-render, then the clip is replaced."""
    checks = []
    def add(k, ok, detail, hard):
        checks.append({"k": k, "ok": bool(ok), "detail": detail, "hard": hard})
    try:
        info = json.loads(subprocess.run([FFPROBE, "-v", "error", "-print_format", "json", "-show_streams",
                                          "-show_format", str(out)], capture_output=True, text=True).stdout)
    except Exception:
        add("File opens", False, "unreadable output", True)
        return checks
    v = next((x for x in info.get("streams", []) if x["codec_type"] == "video"), {})
    a = next((x for x in info.get("streams", []) if x["codec_type"] == "audio"), {})
    dur = float(info.get("format", {}).get("duration", 0))
    vertical = stats.get("_layout") == "original" or (v.get("width"), v.get("height")) == (stats.get("W", 1080), stats.get("H", 1920))
    square = v.get("sample_aspect_ratio", "1:1") in ("1:1", "0:1", "N/A")
    add("Upload-ready format", v.get("codec_name") == "h264" and a.get("codec_name") == "aac" and vertical and square,
        f"{v.get('codec_name')} {v.get('width')}×{v.get('height')} + {a.get('codec_name')}"
        + ("" if square else f", non-square pixels {v.get('sample_aspect_ratio')}"), True)
    exp = stats.get("_expected", dur)
    add("Length matches the edit", abs(dur - exp) < 0.8, f"{dur:.1f}s (expected {exp:.1f}s)", True)
    add("Under upload size limits", stats.get("size_mb", 0) < size_cap_mb, f"{stats.get('size_mb')} MB", True)

    log = stats.get("_detect_log")
    if log is None:   # measured during the render normally; decode the file only if that's missing
        log = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", str(out),
                              "-vf", "blackdetect=d=0.5:pix_th=0.10,freezedetect=n=-60dB:d=2",
                              "-af", "silencedetect=n=-45dB:d=2,ebur128=peak=true", "-f", "null", "-"],
                             capture_output=True, text=True).stderr
    lufs = re.findall(r"I:\s+(-?[\d.]+) LUFS", log)
    peak = re.findall(r"Peak:\s+(-?[\d.]+|-inf) dBFS", log)
    black = sum(float(x) for x in re.findall(r"black_duration:([\d.]+)", log))
    silence = [float(x) for x in re.findall(r"silence_duration: ([\d.]+)", log)]
    freeze = sum(float(x) for x in re.findall(r"freeze_duration: ([\d.]+)", log))
    I = float(lufs[-1]) if lufs else None
    P = float(peak[-1]) if peak and peak[-1] != "-inf" else None
    add("Even loudness (−14 LUFS ±2)", I is not None and -16.5 <= I <= -11.5, f"{I} LUFS" if I is not None else "not measured", False)
    add("No clipping", P is None or P <= -0.3, f"true peak {P} dBFS", False)
    if stats.get("_audiogram"):
        add("No black frames", True, "audiogram card (intentional dark background)", True)
    else:
        add("No black frames", black < 0.5, f"{black:.1f}s black", True)
    add("No dead silence", not silence, f"{max(silence):.1f}s silent stretch" if silence else "none over 2s", True)
    add("Picture keeps moving", freeze < 0.6 * max(dur, 1), f"{freeze:.1f}s frozen" if freeze else "no long freezes", False)
    sw = spoken([w for w in m.words if m.start <= w["s"] <= m.end])
    if captions and sw:
        add("Starts and ends on whole words", sw[0]["s"] - m.start < 0.5 and m.end - sw[-1]["e"] < 0.8,
            "clean in/out points", False)
    return checks


def _passed(checks):
    return all(c["ok"] for c in checks if c["hard"])


def _content_fail(checks):
    """True when every hard failure is about the source itself (silence, black picture), not the edit or encode."""
    hard = [c for c in checks if c["hard"] and not c["ok"]]
    return bool(hard) and all(c["k"] in ("No dead silence", "No black frames") for c in hard)


def _ffesc(p):
    """Escape a path for use inside an ffmpeg filter argument (works for Windows 'C:\\…' paths too)."""
    return p.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


def fmt_t(t):
    t = int(t or 0)
    return f"{t // 3600}:{t % 3600 // 60:02d}:{t % 60:02d}" if t >= 3600 else f"{t // 60}:{t % 60:02d}"


# ---------------------------------------------------------------- pipeline
def run(source, outdir: Path, n=5, min_len=None, max_len=None, layout="fit", captions=True,
        model="base", crop_x=0.5, platform="all", hook=True, tighten=True, version="both", cta="",
        enhance=True, style="pop", progress=_noop, look=None, logo=None, language="auto") -> dict:
    """version: 'both' = long cut + a short cut with the same opening; 'short' or 'long' = one cut.
    look: {format, hl, size, pos, logo, lpos, lsize, lop} caption/frame/brand choices (defaults: 9:16, yellow,
    medium, lower third, no logo). logo: path to the brand logo image, used when look["logo"] is on."""
    look = clean_look(look)
    rlook = dict(look, logo_path=str(logo)) if logo else look   # what render sees; the path isn't saved with the clips
    outdir.mkdir(parents=True, exist_ok=True)
    video, title = fetch(source, outdir, progress)
    info = probe(video)
    if info["duration"] < 3:
        raise RuntimeError("That video is too short to clip (under 3 seconds).")
    if not info["has_audio"]:
        raise RuntimeError("That video has no audio track, so there's nothing to transcribe or score.")
    plat = PLATFORMS.get(platform, PLATFORMS["all"])
    if not plat["long"] and version != "short":
        version = "short"
    custom = bool(min_len or max_len)
    progress("analyze", 0, "Analysing audio")
    wav = outdir / "audio.pcm"
    extract_audio(video, wav)
    loud = loudness_curve(wav)
    qmap = quiet_map(wav)
    # silent: no sample above -55 dBFS, or typical level (the 70th percentile, as in quiet_map) under -55 dB: hiss only
    typical = qmap.get("thr", 0) + 25 if isinstance(qmap, dict) else 0
    if audio_peak_db(wav) < -55 or typical < -55:
        raise RuntimeError("The audio is silent, so there's nothing to clip. Check the file has sound.")
    (outdir / "quiet.json").write_text(json.dumps(qmap))
    progress("analyze", 100, "Audio analysed")
    segs = transcribe(wav, model, progress, info["duration"], language)
    (outdir / "transcript.json").write_text(json.dumps(segs))
    interest = None
    if os.environ.get("CLIP_INTEREST", "1") != "0":
        try:   # optional: offline on first use, or no model, just means sound and words decide alone
            import search
            progress("score", 0, "Reading the transcript for its strongest moments")
            search.model(lambda msg: progress("score", 0, msg))   # downloads the search model once (about 120 MB)
            interest = search.interest_curve(segs, info["duration"], HOP)
        except Exception as e:  # noqa: BLE001
            print(f"[score] ranking without the search model ({e})", file=sys.stderr)
    pool = find_moments(segs, loud, info["duration"], n + 4, min_len, max_len, platform, progress, version, interest)
    clips, dropped = [], 0
    if layout in ("auto", "split") and info["has_video"]:
        progress("render", 0, "Getting face detection ready")
        import reframe
        why = reframe.unavailable()        # installs OpenCV on first use
        if why:
            print(f"[reframe] {why}; clips use a centred crop", file=sys.stderr)

    def make(mm, path, use_cta):
        """Render, measure, and if a hard check fails re-render once with safe settings."""
        st = render(video, mm, path, layout, captions, crop_x, info, platform, hook, tighten, use_cta, enhance, style, rlook)
        qc = quality_check(path, st, mm, captions)
        for safe_tighten in ((tighten, False) if tighten else (False,)):
            if _passed(qc) or _content_fail(qc):   # safe mode can't fix a silent or black source: don't re-render
                break
            st = render(video, mm, path, layout, captions, crop_x, info, platform, hook, safe_tighten, use_cta, False, style, rlook)
            qc = quality_check(path, st, mm, captions)
            st["retried"] = True
            st["_tighten"] = safe_tighten
        return st, qc

    # Several candidates render at once (each ffmpeg keeps only ~3 of 8 cores busy: its filters are single-threaded),
    # into temporary names. Results are taken in ranking order, and a candidate that fails the quality gate is replaced
    # by the next one, so the clips and their order are the same as rendering one at a time.
    want_short = version == "both" and not custom
    use_cta = cta if (version != "short" or custom) else ""   # CTA on the long cut only: the short keeps a clean payoff

    def candidate(k, m):
        st, qc = make(m, outdir / f"_cand{k:02d}.mp4", use_cta)
        sm = sst = sqc = None
        if want_short and _passed(qc):
            sm = shorten(m, segs, loud, *plat["short"])
            if sm:
                sst, sqc = make(sm, outdir / f"_cand{k:02d}_short.mp4", "")
        return m, st, qc, sm, sst, sqc

    def move(k, name, short=False):
        src = f"_cand{k:02d}{'_short' if short else ''}"
        for ext in (".mp4", ".jpg"):
            if (outdir / (src + ext)).exists():
                os.replace(outdir / (src + ext), outdir / (name + ext))

    def discard(k):
        for f in outdir.glob(f"_cand{k:02d}*"):
            f.unlink(missing_ok=True)

    from concurrent.futures import ThreadPoolExecutor
    workers = render_workers()
    todo, inflight = list(enumerate(pool)), []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        def submit():
            while todo and len(clips) + len(inflight) < n:   # the pool runs `workers` of them at a time
                k, m = todo.pop(0)
                m.captions = _post_copy(m, platform, title)
                inflight.append((k, ex.submit(candidate, k, m)))
        submit()
        while inflight and len(clips) < n:
            k, fut = inflight.pop(0)
            progress("render", 100 * len(clips) / n, f"Rendering + checking clip {len(clips) + 1} of {n}")
            m, stats, qc, sm, sst, sqc = fut.result()
            if not _passed(qc):
                dropped += 1
                discard(k)
                submit()
                continue                      # quality gate: replace with the next-best moment
            i = len(clips) + 1
            name = f"clip_{i:02d}"
            move(k, name)
            write_srt(m, outdir / f"{name}.srt", keep_intervals(m, stats.get("_tighten", tighten)))
            d = asdict(m)
            d.pop("words")
            d.pop("norm", None)
            d.update({k_: v for k_, v in stats.items() if not k_.startswith("_")})
            cut_look = dict(look, style=style, layout=layout, cx=crop_x, tighten=tighten, captions=captions, hook=hook)
            d.update(look=cut_look, cta=use_cta)
            d.update(file=f"{name}.mp4", thumb=f"{name}.jpg", srt=f"{name}.srt", quality=qc,
                     duration=stats["final_duration"], range=f"{fmt_t(m.start)}–{fmt_t(m.end)}", short=None)
            if sm and _passed(sqc):
                move(k, f"{name}_short", short=True)
                write_srt(sm, outdir / f"{name}_short.srt", keep_intervals(sm, sst.get("_tighten", tighten)))
                d["short"] = dict({k_: v for k_, v in sst.items() if not k_.startswith("_")},
                                  file=f"{name}_short.mp4", thumb=f"{name}_short.jpg", quality=sqc, look=cut_look, cta="",
                                  start=sm.start, end=sm.end, title=sm.title,
                                  srt=f"{name}_short.srt", duration=sst["final_duration"],
                                  range=f"{fmt_t(sm.start)}–{fmt_t(sm.end)}",
                                  score=sm.score, checklist=sm.checklist, reasons=sm.reasons)
            elif sm:
                d["short_note"] = "No short cut: it failed the quality gate (" + ", ".join(
                    c["k"] for c in sqc if c["hard"] and not c["ok"]) + ")."
            elif not want_short:
                d["short_note"] = ""
            discard(k)
            clips.append(d)
            submit()
        for k, fut in inflight:               # enough clips: let stragglers finish, then drop their files
            fut.cancel()
    for k, _ in enumerate(pool):
        discard(k)
    progress("render", 100, "Done")
    wav.unlink(missing_ok=True)
    (outdir / "session.json").write_text(json.dumps({
        "video": str(video), "has_video": info["has_video"], "duration": info["duration"],
        "settings": dict(layout=layout, captions=captions, crop_x=crop_x, platform=platform, hook=hook,
                         tighten=tighten, enhance=enhance, style=style, cta=cta, version=version, **look)}))
    result = {"dropped_for_quality": dropped, "title": title, "source": str(source), "duration": info["duration"], "platform": platform,
              "platform_name": plat["name"], "platform_note": plat["note"], "judge": plat["judge"],
              "publish": plat["publish"], "version": version, "clips": clips}
    (outdir / "result.json").write_text(json.dumps(result, indent=2))
    return result


def edit_cut(outdir: Path, idx: int, cut: str, start: float, end: float, title: str, words: list,
             style: str | None = None, progress=_noop, look=None, cta=None, logo=None, reason=None, payoff="keep") -> dict:
    """Re-render one cut after a manual edit (trim, caption fixes, headline, style) and re-run the quality gate.
    The previous file is only replaced if the new render passes every hard check."""
    sess = json.loads((outdir / "session.json").read_text())
    res = json.loads((outdir / "result.json").read_text())
    st_ = sess["settings"]
    video = Path(sess["video"])
    if not video.exists():
        raise RuntimeError("The source video is gone (deleted or moved), so this clip can't be re-rendered.")
    info = probe(video)
    if cut == "new":                      # a clip picked from the transcript: rendered as a new long-style clip
        clip = None
        taken = {c["file"] for c in res["clips"]}
        k = len(res["clips"]) + 1
        while f"clip_{k:02d}.mp4" in taken:
            k += 1
        target = {"file": f"clip_{k:02d}.mp4", "thumb": f"clip_{k:02d}.jpg", "srt": f"clip_{k:02d}.srt"}
    else:
        clip = res["clips"][idx]
        target = clip if cut == "long" else clip.get("short")
        if target is None:
            raise RuntimeError("That clip has no short cut.")
    if not (math.isfinite(float(start)) and math.isfinite(float(end))):
        raise RuntimeError("Bad trim points.")
    start, end = max(0.0, float(start)), min(info["duration"], float(end))
    if end - start < 2:
        raise RuntimeError("The trimmed clip is too short.")
    try:
        ws = [{"w": str(w["w"])[:40], "s": float(w["s"]), "e": float(w["e"])} for w in words][:5000]
        assert all(math.isfinite(w["s"]) and math.isfinite(w["e"]) for w in ws)
    except Exception:
        raise RuntimeError("The caption edits were malformed, so nothing was changed.")
    m = Moment(start=start, end=end, title=str(title)[:90], words=ws)
    base = dict(st_, **(target.get("look") or {}))
    lk = clean_look(look, base)
    style = style if style in CAPTION_STYLES else lk.get("style", st_.get("style", "pop"))
    layout = lk.get("layout", base.get("layout", "fit"))
    captions = lk.get("captions", base.get("captions", True))
    hook = lk.get("hook", base.get("hook", True))
    tighten = lk.get("tighten", base.get("tighten", True))
    if cta is not None:
        use_cta = str(cta)[:80]
    else:
        use_cta = st_.get("cta", "") if (cut == "long" and st_.get("version") != "short") else ""
    tmp = outdir / f"_edit_{target['file']}"
    progress("render", 10, "Rendering" if cut == "new" else "Re-rendering")
    args = (video, m, tmp, layout, captions, lk.get("cx", base.get("crop_x", 0.5)), info, st_["platform"], hook)
    rlk = dict(lk, logo_path=str(logo)) if logo else lk
    stats = render(*args, tighten, use_cta, st_["enhance"], style, rlk)
    qc = quality_check(tmp, stats, m, captions)
    if not _passed(qc) and not _content_fail(qc):
        progress("render", 60, "Re-rendering in safe mode")
        stats = render(*args, False, use_cta, False, style, rlk)
        qc = quality_check(tmp, stats, m, captions)
        stats["retried"] = True
    if not _passed(qc):
        tmp.unlink(missing_ok=True)
        for x in (".ass", ".jpg"):
            tmp.with_suffix(x).unlink(missing_ok=True)
        raise RuntimeError("That edit failed the quality gate (" + ", ".join(c["k"] for c in qc if c["hard"] and not c["ok"])
                           + "). Your previous version is kept.")
    final = outdir / target["file"]
    tmp.replace(final)
    for x in (".ass", ".jpg"):
        if tmp.with_suffix(x).exists():
            tmp.with_suffix(x).replace(final.with_suffix(x))
    write_srt(m, outdir / target["srt"], keep_intervals(m, tighten))
    (outdir / target["file"]).with_suffix(".words.json").write_text(json.dumps(ws))   # caption fixes survive a reload
    target.update({k: v for k, v in stats.items() if not k.startswith("_")})
    target.update(quality=qc, duration=stats["final_duration"], start=round(start, 2), end=round(end, 2),
                  range=f"{fmt_t(start)}–{fmt_t(end)}", style=style, edited=True, rev=target.get("rev", 0) + 1, cta=use_cta,
                  look=dict(lk, style=style, layout=layout, captions=captions, hook=hook, tighten=tighten))
    target["title"] = m.title
    if payoff != "keep":                  # the payoff belongs to the clip: its long and short cuts both have to reach it
        (target if cut == "new" else clip)["payoff"] = None if payoff is None else round(float(payoff), 2)
    if cut == "new":
        m.hashtags = []
        target.update(score=None, custom=True, reasons=[reason or "Picked from the transcript"], checklist=[], short=None,
                      captions=_post_copy(m, st_["platform"], res.get("title", "")))
        res["clips"].append(target)
    tmp = outdir / "result.json.tmp"             # temp + rename: a crash mid-edit never corrupts the job's clip list
    tmp.write_text(json.dumps(res, indent=2))
    os.replace(tmp, outdir / "result.json")
    progress("render", 100, "Done")
    return res


if __name__ == "__main__":
    for _s in (sys.stdout, sys.stderr):   # Windows consoles: never crash on ✓/✗ or emoji
        try:
            _s.reconfigure(errors="replace")
        except Exception:
            pass
    import argparse
    ap = argparse.ArgumentParser(description="Find the best moments in a video and cut vertical clips.")
    ap.add_argument("source", help="video URL or local file")
    ap.add_argument("-n", type=int, default=5, help="number of clips")
    ap.add_argument("-p", "--platform", choices=list(PLATFORMS), default="all")
    ap.add_argument("--min", type=int, help="min clip length (default: platform sweet spot)")
    ap.add_argument("--max", type=int, help="max clip length (default: platform sweet spot)")
    ap.add_argument("--layout", choices=[*LAYOUTS, "original"], default="fit",
                    help="fit = full frame over blur, crop = fill, auto = follow whoever's talking, split = two people stacked")
    ap.add_argument("--no-captions", action="store_true")
    ap.add_argument("--no-hook", action="store_true", help="skip the headline overlay")
    ap.add_argument("--keep-pauses", action="store_true", help="don't cut dead air or um/uh")
    ap.add_argument("--no-enhance", action="store_true", help="skip audio clean-up, sharpening and punch-ins")
    ap.add_argument("--model", default="base", help="tiny | base | small | medium")
    ap.add_argument("--language", default="auto", choices=LANGUAGES, help="spoken language code, or auto (detect)")
    ap.add_argument("--version", choices=["both", "short", "long"], default="both",
                    help="both = long cut + short cut with the same opening")
    ap.add_argument("--cta", default="", help="end-card text on the long cut, e.g. 'Which one would you pick?'")
    ap.add_argument("--style", choices=list(CAPTION_STYLES), default="pop", help="caption look: pop | clean | boxed")
    ap.add_argument("--logo", help="brand logo image (PNG with transparency works best), laid over a top corner")
    ap.add_argument("--logo-pos", choices=["tl", "tr"], default="tl", help="logo corner: tl (top left) | tr (top right)")
    ap.add_argument("-o", "--out", default=str(HERE / "jobs" / "cli"))
    a = ap.parse_args()

    def pr(stage, pct, msg=""):
        print(f"\r[{stage:10s}] {pct:5.1f}%  {msg[:60]:60s}", end="", flush=True)
        if pct >= 100:
            print()
    res = run(a.source, Path(a.out), a.n, a.min, a.max, a.layout, not a.no_captions, a.model,
              platform=a.platform, hook=not a.no_hook, tighten=not a.keep_pauses, version=a.version,
              cta=a.cta, enhance=not a.no_enhance, style=a.style, progress=pr,
              look={"logo": bool(a.logo), "lpos": a.logo_pos} if a.logo else None, logo=a.logo, language=a.language)
    for c in res["clips"]:
        print(f"{c['score']:>4}  {c['range']:>13s}  {c['duration']}s  {c['file']}  {c['title']}")
        if c.get("short"):
            print(f"      short cut: {c['short']['duration']}s  {c['short']['file']}")
        q = c["quality"]
        print(f"      quality: {sum(x['ok'] for x in q)}/{len(q)} checks" + ("  (re-rendered safe)" if c.get("retried") else "")
              + "  " + "; ".join(f"✗ {x['k']} ({x['detail']})" for x in q if not x["ok"]))
        print("      " + " · ".join(c["reasons"]))
        print("      " + "  ".join(("✓ " if x["ok"] else "✗ ") + x["k"] for x in c["checklist"]))
    if res.get("dropped_for_quality"):
        print(f"Replaced {res['dropped_for_quality']} clip(s) that failed the quality gate.")
    if not res["clips"]:
        print("No moment passed the quality gate. Try another video, or --keep-pauses.")
    print("Output:", a.out)
