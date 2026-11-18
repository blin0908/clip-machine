"""Fast unit checks for clipper.py helpers (no rendering, no speech model).

    .venv/bin/python -m unittest tests/test_engine_units.py -v
"""
import os
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


class CaptionFonts(unittest.TestCase):
    def test_latin_uses_the_bundled_font(self):
        self.assertEqual(clipper.font_dir(clipper.caption_font(Moment(start=0, end=2, title="Привет", words=[]))), clipper.FONT_DIR)

    def test_failed_download_falls_back_and_is_not_retried_at_once(self):
        import tempfile
        from unittest import mock
        entry = {**clipper.CAPTION_FONTS["thai"], "url": "https://invalid.invalid/none.ttf", "file": "NoSuch_900Black.ttf"}
        calls = []
        def boom(url, dst):
            calls.append(url)
            raise OSError("offline")
        with tempfile.TemporaryDirectory() as d, mock.patch.object(clipper, "FONT_CACHE", Path(d)), \
                mock.patch.object(clipper, "_fetch_font", boom), mock.patch.dict(clipper._font_failed, clear=True):
            self.assertEqual(clipper.font_dir(entry), clipper.FONT_DIR)
            self.assertEqual(clipper.font_dir(entry), clipper.FONT_DIR)
            self.assertEqual(len(calls), 1)
            self.assertFalse(any(p.name.endswith(".part") for p in Path(d).iterdir()))

    def test_cached_font_is_used_without_a_download(self):
        import tempfile
        from unittest import mock
        entry = clipper.CAPTION_FONTS["thai"]
        with tempfile.TemporaryDirectory() as d, mock.patch.object(clipper, "FONT_CACHE", Path(d)), \
                mock.patch.object(clipper, "_fetch_font", side_effect=AssertionError("downloaded")):
            (Path(d) / entry["file"]).write_bytes(b"\x00\x01\x00\x00" + b"0" * 20000)
            self.assertEqual(clipper.font_dir(entry), d)
            self.assertTrue((Path(d) / "Montserrat-Black.ttf").exists())


class SpeechDevice(unittest.TestCase):
    """Whisper on the Apple GPU must fall back to the CPU, whether the backend fails to load or mid-video."""

    def setUp(self):
        import types
        self.saved = (clipper._DEVICE, dict(clipper._MODEL_CACHE), clipper._whisper_device, sys.modules.get("faster_whisper"))
        clipper._DEVICE = None
        clipper._MODEL_CACHE.clear()
        clipper._whisper_device = lambda: "mps"
        self.fail_on = set()
        test = self

        class Seg:
            def __init__(self):
                self.start, self.end, self.text = 0.0, 1.0, " hello there"
                self.words = [types.SimpleNamespace(word=" hello", start=0.0, end=0.4), types.SimpleNamespace(word=" there", start=0.5, end=1.0)]

        class FakeModel:
            def __init__(self, size, device, compute_type):
                if device == "mps" and "load" in test.fail_on:
                    raise RuntimeError("no Metal device")
                self.device, self.compute_type = device, compute_type

            def detect_language(self, audio, **kw):
                return "en", 1.0, None

            def transcribe(self, audio, **kw):
                dev = self.device
                def gen():
                    if dev == "mps" and "run" in test.fail_on:
                        raise RuntimeError("MPS kernel failed")
                    yield Seg()
                return gen(), types.SimpleNamespace(duration=1.0, language="en")

        sys.modules["faster_whisper"] = types.SimpleNamespace(WhisperModel=FakeModel)
        import tempfile
        self.tmp = Path(tempfile.mkdtemp())
        self.wav = self.tmp / "a.raw"
        self.wav.write_bytes(b"\0\0" * 16000)

    def tearDown(self):
        clipper._DEVICE, cache, clipper._whisper_device, fw = self.saved
        clipper._MODEL_CACHE.clear(); clipper._MODEL_CACHE.update(cache)
        if fw is None: sys.modules.pop("faster_whisper", None)
        else: sys.modules["faster_whisper"] = fw

    def test_uses_gpu_when_it_works(self):
        segs = clipper.transcribe(self.wav, "base", language="en")
        self.assertEqual([w["w"] for w in segs[0]["words"]], ["hello", "there"])
        self.assertEqual(clipper._DEVICE, "mps")
        self.assertEqual(clipper._MODEL_CACHE[("base", "mps")].compute_type, "float16")

    def test_falls_back_when_gpu_wont_load(self):
        self.fail_on = {"load"}
        segs = clipper.transcribe(self.wav, "base", language="en")
        self.assertEqual(len(segs), 1)
        self.assertEqual(clipper._DEVICE, "cpu")
        self.assertEqual(clipper._MODEL_CACHE[("base", "cpu")].compute_type, "int8")

    def test_falls_back_when_gpu_fails_mid_video(self):
        self.fail_on = {"run"}
        segs = clipper.transcribe(self.wav, "base", language="en")
        self.assertEqual([w["w"] for w in segs[0]["words"]], ["hello", "there"])
        self.assertEqual(clipper._DEVICE, "cpu")

    def test_cpu_failure_is_not_swallowed(self):
        clipper._whisper_device = lambda: "cpu"
        clipper._DEVICE = None
        def boom(*a, **k): raise RuntimeError("bad file")
        sys.modules["faster_whisper"].WhisperModel = boom
        with self.assertRaises(RuntimeError):
            clipper.transcribe(self.wav, "base", language="en")


