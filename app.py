"""Clip Machine web app. Runs on your Mac; open it from your phone on the same Wi-Fi.

    .venv/bin/python app.py          (or double-click Start Clip Machine.command)
"""
import json
import math
import re
import os
import sys
import secrets
import socket
import threading
import time
import traceback
import urllib.parse
import uuid
from pathlib import Path
from queue import Queue

from flask import Flask, abort, jsonify, make_response, redirect, request, send_file, send_from_directory

import clipper
import search

HERE = Path(__file__).resolve().parent
JOBS = Path(os.environ.get("CLIP_JOBS") or HERE / "jobs")      # CLIP_JOBS / CLIP_KEY: tests run an isolated server
JOBS.mkdir(parents=True, exist_ok=True)
PORT = int(os.environ.get("CLIP_PORT", 8765))
def logo_file():
    """The brand logo laid over clips (uploaded from the workspace, always PNG); None when there isn't one."""
    p = JOBS / "_brand" / "logo.png"
    return p if p.is_file() else None
KEY_FILE = HERE / ".access_key"
KEY_ROTATED = False


def _load_key():
    """The access key. Keys from before 1.7.1 (11 characters) were served to anyone on the network through
    /manifest.json, so they are replaced once with a longer one; phones then need the new link or QR code."""
    global KEY_ROTATED
    if os.environ.get("CLIP_KEY"):
        return os.environ["CLIP_KEY"]
    old = KEY_FILE.read_text(encoding="utf-8").strip() if KEY_FILE.exists() else ""
    if len(old) >= 20:
        return old
    KEY_FILE.write_text(secrets.token_urlsafe(18), encoding="utf-8")
    try:
        os.chmod(KEY_FILE, 0o600)
    except OSError:
        pass
    KEY_ROTATED = bool(old)
    return KEY_FILE.read_text(encoding="utf-8").strip()


KEY = _load_key()

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 ** 3  # 4 GB uploads
jobs: dict[str, dict] = {}
queue: Queue = Queue()
STAGES = {"download": (0, 20), "analyze": (20, 25), "transcribe": (25, 70), "score": (70, 72), "render": (72, 100)}


def authed():
    k = request.args.get("key") or request.cookies.get("ck") or request.headers.get("X-Key")
    return secrets.compare_digest(k or "", KEY)


@app.before_request
def gate():
    if request.path in PUBLIC_UI_FILES:
        return
    if not authed():
        return make_response("Clip Machine: open the link with ?key=… shown on your Mac.", 403)


@app.after_request
def remember(resp):
    if secrets.compare_digest(request.args.get("key") or "", KEY):
        resp.set_cookie("ck", KEY, max_age=60 * 60 * 24 * 365, samesite="Lax", httponly=True)
        if request.method == "GET" and request.path in ("/", "/classic", "/index.html", "/workspace.html") and resp.status_code == 200:
            # the cookie now carries the key: take it out of the address bar (history, screenshots, shared links)
            rest = urllib.parse.urlencode([(k, v) for k, v in request.args.items(multi=True) if k != "key"])
            resp = redirect(request.path + ("?" + rest if rest else ""), 302)
            resp.set_cookie("ck", KEY, max_age=60 * 60 * 24 * 365, samesite="Lax", httponly=True)
    return resp


def worker():
    while True:
        item = queue.get()
        if isinstance(item, tuple):          # ("edit", jid, payload): re-render one cut
            run_edit(*item[1:])
            queue.task_done()
            continue
        jid = item
        job = jobs.get(jid)
        if not job:                           # removed while it waited
            queue.task_done()
            continue
        if job.get("cancel"):
            job.update(status="error", msg="Cancelled")
            save(jid)
            queue.task_done()
            continue
        job["status"] = "running"

        def progress(stage, pct, msg=""):
            if job.get("cancel"):
                raise RuntimeError("Cancelled")
            lo, hi = STAGES.get(stage, (0, 100))
            job["pct"] = round(lo + (hi - lo) * pct / 100, 1)
            job["msg"] = msg
        try:
            o = job["opts"]
            res = clipper.run(o["source"], JOBS / jid, n=o["n"], min_len=o["min"], max_len=o["max"],
                              layout=o["layout"], captions=o["captions"], model=o["model"], language=o.get("lang", "auto"),
                              crop_x=o["crop_x"], platform=o.get("platform", "all"),
                              hook=o.get("hook", True), tighten=o.get("tighten", True),
                              version=o.get("version", "both"), cta=o.get("cta", ""),
                              enhance=o.get("enhance", True), style=o.get("style", "pop"), progress=progress,
                              look={k: o[k] for k in LOOK_KEYS if k in o}, logo=logo_file())
            job.update(status="done", pct=100, msg="Done", result=res)
            # the source is kept so clips can be edited and re-rendered; deleting the job frees the space
        except Exception as e:
            traceback.print_exc()
            job.update(status="error", msg=clipper.explain_error(e)[:1500])
        finally:
            save(jid)
            queue.task_done()


