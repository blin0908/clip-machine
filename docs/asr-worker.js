// Speech-to-text worker: Whisper running in the browser (transformers.js). Audio never leaves the device.
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

env.allowLocalModels = false;
let asr = null, loadedModel = null, device = "wasm", announce = false;   // announce: a run is waiting, so report progress

async function load(model, cfg) {           // cfg: optional { device, dtype } override, used by the speed tests
  const progress_callback = p => {
    if (announce && p.status === "progress" && p.total) self.postMessage({ type: "load", file: p.file, loaded: p.loaded, total: p.total });
  };
  const tryDevice = async dev => pipeline("automatic-speech-recognition", model,
    // GPU: full-precision encoder (needed for accurate timings) + 4-bit decoder keeps the download small
    { device: dev, dtype: cfg?.dtype ?? (dev === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8"), progress_callback });
  device = "wasm";
  if (cfg?.device) device = cfg.device;
  else if (self.navigator && navigator.gpu) {
    try { if (await navigator.gpu.requestAdapter()) device = "webgpu"; } catch {}
  }
  try { asr = await tryDevice(device); }
  catch (e) { if (device !== "webgpu") throw e; device = "wasm"; asr = await tryDevice("wasm"); }
  loadedModel = model + JSON.stringify(cfg || null);
}

let pending = null, pendingKey = null;       // one load at a time: a run that arrives mid-preload waits for it
async function ensure(model, cfg) {
  const key = model + JSON.stringify(cfg || null);
  if (asr && loadedModel === key) return;
  if (pending && pendingKey === key) return pending;
  if (pending) await pending.catch(() => {});
  if (asr && loadedModel === key) return;
  pendingKey = key; pending = load(model, cfg);
  try { await pending; } finally { pending = null; pendingKey = null; }
}
self.onmessage = async ({ data }) => {
  if (data.type === "preload") {             // warm the model while the user is still choosing settings
    try { await ensure(data.model); } catch {}
    return;
  }
  const { audio, windows, model, cfg, language } = data;
  // multilingual models need the language spelled out: without it transformers.js assumes English
  const lang = language && language !== "auto" && !/\.en$/.test(model) ? { language, task: "transcribe" } : {};   // audio: Float32Array @16 kHz; windows: [[s,e], ...] in seconds
  try {
    announce = true;
    try { await ensure(model, cfg); } finally { announce = false; }
    self.postMessage({ type: "device", device });
    const words = [];
    for (let i = 0; i < windows.length; i++) {
      const [s, e] = windows[i];
      const slice = audio.subarray(Math.floor(s * 16000), Math.floor(e * 16000));
      let out;
      try {
        out = await asr(slice, { return_timestamps: "word", chunk_length_s: 30, ...lang });
      } catch (err) {
        if (device !== "webgpu") throw err;
        await (async () => { device = "wasm"; asr = await pipeline("automatic-speech-recognition", model, { device: "wasm", dtype: "q8" }); })();
        self.postMessage({ type: "device", device });
        out = await asr(slice, { return_timestamps: "word", chunk_length_s: 30, ...lang });
      }
      for (const c of out.chunks || []) {
        const w = (c.text || "").trim();
        if (!w) continue;
        const ws = (c.timestamp?.[0] ?? 0) + s;
        const we = (c.timestamp?.[1] ?? (c.timestamp?.[0] ?? 0) + 0.3) + s;
        words.push({ w, s: ws, e: Math.max(we, ws + 0.05) });
      }
      self.postMessage({ type: "progress", done: i + 1, total: windows.length, upto: e });
    }
    self.postMessage({ type: "done", words });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err?.message || err) });
  }
};