class ParallelRender(unittest.TestCase):
    """Clips render several at a time, but the result must match rendering one by one: ranking order, the quality gate
    replacing a failed clip with the next candidate, and no temporary files left over."""

    def run_with(self, fail_starts, workers, n=3):
        import tempfile, threading, time
        tmp = Path(tempfile.mkdtemp())
        src = tmp / "src.mp4"; src.write_bytes(b"x")
        cands = [Moment(start=10.0 * i, end=10.0 * i + 8, title=f"m{i}", words=[]) for i in range(7)]
        P = {}
        def patch(name, fn):
            P[name] = getattr(clipper, name); setattr(clipper, name, fn)
        live, peak = [0], [0]
        lock = threading.Lock()
        def render(video, m, out, *a, **k):
            with lock:
                live[0] += 1; peak[0] = max(peak[0], live[0])
            time.sleep(0.05 if m.start % 20 else 0.12)   # uneven render times, so finishing order differs from ranking
            out.write_bytes(b"v"); out.with_suffix(".jpg").write_bytes(b"j")
            with lock:
                live[0] -= 1
            return {"final_duration": m.end - m.start, "_tighten": False}
        patch("fetch", lambda source, outdir, progress: (src, "Title"))
        patch("probe", lambda v: {"duration": 120.0, "has_audio": True, "has_video": True})
        patch("extract_audio", lambda v, w: Path(w).write_bytes(b"\0\0" * 10))
        patch("loudness_curve", lambda w: [0.0])
        patch("audio_peak_db", lambda w: -10.0)
        patch("quiet_map", lambda w: [])
        patch("transcribe", lambda *a, **k: [])
        patch("find_moments", lambda *a, **k: list(cands))
        patch("render", render)
        patch("quality_check", lambda out, st, m, captions=True: [{"k": "x", "ok": m.start not in fail_starts, "detail": "", "hard": True}])
        patch("shorten", lambda m, *a: Moment(start=m.start, end=m.start + 4, title=m.title + "s", words=[]))
        patch("write_srt", lambda m, path, keep: Path(path).write_text("srt"))
        patch("_post_copy", lambda m, platform, title: {})
        os.environ["CLIP_RENDER_JOBS"] = str(workers)
        try:
            res = clipper.run("src.mp4", tmp / "out", n=n, platform="tiktok")
        finally:
            os.environ.pop("CLIP_RENDER_JOBS", None)
            for k, v in P.items(): setattr(clipper, k, v)
        return res, sorted(f.name for f in (tmp / "out").iterdir()), peak[0]

    def test_same_clips_as_one_at_a_time(self):
        one, files1, _ = self.run_with({10.0, 30.0}, workers=1)
        par, files3, peak = self.run_with({10.0, 30.0}, workers=3)
        starts = lambda r: [c["start"] for c in r["clips"]]
        self.assertEqual(starts(one), [0.0, 20.0, 40.0])      # 10 and 30 failed the gate: replaced in ranking order
        self.assertEqual(starts(par), starts(one))
        self.assertEqual(par["dropped_for_quality"], 2)
        self.assertEqual(files3, files1)
        self.assertFalse([f for f in files3 if f.startswith("_cand")], "temporary renders left behind")
        self.assertIn("clip_02_short.mp4", files3)
        self.assertEqual(par["clips"][1]["file"], "clip_02.mp4")
        self.assertGreater(peak, 1, "renders didn't overlap")

    def test_runs_out_of_candidates(self):
        res, files, _ = self.run_with({0.0, 10.0, 20.0, 30.0, 40.0, 50.0}, workers=2)
        self.assertEqual([c["start"] for c in res["clips"]], [60.0])
        self.assertFalse([f for f in files if f.startswith("_cand")])


