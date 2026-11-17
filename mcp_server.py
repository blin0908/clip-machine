"""Clip Machine MCP server: lets Claude, Codex or any MCP client clip videos with the desktop app.

    .venv/bin/python mcp_server.py        (an MCP client starts this for you; it speaks MCP over stdin/stdout)

It talks to a running desktop app over HTTP, and starts app.py itself (in the background) when none is running.
No extra packages: the MCP protocol (JSON-RPC 2.0, one message per line) is implemented with the standard library.

Settings (environment variables, all optional):
    CLIP_MCP_URL   the desktop app's address        (default http://127.0.0.1:<CLIP_PORT or 8765>)
    CLIP_KEY       its access key                   (default: the .access_key file next to this script)
    CLIP_PORT, CLIP_JOBS, CLIP_LOG, CLIP_STUDIO, CLIP_FONT_CACHE
                   passed on to app.py when this server has to start it
"""
import json
import mimetypes
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from pathlib import Path
import http.client

HERE = Path(__file__).resolve().parent
try:   # the app's version, read rather than imported (importing clipper loads the whole engine)
    VERSION = re.search(r'^VERSION = "([^"]+)"', (HERE / "clipper.py").read_text(encoding="utf-8"), re.M).group(1)
except (OSError, AttributeError):
    VERSION = "unknown"
PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")
PLATFORMS = ("all", "tiktok", "reels", "shorts", "facebook", "snapchat", "x")
STYLES = ("pop", "clean", "boxed")
FORMATS = ("9:16", "4:5", "1:1", "16:9")
PN = {"tiktok": "TikTok", "reels": "Reels", "shorts": "YT Shorts", "facebook": "Facebook", "snapchat": "Snapchat", "x": "X"}
POLL = 1.0


def log(*a):
    print("[clip-machine-mcp]", *a, file=sys.stderr, flush=True)


class ToolError(Exception):
    """A problem the agent should read and act on (bad input, job not finished, app unreachable)."""


# ---------------------------------------------------------------- talking to the desktop app

