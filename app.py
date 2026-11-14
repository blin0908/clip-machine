"""Clip Machine web app. Runs on your Mac; open it from your phone on the same Wi-Fi.

    .venv/bin/python app.py          (or double-click Start Clip Machine.command)
"""
import json
import os
import secrets
import socket
import threading
import time
import traceback
import uuid
from pathlib import Path
from queue import Queue

from flask import Flask, abort, jsonify, request, send_from_directory, make_response

import clipper

HERE = Path(__file__).resolve().parent
JOBS = HERE / "jobs"
JOBS.mkdir(exist_ok=True)
PORT = int(os.environ.get("CLIP_PORT", 8765))
KEY_FILE = HERE / ".access_key"
if not KEY_FILE.exists():
    KEY_FILE.write_text(secrets.token_urlsafe(8))
KEY = KEY_FILE.read_text().strip()

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
        jid = queue.get()
        job = jobs[jid]
        job["status"] = "running"

        def progress(stage, pct, msg=""):
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
                              enhance=o.get("enhance", True), progress=progress)
            job.update(status="done", pct=100, msg="Done", result=res)
            if not o.get("keep_source"):
                for f in (JOBS / jid).glob("source.*"):
                    f.unlink(missing_ok=True)
        except Exception as e:
            traceback.print_exc()
            job.update(status="error", msg=str(e)[:600])
        finally:
            save(jid)
            queue.task_done()


def save(jid):
    j = {k: v for k, v in jobs[jid].items()}
    (JOBS / jid / "job.json").write_text(json.dumps(j))


def load_history():
    for d in JOBS.iterdir():
        f = d / "job.json"
        if f.exists():
            try:
                j = json.loads(f.read_text())
                if j.get("status") in ("queued", "running"):
                    j.update(status="error", msg="Interrupted (server restarted)")
                jobs[d.name] = j
            except Exception:
                pass


def new_job(source, form):
    jid = time.strftime("%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
    (JOBS / jid).mkdir()
    def num(k, d, lo, hi):
        try:
            return max(lo, min(hi, float(form.get(k, d))))
        except ValueError:
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
        "layout": form.get("layout", "fit") if form.get("layout") in ("fit", "crop", "original") else "fit",
        "captions": str(form.get("captions", "1")) in ("1", "true", "on"),
        "model": form.get("model", "base") if form.get("model") in ("tiny", "base", "small", "medium") else "base",
        "crop_x": num("crop_x", 0.5, 0, 1),
    }
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
        jid = new_job(str(dest), form)
        jobs[jid]["opts"]["upload_dir"] = str(jid_dir)
        return jsonify(id=jid)
    data = request.get_json(silent=True) or dict(request.form)
    url = (data.get("url") or "").strip()
    if not url.startswith(("http://", "https://")):
        return jsonify(error="Paste a full link starting with https://"), 400
    return jsonify(id=new_job(url, data))


@app.get("/api/jobs")
def list_jobs():
    out = sorted(jobs.values(), key=lambda j: -j.get("created", 0))[:30]
    return jsonify([{k: j.get(k) for k in ("id", "status", "pct", "msg", "label", "created")} for j in out])


@app.get("/api/jobs/<jid>")
def get_job(jid):
    if jid not in jobs:
        abort(404)
    return jsonify(jobs[jid])


@app.delete("/api/jobs/<jid>")
def del_job(jid):
    if jid not in jobs or jobs[jid]["status"] in ("queued", "running"):
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


# ---- results log: judge each cut by its job (24 h and 7 day check-ins)
LOG = HERE / "results_log.json"
LOG_FIELDS = ["id", "logged", "job", "clip", "cut", "title", "platform", "posted", "checkpoint", "views",
              "metric1", "metric2", "metric3", "notes"]
log_lock = threading.Lock()


def read_log():
    try:
        return json.loads(LOG.read_text())
    except Exception:
        return []


@app.get("/api/log")
def get_log():
    return jsonify(read_log())


@app.post("/api/log")
def add_log():
    d = request.get_json(silent=True) or {}
    row = {k: str(d.get(k, ""))[:300] for k in LOG_FIELDS}
    row["id"] = uuid.uuid4().hex[:8]
    row["logged"] = time.strftime("%Y-%m-%d %H:%M")
    with log_lock:
        rows = read_log()
        rows.append(row)
        LOG.write_text(json.dumps(rows, indent=1))
    return jsonify(row)


@app.delete("/api/log/<rid>")
def del_log(rid):
    with log_lock:
        LOG.write_text(json.dumps([r for r in read_log() if r.get("id") != rid], indent=1))
    return jsonify(ok=True)


@app.get("/api/log.csv")
def log_csv():
    import csv, io
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["logged", "platform", "clip", "cut", "title", "posted", "checkpoint", "views",
                "metric1", "metric2", "metric3", "notes"])
    for r in read_log():
        w.writerow([r.get(k, "") for k in ("logged", "platform", "clip", "cut", "title", "posted", "checkpoint",
                                           "views", "metric1", "metric2", "metric3", "notes")])
    resp = make_response(buf.getvalue())
    resp.headers["Content-Type"] = "text/csv"
    resp.headers["Content-Disposition"] = "attachment; filename=clip_results.csv"
    return resp


@app.get("/api/platforms")
def platforms():
    return jsonify(clipper.PLATFORMS)


@app.get("/")
def index():
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