class Headlines(unittest.TestCase):
    @staticmethod
    def seg(text, s, p):
        ws = text.split()
        step = 3.0 / len(ws)
        return {"s": s, "e": s + 3, "text": text,
                "words": [{"w": w, "s": s + i * step, "e": s + (i + 1) * step, "p": p} for i, w in enumerate(ws)]}

    def test_a_misheard_sentence_is_never_the_headline_when_a_clear_one_exists(self):
        segs = [self.seg("Wait this is insane, the mall of instable!", 0, 0.31),   # loud, hype-y, but misheard
                self.seg("That is the Turkish eye in the font.", 3, 0.93)]
        title, sure = clipper._title(Moment(0, 6), segs, with_confidence=True)
        self.assertEqual(title, "That is the Turkish eye in the font")
        self.assertTrue(sure)

    def test_all_shaky_still_gets_a_headline_but_says_so(self):
        segs = [self.seg("Wait this is insane!", 0, 0.3), self.seg("Mall of instable", 3, 0.4)]
        title, sure = clipper._title(Moment(0, 6), segs, with_confidence=True)
        self.assertTrue(title)
        self.assertFalse(sure)

    def test_transcripts_without_confidence_behave_as_before(self):
        segs = [{"s": 0, "e": 3, "text": "Wait this is insane!", "words": [{"w": "Wait", "s": 0, "e": 1}]}]
        self.assertEqual(clipper._title(Moment(0, 3), segs), "Wait this is insane!")
        self.assertEqual(clipper._title(Moment(0, 3), segs, with_confidence=True), ("Wait this is insane!", True))


class ShortCuts(unittest.TestCase):
    def test_short_gets_its_own_score_and_a_late_payoff_skips_it(self):
        import numpy as np
        words = [{"w": w, "s": t * 0.4, "e": t * 0.4 + 0.3}
                 for t, w in enumerate((["why", "is", "this", "insane", "here's", "the", "secret.", "so"] * 40)[:300])]
        segs = clipper.segments_from_words(words) if hasattr(clipper, "segments_from_words") else None
        if segs is None:
            segs, cur = [], []
            for w in words:
                cur.append(w)
                if w["w"].endswith("."):
                    segs.append({"s": cur[0]["s"], "e": cur[-1]["e"], "text": " ".join(x["w"] for x in cur), "words": cur})
                    cur = []
        loud = np.array([3.0 if 50 <= i <= 56 else 0.1 * np.sin(i) for i in range(240)], dtype=np.float32)
        m = Moment(0, 30, words=[w for w in words if w["e"] <= 30])
        self.assertIsNone(clipper.shorten(m, segs, loud, 12, 18))
        self.assertIn("payoff lands", m.short_note)
        flat = np.array([0.1 * np.sin(i) for i in range(240)], dtype=np.float32)
        ms = clipper.find_moments(segs, flat, 120, 2, platform="tiktok", version="long")
        sm = clipper.shorten(ms[0], segs, flat, *clipper.PLATFORMS["tiktok"]["short"])
        self.assertIsNotNone(sm)
        self.assertEqual(ms[0].short_note, "")
        self.assertTrue(45 <= sm.score <= 99 and sm.checklist)
        self.assertTrue(any("Length" in c["k"] and c["ok"] for c in sm.checklist))   # judged against the short range


