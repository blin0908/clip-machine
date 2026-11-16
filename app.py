"""Clip Machine web app. Runs on your Mac; open it from your phone on the same Wi-Fi.

    .venv/bin/python app.py          (or double-click Start Clip Machine.command)
"""
import json
import math
import os
import sys
import secrets
import socket
import threading
import time
import traceback
import uuid
from pathlib import Path
from queue import Queue

from flask import Flask, abort, jsonify, request, send_file, send_from_directory, make_response

import clipper

HERE = Path(__file__).resolve().parent
JOBS = Path(os.environ.get("CLIP_JOBS") or HERE / "jobs")      # CLIP_JOBS / CLIP_KEY: tests run an isolated server
JOBS.mkdir(parents=True, exist_ok=True)
PORT = int(os.environ.get("CLIP_PORT", 8765))
def logo_file():
    """The brand logo laid over clips (uploaded from the workspace, always PNG); None when there isn't one."""
    p = JOBS / "_brand" / "logo.png"
    return p if p.is_file() else None
KEY_FILE = HERE / ".access_key"
if not os.environ.get("CLIP_KEY") and not KEY_FILE.exists():
    KEY_FILE.write_text(secrets.token_urlsafe(8))
KEY = os.environ.get("CLIP_KEY") or KEY_FILE.read_text().strip()

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
    if request.path in ("/manifest.json", "/icon.svg"):
        return
    if not authed():
        return make_response("Clip Machine: open the link with ?key=… shown on your Mac.", 403)


@app.after_request
def remember(resp):
    if request.args.get("key") == KEY:
        resp.set_cookie("ck", KEY, max_age=60 * 60 * 24 * 365, samesite="Lax")
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
                              layout=o["layout"], captions=o["captions"], model=o["model"],
                              crop_x=o["crop_x"], platform=o.get("platform", "all"),
                              hook=o.get("hook", True), tighten=o.get("tighten", True),
                              version=o.get("version", "both"), cta=o.get("cta", ""),
                              enhance=o.get("enhance", True), style=o.get("style", "pop"), progress=progress,
                              look={k: o[k] for k in LOOK_KEYS if k in o}, logo=logo_file())
            job.update(status="done", pct=100, msg="Done", result=res)
            # the source is kept so clips can be edited and re-rendered; deleting the job frees the space
        except Exception as e:
            traceback.print_exc()
            job.update(status="error", msg=str(e)[:600])
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
                               p.get("style"), progress, look=p.get("look"), cta=p.get("cta"), logo=logo_file())
        job.update(status="done", pct=100, msg="Edit saved", result=res, edit_error=None, edit_rev=job.get("edit_rev", 0) + 1)
    except Exception as e:
        traceback.print_exc()
        job.update(status="done", pct=100, msg="Done", edit_error=str(e)[:400])
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
        "layout": form.get("layout", "fit") if form.get("layout") in ("fit", "crop", "original") else "fit",
        "captions": str(form.get("captions", "1")) in ("1", "true", "on"),
        "model": form.get("model", "base") if form.get("model") in ("tiny", "base", "small", "medium") else "base",
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
                   "cta": str(d["cta"])[:80] if isinstance(d.get("cta"), str) else None}
    except Exception:
        return jsonify(error="Bad edit request."), 400
    job.update(status="queued", msg="Edit waiting in line", edit_error=None)
    queue.put(("edit", jid, payload))
    return jsonify(ok=True)


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
    return jsonify(words=words, quiet=quiet, has_video=sess.get("has_video", True), duration=sess.get("duration"))


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
    return jsonify(desktop=True, models=["tiny", "base", "small"], formats=list(clipper.FORMATS))


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
               "metric1", "metric2", "metric3", "notes", "feed_shown", "feed_share", "avg_view_duration"]
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
    row["id"] = uuid.uuid4().hex[:8]
    row["logged"] = time.strftime("%Y-%m-%d %H:%M")
    with log_lock:
        rows = read_log()
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


UI_FILES = {"formula.js", "formula.json", "app.js", "studio.js", "zip.js", "asr-worker.js", "sw.js", "icon-180.png", "icon-512.png"}


@app.get("/formula.js")
@app.get("/formula.json")
@app.get("/app.js")
@app.get("/studio.js")
@app.get("/zip.js")
@app.get("/asr-worker.js")
@app.get("/sw.js")
@app.get("/icon-180.png")
@app.get("/icon-512.png")
@app.get("/fonts/<path:sub>")
@app.get("/vendor/<path:sub>")
def ui_files(sub=None):
    # the browser UI lives in docs/ in the repo (web/ in the release zip); the desktop app serves the same pages
    name = request.path.lstrip("/")
    if not (name in UI_FILES or name.startswith(("fonts/", "vendor/"))):
        abort(404)
    for d in (HERE / "docs", HERE / "web"):
        if (d / name).is_file():
            return send_from_directory(d, name)
    abort(404)


@app.get("/")
def index():
    for d in (HERE / "docs", HERE / "web"):
        if (d / "index.html").exists() and (d / "studio.js").exists():
            return send_from_directory(d, "index.html")
    return send_from_directory(HERE, "index.html")


@app.get("/classic")
def classic():
    return send_from_directory(HERE, "index.html")


@app.get("/manifest.json")
def manifest():
    return jsonify(name="Clip Machine", short_name="Clips", start_url=f"/?key={KEY}", display="standalone",
                   background_color="#0b0b0f", theme_color="#0b0b0f",
                   icons=[{"src": "/icon.svg", "sizes": "any", "type": "image/svg+xml"}])


@app.get("/icon.svg")
def icon():
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#0b0b0f"/>'
           '<path d="M30 25h40v50H30z" fill="none" stroke="#ffe600" stroke-width="7" rx="6"/><path d="M45 40l15 10-15 10z" fill="#ffe600"/></svg>')
    return app.response_class(svg, mimetype="image/svg+xml")


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
