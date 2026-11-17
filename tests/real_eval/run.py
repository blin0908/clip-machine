"""Clip picking on real, unscripted speech, scored against moments marked blind from the transcripts.

    .venv/bin/python tests/real_eval/run.py [workdir]

Downloads the four NASA videos in sources.json (about 250 MB, once) into workdir (default: a folder in the system temp
dir), runs the desktop engine on each with default settings (5 clips, TikTok), and reports how many picks land on a
marked moment. A pick counts when at least half of it lies inside a marked moment, or it covers half of one.

Baseline (1.8.1): 6/20 picks on a marked moment, 0/4 right top picks. 1.8.2: 8/20, 2/4. It's a small set (30 marks):
use it to catch regressions and to check an idea, not to tune weights until the number goes up.
"""
import json, subprocess, sys, tempfile, urllib.parse, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent


def fetch(work, name, nasa_id):
    out = work / name / f"{name}.mp4"
    if not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        url = f"http://images-assets.nasa.gov/video/{nasa_id}/{nasa_id}~mobile.mp4"
        urllib.request.urlretrieve(urllib.parse.quote(url, safe=":/~"), out)
    return out


def score(gold, clips):
    hits, a_hits, found = [], 0, set()
    for c in clips:
        s, e = c["start"], c["end"]
        hit = None
        for j, (gs, ge, lvl, _) in enumerate(gold):
            ov = max(0, min(e, ge) - max(s, gs))
            if ov >= 0.5 * (e - s) or ov >= 0.5 * (ge - gs):
                hit = (lvl, j)
                break
        hits.append(hit)
        if hit and hit[0] == "A":
            a_hits += 1
            found.add(hit[1])
    return hits, a_hits, found


def main():
    work = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.gettempdir()) / "clip-machine-real-eval"
    gold = json.loads((HERE / "gold.json").read_text(encoding="utf-8"))
    srcs = json.loads((HERE / "sources.json").read_text(encoding="utf-8"))
    tot = dict(picks=0, hit=0, a=0, top=0, vids=0, found=0, a_total=0)
    for name, marks in gold.items():
        video = fetch(work, name, srcs[name])
        out = work / f"out_{name}"
        subprocess.run([sys.executable, str(ROOT / "clipper.py"), str(video), "-o", str(out), "-n", "5", "-p", "tiktok"],
                       check=True, capture_output=True)
        clips = json.loads((out / "result.json").read_text(encoding="utf-8"))["clips"]
        hits, a_hits, found = score(marks, clips)
        print(f"{name:12s} {sum(1 for h in hits if h)}/{len(clips)} on a marked moment, top pick {'hit' if hits and hits[0] else 'miss'}")
        tot["picks"] += len(clips); tot["hit"] += sum(1 for h in hits if h); tot["a"] += a_hits
        tot["top"] += bool(hits and hits[0]); tot["vids"] += 1
        tot["found"] += len(found); tot["a_total"] += sum(1 for m in marks if m[2] == "A")
    print(f"\nTOTAL {tot['hit']}/{tot['picks']} picks on a marked moment, top pick right {tot['top']}/{tot['vids']}, "
          f"best moments found {tot['found']}/{tot['a_total']}")


if __name__ == "__main__":
    main()