class InterestSignal(unittest.TestCase):
    """The desktop-only interest curve moves the ranking towards what's said; without it, nothing changes."""

    def setUp(self):
        import numpy as np
        self.np = np
        self.segs, t = [], 0.0
        for i in range(40):   # 40 three-second sentences with the same delivery
            ws = [{"w": w, "s": t + k * 0.5, "e": t + k * 0.5 + 0.4} for k, w in enumerate(f"sentence {i} says something here.".split())]
            self.segs.append({"s": t, "e": t + 2.9, "text": " ".join(w["w"] for w in ws), "words": ws})
            t += 3.0
        self.loud = np.zeros(int(t / clipper.HOP) + 2)

    def test_none_changes_nothing(self):
        a = clipper.find_moments(self.segs, self.loud, 120, 2, platform="tiktok", version="long")
        b = clipper.find_moments(self.segs, self.loud, 120, 2, platform="tiktok", version="long", interest=None)
        self.assertEqual([(m.start, m.end, m.score) for m in a], [(m.start, m.end, m.score) for m in b])
        self.assertNotIn("interest", a[0].signals)

    def test_high_interest_stretch_wins(self):
        curve = self.np.zeros_like(self.loud)
        curve[int(75 / clipper.HOP): int(100 / clipper.HOP)] = 1.0   # 75-100 s is what's worth posting
        top = clipper.find_moments(self.segs, self.loud, 120, 1, platform="tiktok", version="long", interest=curve)[0]
        self.assertGreaterEqual(top.start, 70)
        self.assertLessEqual(top.start, 90)
        self.assertGreater(top.signals["interest"], 1)
        self.assertIn("a standout story or fact", top.reasons)


if __name__ == "__main__":
    unittest.main()


class LinkDownloads(unittest.TestCase):
    """Links must survive a moved/renamed app folder, and failures must say what to do."""

    def test_ytdlp_runs_as_module(self):
        cmd = clipper._ytdlp_cmd()
        self.assertEqual(cmd[1:], ["-m", "yt_dlp"])
        self.assertEqual(cmd[0], sys.executable)

    def test_download_errors_are_explained(self):
        cases = {
            "ERROR: [youtube] x: Sign in to confirm you're not a bot.": "signed-in",
            "ERROR: [youtube] x: Private video.": "isn't public",
            "ERROR: [generic] Unsupported URL: https://example.com/": "can't find a video",
            "ERROR: [youtube] x: Video unavailable": "can't be found",
            "ERROR: [youtube] x: This video is unavailable": "can't be found",
            "ERROR: Unable to download webpage: timed out": "couldn't reach",
            "ERROR: HTTP Error 429: Too Many Requests": "limiting downloads",
            "garbage": "didn't work",
        }
        for log, want in cases.items():
            out = clipper.explain_download(log)
            self.assertIn(want, out, log)
            self.assertIn("\n\nDetails: ", out)

    def test_missing_tool_is_explained(self):
        e = FileNotFoundError(2, "No such file or directory", "/gone/.venv/bin/yt-dlp")
        self.assertTrue(clipper.explain_error(e).startswith("The link downloader couldn't start."))
        self.assertEqual(clipper.explain_error(RuntimeError("Head\n\nBody")), "Head\n\nBody")
        self.assertEqual(clipper.explain_error(RuntimeError("plain")), "plain")
