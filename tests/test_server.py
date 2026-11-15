"""Fast checks for the desktop server (app.py): auth, input validation, uploads, edits, restarts, results log.
No rendering happens here (the job worker isn't started), so this runs in a couple of seconds.

    .venv/bin/python -m unittest tests/test_server.py -v
"""
import io
import json
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
        self._jobs_dir, self._log = server.JOBS, server.LOG
        server.JOBS, server.LOG = self.tmp / "jobs", self.tmp / "results_log.json"
        server.JOBS.mkdir()
        server.jobs.clear()
        while not server.queue.empty():
            server.queue.get_nowait()
        self.c = server.app.test_client()
        self.k = {"X-Key": server.KEY}

    def tearDown(self):
        server.JOBS, server.LOG = self._jobs_dir, self._log
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

    def test_new_job_keeps_the_look(self):
        r = self.c.post("/api/jobs", json={"url": "https://example.com/v", "format": "16:9", "hl": "#00ff00", "pos": "top", "size": "zz"}, headers=self.k)
        o = server.jobs[r.get_json()["id"]]["opts"]
        self.assertEqual((o["format"], o["hl"], o["pos"], o["size"]), ("16:9", "#00FF00", "top", "m"))

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

    def test_pages(self):
        self.assertEqual(self.c.get("/api/info", headers=self.k).get_json()["desktop"], True)
        for path in ("/", "/classic", "/studio.js", "/app.js", "/zip.js", "/fonts/ui/archivo-400-800.woff2", "/vendor/ffmpeg/index.js"):
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
                                          "feed_shown": "50"}, headers=self.k)
        row = r.get_json()
        self.assertNotIn("extra", row)
        csv = self.c.get("/api/log.csv", headers=self.k).data.decode()
        self.assertIn("A & <B>", csv)
        self.assertEqual(len(self.c.get("/api/log", headers=self.k).get_json()), 1)
        self.c.delete(f"/api/log/{row['id']}", headers=self.k)
        self.assertEqual(self.c.get("/api/log", headers=self.k).get_json(), [])

    def test_log_fields_are_capped(self):
        row = self.c.post("/api/log", json={"notes": "n" * 5000}, headers=self.k).get_json()
        self.assertEqual(len(row["notes"]), 300)


if __name__ == "__main__":
    unittest.main()
