// node harness/asr-bench.mjs  → times speech-model settings in headless Chrome (real GPU on Macs)
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = fileURLToPath(new URL(".", import.meta.url)), ROOT = resolve(HERE, "../..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".wav": "audio/wav" };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const f = p.startsWith("/docs/") ? join(ROOT, p) : p.startsWith("/media/") ? join(ROOT, "tests", p) : join(HERE, p === "/" ? "asr.html" : p);
  try { const b = await readFile(f); res.writeHead(200, { "Content-Type": MIME[extname(f)] || "application/octet-stream" }).end(b); } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const ctx = await chromium.launchPersistentContext(resolve(HERE, "../web-out/profiles/bench-chrome"), { channel: "chrome", headless: true });
const page = ctx.pages()[0];
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(() => window.runASR);
const SECS = +(process.env.SECS || 60);
const CASES = JSON.parse(process.env.CASES || "null") || [
  ["base gpu fp32+q4 (now)", "Xenova/whisper-base.en", { device: "webgpu", dtype: { encoder_model: "fp32", decoder_model_merged: "q4" } }],
  ["base gpu fp32+fp32",     "Xenova/whisper-base.en", { device: "webgpu", dtype: { encoder_model: "fp32", decoder_model_merged: "fp32" } }],
  ["base gpu fp16",          "Xenova/whisper-base.en", { device: "webgpu", dtype: "fp16" }],
  ["base cpu q8",            "Xenova/whisper-base.en", { device: "wasm", dtype: "q8" }],
  ["tiny gpu fp32+q4 (now)", "Xenova/whisper-tiny.en", { device: "webgpu", dtype: { encoder_model: "fp32", decoder_model_merged: "q4" } }],
];
for (const [name, model, cfg] of CASES) {
  try {
    const r = await page.evaluate(a => window.runASR(a), { model, cfg, seconds: SECS, runs: 2 });
    for (const [i, x] of r.entries()) console.log(`${(name + (i ? " (2nd run)" : "")).padEnd(34)} load ${(x.load / 1e3).toFixed(1)}s  first ${(x.first / 1e3).toFixed(1)}s  total ${(x.total / 1e3).toFixed(1)}s for ${x.audio}s audio  ${x.words} words  [${x.times}]`);
    console.log("   ", r[0].text);
  } catch (e) { console.log(`${name.padEnd(34)} FAILED ${String(e.message).slice(0, 150)}`); }
}
await ctx.close(); server.close();