class App:
    def __init__(self):
        port = os.environ.get("CLIP_PORT") or "8765"
        self.base = (os.environ.get("CLIP_MCP_URL") or f"http://127.0.0.1:{port}").rstrip("/") + "/"
        self.proc = None
        self.info = None
        self.lock = threading.Lock()

    @property
    def key(self):
        k = os.environ.get("CLIP_KEY")
        if k:
            return k
        f = HERE / ".access_key"
        return f.read_text(encoding="utf-8").strip() if f.exists() else ""

    def _local(self):
        return urllib.parse.urlsplit(self.base).hostname in ("127.0.0.1", "localhost", "::1")

    def request(self, method, path, body=None, timeout=30):
        data, headers = None, {"X-Key": self.key}
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path.lstrip("/"), data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                return json.loads(raw) if "json" in (r.headers.get("Content-Type") or "") else raw
        except urllib.error.HTTPError as e:
            raw = e.read()
            if e.code == 403:
                raise ToolError("The desktop app refused the access key. Set CLIP_KEY to the key it prints at start-up "
                                "(or run this server from the Clip Machine folder so it can read .access_key).")
            try:
                msg = json.loads(raw).get("error")
            except Exception:
                msg = None
            if e.code == 404:
                raise ToolError(msg or "Not found. Check the job id with list_jobs.")
            raise ToolError(msg or f"The desktop app answered {e.code} for {method} {path}.")

    def ensure(self):
        """Connect to the running app, or start app.py if nothing is listening."""
        with self.lock:
            if self.info and (self.proc is None or self.proc.poll() is None):
                return self.info
            try:
                self.info = self.request("GET", "api/info", timeout=5)
                return self.info
            except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as e:
                if isinstance(e, ToolError):
                    raise
                if not self._local():
                    raise ToolError(f"Can't reach the desktop app at {self.base}. Start it there first.")
            self._start()
            return self.info

    def _start(self):
        if not os.environ.get("CLIP_KEY") and not (HERE / ".access_key").exists():
            (HERE / ".access_key").write_text(secrets.token_urlsafe(8), encoding="utf-8")   # the same file app.py would create
        env = dict(os.environ, CLIP_PORT=str(urllib.parse.urlsplit(self.base).port or 80), PYTHONUNBUFFERED="1")
        jobs = Path(env.get("CLIP_JOBS") or HERE / "jobs")
        jobs.mkdir(parents=True, exist_ok=True)
        log(f"no desktop app at {self.base}; starting app.py (output in {jobs / '_mcp_app.log'})")
        with open(jobs / "_mcp_app.log", "ab") as out:
            self.proc = subprocess.Popen([sys.executable, str(HERE / "app.py")], cwd=str(HERE), env=env,
                                         stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT)
        for _ in range(120):
            if self.proc.poll() is not None:
                raise ToolError(f"The desktop app stopped while starting (exit {self.proc.returncode}). "
                                f"See {jobs / '_mcp_app.log'}.")
            try:
                self.info = self.request("GET", "api/info", timeout=2)
                return
            except ToolError:
                raise
            except Exception:
                time.sleep(0.5)
        raise ToolError(f"The desktop app didn't answer within 60 s. See {jobs / '_mcp_app.log'}.")

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()

    # -- paths and files

    def jobs_dir(self):
        d = (self.info or {}).get("jobs_dir")
        return Path(d) if d else Path(os.environ.get("CLIP_JOBS") or HERE / "jobs")

    def path_of(self, jid, name):
        """Absolute path of a job file when it's on this computer, else its download link."""
        p = self.jobs_dir() / jid / name
        if p.exists():
            return str(p)
        return self.base + f"files/{urllib.parse.quote(jid)}/{urllib.parse.quote(name)}"

    def open_file(self, jid, name):
        p = self.jobs_dir() / jid / name
        if p.exists():
            return open(p, "rb")
        req = urllib.request.Request(self.base + f"files/{urllib.parse.quote(jid)}/{urllib.parse.quote(name)}",
                                     headers={"X-Key": self.key})
        return urllib.request.urlopen(req, timeout=120)

    def upload(self, path: Path, fields: dict):
        """POST a local video as multipart/form-data, streamed so multi-GB files don't load into memory."""
        u = urllib.parse.urlsplit(self.base)
        boundary = "----clipmachine" + uuid.uuid4().hex
        head = b"".join(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
            for k, v in fields.items() if v is not None)
        fname = path.name.replace('"', "'").replace("\r", " ").replace("\n", " ")
        ctype = mimetypes.guess_type(fname)[0] or "application/octet-stream"
        head += (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{fname}"\r\n'
                 f"Content-Type: {ctype}\r\n\r\n").encode()
        tail = f"\r\n--{boundary}--\r\n".encode()
        size = len(head) + path.stat().st_size + len(tail)
        cls = http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection
        conn = cls(u.hostname, u.port, timeout=600)
        try:
            conn.putrequest("POST", (u.path.rstrip("/") or "") + "/api/jobs")
            conn.putheader("X-Key", self.key)
            conn.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
            conn.putheader("Content-Length", str(size))
            conn.endheaders()
            conn.send(head)
            with open(path, "rb") as f:
                while chunk := f.read(1 << 20):
                    conn.send(chunk)
            conn.send(tail)
            r = conn.getresponse()
            raw = r.read()
        finally:
            conn.close()
        if r.status == 403:
            raise ToolError("The desktop app refused the access key.")
        try:
            data = json.loads(raw)
        except Exception:
            raise ToolError(f"The upload failed ({r.status}).")
        if r.status != 200:
            raise ToolError(data.get("error") or f"The upload failed ({r.status}).")
        return data


app = App()


# ---------------------------------------------------------------- tools

