"""Stress-test the clip engine against tests/media/ (build it with make_media.sh).

    ../.venv/bin/python engine_stress.py            # all cases
    ../.venv/bin/python engine_stress.py talk tiny  # cases whose name contains any of these words

Each case states what must happen: clips that pass every hard quality check, or a clean, human-readable error.
"""
import json
import shutil
import subprocess
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import clipper  # noqa: E402

M = HERE / "media"
OUT = HERE / "out"


def probe(p):
    return json.loads(subprocess.run([clipper.FFPROBE, "-v", "error", "-print_format", "json", "-show_streams",
                                      "-show_format", str(p)], capture_output=True, text=True).stdout)


def check_clips(res, outdir, expect_fps=None, expect_captions=True, min_clips=1):
    problems = []
    clips = res["clips"]
    if len(clips) < min_clips:
        problems.append(f"expected ≥{min_clips} clips, got {len(clips)}")
    for c in clips:
        for v, label in [(c, "long")] + ([(c["short"], "short")] if c.get("short") else []):
            f = outdir / v["file"]
            if not f.exists():
                problems.append(f"{v['file']} missing"); continue
            info = probe(f)
            vs = next((s for s in info["streams"] if s["codec_type"] == "video"), {})
            if (vs.get("width"), vs.get("height")) != (1080, 1920):
                problems.append(f"{v['file']} is {vs.get('width')}x{vs.get('height')}")
            hard_fail = [q["k"] for q in v["quality"] if q["hard"] and not q["ok"]]
            if hard_fail:
                problems.append(f"{v['file']} failed {hard_fail}")
            if expect_fps and v["fps"] != expect_fps:
                problems.append(f"{v['file']} fps {v['fps']} != {expect_fps}")
            if not (outdir / v["srt"]).exists():
                problems.append(f"{v['srt']} missing")
        if expect_captions and not c["title"]:
            problems.append("empty title")
    return problems


CASES = [
    # name, file, kwargs, expectation
    ("talk default", "talk_720p.mp4", {}, {"min_clips": 3}),
    ("talk tiktok short-only", "talk_720p.mp4", {"platform": "tiktok", "version": "short", "n": 2}, {"min_clips": 2}),
    ("talk snapchat", "talk_720p.mp4", {"platform": "snapchat", "n": 2}, {"min_clips": 2}),
    ("talk crop no-enhance", "talk_720p.mp4", {"layout": "crop", "enhance": False, "n": 2}, {"min_clips": 2}),
    ("talk custom 45-90", "talk_720p.mp4", {"min_len": 45, "max_len": 90, "n": 1}, {"min_clips": 1}),
    ("portrait source", "portrait.mp4", {"n": 2}, {"min_clips": 2}),
    ("hd60 keeps 60fps", "hd60.mp4", {"n": 1}, {"min_clips": 1, "fps": 60}),
    ("odd low-res 15fps", "odd_lowres.mp4", {"n": 2}, {"min_clips": 2, "fps": 23}),
    ("unicode filename", "my clip (final) #1 ünïcode's.mov", {"n": 1}, {"min_clips": 1}),
    ("audio only", "audio_only.m4a", {"n": 1}, {"min_clips": 1}),
    ("music only (no speech)", "music_only.mp4", {"n": 2}, {"min_clips": 1, "captions": False}),
    ("tiny 6s", "tiny.mp4", {"n": 1}, {"min_clips": 1}),
    ("silent", "silent.mp4", {"n": 2}, {"error_or_zero": True}),
    ("no audio track", "no_audio.mp4", {"n": 1}, {"error": "no audio"}),
    ("corrupt file", "corrupt.mp4", {"n": 1}, {"error": "read"}),
    ("long 25 min", "long_25min.mp4", {"n": 5, "model": "tiny"}, {"min_clips": 5}),
]