def run_edit(jid, p):
    job = jobs.get(jid)
    if not job:
        return
    job.update(status="editing", pct=0, msg="Re-rendering your edit")
    def progress(stage, pct, msg=""):
        job.update(pct=pct, msg=msg)
    try:
        res = clipper.edit_cut(JOBS / jid, p["clip"], p["cut"], p["start"], p["end"], p["title"], p["words"],
                               p.get("style"), progress, look=p.get("look"), cta=p.get("cta"), logo=logo_file(),
                               reason=p.get("reason"), payoff=p.get("payoff", "keep"))
        job.update(status="done", pct=100, msg="Edit saved", result=res, edit_error=None, edit_rev=job.get("edit_rev", 0) + 1)
    except Exception as e:
        traceback.print_exc()
        job.update(status="done", pct=100, msg="Done", edit_error=clipper.explain_error(e)[:1200])
    finally:
        save(jid)


def write_atomic(path, text):
    """Write via a temp file + rename, so a crash mid-write never leaves a half-written (unreadable) file."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


def save(jid):
    j = {k: v for k, v in jobs[jid].items()}
    write_atomic(JOBS / jid / "job.json", json.dumps(j))


def load_history():
    for d in JOBS.iterdir():
        f = d / "job.json"
        if f.exists():
            try:
                j = json.loads(f.read_text())
                if j.get("status") in ("queued", "running", "editing"):
                    if j.get("result"):   # an edit was interrupted: the finished clips are still there
                        j.update(status="done", pct=100, msg="Done", edit_error="The edit was interrupted (server restarted). Try it again.")
                    else:
                        j.update(status="error", msg="Interrupted (server restarted)")
                jobs[d.name] = j
            except Exception:
                pass


LOOK_KEYS = ("format", "hl", "size", "pos", "logo", "lpos", "lsize", "lop")


def new_job(source, form, upload_dir=None):
    jid = time.strftime("%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
    (JOBS / jid).mkdir()
    def num(k, d, lo, hi):
        try:
            v = float(form.get(k, d))
            return max(lo, min(hi, v)) if math.isfinite(v) else d
        except (TypeError, ValueError):   # missing, null or junk → the default
            return d
    opts = {
        "source": source,
        "n": int(num("n", 5, 1, 15)),
        "min": int(num("min", 20, 5, 170)) if form.get("min") not in (None, "", "auto") else None,
        "max": int(num("max", 60, 10, 600)) if form.get("max") not in (None, "", "auto") else None,
        "platform": form.get("platform") if form.get("platform") in clipper.PLATFORMS else "all",
        "hook": str(form.get("hook", "1")) in ("1", "true", "on"),
        "tighten": str(form.get("tighten", "1")) in ("1", "true", "on"),
        "version": form.get("version") if form.get("version") in ("both", "short", "long") else "both",
        "cta": str(form.get("cta") or "")[:80],
        "enhance": str(form.get("enhance", "1")) in ("1", "true", "on"),
        "style": form.get("style") if form.get("style") in clipper.CAPTION_STYLES else "pop",
        "layout": form.get("layout", "fit") if form.get("layout") in (*clipper.LAYOUTS, "original") else "fit",
        "captions": str(form.get("captions", "1")) in ("1", "true", "on"),
        "model": form.get("model", "base") if form.get("model") in ("tiny", "base", "small", "medium") else "base",
        "lang": form.get("lang") if form.get("lang") in clipper.LANGUAGES else "auto",
        "crop_x": num("crop_x", 0.5, 0, 1),
        **clipper.clean_look({k: form.get(k) for k in LOOK_KEYS}),
    }
    opts.pop("cy", None)
    if upload_dir:
        opts["upload_dir"] = upload_dir   # recorded before the job is queued, so a restart can still clean it up
    jobs[jid] = {"id": jid, "status": "queued", "pct": 0, "msg": "Waiting in line", "opts": opts,
                 "label": form.get("label") or source, "created": time.time()}
    save(jid)
    queue.put(jid)
    return jid


@app.post("/api/jobs")
def create():
    if "file" in request.files and request.files["file"].filename:
        f = request.files["file"]
        jid_dir = JOBS / ("upload-" + uuid.uuid4().hex[:8])
        jid_dir.mkdir()
        ext = Path(f.filename).suffix.lower() or ".mp4"
        dest = jid_dir / ("source" + ext)
        f.save(dest)
        form = dict(request.form)
        form["label"] = f.filename
        return jsonify(id=new_job(str(dest), form, str(jid_dir)))
    data = request.get_json(silent=True) or dict(request.form)
    url = (data.get("url") or "").strip()
    if not url.startswith(("http://", "https://")):
        return jsonify(error="Paste a full link starting with https://"), 400
    return jsonify(id=new_job(url, data))


@app.post("/api/jobs/<jid>/edit")
def edit(jid):
    job = jobs.get(jid)
    if not job or job["status"] != "done" or not job.get("result"):
        return jsonify(error="That job isn't finished."), 400
    d = request.get_json(silent=True) or {}
    try:
        clip = int(d.get("clip", -1)); cut = d.get("cut")
        assert cut == "new" or (0 <= clip < len(job["result"]["clips"]) and cut in ("long", "short"))
        assert all(math.isfinite(float(d[k])) for k in ("start", "end")) and float(d["end"]) > float(d["start"])
        payload = {"clip": clip, "cut": cut, "start": float(d["start"]), "end": float(d["end"]),
                   "title": str(d.get("title", ""))[:90], "words": list(d.get("words") or [])[:5000],
                   "style": d.get("style"), "look": clipper.clean_look(d.get("look")) if isinstance(d.get("look"), dict) else None,
                   "cta": str(d["cta"])[:80] if isinstance(d.get("cta"), str) else None,
                   "reason": str(d["reason"])[:120] if isinstance(d.get("reason"), str) else None}
        if "payoff" in d:                 # the moment the clip has to reach (source seconds), or null to clear it
            payload["payoff"] = None if d["payoff"] is None else float(d["payoff"])
            assert payload["payoff"] is None or math.isfinite(payload["payoff"]) and payload["payoff"] >= 0
    except Exception:
        return jsonify(error="Bad edit request."), 400
    job.update(status="queued", msg="Edit waiting in line", edit_error=None)
    queue.put(("edit", jid, payload))
    return jsonify(ok=True)


@app.get("/api/search")
def search_ready():
    return jsonify(ready=search.is_cached(), model=search.MODEL, mb=135)


@app.post("/api/search")
def find_by_description():
    """Find clips by description: rank the transcript's sentence windows against a typed query (search.py).
    The page sends the words it shows, so retyped words count. all=true returns every window with its score."""
    d = request.get_json(silent=True) or {}
    try:
        query = search.clean_query(d.get("query"))
        words = [{"w": str(w["w"]), "s": float(w["s"]), "e": float(w["e"])} for w in list(d.get("words") or [])[:200000]]
        assert all(math.isfinite(w["s"]) and math.isfinite(w["e"]) for w in words)
        duration = float(d.get("duration") or 0)
        duration = duration if math.isfinite(duration) and duration > 0 else (words[-1]["e"] if words else 0)
        n = max(1, min(10, int(d.get("n", 3))))
    except Exception:
        return jsonify(error="Bad search request."), 400
    if not query or not words:
        return jsonify(error="Type what you're looking for."), 400
    try:
        if d.get("all"):
            return jsonify(windows=search.scored_windows(words, duration, query))
        return jsonify(matches=search.search(words, duration, query, n))
    except Exception as e:
        traceback.print_exc()
        return jsonify(error=f"The search model couldn't run: {str(e)[:200]}"), 500


@app.post("/api/jobs/<jid>/cancel")
def cancel(jid):
    job = jobs.get(jid)
    if not job:
        abort(404)
    if job["status"] in ("queued", "running"):
        job["cancel"] = True
    return jsonify(ok=True)


def _session(jid):
    try:
        return json.loads((JOBS / jid / "session.json").read_text())
    except Exception:
        abort(404)


@app.get("/api/jobs/<jid>/transcript")
def transcript(jid):
    """Every word with its timing + the 50 ms level map: the studio's transcript, timeline and waveform."""
    if jid not in jobs:
        abort(404)
    try:
        segs = json.loads((JOBS / jid / "transcript.json").read_text())
    except Exception:
        abort(404)
    words = [{"w": w["w"], "s": w["s"], "e": w["e"]} for sg in segs for w in sg.get("words", [])]
    try:
        quiet = json.loads((JOBS / jid / "quiet.json").read_text())
    except Exception:
        quiet = None
    sess = _session(jid)
    return jsonify(words=words, quiet=quiet, has_video=sess.get("has_video", True), duration=sess.get("duration"),
                   source=source_info(jid, sess))