def _job(jid):
    if not isinstance(jid, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", jid):
        raise ToolError("Give a job_id from new_job or list_jobs.")
    return app.request("GET", f"api/jobs/{jid}")


def _title(j):
    """The video's title; an uploaded file is saved as "source.mp4", so use the name it was uploaded with."""
    res = j.get("result") or {}
    if j.get("opts", {}).get("upload_dir") and j.get("label"):
        return Path(j["label"]).stem
    return res.get("title") or j.get("label") or "clips"


def _summary(j):
    res = j.get("result") or {}
    out = {"job_id": j["id"], "status": j["status"], "percent": j.get("pct"), "message": j.get("msg"),
           "label": j.get("label"), "clips": len(res.get("clips", [])) if res else 0}
    if j["status"] == "error":
        out["error"] = j.get("msg")
    if j.get("edit_error"):
        out["last_rerender_error"] = j["edit_error"]
    if res:
        out.update(video_title=_title(j), platform=res.get("platform_name"),
                   dropped_for_quality=res.get("dropped_for_quality", 0))
    return out


def _bool(v):
    return None if v is None else ("1" if v else "0")


def tool_new_job(a):
    src = str(a.get("source") or "").strip()
    if not src:
        raise ToolError("Give source: a local video file path or a link (YouTube, TikTok, Twitch, X…).")
    if a.get("platform") not in (None, *PLATFORMS):
        raise ToolError(f"platform must be one of {', '.join(PLATFORMS)}.")
    if a.get("style") not in (None, *STYLES):
        raise ToolError(f"style must be one of {', '.join(STYLES)}.")
    if a.get("format") not in (None, *FORMATS):
        raise ToolError(f"format must be one of {', '.join(FORMATS)}.")
    fields = {"platform": a.get("platform"), "n": a.get("n"), "version": a.get("version"), "format": a.get("format"),
              "style": a.get("style"), "lang": a.get("language"), "cta": a.get("cta"), "model": a.get("model"),
              "layout": a.get("layout"), "min": a.get("min_seconds"), "max": a.get("max_seconds"),
              "hl": a.get("highlight"), "size": a.get("size"), "pos": a.get("position"),
              "captions": _bool(a.get("captions")), "hook": _bool(a.get("headline")),
              "tighten": _bool(a.get("cut_pauses")), "logo": _bool(a.get("logo"))}
    fields = {k: str(v) for k, v in fields.items() if v is not None}
    app.ensure()
    if re.match(r"(?i)https?://", src):
        r = app.request("POST", "api/jobs", {"url": src, **fields})
    else:
        p = Path(src).expanduser()
        if not p.is_file():
            raise ToolError(f"No file at {p}. Give an absolute path to a video or audio file, or a https:// link.")
        r = app.upload(p.resolve(), fields)
    return {"job_id": r["id"], "status": "queued",
            "next": "Call job_status with wait_seconds to wait for it, then list_clips."}


def tool_job_status(a):
    app.ensure()
    wait = max(0.0, min(float(a.get("wait_seconds") or 0), 900.0))
    end = time.time() + wait
    while True:
        j = _job(a.get("job_id"))
        if j["status"] in ("done", "error") or time.time() >= end:
            return _summary(j)
        time.sleep(POLL)


def _cut(jid, v, kind):
    q = v.get("quality") or []
    return {"cut": kind, "title": v.get("title"), "start": v.get("start"), "end": v.get("end"), "range": v.get("range"),
            "duration": v.get("duration"), "file": app.path_of(jid, v["file"]),
            "srt": app.path_of(jid, v["srt"]) if v.get("srt") else None,
            "thumbnail": app.path_of(jid, v["thumb"]) if v.get("thumb") else None,
            "quality": f"{sum(1 for c in q if c.get('ok'))}/{len(q)} checks passed",
            "failed_checks": [f"{c['k']} ({c.get('detail', '')})" for c in q if not c.get("ok")],
            "look": v.get("look"), "edited": bool(v.get("edited"))}


def tool_list_clips(a):
    app.ensure()
    j = _job(a.get("job_id"))
    res = j.get("result")
    if not res:
        raise ToolError(f"Job {j['id']} has no clips yet (status: {j['status']}{', ' + j['msg'] if j.get('msg') else ''}).")
    clips = []
    for i, c in enumerate(res["clips"], 1):
        clips.append({"clip": i, "score": c.get("score"), "title": c.get("title"), "reasons": c.get("reasons"),
                      "hashtags": c.get("hashtags"), "post_text": c.get("captions"),
                      "checklist": [("✓ " if x.get("ok") else "✗ ") + x.get("k", "") for x in c.get("checklist") or []],
                      "long": _cut(j["id"], c, "long"), "short": _cut(j["id"], c["short"], "short") if c.get("short") else None})
    return {"job_id": j["id"], "video_title": _title(j), "platform": res.get("platform_name"),
            "job_folder": str(app.jobs_dir() / j["id"]), "clips": clips}


def _words(jid, target, start, end):
    """The words for a re-render: caption fixes saved with the cut, plus the transcript around them."""
    tx = app.request("GET", f"api/jobs/{jid}/transcript").get("words", [])
    fixed = []
    try:
        with app.open_file(jid, Path(target["file"]).with_suffix(".words.json").name) as f:
            fixed = json.loads(f.read())
    except Exception:
        pass
    if fixed:
        lo, hi = min(w["s"] for w in fixed), max(w["e"] for w in fixed)
        tx = [w for w in tx if w["e"] <= lo or w["s"] >= hi] + fixed
    return sorted([w for w in tx if w["s"] >= start - 0.05 and w["e"] <= end + 0.05], key=lambda w: w["s"])


def tool_rerender_clip(a):
    app.ensure()
    j = _job(a.get("job_id"))
    if j["status"] != "done" or not j.get("result"):
        raise ToolError(f"Job {j['id']} isn't finished (status: {j['status']}).")
    clips = j["result"]["clips"]
    try:
        idx = int(a.get("clip")) - 1
        assert 0 <= idx < len(clips)
    except Exception:
        raise ToolError(f"clip must be a clip number from list_clips (1–{len(clips)}).")
    kind = a.get("cut") or "long"
    if kind not in ("long", "short"):
        raise ToolError('cut must be "long" or "short".')
    target = clips[idx] if kind == "long" else clips[idx].get("short")
    if target is None:
        raise ToolError(f"Clip {idx + 1} has no short cut. Use cut \"long\".")
    look = {k: a[s] for s, k in (("style", "style"), ("highlight", "hl"), ("size", "size"), ("position", "pos"),
                                 ("format", "format"), ("layout", "layout"), ("captions", "captions"),
                                 ("headline", "hook"), ("cut_pauses", "tighten"), ("logo", "logo"),
                                 ("reframe_x", "cx")) if a.get(s) is not None}
    for k, allowed in (("style", STYLES), ("format", FORMATS), ("layout", ("fit", "crop")), ("size", ("s", "m", "l")),
                       ("pos", ("bottom", "middle", "top"))):
        if k in look and look[k] not in allowed:
            raise ToolError(f"{k} must be one of {', '.join(allowed)}.")
    if "hl" in look and not re.fullmatch(r"#[0-9a-fA-F]{6}", str(look["hl"])):
        raise ToolError("highlight must be a colour like #FFE600.")
    start = float(a["start"]) if a.get("start") is not None else float(target["start"])
    end = float(a["end"]) if a.get("end") is not None else float(target["end"])
    body = {"clip": idx, "cut": kind, "start": start, "end": end, "title": a.get("title") or target.get("title") or "",
            "words": _words(j["id"], target, start, end), "style": look.get("style"), "look": look}
    if a.get("cta") is not None:
        body["cta"] = str(a["cta"])
    rev = j.get("edit_rev", 0)
    app.request("POST", f"api/jobs/{j['id']}/edit", body)
    end_t = time.time() + max(10.0, min(float(a.get("wait_seconds") or 600), 1800.0))
    while time.time() < end_t:
        time.sleep(POLL)
        j = _job(j["id"])
        if j["status"] == "done" and (j.get("edit_rev", 0) > rev or j.get("edit_error")):
            if j.get("edit_error"):
                raise ToolError(j["edit_error"])
            c = j["result"]["clips"][idx]
            return {"job_id": j["id"], "clip": idx + 1, "rerendered": _cut(j["id"], c if kind == "long" else c["short"], kind)}
    return {"job_id": j["id"], "clip": idx + 1, "status": j["status"],
            "message": "Still rendering. Call job_status with wait_seconds, then list_clips."}


def slug(s, n=48):
    """Same as slug() in docs/zip.js: "The Biggest Mistake I Made!" → "the-biggest-mistake-i-made"."""
    s = unicodedata.normalize("NFKD", str(s or "clip"))
    s = re.sub(r"[̀-ͯ]", "", s).lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:n].rstrip("-")
    return s or "clip"


