"""Cross-platform smoke test of the real engine (Windows, macOS, Linux). Builds its own media with ffmpeg,
so it needs no Mac voices and no tests/media folder. Runs in CI on every push.

    python tests/ci_smoke.py

Checks: a full run (download-free) renders clips that pass the quality gate at 1080x1920 with square pixels,
the editor re-render works, and bad inputs fail with clean messages instead of crashes.
"""
import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import clipper  # noqa: E402

FF = clipper.FFMPEG
TMP = Path(tempfile.mkdtemp(prefix="clip smoke "))   # a space in the path, like "C:\Users\First Last\..."
fails = []


def make(name, *args):
    p = TMP / name
    subprocess.run([FF, "-y", "-v", "error", *args, str(p)], check=True)
    return p


def case(name, fn):
    t = time.time()
    try:
        detail = fn()
        print(f"PASS  {name:28s} {time.time() - t:6.1f}s  {detail}")
    except Exception as e:  # noqa: BLE001
        fails.append(name)
        print(f"FAIL  {name:28s} {time.time() - t:6.1f}s  {type(e).__name__}: {str(e)[:300]}")


def ffprobe(p):
    return json.loads(subprocess.run([clipper.FFPROBE, "-v", "error", "-print_format", "json", "-show_streams", str(p)],
                                     capture_output=True, text=True).stdout)


# a 70 s "show": moving test picture + rhythmic tones with loud bursts (gives the scorer peaks to find)
show = make("my show (ünïcode) #1.mp4", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=70",
            "-f", "lavfi", "-i", "sine=f=220:d=70,volume='if(lt(mod(t,9),2),1.0,0.35)':eval=frame",
            "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac")


def full_run():
    out = TMP / "out run"
    res = clipper.run(str(show), out, n=2, model="tiny", version="both", platform="all")
    assert res["clips"], "no clips"
    for c in res["clips"]:
        for v in (c, c.get("short")):
            if not v:
                continue
            assert all(q["ok"] for q in v["quality"] if q["hard"]), v["quality"]
            s = next(x for x in ffprobe(out / v["file"])["streams"] if x["codec_type"] == "video")
            assert (s["width"], s["height"]) == (1080, 1920), (s["width"], s["height"])
            assert s.get("sample_aspect_ratio", "1:1") in ("1:1", "0:1", "N/A"), s.get("sample_aspect_ratio")
            assert (out / v["thumb"]).exists() and (out / v["srt"]).exists()
    return f"{len(res['clips'])} clips, {sum(1 for c in res['clips'] if c.get('short'))} shorts"


def edit():
    out = TMP / "out run"
    res = json.loads((out / "result.json").read_text())
    c = res["clips"][0]
    new = clipper.edit_cut(out, 0, "long", c["start"] + 1, c["end"] - 1, "Edited {headline}\\N", [], "boxed")
    v = new["clips"][0]
    assert v["edited"] and v["title"].startswith("Edited"), v
    return f"re-rendered to {v['duration']}s, quality {sum(q['ok'] for q in v['quality'])}/{len(v['quality'])}"


def dims(p):
    s = next(x for x in ffprobe(p)["streams"] if x["codec_type"] == "video")
    return s["width"], s["height"]


def edit_look():
    out = TMP / "out run"
    c = json.loads((out / "result.json").read_text())["clips"][0]
    look = {"format": "1:1", "hl": "#FF4FA3", "size": "l", "pos": "top", "layout": "crop", "cx": 0.2, "style": "clean"}
    v = clipper.edit_cut(out, 0, "long", c["start"], c["end"], "Square", [], None, look=look, cta="")["clips"][0]
    assert dims(out / v["file"]) == (1080, 1080), dims(out / v["file"])
    assert all(q["ok"] for q in v["quality"] if q["hard"]), v["quality"]
    assert v["look"]["format"] == "1:1" and v["look"]["layout"] == "crop", v["look"]
    return f"1:1 crop re-render, quality {sum(q['ok'] for q in v['quality'])}/{len(v['quality'])}"


def new_clip():
    out = TMP / "out run"
    before = len(json.loads((out / "result.json").read_text())["clips"])
    res = clipper.edit_cut(out, -1, "new", 20, 34, "My pick", [], None, look={"format": "16:9"})
    c = res["clips"][-1]
    assert len(res["clips"]) == before + 1 and c["custom"] and (out / c["file"]).exists(), c
    assert dims(out / c["file"]) == (1920, 1080), dims(out / c["file"])
    return f"new clip {c['file']} {c['duration']}s 1920x1080"


def expect_error(path, phrase):
    def f():
        try:
            clipper.run(str(path), TMP / f"err {path.stem}", n=1, model="tiny")
        except RuntimeError as e:
            assert phrase in str(e).lower(), str(e)
            return f"clean error: {str(e)[:70]}"
        raise AssertionError("no error raised")
    return f


case("full run (tones, unicode path)", full_run)
case("edit a cut", edit)
case("edit with a look", edit_look)
case("new clip from a range", new_clip)
case("silent audio", expect_error(make("silent.mp4", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=10", "-f", "lavfi",
                                       "-i", "anullsrc=r=48000:cl=mono", "-t", "10", "-c:v", "libx264", "-preset",
                                       "ultrafast", "-c:a", "aac"), "silent"))
case("no audio track", expect_error(make("noaudio.mp4", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=6",
                                         "-c:v", "libx264", "-preset", "ultrafast"), "no audio"))
case("too short", expect_error(make("tiny.mp4", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=2", "-f", "lavfi",
                                    "-i", "sine=f=300:d=2", "-shortest", "-c:v", "libx264", "-preset", "ultrafast",
                                    "-c:a", "aac"), "too short"))
corrupt = TMP / "corrupt.mp4"
corrupt.write_bytes(show.read_bytes()[:200_000])
case("corrupt file", expect_error(corrupt, "couldn't read"))

shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{8 - len(fails)}/8 passed")
sys.exit(1 if fails else 0)