def run_case(name, fname, kw, exp):
    src = M / fname
    outdir = OUT / name.replace(" ", "_")
    shutil.rmtree(outdir, ignore_errors=True)
    kw = {"n": 3, "model": "base", **kw}
    t0 = time.time()
    try:
        res = clipper.run(str(src), outdir, **kw)
    except Exception as e:
        dt = time.time() - t0
        msg = str(e)
        if "error" in exp and exp["error"].lower() in msg.lower():
            return "PASS", dt, f"clean error: {msg[:90]}"
        if exp.get("error_or_zero"):
            return "PASS", dt, f"clean error: {msg[:90]}"
        return "FAIL", dt, f"unexpected error: {msg[:300]}\n{traceback.format_exc()[-600:]}"
    dt = time.time() - t0
    if "error" in exp:
        return "FAIL", dt, f"expected an error ({exp['error']}), got {len(res['clips'])} clips"
    if exp.get("error_or_zero"):
        ok = len(res["clips"]) == 0
        return ("PASS" if ok else "FAIL"), dt, f"{len(res['clips'])} clips (dropped {res.get('dropped_for_quality')})"
    probs = check_clips(res, outdir, exp.get("fps"), exp.get("captions", True), exp.get("min_clips", 1))
    shorts = sum(1 for c in res["clips"] if c.get("short"))
    fillers = sum(c.get("fillers_cut", 0) for c in res["clips"])
    detail = (f"{len(res['clips'])} clips, {shorts} shorts, fillers cut {fillers}, "
              f"dropped {res.get('dropped_for_quality', 0)}, retried {sum(1 for c in res['clips'] if c.get('retried'))}")
    return ("FAIL" if probs else "PASS"), dt, detail + ("".join("\n      ✗ " + p for p in probs))


def edit_case():
    """Re-render one cut after a manual edit: trimmed end, a caption fix, new headline, boxed style."""
    outdir = OUT / "edit"
    shutil.rmtree(outdir, ignore_errors=True)
    t0 = time.time()
    res = clipper.run(str(M / "talk_720p.mp4"), outdir, n=1, model="base", platform="reels")
    c = res["clips"][0]
    v = c["short"] or c
    cut = "short" if c["short"] else "long"
    words = [w for seg in json.loads((outdir / "transcript.json").read_text()) for w in seg["words"]]
    inside = [w for w in words if v["start"] <= w["s"] <= v["end"]]
    end = inside[-2]["e"] + 0.05 if len(inside) > 2 else v["end"]          # drop the last word
    inside[0] = dict(inside[0], w=inside[0]["w"].upper() + "!")
    edited = [w for w in words if w["s"] < v["start"]] + inside + [w for w in words if w["s"] > v["end"]]
    before = (outdir / v["file"]).stat().st_mtime
    res2 = clipper.edit_cut(outdir, 0, cut, v["start"], end, "Edited headline", edited, "boxed")
    v2 = res2["clips"][0]["short"] if cut == "short" else res2["clips"][0]
    probs = check_clips(res2, outdir)
    if not v2.get("edited") or v2.get("style") != "boxed" or v2.get("title") != "Edited headline":
        probs.append(f"result.json not updated: {v2.get('edited')} {v2.get('style')} {v2.get('title')}")
    if (outdir / v2["file"]).stat().st_mtime <= before:
        probs.append("file not replaced")
    ass = (outdir / v2["file"]).with_suffix(".ass").read_text()
    if "BorderStyle" not in ass or ",3," not in ass.split("Style: Cap", 1)[1].split("\n", 1)[0]:
        probs.append("boxed style missing from captions")
    if v2["duration"] >= v["duration"] + 0.05:
        probs.append(f"trim didn't shorten: {v['duration']} -> {v2['duration']}")
    try:
        clipper.edit_cut(outdir, 0, cut, v["start"], v["start"] + 1, "x", edited)
        probs.append("a 1 s trim should be refused")
    except RuntimeError:
        pass
    return ("FAIL" if probs else "PASS"), time.time() - t0, f"{cut} cut {v['duration']}s -> {v2['duration']}s" + "".join("\n      ✗ " + x for x in probs)


if __name__ == "__main__":
    want = sys.argv[1:]
    rows = []
    for name, f, kw, exp in CASES:
        if want and not any(w in name for w in want):
            continue
        status, dt, detail = run_case(name, f, kw, exp)
        rows.append((status, name, dt, detail))
        print(f"{status}  {name:26s} {dt:6.1f}s  {detail}", flush=True)
    if not want or any(w in "edit cut" for w in want):
        try:
            status, dt, detail = edit_case()
        except Exception as e:
            status, dt, detail = "FAIL", 0, f"unexpected error: {e}\n{traceback.format_exc()[-600:]}"
        rows.append((status, "edit cut", dt, detail))
        print(f"{status}  {'edit cut':26s} {dt:6.1f}s  {detail}", flush=True)
    fails = [r for r in rows if r[0] != "PASS"]
    print(f"\n{len(rows) - len(fails)}/{len(rows)} passed")
    sys.exit(1 if fails else 0)
