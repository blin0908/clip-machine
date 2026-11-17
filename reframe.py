"""Auto-reframe and split-screen: find the faces in a clip, follow whoever is talking, or stack two speakers.

Runs on this computer with OpenCV's YuNet face detector (models/face_detection_yunet_2023mar.onnx, 232 KB, MIT licence,
from github.com/opencv/opencv_zoo). OpenCV itself is installed the first time it's needed if the app was installed
before this feature existed.

How it decides, in order:
  1. sample  : decode the clip at FPS frames a second, 640 px wide; detect faces; measure how much each mouth moves
               between frames (mouth-region change minus eye-region change, so a head turn doesn't count as talking);
               flag source camera cuts (the whole frame changes at once).
  2. tracks  : link detections frame to frame into people (nearest face within 0.8 face-heights, similar size).
  3. speaker : while someone is talking (from the transcript's word timings), the person whose mouth moves most over
               ~1.25 s is on screen. A challenger has to out-talk the current speaker for 0.7 s, and a shot lasts at
               least 1.5 s, so the frame doesn't flicker between people. Speaker changes and source camera cuts are
               hard cuts, the way an editor would make them.
  4. camera  : inside one shot the frame holds still while the face stays in the middle part of the frame and eases
               (0.6 s smoothstep) when it drifts out, instead of shaking along with every head movement.
A plan is in source seconds and face-centre coordinates (0-1 of the source frame), so the studio preview and the
render draw the same thing. render() turns it into ffmpeg crop expressions over output time.
"""
from __future__ import annotations

import importlib
import json
import math
import subprocess
import sys
import threading
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
MODEL = HERE / "models" / "face_detection_yunet_2023mar.onnx"
CV_SPEC = "opencv-python-headless>=4.8,<6"   # FaceDetectorYN arrived in 4.5.4; the 2023mar model needs 4.8
FPS = 8.0            # analysis frames per second
DET_W = 640          # analysis width (faces down to ~20 px wide still detect)
SCORE = 0.6          # YuNet confidence threshold
CUT_DIFF = 30.0      # mean grey-level change (0-255) of the whole frame that counts as a source camera cut
ACT_WIN = 1.25       # seconds of mouth movement compared when choosing the speaker
SWITCH_HOLD = 0.7    # a challenger must out-talk the current speaker for this long
MIN_SHOT = 1.5       # seconds before the frame may cut to another speaker
DEAD = 0.18          # the face may wander this far (fraction of the crop window) before the camera moves
EASE = 0.6           # seconds a camera move takes
FACE_IN_PANEL = 0.36 # split-screen: a face fills about this much of its panel's height
MAX_KEYS = 160       # keeps the ffmpeg expression a sane length
MIN_FACE = 0.05      # faces shorter than this (fraction of frame height) are crowds and background, never followed

_cv = None
_cv_err = None
_cv_lock = threading.Lock()


def _cv2():
    """Import OpenCV, installing it into this app's Python the first time (older installs don't have it)."""
    global _cv, _cv_err
    if _cv is not None or _cv_err:
        return _cv
    with _cv_lock:
        if _cv is not None or _cv_err:
            return _cv
        try:
            import cv2
        except ImportError:
            try:
                subprocess.run([sys.executable, "-m", "pip", "install", "-q", CV_SPEC], capture_output=True, timeout=900)
                importlib.invalidate_caches()
                import cv2
            except Exception:  # noqa: BLE001 - offline or no pip: reframing falls back to a centred crop
                _cv_err = "OpenCV isn't installed and couldn't be installed (offline?)"
                return None
        if not hasattr(cv2, "FaceDetectorYN"):
            _cv_err = "this OpenCV is too old for the face detector (needs 4.8+)"
            return None
        _cv = cv2
    return _cv


def unavailable() -> str:
    """Why face reframing can't run here, or '' when it can."""
    if not MODEL.is_file():
        return "the face model file is missing (models/face_detection_yunet_2023mar.onnx)"
    return "" if _cv2() is not None else (_cv_err or "OpenCV couldn't be loaded")