_source_cache: dict[str, dict] = {}


def source_info(jid, sess):
    """The source file's name, path, frame rate and size, for handing a clip to Premiere / Resolve (probed once)."""
    if jid not in _source_cache:
        path = Path(sess.get("video") or "")
        info = {"name": path.name, "path": str(path) if path.is_file() else ""}
        try:
            p = clipper.probe(path) if path.is_file() else {}
            fr = clipper._fps(p.get("frame_rate")) or clipper._fps(p.get("fps"))
            info.update(fps=round(float(fr), 3) if fr else None, width=p.get("width"), height=p.get("height"))
        except Exception:
            pass
        _source_cache[jid] = info
    return _source_cache[jid]


@app.get("/api/jobs/<jid>/reframe")
def reframe_plan(jid):
    """Where auto-reframe or split-screen will put the frame for start..end (reframe.py), so the studio previews it
    before rendering. Times are source seconds; positions are face centres, 0-1 of the source frame."""
    if jid not in jobs:
        abort(404)
    sess = _session(jid)
    try:
        start, end = float(request.args["start"]), float(request.args["end"])
        assert math.isfinite(start) and math.isfinite(end) and 0 <= start < end and end - start <= 900
    except Exception:
        return jsonify(error="Bad start/end."), 400
    mode = request.args.get("mode") if request.args.get("mode") in ("auto", "split") else "auto"
    W, H = clipper.frame_size(request.args.get("format") if request.args.get("format") in clipper.FORMATS else "9:16")
    if not sess.get("has_video", True):
        return jsonify(mode="none", note="Audio-only source: nothing to reframe.")
    try:
        segs = json.loads((JOBS / jid / "transcript.json").read_text())
    except Exception:
        segs = []
    words = [w for sg in segs for w in sg.get("words", []) if start - 1 <= w["s"] <= end + 1]
    m = clipper.Moment(start=start, end=end, title="", words=words)
    return jsonify(clipper.reframe_plan(Path(sess["video"]), m, W / H, mode, JOBS / jid))


