// Workflow test for the browser app's pro features: the queue, the clips board (keys, keep, filter, .zip export),
// the transcript (search, select, make a clip), the studio (formats, undo, render queue), presets, cancel, and
// the phone layout. Runs the real pipeline, like web-stress.mjs.
//
//   node web-pro.mjs                      # Chrome desktop + Chrome phone
//   BROWSER=firefox-desktop node web-pro.mjs
//   BROWSER=webkit-desktop node web-pro.mjs
import { chromium, webkit, firefox, devices } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DOCS = resolve(HERE, "../docs"), MEDIA = resolve(HERE, "media"), OUT = resolve(HERE, "web-out"), PROFILES = join(OUT, "profiles");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml",
  ".ttf": "font/ttf", ".woff2": "font/woff2", ".png": "image/png", ".mp4": "video/mp4" };
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname), f = join(DOCS, p.endsWith("/") ? p + "index.html" : p);
  if (!f.startsWith(DOCS)) { res.writeHead(403).end(); return; }
  try { const b = await readFile(f); res.writeHead(200, { "Content-Type": MIME[extname(f)] || "application/octet-stream" }).end(b); }
  catch { res.writeHead(404).end("not found"); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/`;
const BROWSERS = {
  "chrome-desktop": { type: chromium, ctx: { channel: "chrome", viewport: { width: 1360, height: 900 }, acceptDownloads: true } },
  "firefox-desktop": { type: firefox, ctx: { viewport: { width: 1360, height: 900 }, acceptDownloads: true } },
  "webkit-desktop": { type: webkit, ctx: { viewport: { width: 1360, height: 900 }, acceptDownloads: true } },
  "chrome-android": { type: chromium, ctx: { ...devices["Pixel 7"], channel: "chrome" }, phone: true },
  "webkit-iphone": { type: webkit, ctx: devices["iPhone 13"], phone: true },
};
const which = (process.env.BROWSER || "chrome-desktop,chrome-android").split(",");
let fails = 0;
const check = (ok, name, detail = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  · " + detail : ""}`); return ok; };
const noSideScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const idle = (page, ms = 900000) => page.waitForFunction(() => document.querySelector("#prog").classList.contains("hide") &&
  ![...document.querySelectorAll(".qi")].some(q => q.dataset.st === "running" || q.dataset.st === "queued"), null, { timeout: ms, polling: 1000 });

async function open(name) {
  const B = BROWSERS[name];
  await mkdir(PROFILES, { recursive: true });
  if (B.type === webkit) { const browser = await webkit.launch({ headless: true }); const ctx = await browser.newContext(B.ctx); return { ctx, close: () => browser.close() }; }
  const ctx = await B.type.launchPersistentContext(join(PROFILES, "pro-" + name), { headless: true, ...B.ctx });
  return { ctx, close: () => ctx.close() };
}