# ---------------------------------------------------------------- 1. sampling
def _box_diff(a, b, cx, cy, w, h):
    H, W = a.shape
    x0, x1 = max(0, int(cx - w / 2)), min(W, int(cx + w / 2) + 1)
    y0, y1 = max(0, int(cy - h / 2)), min(H, int(cy + h / 2) + 1)
    if x1 - x0 < 2 or y1 - y0 < 2:
        return 0.0
    return float(np.abs(a[y0:y1, x0:x1] - b[y0:y1, x0:x1]).mean())


def _faces_in(det, frame, gray, prev):
    """One decoded frame -> [[cx, cy, w, h, score, mouth], ...] in pixels at analysis size."""
    _, found = det.detect(frame)
    out = []
    for f in (found if found is not None else []):
        x, y, w, h = (float(v) for v in f[:4])
        if f[14] < SCORE or w < 8:
            continue
        mouth = 0.0
        if prev is not None:
            (rex, rey, lex, ley), (rmx, rmy, lmx, lmy) = f[4:8], f[10:14]
            mw = max(math.hypot(lmx - rmx, lmy - rmy) * 1.5, 0.35 * w)
            md = _box_diff(gray, prev, (rmx + lmx) / 2, (rmy + lmy) / 2 + 0.06 * mw, mw, 0.55 * mw)
            ed = _box_diff(gray, prev, (rex + lex) / 2, (rey + ley) / 2, max(math.hypot(lex - rex, ley - rey) * 1.4, 0.4 * w), 0.3 * h)
            mouth = max(0.0, md - 0.8 * ed)
        out.append([x + w / 2, y + h / 2, w, h, float(f[14]), mouth])
    return out


