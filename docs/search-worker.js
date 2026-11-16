// Find-by-description worker: a multilingual sentence-embedding model running in the browser (transformers.js).
// The transcript never leaves the device. The model file is cached by transformers.js, like Whisper.
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

env.allowLocalModels = false;
// Same weights as the desktop app (search.py): pinned so both apps rank the same windows.
const MODEL = "Xenova/multilingual-e5-small", REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
let embed = null, loading = null, announce = false;

function load() {
  return loading ||= pipeline("feature-extraction", MODEL, {
    revision: REVISION, dtype: "q8", device: "wasm",       // 8-bit on the CPU: 118 MB, and what the desktop app runs
    progress_callback: p => { if (announce && p.status === "progress" && p.total) self.postMessage({ type: "load", file: p.file, loaded: p.loaded, total: p.total }); },
  }).then(e => (embed = e)).catch(err => { loading = null; throw err; });
}

self.onmessage = async ({ data }) => {
  const { id, texts } = data;              // texts: already prefixed with "query: " / "passage: "
  try {
    announce = true;
    try { await load(); } finally { announce = false; }
    // One text per run, as in search.py: the 8-bit model quantizes activations per batch, so batching would shift
    // each vector by up to 0.02 depending on its neighbours. Alone, both apps get the same vector (to 1e-7).
    const out = [], B = 1;
    for (let b = 0; b < texts.length; b += B) {
      const t = await embed(texts.slice(b, b + B), { pooling: "mean", normalize: true });
      const [n, d] = t.dims;
      for (let r = 0; r < n; r++) out.push(t.data.slice(r * d, (r + 1) * d));
      self.postMessage({ type: "progress", id, done: Math.min(b + B, texts.length), total: texts.length });
    }
    self.postMessage({ type: "done", id, vectors: out });
  } catch (err) {
    self.postMessage({ type: "error", id, message: String(err?.message || err) });
  }
};