@app.get("/api/jobs/<jid>/source")
def source(jid):
    """The source video, for the studio's live preview (supports seeking: range requests)."""
    if jid not in jobs:
        abort(404)
    video = Path(_session(jid)["video"])
    if not video.exists():
        abort(404)
    return send_file(video, conditional=True)


@app.get("/api/brand/logo")
def get_logo():
    p = logo_file()
    if not p:
        abort(404)
    return send_file(p, mimetype="image/png", max_age=0)


@app.post("/api/brand/logo")
def put_logo():
    data = request.get_data(cache=False)
    if not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) > 2 * 1024 ** 2:
        return jsonify(error="Send the logo as a PNG under 2 MB."), 400
    d = JOBS / "_brand"
    d.mkdir(parents=True, exist_ok=True)
    (d / "logo.tmp").write_bytes(data)
    os.replace(d / "logo.tmp", d / "logo.png")
    return jsonify(ok=True)


@app.delete("/api/brand/logo")
def del_logo():
    (JOBS / "_brand" / "logo.png").unlink(missing_ok=True)
    return jsonify(ok=True)


@app.get("/api/info")
def info():
    # jobs_dir: where clips are written, so mcp_server.py can hand agents real file paths
    return jsonify(desktop=True, version=clipper.VERSION, models=["tiny", "base", "small"], formats=list(clipper.FORMATS),
                   layouts=list(clipper.LAYOUTS), jobs_dir=str(JOBS.resolve()))