class Faces:
    """Face samples for one source video on a fixed 1/FPS grid, decoded only for the ranges asked for and kept in
    jobs/<id>/faces.json, so the short cut, studio previews and re-renders reuse what the long cut found."""
    _open: dict[str, "Faces"] = {}
    _open_lock = threading.Lock()

    @classmethod
    def for_job(cls, video, ffmpeg, path=None):
        key = str(path or video)
        with cls._open_lock:
            if key not in cls._open:
                cls._open[key] = cls(video, ffmpeg, path)
            return cls._open[key]

    def __init__(self, video, ffmpeg, path=None):
        self.video, self.ffmpeg, self.path = str(video), ffmpeg, Path(path) if path else None
        self.lock = threading.Lock()
        self.size = None              # analysis frame (w, h); w / h is the source's display aspect
        self.s: dict[int, dict] = {}
        if self.path and self.path.is_file():
            try:
                d = json.loads(self.path.read_text())
                if d.get("video") == self.video and d.get("fps") == FPS:
                    self.size = tuple(d["size"])
                    self.s = {int(k): v for k, v in d["s"].items()}
            except Exception:  # noqa: BLE001 - a broken cache is just re-analysed
                self.s = {}

    def _measure(self, t):
        r = subprocess.run([self.ffmpeg, "-v", "error", "-ss", f"{t:.3f}", "-i", self.video, "-frames:v", "1",
                            "-vf", f"scale={DET_W}:-2", "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True)
        h = len(r.stdout) // DET_W
        if h < 16:
            raise RuntimeError("couldn't decode a frame for face detection")
        self.size = (DET_W, h)

    def _decode(self, k0, k1, progress=None):
        cv2 = _cv2()
        w, h = self.size
        det = cv2.FaceDetectorYN.create(str(MODEL), "", (w, h), SCORE, 0.3, 50)
        warm = 1 if k0 > 0 else 0          # decode one frame early: mouth motion compares against the previous frame
        t0, n = (k0 - warm) / FPS, k1 - k0 + warm
        cmd = [self.ffmpeg, "-v", "error", "-ss", f"{t0:.3f}", "-i", self.video, "-t", f"{n / FPS + 0.05:.3f}",
               "-vf", f"fps={FPS:g},scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        prev, k, size = None, k0 - warm, w * h * 3
        try:
            while k < k1:
                buf = p.stdout.read(size)
                if len(buf) < size:
                    break
                frame = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.int16)
                cut = prev is not None and float(np.abs(gray[::4, ::4] - prev[::4, ::4]).mean()) > CUT_DIFF
                faces = _faces_in(det, frame, gray, None if cut else prev)
                if k >= k0:
                    self.s[k] = {"c": int(cut), "f": [[round(f[0] / w, 4), round(f[1] / h, 4), round(f[2] / w, 4), round(f[3] / h, 4),
                                                       round(f[4], 3), round(f[5], 2)] for f in faces]}
                prev, k = gray, k + 1
                if progress and k > k0 and (k - k0) % 40 == 0:
                    progress((k - k0) / max(1, n))
        finally:
            p.stdout.close()
            p.kill()
            p.wait()
        for k in range(max(k, k0), k1):    # past the end of the video: nothing there
            self.s[k] = {"c": 0, "f": []}

    def range(self, start, end, progress=None):
        """Samples covering [start, end] as a list of (t, sample)."""
        k0, k1 = max(0, int(math.floor(start * FPS))), int(math.ceil(end * FPS)) + 1
        with self.lock:
            missing = [k for k in range(k0, k1) if k not in self.s]
            if missing:
                if self.size is None:
                    self._measure(start)
                runs, a = [], missing[0]
                for x, y in zip(missing, missing[1:] + [None]):
                    if y != x + 1:
                        runs.append((a, x + 1))
                        a = y
                for a, b in runs:
                    self._decode(a, b, progress)
                self._save()
            return [(k / FPS, self.s[k]) for k in range(k0, k1)]

    def _save(self):
        if not self.path:
            return
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(json.dumps({"video": self.video, "fps": FPS, "size": list(self.size), "s": self.s}, separators=(",", ":")))
        tmp.replace(self.path)

    @property
    def aspect(self):
        return self.size[0] / self.size[1] if self.size else 16 / 9


# ---------------------------------------------------------------- 2. tracks
def tracks(samples, aspect):
    """Link per-frame faces into people. Returns [{i: face}] (sample index -> face), longest first."""
    out, open_ = [], []
    for i, (_, s) in enumerate(samples):
        if s["c"]:
            open_ = []                     # a source camera cut: positions before it say nothing about after
        open_ = [tr for tr in open_ if i - tr["last"] <= FPS * 1.5]
        cand = []
        faces = [f for f in s["f"] if f[3] >= MIN_FACE]
        for fi, f in enumerate(faces):
            for ti, tr in enumerate(open_):
                g = tr["pts"][tr["last"]]
                d = math.hypot((f[0] - g[0]) * aspect, f[1] - g[1]) / max(f[3], g[3])   # distance in face heights
                if d < 0.8 and 0.6 < f[3] / g[3] < 1.6:
                    cand.append((d, fi, ti))
        used_f, used_t = set(), set()
        for d, fi, ti in sorted(cand):
            if fi in used_f or ti in used_t:
                continue
            used_f.add(fi), used_t.add(ti)
            open_[ti]["pts"][i] = faces[fi]
            open_[ti]["last"] = i
        for fi, f in enumerate(faces):
            if fi not in used_f:
                tr = {"pts": {i: f}, "last": i}
                open_.append(tr)
                out.append(tr)
    keep = [tr["pts"] for tr in out if len(tr["pts"]) >= max(4, 0.06 * len(samples))]   # at least half a second on screen
    return sorted(keep, key=len, reverse=True)


def _speech_mask(samples, words):
    ws = sorted((float(w["s"]), float(w["e"])) for w in (words or []))
    mask, j = [], 0
    for t, _ in samples:
        while j < len(ws) and ws[j][1] + 0.25 < t:
            j += 1
        mask.append(j < len(ws) and ws[j][0] - 0.25 <= t)
    return mask


def _activity(trs, n):
    """Mouth movement per person, averaged over ACT_WIN s (frames where they're off screen count as 0)."""
    win = max(1, int(ACT_WIN * FPS))
    A = np.zeros((len(trs), n))
    for ti, pts in enumerate(trs):
        for i, f in pts.items():
            A[ti, i] = f[5]
    if n:
        k = np.ones(win) / win
        A = np.array([np.convolve(a, k, mode="same") for a in A]) if len(trs) else A
    return A


# ---------------------------------------------------------------- 3. speaker
def speakers(samples, trs, words):
    """Which person (index into trs) is on screen at each sample, plus the sample indices where the frame cuts."""
    n = len(samples)
    if not trs:
        return [None] * n, []
    A, talk = _activity(trs, n), _speech_mask(samples, words)
    size = lambda ti, i: trs[ti][i][3] if i in trs[ti] else 0
    cur, since, chal, chal_n, gone = None, 0, None, 0, 0
    active, cuts = [None] * n, []
    for i in range(n):
        present = [ti for ti in range(len(trs)) if i in trs[ti]]
        src_cut = samples[i][1]["c"]
        if cur is not None and cur not in present:
            gone += 1
        else:
            gone = 0
        if present and (cur is None or src_cut or gone > FPS * 0.75):
            # first pick, a camera cut in the source, or the speaker left: whoever talks most in the next 2 s, else the biggest face
            ahead = slice(i, min(n, i + int(2 * FPS)))
            new = max(present, key=lambda ti: (round(float(A[ti, ahead].mean()), 1), size(ti, i)))
            if new != cur and cur is not None:
                cuts.append(i)
            cur, since, chal, chal_n, gone = new, i, None, 0, 0
        elif talk[i] and len(present) > 1 and cur in present:
            best = max(present, key=lambda ti: A[ti, i])
            if best != cur and A[best, i] > 1.4 * A[cur, i] + 0.4:
                chal_n = chal_n + 1 if best == chal else 1
                chal = best
            else:
                chal, chal_n = None, 0
            if chal is not None and chal_n >= SWITCH_HOLD * FPS and i - since >= MIN_SHOT * FPS:
                cur, since, chal, chal_n = chal, i, None, 0
                cuts.append(i)
        active[i] = cur
    return active, cuts


# ---------------------------------------------------------------- 4. camera
def _window(src_aspect, out_aspect):
    """Size of the crop window as a fraction of the source frame when the output fills the frame."""
    return (out_aspect / src_aspect, 1.0) if src_aspect > out_aspect else (1.0, src_aspect / out_aspect)


def _target(f, wh):
    return f[0], f[1] + 0.1 * wh          # face a little above the middle of the window when there's vertical room


def camera(samples, follow, cuts, ww, wh):
    """Keyframes [t, fx, fy] (window centre, 0-1 of the source) for one window following `follow[i]` (a face or None)."""
    pos = [None] * len(samples)
    last = None
    for i, f in enumerate(follow):
        if f is not None:
            last = _target(f, wh)
        pos[i] = last
    first = next((p for p in pos if p is not None), None)
    if first is None:
        return []
    pos = [p or first for p in pos]
    # smooth jitter: median of 5 within each shot
    bounds = [0] + sorted(set(cuts)) + [len(pos)]
    sm = []
    for a, b in zip(bounds, bounds[1:]):
        for i in range(a, b):
            lo, hi = max(a, i - 2), min(b, i + 3)
            sm.append((float(np.median([p[0] for p in pos[lo:hi]])), float(np.median([p[1] for p in pos[lo:hi]]))))
    cutset = set(cuts)
    t0 = samples[0][0]
    cam = sm[0]
    keys = [[t0, *cam]]
    busy = -1.0
    for i in range(1, len(sm)):
        t, tg = samples[i][0], sm[i]
        if i in cutset:
            keys.append([t - 0.001, *cam])
            cam = tg
            keys.append([t, *cam])
            busy = t
        elif t >= busy and (abs(tg[0] - cam[0]) > DEAD * ww or abs(tg[1] - cam[1]) > DEAD * wh):
            if keys[-1][0] < t:
                keys.append([t, *cam])
            cam = tg
            keys.append([t + EASE, *cam])
            busy = t + EASE
    keys.append([max(samples[-1][0], keys[-1][0]), *cam])
    keys = [[round(k[0], 3), round(min(1, max(0, k[1])), 4), round(min(1, max(0, k[2])), 4)] for k in keys]
    while len(keys) > MAX_KEYS:            # very long clips: drop the smallest moves first
        j = min(range(1, len(keys) - 1), key=lambda j: abs(keys[j][1] - keys[j - 1][1]) + abs(keys[j][2] - keys[j - 1][2]))
        del keys[j]
    return keys


def plan(faces: Faces, start, end, words, out_aspect, mode="auto", progress=None):
    """mode 'auto' -> {"mode": "auto", "keys": [[t, fx, fy]...]}; mode 'split' -> {"mode": "split", "panels": [...]}.
    Falls back (auto with one person, 'none' with nobody) and says why in "note"."""
    why = unavailable()
    if why:
        return {"mode": "none", "note": f"Face reframing is off: {why}. Used a centred crop."}
    samples = faces.range(start, end, progress)
    sa = faces.aspect
    trs = tracks(samples, sa)
    words = [w for w in (words or []) if start - 1 <= float(w["s"]) <= end + 1]
    base = {"aspect": round(sa, 4), "faces": len(trs), "start": round(start, 3), "end": round(end, 3)}
    if not trs:
        return dict(base, mode="none", note="No faces found, so the crop stays centred.")
    if mode == "split":
        # the two people on screen longest, in reading order (left one on top)
        both = [tr for tr in trs[:3] if len(tr) >= 0.3 * len(samples)][:2]
        if len(both) == 2:
            both.sort(key=lambda tr: float(np.median([f[0] for f in tr.values()])))
            stacked = out_aspect < 1.2
            pa = out_aspect * (2 if stacked else 0.5)          # each panel's aspect (w / h)
            panels = []
            for tr in both:
                fh = float(np.median([f[3] for f in tr.values()]))
                rh = min(1.0, max(0.35, fh / FACE_IN_PANEL))   # panel height as a fraction of the source height
                rw = rh * pa / sa                              # ... and width as a fraction of the source width
                if rw > 1:
                    rw, rh = 1.0, sa / pa
                follow = [tr.get(i) for i in range(len(samples))]
                keys = camera(samples, follow, [i for i, (_, s) in enumerate(samples) if s["c"]], rw, rh)
                panels.append({"keys": keys, "rw": round(rw, 4), "rh": round(rh, 4)})
            return dict(base, mode="split", stack="v" if stacked else "h", panels=panels)
        base["note"] = "Only one person is on screen most of the time, so it follows them instead of splitting."
    ww, wh = _window(sa, out_aspect)
    active, cuts = speakers(samples, trs, words)
    follow = [trs[a].get(i) if a is not None else None for i, a in enumerate(active)]
    src_cuts = [i for i, (_, s) in enumerate(samples) if s["c"]]
    keys = camera(samples, follow, sorted(set(cuts) | set(src_cuts)), ww, wh)
    return dict(base, mode="auto", keys=keys, switches=len(cuts))


# ---------------------------------------------------------------- render helpers
def _num(v):
    return f"{v:.4f}".rstrip("0").rstrip(".") or "0"


def expr(keys, col, to_out):
    """ffmpeg expression in output time t for column col (1 = fx, 2 = fy) of keys, eased with smoothstep.
    to_out maps source seconds to output seconds (after the cut list)."""
    pts = []
    for k in keys:
        t = to_out(k[0])
        if pts and t < pts[-1][0]:
            t = pts[-1][0]
        pts.append((t, k[col]))
    if not pts:
        return "0.5"
    e = _num(pts[-1][1])
    for (t0, a), (t1, b) in reversed(list(zip(pts, pts[1:]))):
        d = t1 - t0
        if d < 0.01 or abs(b - a) < 1e-4:
            seg = _num(a)
        else:
            u = f"clip((t-{_num(t0)})/{_num(d)},0,1)"
            seg = f"({_num(a)}+{_num(b - a)}*{u}*{u}*(3-2*{u}))"
        e = f"if(lt(t,{_num(t1)}),{seg},{e})"
    return f"if(lt(t,{_num(pts[0][0])}),{_num(pts[0][1])},{e})"


def at(keys, t):
    """Window centre (fx, fy) at source time t (same easing as expr). Used by tests and the server."""
    if not keys:
        return 0.5, 0.5
    if t <= keys[0][0]:
        return keys[0][1], keys[0][2]
    for a, b in zip(keys, keys[1:]):
        if t < b[0]:
            d = b[0] - a[0]
            if d < 0.01:
                return a[1], a[2]
            u = min(1, max(0, (t - a[0]) / d))
            s = u * u * (3 - 2 * u)
            return a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s
    return keys[-1][1], keys[-1][2]
