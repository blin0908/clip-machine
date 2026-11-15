// Cross-browser stress test for the browser app (docs/). Runs the real pipeline (ffmpeg.wasm + Whisper)
// in Chromium, WebKit (Safari's engine) and Firefox, on desktop and phone viewports.
//
//   cd tests && npm install && npx playwright install chromium webkit firefox
//   node web-stress.mjs                       # every browser, every case
//   node web-stress.mjs webkit tiny editor    # only cases/browsers whose name contains any of these words
//   BROWSER=firefox-desktop node web-stress.mjs talk corrupt   # chosen cases in one browser
//
// Needs tests/media/ (zsh make_media.sh). Downloads the Whisper tiny model and ffmpeg core on first run.
import { chromium, webkit, firefox, devices } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir, rm } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DOCS = resolve(HERE, "../docs"), MEDIA = resolve(HERE, "media"), PROFILES = resolve(HERE, "web-out/profiles");
const want = process.argv.slice(2);
const pick = name => !want.length || want.some(w => name.includes(w));

// ---- tiny static server (correct MIME types for modules + wasm)
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".wasm": "application/wasm", ".css": "text/css", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".png": "image/png", ".mp4": "video/mp4", ".webmanifest": "application/manifest+json" };
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const f = join(DOCS, p.endsWith("/") ? p + "index.html" : p);
  if (!f.startsWith(DOCS)) { res.writeHead(403).end(); return; }
  try { const b = await readFile(f); res.writeHead(200, { "Content-Type": MIME[extname(f)] || "application/octet-stream" }).end(b); }
  catch { res.writeHead(404).end("not found"); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

// ---- cases: expect "clips" (≥1 clip, every hard check passed) or an error message containing a phrase
const PRESET = "?model=Xenova/whisper-tiny.en&n=1";
const CASES = [
  { name: "tiny 6s",          file: "tiny.mp4",          q: "&version=short&platform=tiktok", expect: "clips" },
  { name: "talk short+long",  file: "talk_720p.mp4",     q: "&version=both&platform=reels",   expect: "clips", editor: true },
  { name: "talk 80s",         file: "talk_80s.mp4",      q: "&version=short&platform=tiktok", expect: "clips" },
  { name: "portrait crop",    file: "portrait.mp4",      q: "&version=short&layout=crop&style=boxed", expect: "clips" },
  { name: "odd low-res",      file: "odd_lowres.mp4",    q: "&version=short&style=clean",     expect: "clips" },
  { name: "audio only",       file: "audio_only.m4a",    q: "&version=short",                 expect: "clips" },
  { name: "unicode name",     file: "my clip (final) #1 ünïcode's.mov", q: "&version=short",  expect: "clips" },
  { name: "silent",           file: "silent.mp4",        q: "",                               expect: "silent" },
  { name: "no audio",         file: "no_audio.mp4",      q: "",                               expect: "no audio" },
  { name: "corrupt",          file: "corrupt.mp4",       q: "",                               expect: "couldn't read" },
];
const BROWSERS = [
  { name: "chrome-desktop",   type: chromium, ctx: { channel: "chrome", viewport: { width: 1280, height: 900 } } },  // real Chrome (Playwright's Chromium has no H.264)
  { name: "webkit-desktop",   type: webkit,   ctx: { viewport: { width: 1280, height: 900 } } },
  { name: "firefox-desktop",  type: firefox,  ctx: { viewport: { width: 1280, height: 900 } } },
  { name: "webkit-iphone",    type: webkit,   ctx: devices["iPhone 13"], phone: true },
  { name: "chrome-android",   type: chromium, ctx: { ...devices["Pixel 7"], channel: "chrome" }, phone: true },
];
const PHONE_CASES = ["tiny 6s", "corrupt"];        // phones: one full run + one error path (layout is what differs)

const rows = [];
const log = (status, b, c, dt, detail) => { rows.push({ status, b, c }); console.log(`${status.padEnd(4)} ${b.padEnd(17)} ${c.padEnd(16)} ${dt.toFixed(0).padStart(4)}s  ${detail}`); };

async function waitDone(page, timeoutMs) {
  // done = an error card, a "no moment" card, or results with the progress bar hidden; a crashed tab fails fast
  const crashed = new Promise((_, bad) => page.once("crash", () => bad(new Error("the browser tab crashed (likely out of memory)"))));
  const tick = process.env.VERBOSE ? setInterval(async () => console.log("   …", (await page.locator("#prog").textContent().catch(() => "")).replace(/\s+/g, " ").slice(0, 90)), 30000) : null;
  try { await Promise.race([crashed, waitDoneInner(page, timeoutMs)]); } finally { clearInterval(tick); }
}
async function waitDoneInner(page, timeoutMs) {
  await page.waitForFunction(() => {
    const prog = document.querySelector("#prog");
    return document.querySelector("#out .card.err, #out .card.msg") || (document.querySelectorAll("#out .clip").length && prog?.classList.contains("hide"));
  }, null, { timeout: timeoutMs, polling: 1000 });
}

async function checkClips(page) {
  return page.evaluate(async () => {
    const out = [];
    for (const art of document.querySelectorAll("#out .clip")) {
      const v = art.querySelector("video");
      const meta = await new Promise(res => {
        if (v.readyState >= 1) return res({ w: v.videoWidth, h: v.videoHeight, d: v.duration });
        const t = setTimeout(() => res({ w: 0, h: 0, d: 0, err: "no metadata (codec unsupported in this browser build?)" }), 8000);
        v.addEventListener("loadedmetadata", () => { clearTimeout(t); res({ w: v.videoWidth, h: v.videoHeight, d: v.duration }); }, { once: true });
        v.addEventListener("error", () => { clearTimeout(t); res({ w: 0, h: 0, d: 0, err: "video error " + (v.error?.code ?? "") }); }, { once: true });
        v.preload = "metadata"; v.load();
      });
      const size = await fetch(v.src).then(r => r.blob()).then(b => b.size).catch(() => 0);
      const hardFails = [...art.querySelectorAll(".qc li.no")].map(li => li.textContent.trim().slice(0, 60));
      const badge = art.querySelector(".qbadge")?.textContent.trim();
      out.push({ meta, size, badge, hardFails, title: art.querySelector(".ttl")?.textContent.trim() });
    }
    return out;
  });
}

async function runEditor(page) {
  // open the editor on the first clip, trim the end one word earlier, fix a caption, switch style, re-render
  const art = page.locator("#out .clip").first();
  await art.locator("[data-edit]").click();
  await art.locator(".editor:not(.hide)").waitFor({ timeout: 10000 });
  const before = await art.locator(".editor label.t").nth(1).textContent();
  await art.locator('[data-nudge="end:-1"]').click();
  const after = await art.locator(".editor label.t").nth(1).textContent();
  const line = art.locator(".ed-line").first();
  if (await line.count()) await line.fill((await line.inputValue()).toUpperCase());
  await art.locator('[data-estyle="boxed"]').click();
  const oldSrc = await art.locator("video").getAttribute("src");
  await art.locator("[data-rerender]").click();
  await page.waitForFunction(old => { const v = document.querySelector("#out .clip video"); const st = document.querySelector("#out .clip .ed-status");
    return (v && v.getAttribute("src") !== old) || (st && st.textContent.includes("⚠")); }, oldSrc, { timeout: 900000, polling: 1000 });
  const status = await page.locator("#out .clip .ed-status").first().textContent().catch(() => "");
  const newSrc = await page.locator("#out .clip video").first().getAttribute("src");
  return { trimmed: before !== after, replaced: newSrc !== oldSrc, status: (status || "").trim() };
}

async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

for (const B of BROWSERS) {
  if (process.env.BROWSER && !process.env.BROWSER.split(",").includes(B.name)) continue;   // e.g. BROWSER=firefox-desktop node web-stress.mjs talk
  const offline = B.name === "chrome-desktop" && pick("offline");
  const cases = CASES.filter(c => (!B.phone || PHONE_CASES.includes(c.name)) && (pick(B.name) || pick(c.name)));
  if (!cases.length && !offline) continue;
  await mkdir(PROFILES, { recursive: true });
  let ctx, browser = null;
  try {
    if (B.type === webkit) {   // WebKit's persistent-profile mode fails on recent macOS; one context keeps the model cache for the run
      const { channel, ...rest } = B.ctx;
      browser = await webkit.launch({ headless: true }); ctx = await browser.newContext(rest);
    } else ctx = await B.type.launchPersistentContext(join(PROFILES, B.name), { headless: true, ...B.ctx });
  } catch (e) { log("SKIP", B.name, "-", 0, "browser failed to start: " + e.message.split("\n")[0]); continue; }
  for (const C of cases) {
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push("pageerror: " + e.message));
    page.on("console", m => { if (m.type() === "error" && !/favicon|Failed to load resource.*404/.test(m.text())) errors.push(m.text().slice(0, 160)); });
    const t0 = Date.now();
    try {
      await page.goto(BASE + PRESET + C.q, { waitUntil: "load" });
      await page.waitForFunction(() => document.querySelector("#go"), null, { timeout: 30000 });
      const layoutOk = await noHorizontalScroll(page);
      await page.setInputFiles("#file", join(MEDIA, C.file));
      await page.click("#go");
      await waitDone(page, C.file.includes("talk") || C.file.includes("unicode") || C.file.includes("audio_only") ? 1800000 : 900000);
      const dt = (Date.now() - t0) / 1000;
      const err = await page.locator("#out .card.err, #out .card.msg").first().textContent().catch(() => null);
      if (C.expect !== "clips") {
        const ok = err && err.toLowerCase().includes(C.expect);
        log(ok ? "PASS" : "FAIL", B.name, C.name, dt, ok ? "clean error: " + err.trim().slice(0, 80) : "expected error '" + C.expect + "', got: " + (err || "clips").slice(0, 120));
      } else if (err && B.type === webkit && /ran out of memory/.test(err)) {
        log("WARN", B.name, C.name, dt, "known WebKit memory limit, clean message shown: " + err.trim().slice(0, 90));
      } else if (err) {
        log("FAIL", B.name, C.name, dt, "error: " + err.trim().slice(0, 200));
      } else {
        const clips = await checkClips(page);
        const probs = [];
        for (const c of clips) {
          if (c.hardFails.length) probs.push("checks failed: " + c.hardFails.join("; "));
          if (c.size < 20000) probs.push("tiny output " + c.size + " B");
          if (c.meta.err) probs.push("playback: " + c.meta.err);
          else if (!(c.meta.h > c.meta.w && c.meta.d > 1)) probs.push(`bad video ${c.meta.w}x${c.meta.h} ${c.meta.d}s`);
        }
        if (!layoutOk) probs.push("page scrolls sideways");
        let ed = "";
        if (C.editor && !B.phone) {
          const r = await runEditor(page);
          ed = ` · editor: trim ${r.trimmed ? "✓" : "✗"}, re-render ${r.replaced ? "✓" : "✗"}${r.status ? " (" + r.status.slice(0, 60) + ")" : ""}`;
          if (!r.trimmed || !r.replaced) probs.push("editor failed");
        }
        const playbackOnly = probs.length && probs.every(p => p.startsWith("playback"));
        log(probs.length ? (playbackOnly ? "WARN" : "FAIL") : "PASS", B.name, C.name, (Date.now() - t0) / 1000,
          `${clips.length} clip(s), ${clips.map(c => `${c.meta.w}x${c.meta.h} ${c.meta.d?.toFixed?.(1)}s ${(c.size / 1e6).toFixed(1)}MB ${c.badge}`).join(" | ")}${ed}` +
          probs.map(p => "\n       ✗ " + p).join(""));
      }
      const card = (await page.locator("#out .card.err").first().textContent().catch(() => "")) || "";
      const real = errors.filter(e => !/WebGPU|webgpu|onnxruntime|No available adapters|powerPreference/.test(e) && !(card && card.includes(e.replace(/^Error: /, "").split("\n")[0])));
      if (real.length) console.log("       console:", real.slice(0, 3).join(" || "));
    } catch (e) {
      const shot = join(HERE, "web-out", `${B.name}-${C.name.replace(/\W+/g, "_")}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      const stage = await page.locator("#prog").textContent().catch(() => "");
      log("FAIL", B.name, C.name, (Date.now() - t0) / 1000, "timeout/crash: " + e.message.split("\n")[0] + " | stage: " + stage.replace(/\s+/g, " ").slice(0, 100) + (errors.length ? "\n       console: " + errors.slice(-3).join(" || ") : ""));
    }
    await page.close();
  }
  if (offline) {
    // offline: after one online visit, the app shell, ffmpeg core (service worker) and model (transformers.js cache) are local
    const t0 = Date.now(), page = await ctx.newPage();
    try {
      await page.goto(BASE + PRESET + "&version=short", { waitUntil: "load" });
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.reload({ waitUntil: "load" });                       // now controlled: core fetches go through the cache
      await page.setInputFiles("#file", join(MEDIA, "tiny.mp4")); await page.click("#go"); await waitDone(page, 420000);
      await ctx.setOffline(true);
      await page.reload({ waitUntil: "load" });
      await page.setInputFiles("#file", join(MEDIA, "tiny.mp4")); await page.click("#go"); await waitDone(page, 420000);
      const err = await page.locator("#out .card.err").first().textContent().catch(() => null);
      const n = await page.locator("#out .clip").count();
      log(err || !n ? "FAIL" : "PASS", B.name, "offline rerun", (Date.now() - t0) / 1000, err ? "error: " + err.slice(0, 150) : `${n} clip(s) made with the network off`);
    } catch (e) { log("FAIL", B.name, "offline rerun", (Date.now() - t0) / 1000, e.message.split("\n")[0]); }
    await ctx.setOffline(false); await page.close();
  }
  await ctx.close(); await browser?.close();
}
server.close();
const fails = rows.filter(r => r.status === "FAIL");
console.log(`\n${rows.filter(r => r.status === "PASS").length} pass, ${rows.filter(r => r.status === "WARN").length} warn, ${fails.length} fail, ${rows.filter(r => r.status === "SKIP").length} skipped`);
process.exit(fails.length ? 1 : 0);