def _csv(rows):
    return "".join(",".join('"' + str(c).replace('"', '""') + '"' for c in r) + "\r\n" for r in rows)


def tool_export_zip(a):
    """The same .zip the workspace's "Download all" button makes: each cut's .mp4 and .srt, post text, youtube.csv."""
    app.ensure()
    j = _job(a.get("job_id"))
    res = j.get("result")
    if j["status"] not in ("done",) or not res:
        raise ToolError(f"Job {j['id']} isn't finished (status: {j['status']}).")
    nums = a.get("clips") or list(range(1, len(res["clips"]) + 1))
    try:
        picked = [(int(n), res["clips"][int(n) - 1]) for n in nums]
        assert all(n >= 1 for n, _ in picked)
    except Exception:
        raise ToolError(f"clips must be clip numbers from list_clips (1–{len(res['clips'])}).")
    out_dir = Path(a["out_dir"]).expanduser() if a.get("out_dir") else app.jobs_dir() / j["id"]
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / f"{slug(_title(j))}-clips.zip"
    tmp = dest.with_name(dest.name + ".part")

    def base(i, c, which):
        cut = c["short"] if which == "short" else c
        suffix = "-short" if which == "short" else "-long" if c.get("short") else ""
        return f"{i:02d}{suffix}-{slug(cut.get('title'), 40)}"

    rows = [["filename", "title", "description", "hashtag"]]
    for i, c in picked:
        post = c.get("title") or ""
        title = ((c.get("captions") or {}).get("shorts") or post)[:100]
        rows.append([base(i, c, "short" if c.get("short") else "long") + ".mp4", title,
                     "\n\n".join(x for x in (post, " ".join(c.get("hashtags") or [])) if x), "#Shorts"])
    names = []
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED, allowZip64=True) as z:
        z.writestr("youtube.csv", _csv(rows))
        for i, c in picked:
            for which in (("short", "long") if c.get("short") else ("long",)):
                v = c["short"] if which == "short" else c
                b = base(i, c, which)
                for ext, key in ((".mp4", "file"), (".srt", "srt")):
                    with app.open_file(j["id"], v[key]) as src, z.open(b + ext, "w", force_zip64=True) as dst:
                        while chunk := src.read(1 << 20):
                            dst.write(chunk)
                    names.append(b + ext)
            caps = "\n".join(f"{PN.get(k, k)}\n{t}\n" for k, t in (c.get("captions") or {}).items())
            score = f" · score {c['score']}" if c.get("score") is not None else ""
            z.writestr(f"{i:02d}-captions.txt", f"{c.get('title') or ''}\n{c.get('range') or ''}{score}\n\n{caps}")
            names.append(f"{i:02d}-captions.txt")
    os.replace(tmp, dest)
    return {"job_id": j["id"], "zip": str(dest), "bytes": dest.stat().st_size, "clips": [i for i, _ in picked],
            "files": ["youtube.csv", *names]}


