"""Find clips by description: rank sentence-aligned windows of a transcript against a typed query.

Runs on this computer. The model is the same file the website runs in its search worker (docs/search-worker.js):
Xenova/multilingual-e5-small, 8-bit ONNX, pinned to one revision, so both apps rank the same windows. It needs no
extra packages: onnxruntime, tokenizers and huggingface_hub already come with faster-whisper. The windows, scores
and picks mirror docs/search.js line for line (checked by tests/search_parity.py).
"""
import math
import threading

from clipper import SENT_END, join_words, _units

MODEL = "Xenova/multilingual-e5-small"
REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78"   # pinned: both engines must load the exact same weights
ONNX_FILE = "onnx/model_quantized.onnx"                    # 118 MB; what transformers.js loads for dtype "q8"
MAX_TOKENS = 512

# Windows: grow from each sentence until it lasts WIN_MIN s, never past WIN_MAX s (one long sentence still counts).
WIN_MIN, WIN_MAX = 15.0, 40.0
# e5 scores every pair of texts 0.70-0.90, so "good enough" is judged two ways at once: how close the best window is
# (top) and how far it stands out from this video's typical window (top - median). Calibrated on a 4-topic talk in
# English, Spanish and Japanese with queries in all three (tests/search_parity.py): on-topic queries scored >= 0.839
# except one cross-language query (0.832), off-topic ones <= 0.824 except "how to fix a flat bike tyre", which
# matched an English cooking tip ("the trick is...", 0.843). Further picks stay within PICK_SPREAD of the best one.
MIN_TOP, MIN_MATCH, PICK_SPREAD = 0.79, 0.835, 0.03


def segments_from_words(words):
    """Group word timestamps into sentence-ish segments. Mirrors segmentsFromWords in formula.js."""
    segs, cur = [], []

    def flush():
        if cur:
            segs.append({"s": cur[0]["s"], "e": cur[-1]["e"], "text": join_words([w["w"] for w in cur]), "words": list(cur)})
            cur.clear()
    for w in words:
        if cur and (w["s"] - cur[-1]["e"] > 1.0 or w["s"] - cur[0]["s"] > 12):
            flush()
        cur.append(w)
        if SENT_END.search(w["w"]):
            flush()
    flush()
    return segs


def windows(words, duration):
    """One window per sentence: it and the sentences after it, up to WIN_MIN..WIN_MAX seconds of speech.
    Each window snaps to speech like a scored moment does. Mirrors searchWindows in search.js."""
    units = _units(segments_from_words(words), duration)
    out = []
    for i in range(len(units)):
        j = i
        while j + 1 < len(units) and units[j]["e"] - units[i]["s"] < WIN_MIN and units[j + 1]["e"] - units[i]["s"] <= WIN_MAX:
            j += 1
        ws = [w for u in units[i:j + 1] for w in u["words"]]
        if not ws:
            continue
        text = " ".join(u["text"] for u in units[i:j + 1]).strip()
        out.append({"start": round(max(0.0, ws[0]["s"] - 0.12), 2), "end": round(min(duration, ws[-1]["e"] + 0.35), 2), "text": text})
    full = [w for w in out if w["end"] - w["start"] >= WIN_MIN / 2]     # the last few sentences make stubs: drop them
    return full or out


def median(xs):
    xs = sorted(xs)
    h = len(xs) // 2
    return xs[h] if len(xs) % 2 else (xs[h - 1] + xs[h]) / 2


def match_strength(scores):
    """How well the best window matches, judged against the rest of the video. Mirrors matchStrength in search.js."""
    top = max(scores)
    return top + (top - median(scores))


def pick(wins, scores, n):
    """Best windows first, no two overlapping (2 s apart, like the scored moments), all within PICK_SPREAD of the best.
    Empty when even the best is not a good enough match. Mirrors pickMatches in search.js."""
    if not scores or max(scores) < MIN_TOP or match_strength(scores) < MIN_MATCH:
        return []
    order = sorted(range(len(wins)), key=lambda k: (-scores[k], k))
    best, out = scores[order[0]], []
    for k in order:
        if scores[k] < best - PICK_SPREAD or len(out) >= n:
            break
        w = wins[k]
        if any(not (w["end"] + 2 <= m["start"] or w["start"] >= m["end"] + 2) for m in out):
            continue
        out.append({**w, "score": round(float(scores[k]), 4)})
    return out