@app.get("/api/jobs")
def list_jobs():
    out = sorted(jobs.values(), key=lambda j: -j.get("created", 0))[:30]
    return jsonify([{**{k: j.get(k) for k in ("id", "status", "pct", "msg", "label", "created")}, "has_result": bool(j.get("result"))}
                    for j in out])


@app.get("/api/jobs/<jid>")
def get_job(jid):
    if jid not in jobs:
        abort(404)
    return jsonify(jobs[jid])


@app.delete("/api/jobs/<jid>")
def del_job(jid):
    if jid not in jobs or jobs[jid]["status"] in ("queued", "running", "editing"):
        abort(400)
    import shutil
    shutil.rmtree(JOBS / jid, ignore_errors=True)
    up = jobs[jid]["opts"].get("upload_dir")
    if up:
        shutil.rmtree(up, ignore_errors=True)
    jobs.pop(jid)
    return jsonify(ok=True)


@app.get("/files/<jid>/<path:name>")
def files(jid, name):
    if jid not in jobs:
        abort(404)
    dl = request.args.get("dl") == "1"
    return send_from_directory(JOBS / jid, name, as_attachment=dl)


# ---- results log: judge each cut by its job (24 h, 72 h, and 7 day check-ins)
LOG = Path(os.environ.get("CLIP_LOG") or HERE / "results_log.json")
LOG_COLUMNS = ["logged", "platform", "clip", "cut", "title", "posted", "checkpoint", "views",
               "metric1", "metric2", "metric3", "notes", "feed_shown", "feed_share", "avg_view_duration",
               "score", "signals",   # signals: the clip's scoring signals as compact JSON, for learning from results
               "post", "rev"]        # post: the platform's id for the post; rev: which render of the cut was posted
POST_ID = [re.compile(p) for p in (
    r"(?:youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|live/)|youtu\.be/)([A-Za-z0-9_-]{11})",
    r"tiktok\.com/@[\w.-]+/video/(\d+)", r"instagram\.com/(?:reels?|p)/([\w-]+)",
    r"facebook\.com/(?:reel/|.*[?&]v=|watch/\?v=)(\d+)", r"(?:x|twitter)\.com/\w+/status/(\d+)",
    r"snapchat\.com/spotlight/([\w-]+)")]


def post_id(value):
    """A post's link or id → the platform's id, so the same post is recognised however it was pasted.
    Mirrors postId in formula.js."""
    v = str(value or "").strip()
    for rx in POST_ID:
        m = rx.search(v)
        if m:
            return m.group(1)
    return v.split("?")[0].rstrip("/").rsplit("/", 1)[-1][:80] if v.startswith("http") else v[:80]


def log_conflict(rows, row):
    """Why this result can't be logged, or None. One post per cut per platform; a post id belongs to one cut;
    each checkpoint of a post is logged once. Mirrors logConflict in formula.js."""
    pid = row.get("post") or ""
    if not pid:
        return None
    same_cut = lambda r: all((r.get(k) or "") == (row.get(k) or "") for k in ("job", "clip", "cut"))
    for r in rows:
        if r.get("platform") != row.get("platform"):
            continue
        if r.get("post") == pid and not same_cut(r):
            return f"Post {pid} is already logged for \"{str(r.get('title') or 'another clip')[:60]}\"."
        if r.get("post") and r.get("post") != pid and same_cut(r):
            return (f"This cut is already logged on that platform as post {r['post']}. One post per platform: "
                    "log new numbers against that post, or delete its rows first.")
        if r.get("post") == pid and r.get("checkpoint") == row.get("checkpoint"):
            return f"The {row.get('checkpoint')} numbers for post {pid} are already logged. Delete that row to replace them."
    return None
LOG_FIELDS = ["job", *LOG_COLUMNS[1:]]
log_lock = threading.Lock()


def read_log():
    try:
        rows = json.loads(LOG.read_text())
    except FileNotFoundError:
        return []
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError("Invalid results log")
    return rows


def log_fields(data):
    return {k: str(data.get(k, ""))[:300] for k in LOG_FIELDS}


@app.get("/api/log")
def get_log():
    return jsonify(read_log())


