// Debug: two videos queued in WebKit. Prints the queue + progress every 5 s and every console line.
import { webkit } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = fileURLToPath(new URL(".", import.meta.url)), DOCS = resolve(HERE, "../docs"), MEDIA = resolve(HERE, "media");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".woff2": "font/woff2", ".ttf": "font/ttf", ".mp4": "video/mp4", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer(async (req, res) => { const p = decodeURIComponent(new URL(req.url, "http://x").pathname), f = join(DOCS, p.endsWith("/") ? p + "index.html" : p);
  try { const b = await readFile(f); res.writeHead(200, { "Content-Type": MIME[extname(f)] || "application/octet-stream" }).end(b); } catch { res.writeHead(404).end(); } });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const files = (process.argv[2] || "talk_40s.mp4,tiny.mp4").split(",");
const b = await webkit.launch({ headless: true }); const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } }); const page = await ctx.newPage();
const t0 = Date.now(), ts = () => ((Date.now() - t0) / 1000).toFixed(0) + "s";
page.on("console", m => { const t = m.text(); if (!/^\[ffmpeg\]|frame=|size=/.test(t)) console.log(ts(), "console:", t.slice(0, 200)); });
page.on("pageerror", e => console.log(ts(), "PAGEERROR", e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/?model=Xenova/whisper-tiny.en&n=2&version=both&platform=tiktok`);
await page.setInputFiles("#file", files.map(f => join(MEDIA, f)));
await page.click("#go");
for (let i = 0; i < 80; i++) {
  await page.waitForTimeout(5000);
  const s = await Promise.race([page.evaluate(() => ({ q: [...document.querySelectorAll(".qi")].map(x => x.dataset.st + ":" + x.querySelector(".qs").textContent).join(" | "),
    p: document.querySelector("#plabel").textContent + " " + document.querySelector("#ppct").textContent + " · " + document.querySelector("#pmsg").textContent, hidden: document.querySelector("#prog").classList.contains("hide") })),
    new Promise(r => setTimeout(() => r({ q: "PAGE UNRESPONSIVE" }), 4000))]);
  console.log(ts(), JSON.stringify(s));
  if (s.hidden) break;
}
await b.close(); server.close();