async function desktop(name) {
  const { ctx, close } = await open(name);
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  try {
    await page.goto(BASE + "?model=Xenova/whisper-tiny.en&n=2&version=both&platform=tiktok", { waitUntil: "load" });
    await page.evaluate(() => localStorage.clear());
    check(await page.locator("#empty").isVisible(), `${name}: empty state shows`);
    check(await noSideScroll(page), `${name}: no sideways scroll (empty)`);

    // ---- queue: two files, one run
    await page.setInputFiles("#file", [join(MEDIA, "talk_40s.mp4"), join(MEDIA, "tiny.mp4")]);
    check(await page.locator(".qi").count() === 2, `${name}: two videos queued`, await page.locator("#goLabel").textContent());
    const t0 = Date.now();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
    await page.waitForFunction(() => document.querySelector('.qi[data-st="running"]'), null, { timeout: 10000 });
    await idle(page);
    const states = await page.$$eval(".qi", q => q.map(x => x.dataset.st));
    check(states.every(s => s === "done"), `${name}: queue finished`, `${states.join(", ")} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    await page.click('.qi[data-sid] >> nth=0');
    const n = await page.locator("#out .clip").count();
    check(n >= 1, `${name}: first video has clips`, `${n}`);
    const idx = await page.$$eval("#out .clip .when", e => e.map(x => x.textContent.slice(0, 2)));
    check(idx[0] === "01", `${name}: best clip is numbered 01`, idx.join(" "));

    // ---- board keys, keep, filter
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("k");
    check(await page.locator("#out .clip.sel [data-keep][aria-pressed=true]").count() === 1, `${name}: K keeps the selected clip`);
    await page.click("#fKept");
    check(await page.locator("#out .clip").count() === 1, `${name}: Kept filter shows 1`);
    await page.click("#fAll");

    // ---- .zip export
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click("#zip")]);
    const zp = join(OUT, `pro-${name}.zip`); await dl.saveAs(zp);
    let list = "";
    try { execFileSync("unzip", ["-tq", zp]); list = execFileSync("unzip", ["-Z1", zp], { encoding: "utf8" }); } catch (e) { list = "BAD: " + e.message; }
    const files = list.trim().split("\n");
    check(!list.startsWith("BAD") && files.some(f => f.endsWith(".mp4")) && files.some(f => f.endsWith(".srt")) && files.some(f => f.endsWith("captions.txt")),
      `${name}: .zip is valid with mp4 + srt + captions`, `${files.length} files, e.g. ${files[0]}`);

    // ---- transcript: search, select, make a clip in 1:1
    await page.click("#tTx");
    await page.fill("#txq", "the");
    check(/\d+\/\d+/.test(await page.locator("#txhits").textContent()), `${name}: transcript search finds matches`, await page.locator("#txhits").textContent());
    const words = page.locator("#tx w");
    const wc = await words.count();
    await words.nth(2).click();
    await words.nth(Math.min(wc - 2, 40)).click({ modifiers: ["Shift"] });
    const selinfo = await page.locator("#selinfo").textContent();
    check(await page.locator("#mkclip").isEnabled(), `${name}: selection enables Make clip`, selinfo);
    await page.click("#mkclip");
    await page.locator("#studio:not(.hide)").waitFor();
    check((await page.locator("#stNum").textContent()) === "New clip", `${name}: studio opens a new clip`);
    await page.click("#stTabLook");
    await page.click('[data-ek="format"] [data-v="1:1"]');
    const ar = await page.$eval("#stFrame", el => getComputedStyle(el).aspectRatio);
    check(/1 \/ 1/.test(ar), `${name}: preview frame follows the format`, ar);
    const before = await page.locator("#out .clip").count();
    await page.locator("#stPlay").focus();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
    await page.waitForFunction(b => document.querySelectorAll("#out .clip").length > b || /⚠/.test(document.querySelector("#stStatus").textContent), before, { timeout: 600000, polling: 1000 });
    const dims = await page.evaluate(async () => {
      const v = [...document.querySelectorAll("#out .clip")].find(a => a.querySelector(".score.mine"))?.querySelector("video");
      if (!v) return null;
      if (v.readyState < 1) await new Promise(r => { v.addEventListener("loadedmetadata", r, { once: true }); v.load(); setTimeout(r, 8000); });
      return [v.videoWidth, v.videoHeight];
    });
    check(dims && dims[0] === dims[1] && dims[0] > 0, `${name}: transcript clip renders square`, JSON.stringify(dims) + " " + (await page.locator("#stStatus").textContent()));
    await page.click("#stClose");

    // ---- studio: nudge + undo, live preview, cut switch
    await page.click("#tClips");
    await page.locator("#out .clip [data-edit]").first().click();
    await page.locator("#studio:not(.hide)").waitFor();
    const len0 = await page.locator("#stLen").textContent();
    await page.click('[data-nudge="end:-1"]');
    const len1 = await page.locator("#stLen").textContent();
    await page.locator("#stPlay").focus();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    const len2 = await page.locator("#stLen").textContent();
    check(len0 !== len1 && len2 === len0, `${name}: trim nudge + undo`, `${len0} → ${len1} → ${len2}`);
    await page.$eval("#stVid", v => { v.muted = true; });
    await page.keyboard.press("Space");
    await page.waitForTimeout(2500);
    const live = await page.evaluate(() => ({ playing: !document.querySelector("#stVid").paused, cap: document.querySelector("#stCap").textContent, tc: document.querySelector("#stTC").textContent }));
    check(live.playing && /clip/.test(live.tc), `${name}: preview plays the selection`, `${live.tc} "${live.cap}"`);
    await page.keyboard.press("Space");
    await page.keyboard.press("Escape");
    check(await page.locator("#studio").evaluate(el => el.classList.contains("hide")), `${name}: Esc closes the studio`);

    // ---- presets
    await page.click("#setup details.grp:nth-of-type(2) > summary").catch(() => {});
    await page.click('.chips[data-k="format"] [data-v="4:5"]');
    await page.click("#psave"); await page.fill("#pname", "Test preset"); await page.press("#pname", "Enter");
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => document.querySelector("#preset option"));
    const kept = await page.evaluate(() => ({ fmt: document.querySelector('.chips[data-k="format"] [aria-pressed=true]')?.dataset.v,
      saved: [...document.querySelectorAll("#preset option")].some(o => o.textContent === "Test preset") }));
    check(kept.saved, `${name}: saved preset survives a reload`);
    await page.selectOption("#preset", { label: "Feed square · 1:1" });
    check(await page.locator('.chips[data-k="format"] [data-v="1:1"][aria-pressed=true]').count() === 1, `${name}: starter preset applies`);

    // ---- cancel
    await page.goto(BASE + "?model=Xenova/whisper-tiny.en&n=1&version=short", { waitUntil: "load" });
    await page.setInputFiles("#file", join(MEDIA, "talk_80s.mp4"));
    await page.click("#go");
    await page.waitForFunction(() => /Transcrib|Rendering|speech/.test(document.querySelector("#plabel").textContent), null, { timeout: 120000 });
    await page.click("#cancel");
    await page.waitForFunction(() => document.querySelector("#prog").classList.contains("hide"), null, { timeout: 30000 });
    const after = await page.evaluate(() => ({ st: document.querySelector(".qi")?.dataset.st, err: document.querySelector("#out .card.err")?.textContent, go: !document.querySelector("#go").disabled }));
    check((after.st === "ready" || after.st === "done") && !after.err && after.go, `${name}: cancel stops cleanly and can run again`, JSON.stringify(after));
  } catch (e) {
    check(false, `${name}: workflow`, e.message.split("\n")[0]);
    await page.screenshot({ path: join(OUT, `pro-${name}.png`), fullPage: true }).catch(() => {});
  }
  if (errors.length) console.log("      page errors:", errors.slice(0, 3).join(" || "));
  check(!errors.length, `${name}: no page errors`);
  await close();
}

async function phone(name) {
  const { ctx, close } = await open(name);
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  try {
    await page.goto(BASE + "?model=Xenova/whisper-tiny.en&n=1&version=short", { waitUntil: "load" });
    check(await noSideScroll(page), `${name}: no sideways scroll (empty)`);
    check(await page.locator("#go").isVisible() || (await page.locator("#go").boundingBox()).y < 1600, `${name}: settings folded, button in reach`);
    await page.setInputFiles("#file", join(MEDIA, "tiny.mp4"));
    await page.click("#go");
    await idle(page);
    check(await page.locator("#out .clip").count() >= 1, `${name}: clip made`);
    check(await noSideScroll(page), `${name}: no sideways scroll (board)`);
    await page.locator("#out .clip [data-edit]").first().click();
    await page.locator("#studio:not(.hide)").waitFor();
    const fit = await page.evaluate(() => document.querySelector("#studio").scrollWidth <= innerWidth + 1);
    check(fit, `${name}: studio fits the screen`);
    const tl = await page.locator("#stTl").boundingBox();
    check(tl && tl.width > 250, `${name}: timeline is usable`, tl ? `${tl.width.toFixed(0)}px wide` : "");
  } catch (e) {
    check(false, `${name}: phone workflow`, e.message.split("\n")[0]);
    await page.screenshot({ path: join(OUT, `pro-${name}.png`), fullPage: true }).catch(() => {});
  }
  check(!errors.length, `${name}: no page errors`, errors.slice(0, 2).join(" || "));
  await close();
}

for (const name of which) {
  if (!BROWSERS[name]) { console.log("unknown browser", name); continue; }
  console.log(`\n== ${name}`);
  try { await (BROWSERS[name].phone ? phone(name) : desktop(name)); }
  catch (e) { check(false, `${name}: browser`, e.message.split("\n")[0]); }
}
server.close();
console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
