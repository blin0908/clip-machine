// Safari (WebKit) keeps a tab's WebAssembly memory across reloads, so after one video the speech model never
// starts again in that tab. Checks the way out: after a reload the page offers a fresh tab, and the next video
// clips there. Also checks a first visit shows no notice.   node web-safari-reload.mjs
import { webkit } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url)), DOCS = resolve(HERE, "../docs"), MEDIA = resolve(HERE, "media");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".mp4": "video/mp4", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname), f = join(DOCS, p.endsWith("/") ? p + "index.html" : p);
  if (!f.startsWith(DOCS)) { res.writeHead(403).end(); return; }
  try { const b = await readFile(f); res.writeHead(200, { "Content-Type": MIME[extname(f)] || "application/octet-stream" }).end(b); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/?model=Xenova/whisper-tiny.en&n=1&version=short`;
let fails = 0;
const check = (ok, what, detail = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  webkit: ${what}${detail ? "  · " + detail : ""}`); };

const browser = await webkit.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
let page = await ctx.newPage();
async function clip(file) {
  await page.setInputFiles("#file", join(MEDIA, file));
  await page.click("#go");
  const t0 = Date.now();
  while (Date.now() - t0 < 300000) {
    await page.waitForTimeout(3000);
    const st = await page.evaluate(() => document.querySelector(".qi")?.dataset.st);
    if (st === "done" || st === "error") return { st, s: (Date.now() - t0) / 1000, err: await page.locator("#out .err").textContent().catch(() => "") };
  }
  return { st: "timeout" };
}

await page.goto(BASE);
check(await page.locator("#freshTab").count() === 0, "a first visit shows no fresh-tab notice");
const a = await clip("talk_40s.mp4");
check(a.st === "done", "first video clips", `${a.s?.toFixed(0)} s`);
await page.reload();
await page.waitForSelector("#go");
check(await page.locator("#freshTab").isVisible(), "after a reload, the page offers a fresh tab");
const [fresh] = await Promise.all([ctx.waitForEvent("page"), page.click("#freshTab a")]);
await page.close(); page = fresh; await page.waitForLoadState(); await page.waitForSelector("#go");
check(await page.locator("#freshTab").count() === 0, "the fresh tab starts clean");
const b = await clip("audio_only.m4a");
check(b.st === "done", "the next video clips in the fresh tab", b.st === "done" ? `${b.s.toFixed(0)} s` : b.err || b.st);

await browser.close(); server.close();
console.log(fails ? `\n${fails} failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