@app.post("/api/log")
def add_log():
    d = request.get_json(silent=True)
    if not isinstance(d, dict):
        return jsonify(error="Enter a result and try saving again."), 400
    row = log_fields(d)
    row["post"] = post_id(row.get("post"))
    row["id"] = uuid.uuid4().hex[:8]
    row["logged"] = time.strftime("%Y-%m-%d %H:%M")
    with log_lock:
        rows = read_log()
        why = log_conflict(rows, row)
        if why:
            return jsonify(error=why), 409
        rows.append(row)
        write_atomic(LOG, json.dumps(rows, indent=1))
    return jsonify(row)


@app.post("/api/log/import")
def import_log():
    """Move results saved by an older desktop workspace from its browser into the shared log."""
    incoming = request.get_json(silent=True)
    if not isinstance(incoming, list) or any(
        not isinstance(row, dict) or not isinstance(row.get("id"), str)
        or not 1 <= len(row["id"]) <= 8 or not row["id"].isascii() or not row["id"].isalnum()
        for row in incoming
    ):
        return jsonify(error="The saved browser results could not be imported."), 400
    with log_lock:
        rows = read_log()
        ids = {row.get("id") for row in rows}
        for data in incoming:
            rid = "browser-" + data["id"]
            if rid in ids:
                continue
            rows.append({**log_fields(data), "id": rid, "logged": str(data.get("logged", ""))[:16]})
            ids.add(rid)
        write_atomic(LOG, json.dumps(rows, indent=1))
    return jsonify(ok=True)


@app.delete("/api/log/<rid>")
def del_log(rid):
    with log_lock:
        write_atomic(LOG, json.dumps([r for r in read_log() if r.get("id") != rid], indent=1))
    return jsonify(ok=True)


# ---- YouTube Studio import: the latest export, matched against the log in the page to learn which signals work
STUDIO = Path(os.environ.get("CLIP_STUDIO") or HERE / "studio_import.json")


def clean_studio(d):
    """Keep only the shape the page writes: {file, imported, columns, rows: [{title, published, values}]}."""
    if not isinstance(d, dict) or not isinstance(d.get("rows"), list) or not isinstance(d.get("columns", []), list):
        return None
    if len(d["rows"]) > 5000 or len(d.get("columns", [])) > 60:
        return None
    cols = [str(c)[:120] for c in d.get("columns", [])]
    rows = []
    for r in d["rows"]:
        if not isinstance(r, dict) or not isinstance(r.get("values", {}), dict):
            return None
        vals = {}
        for c in cols:
            v = r.get("values", {}).get(c)
            vals[c] = float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None
        rows.append({"title": str(r.get("title", ""))[:300], "published": str(r.get("published", ""))[:60], "values": vals})
    return {"file": str(d.get("file", ""))[:120], "imported": str(d.get("imported", ""))[:20], "columns": cols, "rows": rows}


@app.get("/api/studio")
def get_studio():
    try:
        return jsonify(studio=json.loads(STUDIO.read_text()))
    except FileNotFoundError:
        return jsonify(studio=None)


@app.post("/api/studio")
def put_studio():
    if (request.content_length or 0) > 5_000_000:
        return jsonify(error="That import is too large. Export a shorter date range."), 400
    d = clean_studio(request.get_json(silent=True))
    if d is None:
        return jsonify(error="The YouTube Studio import could not be saved. Import the CSV again."), 400
    with log_lock:
        write_atomic(STUDIO, json.dumps(d))
    return jsonify(ok=True)


@app.delete("/api/studio")
def del_studio():
    with log_lock:
        STUDIO.unlink(missing_ok=True)
    return jsonify(ok=True)


@app.get("/api/log.csv")
def log_csv():
    import csv, io
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(LOG_COLUMNS)
    for r in read_log():
        w.writerow([r.get(k, "") for k in LOG_COLUMNS])
    resp = make_response(buf.getvalue())
    resp.headers["Content-Type"] = "text/csv"
    resp.headers["Content-Disposition"] = "attachment; filename=clip_results.csv"
    return resp


@app.get("/api/platforms")
def platforms():
    return jsonify(clipper.PLATFORMS)


PUBLIC_UI_FILES = {"/manifest.json", "/icon.svg", "/icon-180.png", "/icon-512.png",
                   "/brand/favicon.svg", "/brand/favicon-32.png", "/brand/favicon.ico",
                   "/brand/lockup-horizontal.svg", "/brand/logo-mark.svg"}
