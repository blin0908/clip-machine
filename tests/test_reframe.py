"""Auto-reframe + split-screen (reframe.py): speaker choice, camera path, ffmpeg expressions, and render fallbacks.

    .venv/bin/python -m unittest tests/test_reframe.py -v

The decision logic runs on synthetic face samples, so these need neither OpenCV nor a video with people in it.
The render checks at the bottom use a generated test pattern (no faces) and confirm every layout still renders.
"""
import json
import math
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import clipper  # noqa: E402
import reframe  # noqa: E402

FPS = reframe.FPS


def face(x, y=0.4, h=0.25, mouth=0.0, aspect=16 / 9):
    return [x, y, round(h / aspect, 4), h, 0.95, mouth]


def samples(n, fn, cut_at=()):
    """n samples; fn(i) -> list of faces."""
    return [(i / FPS, {"c": int(i in cut_at), "f": fn(i)}) for i in range(n)]


def talk(i, on):
    """Mouth movement that looks like speech when on (jittery, high), still when off."""
    return (6.0 + 3 * math.sin(i * 1.7)) if on else 0.3


def words_between(a, b):
    out, t = [], a
    while t < b:
        out.append({"w": "word", "s": round(t, 2), "e": round(t + 0.3, 2)})
        t += 0.4
    return out


def ffeval(e, t):
    """Evaluate the subset of ffmpeg's expression language reframe.expr writes."""
    return eval(e.replace("if(", "IF("), {"__builtins__": {}},
                {"IF": lambda c, a, b: a if c else b, "lt": lambda a, b: a < b,
                 "clip": lambda x, lo, hi: min(max(x, lo), hi), "t": t})


class Tracks(unittest.TestCase):
    def test_two_still_people_are_two_tracks(self):
        s = samples(80, lambda i: [face(0.25), face(0.75)])
        trs = reframe.tracks(s, 16 / 9)
        self.assertEqual(len(trs), 2)
        self.assertTrue(all(len(t) == 80 for t in trs))

    def test_a_walking_face_stays_one_track(self):
        s = samples(80, lambda i: [face(0.2 + i * 0.006)])
        self.assertEqual(len(reframe.tracks(s, 16 / 9)), 1)

    def test_a_source_camera_cut_starts_new_tracks(self):
        s = samples(80, lambda i: [face(0.5)], cut_at={40})
        self.assertEqual(len(reframe.tracks(s, 16 / 9)), 2)

    def test_flicker_detections_are_dropped(self):
        s = samples(80, lambda i: [face(0.5)] + ([face(0.9, h=0.08)] if i == 30 else []))
        self.assertEqual(len(reframe.tracks(s, 16 / 9)), 1)


class Speaker(unittest.TestCase):
    def setUp(self):
        # A on the left talks for 6 s, then B on the right for 6 s
        self.s = samples(96, lambda i: [face(0.25, mouth=talk(i, i < 48)), face(0.75, mouth=talk(i, i >= 48))])
        self.trs = reframe.tracks(self.s, 16 / 9)
        self.words = words_between(0, 12)

    def test_follows_whoever_talks(self):
        active, cuts = reframe.speakers(self.s, self.trs, self.words)
        x = lambda i: self.trs[active[i]][i][0]
        self.assertAlmostEqual(x(20), 0.25)
        self.assertAlmostEqual(x(90), 0.75)
        self.assertEqual(len(cuts), 1)
        self.assertLess(abs(cuts[0] / FPS - 6.0), 1.5)          # cuts within ~1.5 s of the speaker change

    def test_no_flicker_on_short_interjections(self):
        # B says one quick word (0.4 s) in the middle of A's turn: the frame stays on A
        s = samples(96, lambda i: [face(0.25, mouth=talk(i, not 40 <= i < 43)), face(0.75, mouth=talk(i, 40 <= i < 43))])
        active, cuts = reframe.speakers(s, reframe.tracks(s, 16 / 9), words_between(0, 12))
        self.assertEqual(cuts, [])

    def test_silence_never_switches(self):
        s = samples(96, lambda i: [face(0.25, mouth=0.3), face(0.75, mouth=talk(i, i > 30))])
        _, cuts = reframe.speakers(s, reframe.tracks(s, 16 / 9), [])    # no words = nobody's talking
        self.assertEqual(cuts, [])

    def test_speaker_leaving_hands_over(self):
        s = samples(96, lambda i: ([face(0.25, mouth=talk(i, True))] if i < 40 else []) + [face(0.75, mouth=0.3)])
        trs = reframe.tracks(s, 16 / 9)
        active, cuts = reframe.speakers(s, trs, words_between(0, 12))
        self.assertAlmostEqual(trs[active[95]][95][0], 0.75)


