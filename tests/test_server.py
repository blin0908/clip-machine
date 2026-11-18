"""Fast checks for the desktop server (app.py): auth, input validation, uploads, edits, restarts, results log.
No rendering happens here (the job worker isn't started), so this runs in a couple of seconds.

    .venv/bin/python -m unittest tests/test_server.py -v
"""
import csv
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import app as server  # noqa: E402


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self._jobs_dir, self._log, self._studio = server.JOBS, server.LOG, server.STUDIO
        server.JOBS, server.LOG, server.STUDIO = self.tmp / "jobs", self.tmp / "results_log.json", self.tmp / "studio_import.json"
        server.JOBS.mkdir()
        server.jobs.clear()
        while not server.queue.empty():
            server.queue.get_nowait()
        self.c = server.app.test_client()
        self.k = {"X-Key": server.KEY}

    def tearDown(self):
        server.JOBS, server.LOG, server.STUDIO = self._jobs_dir, self._log, self._studio
        server.jobs.clear()
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- access key
    def test_requires_key(self):
        self.assertEqual(self.c.get("/api/jobs").status_code, 403)
        self.assertEqual(self.c.get("/api/jobs", headers={"X-Key": "wrong"}).status_code, 403)
        self.assertEqual(self.c.get("/api/jobs", headers=self.k).status_code, 200)

    def test_key_in_link_sets_cookie(self):
        r = self.c.get(f"/api/jobs?key={server.KEY}")
        self.assertIn("ck=", r.headers.get("Set-Cookie", ""))
        self.assertEqual(self.c.get("/api/jobs").status_code, 200)   # cookie now carries the key

    def test_icon_and_manifest_are_public(self):
        self.assertEqual(self.c.get("/icon.svg").status_code, 200)
        self.assertEqual(self.c.get("/manifest.json").status_code, 200)

    def test_manifest_never_gives_the_key_away(self):
        r = self.c.get("/manifest.json")                       # anyone on the network
        self.assertNotIn(server.KEY, r.get_data(as_text=True))
        self.assertEqual(r.get_json()["start_url"], "/")
        self.assertEqual(r.headers.get("Cache-Control"), "no-store")
        self.assertEqual(self.c.get("/manifest.json", headers={"X-Key": "wrong"}).get_json()["start_url"], "/")
        self.c.get(f"/api/jobs?key={server.KEY}")              # this device has the key: its home-screen app keeps it
        self.assertEqual(self.c.get("/manifest.json").get_json()["start_url"], f"/?key={server.KEY}")

    def test_key_link_leaves_the_address_bar(self):
        r = self.c.get(f"/?key={server.KEY}&layout=auto")
        self.assertEqual(r.status_code, 302)
        self.assertEqual(r.headers["Location"], "/?layout=auto")
        self.assertIn("HttpOnly", r.headers.get("Set-Cookie", ""))
        self.assertEqual(self.c.get("/?layout=auto").status_code, 200)
        self.assertEqual(self.c.get("/api/jobs?key=wrong").status_code, 403)

    def test_short_keys_are_rotated(self):
        f = Path(self.tmp) / "key"
        saved = (server.KEY_FILE, server.KEY_ROTATED, os.environ.pop("CLIP_KEY", None))
        try:
            server.KEY_FILE = f
            f.write_text("abcdefghijk", encoding="utf-8")       # an 11-character key from before 1.7.1
            k = server._load_key()
            self.assertGreaterEqual(len(k), 20)
            self.assertNotEqual(k, "abcdefghijk")
            self.assertTrue(server.KEY_ROTATED)
            self.assertEqual(server._load_key(), k)             # stable after that
            f.unlink()
            server.KEY_ROTATED = False
            self.assertGreaterEqual(len(server._load_key()), 20)  # fresh installs get a long key, no notice
            self.assertFalse(server.KEY_ROTATED)
        finally:
            server.KEY_FILE, server.KEY_ROTATED = saved[0], saved[1]
            if saved[2] is not None:
                os.environ["CLIP_KEY"] = saved[2]

    # ---- creating jobs
    def test_link_must_be_http(self):
        for bad in ("", "ftp://x/y.mp4", "file:///etc/passwd", "-o /tmp/x", "/Users/me/video.mp4"):
            r = self.c.post("/api/jobs", json={"url": bad}, headers=self.k)
            self.assertEqual(r.status_code, 400, bad)

    def test_bad_numbers_fall_back_to_defaults(self):
        r = self.c.post("/api/jobs", json={"url": "https://example.com/v", "n": None, "crop_x": "nan",
                                           "min": "abc", "max": "inf", "model": "huge", "style": "<b>", "layout": "x"},
                        headers=self.k)
        self.assertEqual(r.status_code, 200, r.data)
        o = server.jobs[r.get_json()["id"]]["opts"]
        self.assertEqual(o["n"], 5)
        self.assertEqual(o["crop_x"], 0.5)
        self.assertEqual(o["min"], 20)
        self.assertEqual(o["max"], 60)
        self.assertEqual((o["model"], o["style"], o["layout"]), ("base", "pop", "fit"))

    def test_numbers_are_clamped(self):
        r = self.c.post("/api/jobs", json={"url": "https://example.com/v", "n": 999, "crop_x": -4}, headers=self.k)
        o = server.jobs[r.get_json()["id"]]["opts"]
        self.assertEqual((o["n"], o["crop_x"]), (15, 0))

    def test_cta_is_truncated(self):
        r = self.c.post("/api/jobs", json={"url": "https://example.com/v", "cta": "x" * 500}, headers=self.k)
        self.assertEqual(len(server.jobs[r.get_json()["id"]]["opts"]["cta"]), 80)

    def test_upload_records_its_folder_before_queueing(self):
        r = self.c.post("/api/jobs", data={"file": (io.BytesIO(b"not really a video"), "my clip.MOV"), "n": "2"},
                        headers=self.k, content_type="multipart/form-data")
        self.assertEqual(r.status_code, 200, r.data)
        jid = r.get_json()["id"]
        saved = json.loads((server.JOBS / jid / "job.json").read_text())
        self.assertTrue(saved["opts"].get("upload_dir"))           # on disk already, not only in memory
        self.assertTrue(saved["opts"]["source"].endswith("source.mov"))
        self.assertEqual(saved["label"], "my clip.MOV")
        shutil.rmtree(saved["opts"]["upload_dir"], ignore_errors=True)

    # ---- edits
    def _done_job(self, clips=1):
        jid = "test-job"
        (server.JOBS / jid).mkdir()
        server.jobs[jid] = {"id": jid, "status": "done", "opts": {}, "result": {"clips": [{"file": "clip_01.mp4"}] * clips}}
        return jid

    def test_edit_rejects_bad_requests(self):
        jid = self._done_job()
        bad = [{}, {"clip": 5, "cut": "long", "start": 1, "end": 5}, {"clip": 0, "cut": "middle", "start": 1, "end": 5},
               {"clip": 0, "cut": "long", "start": "nan", "end": 5}, {"clip": 0, "cut": "long", "start": 1, "end": "inf"},
               {"clip": 0, "cut": "long", "start": 9, "end": 5}, {"clip": "x", "cut": "long", "start": 1, "end": 5}]
        for d in bad:
            self.assertEqual(self.c.post(f"/api/jobs/{jid}/edit", json=d, headers=self.k).status_code, 400, d)
        self.assertTrue(server.queue.empty())

    def test_edit_queues_and_blocks_a_second_edit(self):
        jid = self._done_job()
        d = {"clip": 0, "cut": "long", "start": 1, "end": 5, "title": "t" * 200, "words": [{"w": "hi", "s": 1, "e": 2}]}
        self.assertEqual(self.c.post(f"/api/jobs/{jid}/edit", json=d, headers=self.k).status_code, 200)
        item = server.queue.get_nowait()
        self.assertEqual(item[0], "edit")
        self.assertEqual(len(item[2]["title"]), 90)
        self.assertEqual(self.c.post(f"/api/jobs/{jid}/edit", json=d, headers=self.k).status_code, 400)  # one at a time

    def test_edit_accepts_a_look_and_new_clips(self):
        jid = self._done_job()
        d = {"clip": -1, "cut": "new", "start": 1, "end": 9, "title": "Mine", "words": [], "cta": "x" * 200,
             "look": {"format": "1:1", "hl": "#ff00aa", "size": "huge", "layout": "crop", "cx": 2}}
        self.assertEqual(self.c.post(f"/api/jobs/{jid}/edit", json=d, headers=self.k).status_code, 200)
        item = server.queue.get_nowait()[2]
        self.assertEqual(item["cut"], "new")
        self.assertEqual(len(item["cta"]), 80)
        self.assertEqual((item["look"]["format"], item["look"]["hl"], item["look"]["size"], item["look"]["cx"]), ("1:1", "#FF00AA", "m", 1.0))

    def test_edit_carries_a_search_reason(self):
        jid = self._done_job()
        d = {"clip": -1, "cut": "new", "start": 1, "end": 9, "title": "Found", "words": [], "reason": "Matches “" + "x" * 300}
        self.assertEqual(self.c.post(f"/api/jobs/{jid}/edit", json=d, headers=self.k).status_code, 200)
        self.assertEqual(len(server.queue.get_nowait()[2]["reason"]), 120)
        self.c.post(f"/api/jobs/{jid}/cancel", headers=self.k)
        server.jobs[jid]["status"] = "done"
        d["reason"] = {"html": "<b>"}
        self.assertEqual(self.c.post(f"/api/jobs/{jid}/edit", json=d, headers=self.k).status_code, 200)
        self.assertIsNone(server.queue.get_nowait()[2]["reason"])

    # ---- find clips by description (the model is stubbed here; tests/search_parity.py runs the real one)
    WORDS = [{"w": w, "s": i * 0.5, "e": i * 0.5 + 0.4} for i, w in enumerate(
        ("Our pricing is simple. " * 8 + "We hired two people. " * 8 + "I cook on weekends. " * 8).split())]

    def _stub_model(self):
        import numpy as np
        import search

        class Stub:   # one axis per topic: a text's vector points at the topics it mentions
            def embed(self, texts):
                v = np.array([[t.count("pricing") + 0.01, t.count("hired") + 0.01, t.count("cook") + 0.01] for t in texts], dtype=np.float32)
                return v / np.linalg.norm(v, axis=1, keepdims=True)
        old = search._model
        search._model = Stub()
        self.addCleanup(setattr, search, "_model", old)

    def test_search_rejects_bad_requests(self):
        self.assertEqual(self.c.post("/api/search", json={"query": "x", "words": self.WORDS}).status_code, 403)
        for d in ({}, {"query": "  ", "words": self.WORDS}, {"query": "pricing", "words": []}, {"query": "pricing", "words": "abc"},
                  {"query": "pricing", "words": [{"w": "a", "s": "nan", "e": 1}]}, {"query": "pricing", "words": [{"w": "a"}]},
                  {"query": "pricing", "words": self.WORDS, "n": "many"}):
            self.assertEqual(self.c.post("/api/search", json=d, headers=self.k).status_code, 400, d)

    def test_search_finds_the_matching_window(self):
        self._stub_model()
        r = self.c.post("/api/search", json={"query": "the part about pricing", "words": self.WORDS, "duration": 40}, headers=self.k)
        self.assertEqual(r.status_code, 200)
        m = r.get_json()["matches"]
        self.assertTrue(m and "pricing" in m[0]["text"] and m[0]["start"] == 0.0, m)
        r = self.c.post("/api/search", json={"query": "cook", "words": self.WORDS, "duration": 40, "all": True}, headers=self.k)
        wins = r.get_json()["windows"]
        self.assertTrue(len(wins) > 3 and all({"start", "end", "text", "score"} <= set(w) for w in wins))
        self.assertTrue("cook" in max(wins, key=lambda w: w["score"])["text"])

    def test_search_says_when_the_model_is_ready(self):
        self._stub_model()
        j = self.c.get("/api/search", headers=self.k).get_json()
        self.assertTrue(j["ready"])
        self.assertEqual(j["model"], "Xenova/multilingual-e5-small")

    def test_new_job_keeps_the_look(self):
        r = self.c.post("/api/jobs", json={"url": "https://example.com/v", "format": "16:9", "hl": "#00ff00", "pos": "top", "size": "zz"}, headers=self.k)
        o = server.jobs[r.get_json()["id"]]["opts"]
        self.assertEqual((o["format"], o["hl"], o["pos"], o["size"]), ("16:9", "#00FF00", "top", "m"))

    def test_layouts_accepted(self):
        for lay in ("auto", "split", "crop"):
            r = self.c.post("/api/jobs", json={"url": "https://example.com/v", "layout": lay}, headers=self.k)
            self.assertEqual(server.jobs[r.get_json()["id"]]["opts"]["layout"], lay)
        self.assertIn("split", self.c.get("/api/info", headers=self.k).get_json()["layouts"])

    def test_reframe_plan_endpoint(self):
        jid = self._done_job()
        (server.JOBS / jid / "transcript.json").write_text(json.dumps([{"s": 0, "e": 2, "text": "hi", "words": [{"w": "hi", "s": 0.1, "e": 0.4}]}]))
        (server.JOBS / jid / "session.json").write_text(json.dumps({"video": "/nonexistent/x.mp4", "has_video": True, "duration": 9.0, "settings": {}}))
        u = f"/api/jobs/{jid}/reframe"
        for q in ("", "?start=x&end=2", "?start=3&end=2", "?start=0&end=nan", "?start=0&end=2000"):
            self.assertEqual(self.c.get(u + q, headers=self.k).status_code, 400, q)
        self.assertEqual(self.c.get("/api/jobs/nope/reframe?start=0&end=2", headers=self.k).status_code, 404)
        p = self.c.get(u + "?start=0&end=2&mode=split&format=9:16", headers=self.k).get_json()
        self.assertEqual(p["mode"], "none")                     # unreadable source: a centred crop and a note, never a 500
        self.assertTrue(p["note"])
        (server.JOBS / jid / "session.json").write_text(json.dumps({"video": "/x.mp3", "has_video": False, "duration": 9.0, "settings": {}}))
        self.assertEqual(self.c.get(u + "?start=0&end=2", headers=self.k).get_json()["mode"], "none")

    def test_cancel_flags_a_running_job(self):
        jid = self._done_job()
        server.jobs[jid]["status"] = "running"
        self.assertEqual(self.c.post(f"/api/jobs/{jid}/cancel", headers=self.k).status_code, 200)
        self.assertTrue(server.jobs[jid]["cancel"])
        self.assertEqual(self.c.post("/api/jobs/nope/cancel", headers=self.k).status_code, 404)

    def test_studio_feeds(self):
        jid = self._done_job()
        (server.JOBS / jid / "transcript.json").write_text(json.dumps([{"s": 0, "e": 2, "text": "hi there", "words": [{"w": "hi", "s": 0.1, "e": 0.4, "p": 0.9}]}]))
        (server.JOBS / jid / "quiet.json").write_text(json.dumps({"step": 0.05, "thr": -40, "db": [-20, -60]}))
        src = self.tmp / "source.mp4"; src.write_bytes(b"0123456789")
        (server.JOBS / jid / "session.json").write_text(json.dumps({"video": str(src), "has_video": True, "duration": 2.0, "settings": {}}))
        t = self.c.get(f"/api/jobs/{jid}/transcript", headers=self.k).get_json()
        self.assertEqual(t["words"], [{"w": "hi", "s": 0.1, "e": 0.4}])
        self.assertEqual(t["quiet"]["db"], [-20, -60])
        r = self.c.get(f"/api/jobs/{jid}/source", headers={**self.k, "Range": "bytes=2-5"})
        self.assertEqual((r.status_code, r.data), (206, b"2345"))                  # seeking works
        r.close()
        self.assertEqual(self.c.get("/api/jobs/nope/transcript", headers=self.k).status_code, 404)
        row = next(j for j in self.c.get("/api/jobs", headers=self.k).get_json() if j["id"] == jid)
        self.assertTrue(row["has_result"])                                          # the page can tell an edit from a first run

    def test_one_post_per_cut_per_platform(self):
        base = {"platform": "shorts", "job": "j1", "clip": "clip_01.mp4", "cut": "short", "title": "The reveal", "checkpoint": "24h"}
        r = self.c.post("/api/log", json=dict(base, post="https://youtube.com/shorts/dQw4w9WgXcQ?feature=share"), headers=self.k)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["post"], "dQw4w9WgXcQ")                       # stored as the platform's id
        later = self.c.post("/api/log", json=dict(base, post="dQw4w9WgXcQ", checkpoint="72h"), headers=self.k)
        self.assertEqual(later.status_code, 200)                                     # more numbers for the same post: fine
        for bad, word in ((dict(base, post="https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "24h numbers"),
                          (dict(base, post="abcdefghijk", checkpoint="7d"), "One post per platform"),
                          (dict(base, clip="clip_02.mp4", post="dQw4w9WgXcQ", checkpoint="7d"), "already logged for")):
            r = self.c.post("/api/log", json=bad, headers=self.k)
            self.assertEqual(r.status_code, 409, bad)
            self.assertIn(word, r.get_json()["error"])
        ok = self.c.post("/api/log", json=dict(base, platform="tiktok", post="https://www.tiktok.com/@me/video/7312345678901234567"), headers=self.k)
        self.assertEqual(ok.get_json()["post"], "7312345678901234567")              # same cut on another platform: fine
        self.assertEqual(self.c.post("/api/log", json=dict(base, checkpoint="7d"), headers=self.k).status_code, 200)   # no post id: not checked
        self.assertIn("post", self.c.get("/api/log.csv", headers=self.k).get_data(as_text=True).splitlines()[0])

    def test_every_module_the_page_imports_is_served(self):
        import re
        docs = Path(server.__file__).resolve().parent / "docs"
        names = {"app.js"}
        for f in docs.glob("*.js"):
            names |= set(re.findall(r'from "\./([\w.-]+\.js)"', f.read_text(encoding="utf-8")))
            names |= set(re.findall(r'new Worker\(new URL\("\./([\w.-]+\.js)"', f.read_text(encoding="utf-8")))
        sw = (docs / "sw.js").read_text(encoding="utf-8")
        for n in sorted(names):
            self.assertEqual(self.c.get("/" + n, headers=self.k).status_code, 200, n)
            self.assertIn(f'"{n}"', sw, f"{n} missing from the offline cache list in sw.js")

    def test_brand_logo(self):
        png = b"\x89PNG\r\n\x1a\n" + b"0" * 64
        self.assertEqual(self.c.get("/api/brand/logo", headers=self.k).status_code, 404)
        self.assertEqual(self.c.post("/api/brand/logo", data=b"GIF89a....", headers=self.k).status_code, 400)
        self.assertEqual(self.c.post("/api/brand/logo", data=png, headers=self.k).status_code, 200)
        r = self.c.get("/api/brand/logo", headers=self.k)
        self.assertEqual((r.status_code, r.data), (200, png)); r.close()
        self.assertEqual(server.logo_file(), server.JOBS / "_brand" / "logo.png")
        self.c.delete("/api/brand/logo", headers=self.k)
        self.assertIsNone(server.logo_file())
        self.assertEqual(self.c.post("/api/brand/logo", data=b"x").status_code, 403)       # needs the key

    def test_pages(self):
        self.assertEqual(self.c.get("/api/info", headers=self.k).get_json()["desktop"], True)
        self.assertRegex(self.c.get("/api/info", headers=self.k).get_json()["version"], r"^\d+\.\d+\.\d+$")
        # every page module and worker the UI loads (import "./x.js", new URL("./x.js")) must be served, or the page breaks
        import re
        local = {m for f in (HERE.parent / "docs").glob("*.js") for m in re.findall(r'(?:from |import\(|new URL\()"\./([\w-]+\.js)"', f.read_text(encoding="utf-8"))}
        self.assertTrue({"search.js", "search-worker.js", "studio.js"} <= local, local)
        for path in ("/", "/classic", "/fonts/ui/archivo-400-800.woff2", "/vendor/ffmpeg/index.js", *sorted("/" + m for m in local)):
            r = self.c.get(path, headers=self.k)
            self.assertEqual(r.status_code, 200, path)
            r.close()
        r = self.c.get("/", headers=self.k)
        self.assertIn(b"studio", r.data)
        r.close()
        for bad in ("/fonts/../app.py", "/vendor/%2e%2e/app.py", "/sw.js/../app.py"):
            r = self.c.get(bad, headers=self.k, follow_redirects=True)
            self.assertIn(r.status_code, (400, 404), bad)
            r.close()
        self.assertEqual(self.c.get("/studio.js").status_code, 403)               # the key still guards everything

    def test_homepage_workspace_and_identity_routes(self):
        for route in ("/", "/workspace.html"):
            r = self.c.get(route, headers=self.k)
            self.assertIn(b'id="file"', r.data, route)
            self.assertIn(b'M5 5h6v3', r.data, route)
            r.close()
        r = self.c.get("/index.html", headers=self.k)
        self.assertIn(b'home.js', r.data)
        self.assertIn(b'href="workspace.html"', r.data)
        self.assertNotIn(b'id="file"', r.data)
        r.close()
        for route in ("/icon.svg", "/icon-180.png", "/icon-512.png", "/brand/favicon.svg",
                      "/brand/favicon-32.png", "/brand/favicon.ico", "/brand/logo-mark.svg", "/brand/lockup-horizontal.svg"):
            r = self.c.get(route)
            self.assertEqual(r.status_code, 200, route)
            self.assertEqual(r.data, (HERE.parent / "docs" / route.lstrip("/")).read_bytes())
            r.close()
        for route in ("/workspace.html", "/index.html", "/home.js", "/privacy.html"):
            self.assertEqual(self.c.get(route).status_code, 403, route)
        for route in ("/brand/identity.json", "/brand/../app.py", "/brand/%2e%2e/app.py"):
            r = self.c.get(route, headers=self.k, follow_redirects=True)
            self.assertIn(r.status_code, (400, 404), route)
            r.close()
        for route in ("/workspace.html", "/index.html"):
            r = self.c.get(route + "?key=" + server.KEY + "&platform=shorts")
            self.assertEqual(r.status_code, 302)
            self.assertEqual(r.headers["Location"], route + "?platform=shorts")
        self.assertEqual(self.c.get("/manifest.json").json["icons"][1]["purpose"], "any maskable")

    def test_unfinished_job_cannot_be_edited_or_deleted(self):
        jid = self._done_job()
        server.jobs[jid]["status"] = "running"
        self.assertEqual(self.c.post(f"/api/jobs/{jid}/edit", json={}, headers=self.k).status_code, 400)
        self.assertEqual(self.c.delete(f"/api/jobs/{jid}", headers=self.k).status_code, 400)

    # ---- restarts
    def test_restart_keeps_clips_when_an_edit_was_interrupted(self):
        for jid, status, result in (("a", "editing", {"clips": [1]}), ("b", "queued", {"clips": [1]}),
                                    ("c", "running", None), ("d", "done", {"clips": [1]})):
            (server.JOBS / jid).mkdir()
            (server.JOBS / jid / "job.json").write_text(json.dumps({"id": jid, "status": status, "result": result, "opts": {}}))
        server.load_history()
        self.assertEqual(server.jobs["a"]["status"], "done")
        self.assertIn("interrupted", server.jobs["a"]["edit_error"])
        self.assertEqual(server.jobs["b"]["status"], "done")
        self.assertEqual(server.jobs["c"]["status"], "error")
        self.assertEqual(server.jobs["d"]["status"], "done")

    def test_corrupt_job_file_is_skipped(self):
        (server.JOBS / "bad").mkdir()
        (server.JOBS / "bad" / "job.json").write_text("{not json")
        server.load_history()
        self.assertNotIn("bad", server.jobs)

    # ---- files
    def test_files_cannot_escape_the_job_folder(self):
        jid = self._done_job()
        (server.JOBS / jid / "clip_01.mp4").write_bytes(b"x")
        r = self.c.get(f"/files/{jid}/clip_01.mp4", headers=self.k)
        self.assertEqual(r.status_code, 200)
        r.close()
        for bad in ("../../app.py", "..%2F..%2Fapp.py", "/etc/passwd"):   # a "//" path redirects to a cleaned URL first
            r = self.c.get(f"/files/{jid}/{bad}", headers=self.k, follow_redirects=True)
            self.assertIn(r.status_code, (400, 404), bad)
            r.close()
        self.assertEqual(self.c.get("/files/nojob/clip_01.mp4", headers=self.k).status_code, 404)

    # ---- results log
    def test_results_log_round_trip(self):
        r = self.c.post("/api/log", json={"title": "A & <B>", "views": "100", "platform": "shorts", "extra": "ignored",
                                          "checkpoint": "72h", "feed_shown": "50", "feed_share": "92.7",
                                          "avg_view_duration": "00:17"}, headers=self.k)
        row = r.get_json()
        self.assertNotIn("extra", row)
        exported = self.c.get("/api/log.csv", headers=self.k).data.decode()
        record = next(csv.DictReader(io.StringIO(exported)))
        for name in ("title", "checkpoint", "feed_shown", "feed_share", "avg_view_duration"):
            self.assertEqual(record[name], row[name])
        self.assertEqual(record["feed_shown"], "50")
        self.assertEqual(len(self.c.get("/api/log", headers=self.k).get_json()), 1)
        self.c.delete(f"/api/log/{row['id']}", headers=self.k)
        self.assertEqual(self.c.get("/api/log", headers=self.k).get_json(), [])

    def test_log_keeps_the_clips_signals(self):
        sig = json.dumps({"hook": 1.25, "deadair": -0.4}, separators=(",", ":"))
        row = self.c.post("/api/log", json={"title": "T", "score": "84", "signals": sig}, headers=self.k).get_json()
        self.assertEqual((row["score"], row["signals"]), ("84", sig))
        record = next(csv.DictReader(io.StringIO(self.c.get("/api/log.csv", headers=self.k).data.decode())))
        self.assertEqual(json.loads(record["signals"])["hook"], 1.25)

    def test_studio_import(self):
        self.assertIsNone(self.c.get("/api/studio", headers=self.k).get_json()["studio"])
        self.assertEqual(self.c.post("/api/studio", json={"rows": []}).status_code, 403)
        good = {"file": "Table data.csv", "imported": "2026-11-16", "columns": ["Views", "Average percentage viewed (%)"],
                "rows": [{"title": "Why this works", "published": "Nov 1, 2026", "values": {"Views": 1200, "Average percentage viewed (%)": 61.5, "junk": 3}},
                         {"title": "x" * 900, "values": {"Views": "lots", "Average percentage viewed (%)": True}}]}
        self.assertEqual(self.c.post("/api/studio", json=good, headers=self.k).status_code, 200)
        saved = self.c.get("/api/studio", headers=self.k).get_json()["studio"]
        self.assertEqual(saved["rows"][0]["values"], {"Views": 1200.0, "Average percentage viewed (%)": 61.5})
        self.assertEqual(len(saved["rows"][1]["title"]), 300)
        self.assertEqual(saved["rows"][1]["values"], {"Views": None, "Average percentage viewed (%)": None})
        for junk in ([1, 2], {"rows": "no"}, {"rows": [1]}, {"rows": [{}] * 5001}, {"rows": [], "columns": ["c"] * 61}):
            self.assertEqual(self.c.post("/api/studio", json=junk, headers=self.k).status_code, 400, junk if not isinstance(junk, dict) or len(str(junk)) < 80 else "big")
        self.assertEqual(self.c.get("/api/studio", headers=self.k).get_json()["studio"]["file"], "Table data.csv")   # a bad import keeps the last good one
        self.c.delete("/api/studio", headers=self.k)
        self.assertIsNone(self.c.get("/api/studio", headers=self.k).get_json()["studio"])

    def test_log_fields_are_capped(self):
        row = self.c.post("/api/log", json={"notes": "n" * 5000}, headers=self.k).get_json()
        self.assertEqual(len(row["notes"]), 300)

    def test_browser_log_import_preserves_existing_rows_and_can_retry(self):
        existing = {"id": "older", "title": "Classic result"}
        server.LOG.write_text(json.dumps([existing]))
        legacy = {"id": "a8b1c9fe", "logged": "2026-11-15 10:30", "title": "Browser result", "feed_shown": "0"}
        self.assertEqual(self.c.post("/api/log/import", json=[legacy]).status_code, 403)
        for _ in range(2):
            response = self.c.post("/api/log/import", json=[legacy], headers=self.k)
            self.assertEqual(response.status_code, 200)
        saved = self.c.get("/api/log", headers=self.k).get_json()
        self.assertEqual(len(saved), 2)
        self.assertEqual(saved[0], existing)
        self.assertEqual(saved[1]["id"], "browser-a8b1c9fe")
        for field in ("logged", "title", "feed_shown"):
            self.assertEqual(saved[1][field], legacy[field])


if __name__ == "__main__":
    unittest.main()
