"""End-to-end checks for the MCP server (mcp_server.py) against an isolated desktop app (never the one on port 8765).
Runs a real clipping job on tests/media/talk_40s.mp4, so it takes a minute or two.

    .venv/bin/python -m unittest tests/test_mcp.py -v

Covers: the MCP handshake and tool list, every tool (new_job from a local file, job_status, list_clips,
rerender_clip, export_zip, list_jobs), clear errors for bad input, and starting app.py itself when none is running.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PY = sys.executable
MEDIA = HERE / "media" / "talk_40s.mp4"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    assert p != 8765
    return p


def isolated_env(tmp: Path, port: int, key: str):
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLIP_")}
    env.update(CLIP_PORT=str(port), CLIP_KEY=key, CLIP_JOBS=str(tmp / "jobs"), CLIP_LOG=str(tmp / "log.json"),
               CLIP_STUDIO=str(tmp / "studio.json"), CLIP_FONT_CACHE=str(tmp / "fonts"), PYTHONUNBUFFERED="1")
    return env


def wait_for(port, key, up=True, secs=60):
    end = time.time() + secs
    while time.time() < end:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/info?key={key}", timeout=2).read()
            if up:
                return True
        except Exception:
            if not up:
                return True
        time.sleep(0.3)
    return False


class Client:
    """A minimal MCP client over stdio."""

    def __init__(self, env):
        self.p = subprocess.Popen([PY, str(ROOT / "mcp_server.py")], env=env, cwd=str(ROOT),
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.n = 0

    def rpc(self, method, params=None, notify=False):
        msg = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if not notify:
            self.n += 1
            msg["id"] = self.n
        self.p.stdin.write((json.dumps(msg) + "\n").encode())
        self.p.stdin.flush()
        if notify:
            return None
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError("the MCP server exited")
            r = json.loads(line)
            if r.get("id") == self.n:
                return r

    def call(self, name, **args):
        r = self.rpc("tools/call", {"name": name, "arguments": args})
        res = r["result"]
        return res.get("structuredContent"), res["isError"], res["content"][0]["text"]

    def close(self):
        self.p.stdin.close()
        self.p.stdout.close()
        try:
            self.p.wait(60)
        except subprocess.TimeoutExpired:
            self.p.kill()


@unittest.skipUnless(MEDIA.exists(), "needs tests/media (zsh tests/make_media.sh)")
class McpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="clip mcp ")).resolve()
        cls.port, cls.key = free_port(), "mcp-test-key"
        cls.env = isolated_env(cls.tmp, cls.port, cls.key)
        cls.app = subprocess.Popen([PY, str(ROOT / "app.py")], env=cls.env, cwd=str(ROOT),
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        assert wait_for(cls.port, cls.key), "isolated app.py didn't start"
        cls.c = Client(cls.env)
        cls.c.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                 "clientInfo": {"name": "test", "version": "0"}})
        cls.c.rpc("notifications/initialized", notify=True)
        cls.jid = None

    @classmethod
    def tearDownClass(cls):
        cls.c.close()
        cls.app.terminate()
        cls.app.wait(10)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def finished_job(self):
        """One real job, shared by the tests that need clips (made once, in whichever test asks first)."""
        if McpTest.jid is None:
            out, err, text = self.c.call("new_job", source=str(MEDIA), n=1, model="tiny", platform="tiktok",
                                         version="both", style="boxed", format="9:16", language="en", cta="Agree?")
            self.assertFalse(err, text)
            jid = out["job_id"]
            st, err, text = self.c.call("job_status", job_id=jid, wait_seconds=600)
            self.assertFalse(err, text)
            self.assertEqual(st["status"], "done", st)
            self.assertGreaterEqual(st["clips"], 1)
            McpTest.jid = jid
        return McpTest.jid

    # ---- protocol
    def test_01_handshake_and_tools(self):
        r = self.c.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}})
        self.assertEqual(r["result"]["protocolVersion"], "2025-06-18")
        self.assertIn("tools", r["result"]["capabilities"])
        r = self.c.rpc("initialize", {"protocolVersion": "1999-01-01"})
        self.assertEqual(r["result"]["protocolVersion"], "2025-06-18")   # unknown version → our latest
        names = {t["name"] for t in self.c.rpc("tools/list")["result"]["tools"]}
        self.assertEqual(names, {"new_job", "job_status", "list_clips", "rerender_clip", "export_zip", "list_jobs"})
        for t in self.c.rpc("tools/list")["result"]["tools"]:
            self.assertEqual(t["inputSchema"]["type"], "object")
            self.assertTrue(t["description"])
        self.assertEqual(self.c.rpc("ping")["result"], {})
        self.assertEqual(self.c.rpc("nope/nope")["error"]["code"], -32601)
        self.assertIn("error", self.c.rpc("tools/call", {"name": "nope", "arguments": {}}))

    def test_02_bad_input_is_a_clear_tool_error(self):
        for args, needle in (({"source": "/no/such/video.mp4"}, "No file"),
                             ({"source": str(MEDIA), "platform": "myspace"}, "platform"),
                             ({"source": ""}, "source")):
            _, err, text = self.c.call("new_job", **args)
            self.assertTrue(err, args)
            self.assertIn(needle, text)
        _, err, text = self.c.call("job_status", job_id="../etc")
        self.assertTrue(err)
        _, err, text = self.c.call("list_clips", job_id="0101-000000-dead")
        self.assertTrue(err)
        self.assertIn("Not found", text)

    # ---- the clipping workflow
    def test_03_new_job_status_and_list_clips(self):
        jid = self.finished_job()
        out, err, text = self.c.call("list_clips", job_id=jid)
        self.assertFalse(err, text)
        self.assertEqual(out["video_title"], "talk_40s")
        clip = out["clips"][0]
        self.assertEqual(clip["clip"], 1)
        self.assertIsInstance(clip["score"], (int, float))
        self.assertTrue(clip["reasons"] and clip["title"])
        self.assertIn("tiktok", clip["post_text"])
        for cut in filter(None, (clip["long"], clip["short"])):
            self.assertTrue(Path(cut["file"]).is_file(), cut["file"])
            self.assertTrue(Path(cut["srt"]).is_file())
            self.assertTrue(cut["file"].startswith(str(self.tmp / "jobs")))
            self.assertEqual(cut["failed_checks"], [], cut)
        self.assertEqual(clip["long"]["look"]["style"], "boxed")
        # the uploaded file is a copy: the job's source is inside the isolated jobs folder, the original is untouched
        self.assertTrue(MEDIA.exists())

    def test_04_list_jobs(self):
        jid = self.finished_job()
        out, err, _ = self.c.call("list_jobs")
        self.assertFalse(err)
        row = next(j for j in out["jobs"] if j["job_id"] == jid)
        self.assertEqual((row["status"], row["has_clips"], row["label"]), ("done", True, "talk_40s.mp4"))

    def test_05_rerender_clip(self):
        jid = self.finished_job()
        before = self.c.call("list_clips", job_id=jid)[0]["clips"][0]["long"]
        mtime = Path(before["file"]).stat().st_mtime
        out, err, text = self.c.call("rerender_clip", job_id=jid, clip=1, style="clean", highlight="#00E5FF",
                                     size="l", position="middle", format="1:1", layout="crop", title="New headline")
        self.assertFalse(err, text)
        cut = out["rerendered"]
        self.assertTrue(cut["edited"])
        self.assertEqual(cut["title"], "New headline")
        self.assertEqual((cut["look"]["style"], cut["look"]["hl"], cut["look"]["size"], cut["look"]["pos"],
                          cut["look"]["format"], cut["look"]["layout"]), ("clean", "#00E5FF", "l", "middle", "1:1", "crop"))
        self.assertGreater(Path(cut["file"]).stat().st_mtime, mtime)
        probe = subprocess.run([shutil.which("ffprobe") or "ffprobe", "-v", "error", "-select_streams", "v:0",
                                "-show_entries", "stream=width,height", "-of", "csv=p=0", cut["file"]],
                               capture_output=True, text=True)
        if probe.returncode == 0:
            w, h = map(int, probe.stdout.strip().split(",")[:2])
            self.assertEqual(w, h)   # 1:1 frame
        # bad look values never reach the engine
        for args in ({"highlight": "yellow"}, {"format": "3:2"}, {"cut": "medium"}, {"clip": 99}):
            _, err, _ = self.c.call("rerender_clip", **{"job_id": jid, "clip": 1, **args})
            self.assertTrue(err, args)

    def test_06_export_zip(self):
        jid = self.finished_job()
        clips = self.c.call("list_clips", job_id=jid)[0]["clips"]
        dest = self.tmp / "export here"
        out, err, text = self.c.call("export_zip", job_id=jid, out_dir=str(dest))
        self.assertFalse(err, text)
        z = Path(out["zip"])
        self.assertEqual(z.parent, dest)
        self.assertEqual(z.name, "talk-40s-clips.zip")   # named after the uploaded file, not "source"
        with zipfile.ZipFile(z) as zf:
            self.assertIsNone(zf.testzip())
            names = zf.namelist()
            self.assertIn("youtube.csv", names)
            self.assertIn("01-captions.txt", names)
            mp4s = [n for n in names if n.endswith(".mp4")]
            self.assertEqual(len(mp4s), sum(2 if c["short"] else 1 for c in clips))
            if clips[0]["short"]:
                self.assertTrue(any(n.startswith("01-short-") for n in mp4s) and any(n.startswith("01-long-") for n in mp4s))
            self.assertEqual(zf.getinfo(mp4s[0]).file_size, Path(clips[0]["short"]["file"] if clips[0]["short"] and "-short-" in mp4s[0]
                                                                  else clips[0]["long"]["file"]).stat().st_size)
            csv = zf.read("youtube.csv").decode()
            self.assertTrue(csv.startswith('"filename","title","description","hashtag"\r\n'))
            self.assertIn("#Shorts", csv)
        out2, err, _ = self.c.call("export_zip", job_id=jid)   # default: the job's own folder
        self.assertFalse(err)
        self.assertEqual(Path(out2["zip"]).parent, self.tmp / "jobs" / jid)
        _, err, _ = self.c.call("export_zip", job_id=jid, clips=[7])
        self.assertTrue(err)


class AutoStartTest(unittest.TestCase):
    """With no desktop app running, the MCP server starts app.py itself and stops it when the client goes away."""

    def test_starts_and_stops_the_app(self):
        tmp = Path(tempfile.mkdtemp(prefix="clip mcp auto "))
        port, key = free_port(), "auto-key"
        try:
            c = Client(isolated_env(tmp, port, key))
            self.assertFalse(wait_for(port, key, secs=1))
            c.rpc("initialize", {"protocolVersion": "2025-06-18"})
            out, err, text = c.call("list_jobs")
            self.assertFalse(err, text)
            self.assertEqual(out["jobs"], [])
            self.assertTrue(wait_for(port, key, secs=30))
            self.assertTrue((tmp / "jobs" / "_mcp_app.log").exists())
            c.close()
            self.assertTrue(wait_for(port, key, up=False, secs=60), "app.py kept running after the client left")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_wrong_key_is_explained(self):
        tmp = Path(tempfile.mkdtemp(prefix="clip mcp key "))
        port = free_port()
        env = isolated_env(tmp, port, "right-key")
        app = subprocess.Popen([PY, str(ROOT / "app.py")], env=env, cwd=str(ROOT),
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            self.assertTrue(wait_for(port, "right-key"))
            c = Client(dict(env, CLIP_KEY="wrong-key"))
            _, err, text = c.call("list_jobs")
            self.assertTrue(err)
            self.assertIn("access key", text)
            c.close()
        finally:
            app.terminate()
            app.wait(10)
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
