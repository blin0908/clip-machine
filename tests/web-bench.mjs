// Time each stage of the browser app on one video with the app's DEFAULT settings (unlike web-stress, which
// uses the tiny model and one clip to stay fast).
//   node web-bench.mjs [file in tests/media] [extra query, e.g. "&n=1"]
// Prints window.__perf rows (ms per stage) and the total. Real Chrome; reuses a profile so models stay cached.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DOCS = resolve(process.env.DOCS || resolve(HERE, "../docs")), MEDIA = resolve(HERE, "media");
const file = process.argv[2] || "talk_720p.mp4", q = process.argv[3] || "";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".png": "image/png", ".woff2": "font/woff2" };
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname), f = join(DOCS, p.endsWith("/") ? p + "index.html" : p);
  if (!f.startsWith(DOCS)) return res.writeHead(403).end();
  try { const b = await readFile(f); res.writeHead(200, { "Content-Type": MIME[extname(f)] || "application/octet-stream" }).end(b); } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const ctx = await chromium.launchPersistentContext(resolve(HERE, "web-out/profiles/bench-chrome"), { channel: "chrome", headless: true, viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || await ctx.newPage();
page.on("console", m => { if (m.type() === "error" && !/onnxruntime/.test(m.text())) console.log("console:", m.text().slice(0, 200)); });
await page.goto(`http://127.0.0.1:${server.address().port}/?${q.replace(/^&/, "")}`);
await page.waitForFunction(() => window.X || document.querySelector("#go"));
await page.setInputFiles("#file", join(MEDIA, file));
const t0 = Date.now();
await page.click("#go");
const tick = setInterval(async () => {
  const txt = (await page.locator("#prog").textContent().catch(() => "")).replace(/\s+/g, " ").replace("Cancel", "").trim();
  const laps = (await page.evaluate(() => (window.__perf || []).map(r => `${r.k} ${(r.ms / 1000).toFixed(0)}s`).join(" · ")).catch(() => ""));
  console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(5)}s  ${txt.slice(0, 80)}  [${laps}]`);
}, 15000);
await page.waitForFunction(() => !document.querySelector("#setup").classList.contains("busy") && (document.querySelector(".clip") || document.querySelector(".err") || document.querySelector("#out .msg")), null, { timeout: 1800000, polling: 1000 });
clearInterval(tick);
const total = (Date.now() - t0) / 1000;
const rows = await page.evaluate(() => window.__perf);
const err = await page.locator(".err, #out .msg").first().textContent({ timeout: 1000 }).catch(() => null);
const clips = await page.locator(".clip").count();
const sum = {};
for (const r of rows) { const k = r.k.replace(/ \d+s$/, ""); sum[k] = (sum[k] || 0) + r.ms; console.log(`  ${r.k.padEnd(26)} ${(r.ms / 1000).toFixed(1).padStart(6)}s`); }
console.log("by stage:", Object.entries(sum).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join(" · "));
console.log(`${file}${q}: ${clips} clip(s) in ${total.toFixed(0)}s${err ? " ERROR " + err : ""}`);
await ctx.close(); server.close();
