// Speech-to-text worker: Whisper running in the browser (transformers.js). Audio never leaves the device.
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

env.allowLocalModels = false;
let asr = null, loadedModel = null, device = "wasm";

async function load(model) {
  const progress_callback = p => {
    if (p.status === "progress" && p.total) self.postMessage({ type: "load", file: p.file, loaded: p.loaded, total: p.total });
  };
  const tryDevice = async dev => pipeline("automatic-speech-recognition", model,
    // GPU: full-precision encoder (needed for accurate timings) + 4-bit decoder keeps the download small
    { device: dev, dtype: dev === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8", progress_callback });
  device = "wasm";
  if (self.navigator && navigator.gpu) {
    try { if (await navigator.gpu.requestAdapter()) device = "webgpu"; } catch {}
  }
  try { asr = await tryDevice(device); }
  catch (e) { if (device !== "webgpu") throw e; device = "wasm"; asr = await tryDevice("wasm"); }
  loadedModel = model;
  self.postMessage({ type: "device", device });
}

self.onmessage = async ({ data }) => {
  const { audio, windows, model } = data;   // audio: Float32Array @16 kHz; windows: [[s,e], ...] in seconds
  try {
    if (!asr || loadedModel !== model) await load(model);
    const words = [];
    for (let i = 0; i < windows.length; i++) {
      const [s, e] = windows[i];
      const slice = audio.subarray(Math.floor(s * 16000), Math.floor(e * 16000));
      let out;
      try {
        out = await asr(slice, { return_timestamps: "word", chunk_length_s: 30 });
      } catch (err) {
        if (device !== "webgpu") throw err;
        await (async () => { device = "wasm"; asr = await pipeline("automatic-speech-recognition", model, { device: "wasm", dtype: "q8" }); })();
        self.postMessage({ type: "device", device });
        out = await asr(slice, { return_timestamps: "word", chunk_length_s: 30 });
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