def tool_list_jobs(a):
    app.ensure()
    jobs = app.request("GET", "api/jobs")
    return {"jobs": [{"job_id": j["id"], "status": j["status"], "percent": j.get("pct"), "message": j.get("msg"),
                      "label": j.get("label"), "has_clips": j.get("has_result"),
                      "created": time.strftime("%Y-%m-%d %H:%M", time.localtime(j["created"])) if j.get("created") else None}
                     for j in jobs]}


# ---------------------------------------------------------------- tool definitions

S = lambda t, d, **k: {"type": t, "description": d, **k}   # noqa: E731
JOB_ID = S("string", "Job id from new_job or list_jobs.")
LOOK = {
    "style": S("string", "Caption style.", enum=list(STYLES)),
    "highlight": S("string", "Highlight colour for the spoken word, as #RRGGBB (default #FFF000)."),
    "size": S("string", "Caption size: s, m or l.", enum=["s", "m", "l"]),
    "position": S("string", "Caption position.", enum=["bottom", "middle", "top"]),
    "format": S("string", "Frame shape.", enum=list(FORMATS)),
    "captions": S("boolean", "Burn in word-by-word captions (default on)."),
    "headline": S("boolean", "Show the 3-second headline at the start (default on)."),
    "cut_pauses": S("boolean", "Cut dead air and um/uh (default on)."),
    "logo": S("boolean", "Lay the brand logo (set in the workspace) over a top corner."),
}
TOOLS = [
    {"name": "new_job", "fn": tool_new_job,
     "description": "Start clipping a video with Clip Machine. Finds the strongest moments, then renders captioned "
                    "short-form clips that pass a quality gate. Returns a job_id right away; clipping takes minutes "
                    "(call job_status with wait_seconds, then list_clips).",
     "inputSchema": {"type": "object", "required": ["source"], "properties": {
         "source": S("string", "Absolute path to a local video/audio file, or a link (YouTube, TikTok, Twitch VOD, X…)."),
         "platform": S("string", "Platform to cut for: sets clip lengths, safe zones and post text.", enum=list(PLATFORMS)),
         "n": S("integer", "Number of clips, 1–15 (default 5).", minimum=1, maximum=15),
         "version": S("string", "both = a long cut plus a short cut with the same opening; or only one.",
                      enum=["both", "short", "long"]),
         "language": S("string", "Spoken language code (en, es, hi, zh…) or auto to detect (default)."),
         "cta": S("string", "End-card question on the long cut, e.g. 'Which one would you pick?' (max 80 chars)."),
         "layout": S("string", "fit = full frame over a blurred fill; crop = fill the frame; original = keep the source shape.",
                     enum=["fit", "crop", "original"]),
         "model": S("string", "Speech model: tiny is fastest, small is most accurate (default base).",
                    enum=["tiny", "base", "small", "medium"]),
         "min_seconds": S("integer", "Shortest clip length (default: the platform's sweet spot)."),
         "max_seconds": S("integer", "Longest clip length (default: the platform's sweet spot)."),
         **LOOK}}},
    {"name": "job_status", "fn": tool_job_status,
     "description": "Progress of a clipping job (queued, running, done, error). Set wait_seconds to wait until it "
                    "finishes or the time runs out.",
     "inputSchema": {"type": "object", "required": ["job_id"], "properties": {
         "job_id": JOB_ID, "wait_seconds": S("number", "Wait up to this long for the job to finish (0–900, default 0).")}}},
    {"name": "list_clips", "fn": tool_list_clips,
     "description": "The finished clips of a job, best first: score, why each was picked, title, hashtags, post text "
                    "per platform, quality-gate result, and the file paths of each cut (.mp4, .srt, thumbnail).",
     "inputSchema": {"type": "object", "required": ["job_id"], "properties": {"job_id": JOB_ID}}},
    {"name": "rerender_clip", "fn": tool_rerender_clip,
     "description": "Re-render one cut with a new look (caption style, highlight colour, size, position, frame, layout), "
                    "trim, headline or end card. Goes back through the quality gate; if it fails, the previous version "
                    "is kept and the reason is returned. Waits for the render.",
     "inputSchema": {"type": "object", "required": ["job_id", "clip"], "properties": {
         "job_id": JOB_ID,
         "clip": S("integer", "Clip number from list_clips.", minimum=1),
         "cut": S("string", "Which cut to re-render (default long).", enum=["long", "short"]),
         "layout": S("string", "fit = full frame over a blurred fill; crop = fill the frame.", enum=["fit", "crop"]),
         "reframe_x": S("number", "With layout crop: horizontal centre of the crop, 0 (left) to 1 (right)."),
         "start": S("number", "New start in the source video, in seconds."),
         "end": S("number", "New end in the source video, in seconds."),
         "title": S("string", "New headline (max 90 chars)."),
         "cta": S("string", "New end-card text; empty string removes it."),
         "wait_seconds": S("number", "Give up waiting after this long (default 600)."),
         **LOOK}}},
    {"name": "export_zip", "fn": tool_export_zip,
     "description": "Pack a job's clips into a .zip (each cut's .mp4 and .srt, post text for every platform, and a "
                    "youtube.csv upload sheet), the same as the workspace's Download all. Returns the .zip path.",
     "inputSchema": {"type": "object", "required": ["job_id"], "properties": {
         "job_id": JOB_ID,
         "clips": S("array", "Clip numbers to include (default all).", items={"type": "integer"}),
         "out_dir": S("string", "Folder to write the .zip to (default: the job's folder).")}}},
    {"name": "list_jobs", "fn": tool_list_jobs,
     "description": "The 30 most recent clipping jobs in the desktop app, newest first.",
     "inputSchema": {"type": "object", "properties": {}}},
]
BY_NAME = {t["name"]: t for t in TOOLS}