BRAND_FILES = {p.removeprefix("/brand/") for p in PUBLIC_UI_FILES if p.startswith("/brand/")}
UI_FILES = {"index.html", "workspace.html", "home.css", "home.js", "privacy.html", "pricing.html", "pricing.css", "pricing.js", "og-image.png", "formula.js", "formula.json", "app.js", "studio.js", "account.js", "zip.js", "nle.js", "asr-worker.js", "search.js", "search-worker.js", "sw.js", "icon-180.png", "icon-512.png"}


@app.get("/index.html")
@app.get("/workspace.html")
@app.get("/home.css")
@app.get("/home.js")
@app.get("/privacy.html")
@app.get("/pricing.html")
@app.get("/pricing.css")
@app.get("/pricing.js")
@app.get("/og-image.png")
@app.get("/brand/<path:sub>")
@app.get("/formula.js")
@app.get("/formula.json")
@app.get("/app.js")
@app.get("/studio.js")
@app.get("/account.js")
@app.get("/zip.js")
@app.get("/nle.js")
@app.get("/asr-worker.js")
@app.get("/search.js")
@app.get("/search-worker.js")
@app.get("/sw.js")
@app.get("/icon-180.png")
@app.get("/icon-512.png")
@app.get("/fonts/<path:sub>")
@app.get("/vendor/<path:sub>")
def ui_files(sub=None):
    # the browser UI lives in docs/ in the repo (web/ in the release zip); the desktop app serves the same pages
    name = request.path.lstrip("/")
    if not (name in UI_FILES or (name.startswith("brand/") and sub in BRAND_FILES) or name.startswith(("fonts/", "vendor/"))):
        abort(404)
    for d in (HERE / "docs", HERE / "web"):
        if (d / name).is_file():
            return send_from_directory(d, name)
    abort(404)


@app.get("/")
def index():
    for d in (HERE / "docs", HERE / "web"):
        if (d / "index.html").exists() and (d / "studio.js").exists():
            return send_from_directory(d, "workspace.html" if (d / "workspace.html").is_file() else "index.html")
    return send_from_directory(HERE, "index.html")


@app.get("/classic")
def classic():
    return send_from_directory(HERE, "index.html")


@app.get("/manifest.json")
def manifest():
    # public so a phone can install the app, but the key goes in start_url only for a device that already has it
    # (a home-screen app on iOS keeps its own cookies, so it needs the key once on launch)
    start = f"/?key={KEY}" if authed() else "/"
    resp = jsonify(name="Clip Machine", short_name="Clips", start_url=start, display="standalone",
                   background_color="#05070c", theme_color="#05070c",
                   icons=[{"src": "/icon.svg", "sizes": "any", "type": "image/svg+xml"},
                          {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"},
                          {"src": "/icon-180.png", "sizes": "180x180", "type": "image/png"}])
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["Vary"] = "Cookie"
    return resp


@app.get("/icon.svg")
def icon():
    for directory in (HERE / "docs", HERE / "web"):
        if (directory / "icon.svg").is_file():
            return send_from_directory(directory, "icon.svg")
    abort(404)


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    for _s in (sys.stdout, sys.stderr):   # Windows consoles: never crash on ✓/✗ or emoji
        try:
            _s.reconfigure(errors="replace")
        except Exception:
            pass
    load_history()
    threading.Thread(target=worker, daemon=True).start()
    url = f"http://{lan_ip()}:{PORT}/?key={KEY}"
    print("\n  Clip Machine is running.\n")
    if KEY_ROTATED:
        print("  Security update: the access key has changed. Open the new link (or scan the new code) on your phone;\n"
              "  a home-screen app added before this update needs deleting and adding again.\n")
    print(f"  On this Mac:   http://127.0.0.1:{PORT}/?key={KEY}")
    print(f"  On your phone: {url}   (same Wi-Fi)\n")
    try:
        import qrcode
        q = qrcode.QRCode(border=1)
        q.add_data(url)
        q.print_ascii(invert=True)
        print("  Scan this with your phone camera, then Share → Add to Home Screen.\n")
    except Exception:
        pass
    app.run(host="0.0.0.0", port=PORT, threaded=True)