class Embedder:
    """The e5 model on onnxruntime: mean-pooled, normalised sentence vectors (what the web worker's
    feature-extraction pipeline returns with pooling "mean", normalize true)."""

    def __init__(self, progress=None):
        import numpy as np
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        from tokenizers import Tokenizer
        if progress:
            progress("Loading the search model (about 120 MB the first time)")
        get = lambda f: hf_hub_download(MODEL, f, revision=REVISION)
        self.tok = Tokenizer.from_file(get("tokenizer.json"))
        self.tok.enable_truncation(MAX_TOKENS)
        self.tok.no_padding()
        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        # Basic graph fusions only: the extended ones (fused int8 matmuls) round differently from the browser's
        # build and roughly double the score gap between the two apps (see tests/web-find.mjs).
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
        self.sess = ort.InferenceSession(get(ONNX_FILE), opts, providers=["CPUExecutionProvider"])
        self.inputs = {i.name for i in self.sess.get_inputs()}
        self.np = np

    def embed(self, texts, batch=1):
        # One text per run, on purpose: the 8-bit model quantizes activations per batch, so batching (and the
        # padding it adds) shifts every vector by up to 0.02. Alone, each text gets the same vector here and in
        # the browser (to 1e-7), whatever else is in the transcript.
        np, out = self.np, []
        for b in range(0, len(texts), batch):
            enc = self.tok.encode_batch(texts[b:b + batch])
            L = max(len(e.ids) for e in enc)
            ids = np.full((len(enc), L), 1, dtype=np.int64)      # XLM-R pad token
            mask = np.zeros((len(enc), L), dtype=np.int64)
            for r, e in enumerate(enc):
                ids[r, :len(e.ids)] = e.ids
                mask[r, :len(e.ids)] = 1
            feed = {"input_ids": ids, "attention_mask": mask}
            if "token_type_ids" in self.inputs:
                feed["token_type_ids"] = np.zeros_like(ids)
            h = self.sess.run(None, feed)[0]                     # last_hidden_state (B, L, 384)
            m = mask[:, :, None].astype(np.float32)
            v = (h * m).sum(1) / np.maximum(m.sum(1), 1e-9)
            v /= np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-12)
            out.append(v)
        return np.concatenate(out) if out else np.zeros((0, 384), dtype=np.float32)


def is_cached():
    """True once the model files are on this computer (the first search downloads them)."""
    if _model is not None:
        return True
    try:
        from huggingface_hub import try_to_load_from_cache
        return all(isinstance(try_to_load_from_cache(MODEL, f, revision=REVISION), str) for f in ("tokenizer.json", ONNX_FILE))
    except Exception:
        return False


_model, _lock = None, threading.Lock()


def model(progress=None):
    global _model
    with _lock:
        if _model is None:
            _model = Embedder(progress)
        return _model


def clean_query(q):
    """Mirrors cleanQuery in search.js."""
    return " ".join(str(q or "").split())[:200]


def search(words, duration, query, n=3, progress=None):
    """The best-matching windows for query, best first: [{start, end, text, score}]. Empty when nothing is close."""
    query = clean_query(query)
    if not query or not words:
        return []
    if not duration or not math.isfinite(duration):
        duration = max(w["e"] for w in words)
    wins = windows(words, duration)
    if not wins:
        return []
    m = model(progress)
    # e5 is trained with these prefixes: a short query against longer passages
    v = m.embed(["query: " + query] + ["passage: " + w["text"] for w in wins])
    scores = (v[1:] @ v[0]).tolist()
    return pick(wins, scores, n)


def scored_windows(words, duration, query):
    """Every window with its score, in video order (the page picks from these too, and the parity test compares them)."""
    query = clean_query(query)
    wins = windows(words, duration)
    if not wins:
        return []
    v = model().embed(["query: " + query] + ["passage: " + w["text"] for w in wins])
    return [{**w, "score": float(s)} for w, s in zip(wins, (v[1:] @ v[0]).tolist())]