# ---------------------------------------------------------------- MCP over stdio (JSON-RPC 2.0, one message per line)

out_lock = threading.Lock()


def send(msg):
    data = (json.dumps(msg, ensure_ascii=False) + "\n").encode("utf-8")
    with out_lock:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def call_tool(mid, params):
    t = BY_NAME.get(params.get("name"))
    if not t:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"Unknown tool: {params.get('name')}"}})
        return
    try:
        out = t["fn"](params.get("arguments") or {})
        result = {"content": [{"type": "text", "text": json.dumps(out, indent=1, ensure_ascii=False)}],
                  "structuredContent": out, "isError": False}
    except ToolError as e:
        result = {"content": [{"type": "text", "text": str(e)}], "isError": True}
    except Exception as e:   # never take the server down; tell the agent what broke
        log("tool", t["name"], "failed:", repr(e))
        result = {"content": [{"type": "text", "text": f"{t['name']} failed: {e}"}], "isError": True}
    send({"jsonrpc": "2.0", "id": mid, "result": result})


def handle(msg):
    mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
    if mid is None:   # a notification (initialized, cancelled…): nothing to answer
        return
    if method == "initialize":
        want = params.get("protocolVersion")
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": want if want in PROTOCOLS else PROTOCOLS[0],
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "clip-machine", "title": "Clip Machine", "version": VERSION},
            "instructions": "Clip Machine cuts long videos into captioned short-form clips on this computer. "
                            "new_job → job_status (wait_seconds) → list_clips → rerender_clip / export_zip. "
                            "Only clip videos the user owns or has permission to repost."}})
    elif method == "ping":
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "tools": [{k: v for k, v in t.items() if k != "fn"} for t in TOOLS]}})
    elif method == "tools/call":
        threading.Thread(target=call_tool, args=(mid, params), daemon=True).start()   # long waits don't block ping
    else:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"Method not found: {method}"}})


def main():
    log(f"ready (desktop app: {app.base})")
    try:
        for line in sys.stdin.buffer:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
                continue
            for m in (msg if isinstance(msg, list) else [msg]):
                if isinstance(m, dict) and "method" in m:
                    handle(m)
    finally:
        app.stop()


if __name__ == "__main__":
    main()
