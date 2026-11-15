"""Fast unit checks for clipper.py helpers (no rendering, no speech model).

    .venv/bin/python -m unittest tests/test_engine_units.py -v
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import clipper  # noqa: E402
from clipper import Moment  # noqa: E402


def W(w, s, e):
    return {"w": w, "s": s, "e": e}


class KeepIntervals(unittest.TestCase):
    def test_no_tighten_keeps_everything(self):
        m = Moment(start=10, end=20, words=[W("a", 10.2, 10.5), W("b", 15, 15.3)])
        self.assertEqual(clipper.keep_intervals(m, False), [(0.0, 10)])

    def test_long_pause_is_cut_to_a_breath(self):
        m = Moment(start=0, end=6, words=[W("one", 0.1, 0.6), W("two", 3.0, 3.4), W("three", 3.5, 5.9)])
        keep = clipper.keep_intervals(m, True)
        self.assertEqual(len(keep), 2)
        kept_gap = (3.0 - keep[1][0]) + (keep[0][1] - 0.6)
        self.assertLess(kept_gap, 0.4)                     # ~0.3 s of the 2.4 s pause survives

    def test_fillers_are_removed(self):
        m = Moment(start=0, end=4, words=[W("so", 0.1, 0.4), W("um", 0.45, 0.8), W("yes", 0.85, 1.2), W("ok", 1.25, 3.9)])
        keep = clipper.keep_intervals(m, True)
        total = sum(b - a for a, b in keep)
        self.assertLess(total, 4 - 0.3)
        for a, b in keep:                                  # nothing kept overlaps the "um"
            self.assertFalse(a < 0.75 and b > 0.5)

    def test_intervals_are_ordered_and_inside_the_clip(self):
        words = [W(f"w{i}", i * 0.7, i * 0.7 + 0.3) for i in range(20)] + [W("uh", 14.5, 14.8)]
        m = Moment(start=0, end=15, words=words)
        keep = clipper.keep_intervals(m, True)
        for (a, b), nxt in zip(keep, keep[1:] + [(99, 99)]):
            self.assertTrue(0 <= a < b <= 15 and b <= nxt[0])

    def test_remap_follows_the_cuts(self):
        keep = [(0.0, 2.0), (3.0, 5.0)]
        self.assertAlmostEqual(clipper.remap(1.0, keep), 1.0)
        self.assertAlmostEqual(clipper.remap(4.0, keep), 3.0)
        self.assertAlmostEqual(clipper.remap(2.5, keep), 2.0)   # inside a cut → snaps to the join


class QualityGateRules(unittest.TestCase):
    def q(self, *fails):
        names = ["Upload-ready format", "Length matches the edit", "No black frames", "No dead silence", "No clipping"]
        return [{"k": k, "ok": k not in fails, "hard": k != "No clipping", "detail": ""} for k in names]

    def test_passed(self):
        self.assertTrue(clipper._passed(self.q()))
        self.assertTrue(clipper._passed(self.q("No clipping")))       # soft check
        self.assertFalse(clipper._passed(self.q("No dead silence")))

    def test_content_failures_skip_the_safe_retry(self):
        self.assertTrue(clipper._content_fail(self.q("No dead silence")))
        self.assertTrue(clipper._content_fail(self.q("No dead silence", "No black frames")))
        self.assertFalse(clipper._content_fail(self.q("No dead silence", "Length matches the edit")))
        self.assertFalse(clipper._content_fail(self.q()))
        self.assertFalse(clipper._content_fail(self.q("No clipping")))


class Looks(unittest.TestCase):
    def test_brand_logo_settings(self):
        lk = clipper.clean_look({"logo": "1", "lpos": "tr", "lsize": "l", "lop": "0.66"})
        self.assertEqual((lk["logo"], lk["lpos"], lk["lsize"], lk["lop"]), (True, "tr", "l", 0.7))
        junk = clipper.clean_look({"logo": "maybe", "lpos": "bottom", "lsize": "xl", "lop": "abc", "logo_path": "/etc/passwd"})
        self.assertNotIn("lpos", junk); self.assertNotIn("lsize", junk); self.assertNotIn("logo_path", junk)
        self.assertEqual(junk.get("lop"), 0.7)
        kept = clipper.clean_look({"format": "1:1"}, {"logo": True, "lpos": "tr"})   # an edit keeps the run's brand settings
        self.assertEqual((kept["logo"], kept["lpos"]), (True, "tr"))
        b = clipper.logo_box("16:9", {"lsize": "s"})
        self.assertEqual((b["box"], b["mx"], b["my"]), (98, 54, 54))

    def test_frame_sizes(self):
        self.assertEqual(clipper.frame_size("9:16"), (1080, 1920))
        self.assertEqual(clipper.frame_size("4:5"), (1080, 1350))
        self.assertEqual(clipper.frame_size("16:9"), (1920, 1080))
        self.assertEqual(clipper.frame_size("junk"), (1080, 1920))

    def test_colours(self):
        self.assertEqual(clipper.ass_colour("#FF4FA3"), "&HA34FFF&")
        self.assertEqual(clipper.ass_colour("red"), "&H00F0FF&")

    def test_clean_look_rejects_junk(self):
        lk = clipper.clean_look({"format": "3:2", "hl": "javascript:", "size": "xl", "pos": "left", "cx": "nan", "cy": 9,
                                 "style": "<b>", "layout": "original", "tighten": "yes"})
        self.assertEqual(lk, {"format": "9:16", "hl": "#FFF000", "size": "m", "pos": "bottom", "cy": 1.0})
        lk = clipper.clean_look({"format": "1:1", "hl": "#22ccff", "style": "boxed", "layout": "crop", "tighten": False, "cx": 0.2})
        self.assertEqual((lk["format"], lk["hl"], lk["style"], lk["layout"], lk["tighten"], lk["cx"]), ("1:1", "#22CCFF", "boxed", "crop", False, 0.2))

    def test_caption_positions(self):
        p = clipper.PLATFORMS["tiktok"]
        self.assertEqual(clipper.caption_layout(p)["marginV"], p["cap_bottom"])          # default = the platform's safe zone
        self.assertEqual(clipper.caption_layout(p, pos="middle")["align"], 5)
        self.assertLess(clipper.caption_layout(p, "16:9")["scale"], 1)


class Helpers(unittest.TestCase):
    def test_ffmpeg_path_escaping(self):
        self.assertEqual(clipper._ffesc(r"C:\Users\me\clip.ass"), r"C\:/Users/me/clip.ass")
        self.assertEqual(clipper._ffesc("/tmp/it's.ass"), r"/tmp/it\'s.ass")

    def test_fps_parsing(self):
        self.assertAlmostEqual(clipper._fps("30000/1001"), 29.97, places=2)
        for junk in ("0/0", "", None, "abc", "25/0"):
            self.assertEqual(clipper._fps(junk), 30.0, junk)

    def test_time_format(self):
        self.assertEqual(clipper.fmt_t(65), "1:05")
        self.assertEqual(clipper.fmt_t(3725), "1:02:05")
        self.assertEqual(clipper.fmt_t(None), "0:00")

    def test_fillers(self):
        for w in ("um", "Uh,", "UMM", "hmm"):
            self.assertTrue(clipper.is_filler(W(w, 0, 1)), w)
        for w in ("umbrella", "the", "uhh-huh"):
            self.assertFalse(clipper.is_filler(W(w, 0, 1)), w)

    def test_titles_skip_filler(self):
        m = Moment(start=0, end=5, text="Um, ah, the biggest mistake I ever made", words=[])
        t = clipper._title(m, [{"s": 0, "e": 5, "text": m.text}])
        self.assertFalse(t.lower().startswith(("um", "ah")), t)

    def test_every_platform_is_complete(self):
        for k, p in clipper.PLATFORMS.items():
            for key in ("name", "short", "hard_max", "cap_bottom", "hook_top", "note", "judge", "publish"):
                self.assertIn(key, p, f"{k}.{key}")
            lo, hi = p["short"]
            self.assertLess(lo, hi)
            if p.get("long"):
                self.assertLessEqual(p["long"][1], p["hard_max"])


if __name__ == "__main__":
    unittest.main()