class Camera(unittest.TestCase):
    def test_holds_still_through_small_movement(self):
        s = samples(80, lambda i: [face(0.5 + 0.01 * math.sin(i))])
        keys = reframe.camera(s, [f[0] for _, f in [(t, x["f"]) for t, x in s]], [], 0.32, 1.0)
        xs = {round(k[1], 3) for k in keys}
        self.assertEqual(len(xs), 1)

    def test_eases_when_the_face_moves_away(self):
        s = samples(80, lambda i: [face(0.3 if i < 40 else 0.6)])
        keys = reframe.camera(s, [x["f"][0] for _, x in s], [], 0.32, 1.0)
        self.assertAlmostEqual(keys[0][1], 0.3, places=2)
        self.assertAlmostEqual(keys[-1][1], 0.6, places=2)
        move = [(a, b) for a, b in zip(keys, keys[1:]) if abs(b[1] - a[1]) > 0.1]
        self.assertEqual(len(move), 1)
        self.assertAlmostEqual(move[0][1][0] - move[0][0][0], reframe.EASE, places=2)   # a smooth move, not a jump

    def test_cuts_are_instant(self):
        s = samples(80, lambda i: [face(0.3 if i < 40 else 0.7)])
        keys = reframe.camera(s, [x["f"][0] for _, x in s], [40], 0.32, 1.0)
        jump = [(a, b) for a, b in zip(keys, keys[1:]) if abs(b[1] - a[1]) > 0.1]
        self.assertEqual(len(jump), 1)
        self.assertLess(jump[0][1][0] - jump[0][0][0], 0.01)

    def test_no_faces_no_keys(self):
        s = samples(20, lambda i: [])
        self.assertEqual(reframe.camera(s, [None] * 20, [], 0.3, 1), [])

    def test_key_count_is_capped(self):
        s = samples(4000, lambda i: [face(0.2 if (i // 20) % 2 else 0.8)])
        keys = reframe.camera(s, [x["f"][0] for _, x in s], [], 0.3, 1.0)
        self.assertLessEqual(len(keys), reframe.MAX_KEYS)


class Expressions(unittest.TestCase):
    keys = [[10.0, 0.3, 0.5], [12.0, 0.3, 0.5], [12.6, 0.7, 0.4], [15.0, 0.7, 0.4], [15.001, 0.2, 0.6], [20.0, 0.2, 0.6]]

    def test_expression_matches_the_preview_curve(self):
        to_out = lambda t: t - 10
        ex, ey = reframe.expr(self.keys, 1, to_out), reframe.expr(self.keys, 2, to_out)
        for t in [0, 1, 2.0, 2.1, 2.3, 2.59, 3, 4.999, 5.0005, 5.002, 9, 30]:
            fx, fy = reframe.at(self.keys, t + 10)
            self.assertAlmostEqual(ffeval(ex, t), fx, places=3, msg=f"x at {t}")
            self.assertAlmostEqual(ffeval(ey, t), fy, places=3, msg=f"y at {t}")

    def test_cut_list_is_respected(self):
        # the render drops 11-13 s of source: output time 1.0 is source 11.0 is source 13.0
        keep = [(0.0, 1.0), (3.0, 10.0)]
        to_out = lambda t: clipper.remap(t - 10, keep)
        e = reframe.expr(self.keys, 1, to_out)
        self.assertAlmostEqual(ffeval(e, 3.0), reframe.at(self.keys, 15.0 - 0.0001)[0], places=2)
        vals = [ffeval(e, t / 10) for t in range(0, 90)]
        self.assertTrue(all(0 <= v <= 1 for v in vals))


class Plan(unittest.TestCase):
    """plan() end to end on fake samples (no decoding)."""
    class FakeFaces:
        aspect = 16 / 9

        def __init__(self, s):
            self.s = s

        def range(self, start, end, progress=None):
            return [(t, x) for t, x in self.s if start - 1e-9 <= t <= end + 1e-9]

    def setUp(self):
        if reframe.unavailable():
            self.skipTest(reframe.unavailable())

    def test_auto_follows_the_speaker(self):
        s = samples(96, lambda i: [face(0.25, mouth=talk(i, i < 48)), face(0.75, mouth=talk(i, i >= 48))])
        p = reframe.plan(self.FakeFaces(s), 0, 11.9, words_between(0, 12), 9 / 16, "auto")
        self.assertEqual(p["mode"], "auto")
        self.assertEqual(p["switches"], 1)
        self.assertAlmostEqual(reframe.at(p["keys"], 2)[0], 0.25, places=2)
        self.assertAlmostEqual(reframe.at(p["keys"], 11)[0], 0.75, places=2)

    def test_split_puts_the_left_person_on_top(self):
        s = samples(96, lambda i: [face(0.75), face(0.25)])
        p = reframe.plan(self.FakeFaces(s), 0, 11.9, [], 9 / 16, "split")
        self.assertEqual(p["mode"], "split")
        self.assertEqual(p["stack"], "v")
        self.assertAlmostEqual(p["panels"][0]["keys"][0][1], 0.25, places=2)
        self.assertAlmostEqual(p["panels"][1]["keys"][0][1], 0.75, places=2)
        for pn in p["panels"]:                        # each crop has the panel's shape (1080x960 -> 9:8)
            self.assertAlmostEqual(pn["rw"] * 16 / 9 / pn["rh"], 1080 / 960, places=2)
            self.assertLessEqual(pn["rw"], 1)
            self.assertLessEqual(pn["rh"], 1)

    def test_split_side_by_side_for_landscape(self):
        s = samples(40, lambda i: [face(0.75), face(0.25)])
        p = reframe.plan(self.FakeFaces(s), 0, 4.9, [], 16 / 9, "split")
        self.assertEqual(p["stack"], "h")

    def test_split_with_one_person_follows_them(self):
        s = samples(40, lambda i: [face(0.6)])
        p = reframe.plan(self.FakeFaces(s), 0, 4.9, [], 9 / 16, "split")
        self.assertEqual(p["mode"], "auto")
        self.assertIn("one person", p["note"])

    def test_nobody(self):
        p = reframe.plan(self.FakeFaces(samples(40, lambda i: [])), 0, 4.9, [], 9 / 16, "auto")
        self.assertEqual(p["mode"], "none")


class Render(unittest.TestCase):
    """Real renders on a generated test pattern: there are no faces, so auto/split fall back to a centred crop."""
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.src = cls.tmp / "pattern.mp4"
        subprocess.run([clipper.FFMPEG, "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=8",
                        "-f", "lavfi", "-i", "sine=f=300:d=8", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                        "-c:a", "aac", str(cls.src)], check=True)
        cls.info = clipper.probe(cls.src)

    def _render(self, layout, fmt="9:16"):
        m = clipper.Moment(start=1, end=6, title="", words=[{"w": "hello", "s": 1.2, "e": 1.6}, {"w": "there", "s": 4.0, "e": 4.4}])
        out = self.tmp / f"{layout}_{fmt.replace(':', 'x')}.mp4"
        st = clipper.render(self.src, m, out, layout, True, 0.5, self.info, "all", False, True, "", True, "pop", {"format": fmt})
        return out, st

    def test_auto_falls_back_cleanly(self):
        out, st = self._render("auto")
        self.assertTrue(out.exists())
        self.assertEqual((st["W"], st["H"]), (1080, 1920))
        if not reframe.unavailable():
            self.assertEqual(st["reframe"]["mode"], "none")
            self.assertTrue((self.tmp / "faces.json").exists())          # the analysis is cached for the next cut

    def test_split_falls_back_cleanly(self):
        out, st = self._render("split", "4:5")
        self.assertTrue(out.exists())
        self.assertEqual((st["W"], st["H"]), (1080, 1350))

    def test_split_render_with_a_forced_plan(self):
        """The split filter graph itself, with a plan as if two people were found (odd panel heights at 4:5)."""
        m = clipper.Moment(start=1, end=6, title="", words=[])
        plan = {"mode": "split", "stack": "v", "panels": [
            {"keys": [[1, 0.25, 0.4], [3, 0.25, 0.4], [3.6, 0.35, 0.45], [6, 0.35, 0.45]], "rw": 0.4, "rh": 0.6},
            {"keys": [[1, 0.75, 0.4], [6, 0.75, 0.4]], "rw": 0.4, "rh": 0.6}]}
        orig = clipper.reframe_plan
        clipper.reframe_plan = lambda *a, **k: plan
        try:
            for fmt in ("9:16", "4:5", "16:9"):
                if fmt == "16:9":
                    plan["stack"] = "h"
                out = self.tmp / f"forced_{fmt.replace(':', 'x')}.mp4"
                st = clipper.render(self.src, m, out, "split", False, 0.5, self.info, "all", False, True, "", True, "pop", {"format": fmt})
                p = clipper.probe(out)
                self.assertEqual((p["width"], p["height"]), (st["W"], st["H"]), fmt)
        finally:
            clipper.reframe_plan = orig

    def test_auto_render_with_a_forced_plan_moves_the_crop(self):
        m = clipper.Moment(start=1, end=6, title="", words=[])
        plan = {"mode": "auto", "keys": [[1, 0.15, 0.5], [3, 0.15, 0.5], [3.001, 0.85, 0.5], [6, 0.85, 0.5]]}
        orig = clipper.reframe_plan
        clipper.reframe_plan = lambda *a, **k: plan
        try:
            out = self.tmp / "forced_auto.mp4"
            clipper.render(self.src, m, out, "auto", False, 0.5, self.info, "all", False, False, "", False, "pop", {"format": "9:16"})
        finally:
            clipper.reframe_plan = orig
        # the left/right edge of the frame, rendered as plain crops for comparison
        def static(cx):
            o = self.tmp / f"static_{cx}.mp4"
            clipper.render(self.src, m, o, "crop", False, cx, self.info, "all", False, False, "", False, "pop", {"format": "9:16", "cx": cx})
            return o

        def frame(path, t):
            r = subprocess.run([clipper.FFMPEG, "-v", "error", "-ss", str(t), "-i", str(path), "-frames:v", "1",
                                "-vf", "scale=27:48", "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True)
            self.assertEqual(len(r.stdout), 27 * 48)
            return r.stdout
        diff = lambda a, b: sum(abs(x - y) for x, y in zip(a, b)) / len(a)
        left, right = static(0.0), static(1.0)
        self.assertLess(diff(frame(out, 0.5), frame(left, 0.5)), 3)       # before the cut: the left edge
        self.assertLess(diff(frame(out, 4.0), frame(right, 4.0)), 3)      # after it: the right edge
        self.assertGreater(diff(frame(out, 4.0), frame(left, 4.0)), 10)


if __name__ == "__main__":
    unittest.main()
