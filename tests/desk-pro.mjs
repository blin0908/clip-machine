// The desktop app's workspace: the same page as the website, served by app.py and backed by its native engine.
// Starts an isolated server (temporary jobs folder + its own key), then drives it in Chrome: a link job, a file
// upload, a studio edit with a new frame, a clip made from the transcript, cancel, and past jobs after a reload.
//
//   node desk-pro.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url)), ROOT = resolve(HERE, ".."), MEDIA = join(HERE, "media");
const PY = process.env.PYTHON || [".venv/bin/python", ".venv/Scripts/python.exe"].map(p => join(ROOT, p)).find(existsSync) || "python";
const KEY = "test-" + Math.random().toString(36).slice(2, 10), PORT = 8700 + Math.floor(Math.random() * 90);
const JOBS = await mkdtemp(join(tmpdir(), "clip desk jobs "));
let fails = 0;
const check = (ok, name, detail = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  · " + detail : ""}`); return ok; };

// media for the link job, from a plain local server (the desktop app downloads it like any link)
const media = createServer(async (req, res) => {
  try { const b = await readFile(join(MEDIA, decodeURIComponent(new URL(req.url, "http://x").pathname).slice(1))); res.writeHead(200, { "Content-Type": extname(req.url) === ".mp4" ? "video/mp4" : "application/octet-stream", "Content-Length": b.length }).end(b); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => media.listen(0, "127.0.0.1", r));
const MEDIA_URL = `http://127.0.0.1:${media.address().port}/`;

const srv = spawn(PY, ["app.py"], { cwd: ROOT, env: { ...process.env, CLIP_PORT: String(PORT), CLIP_JOBS: JOBS, CLIP_KEY: KEY }, stdio: ["ignore", "pipe", "pipe"] });
let srvLog = ""; srv.stdout.on("data", d => { srvLog += d; }); srv.stderr.on("data", d => { srvLog += d; });
const BASE = `http://127.0.0.1:${PORT}/`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "api/info?key=" + KEY)).ok) break; } catch {} await new Promise(r => setTimeout(r, 500)); }

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
ctx.setDefaultTimeout(30000);
const page = await ctx.newPage();
const errors = []; page.on("pageerror", e => errors.push(e.message));
const idle = (ms = 600000) => page.waitForFunction(() => document.querySelector("#prog").classList.contains("hide") &&
  ![...document.querySelectorAll(".qi")].some(q => q.dataset.st === "running" || q.dataset.st === "queued"), null, { timeout: ms, polling: 1000 });
const mod = process.platform === "darwin" ? "Meta" : "Control";
try {
  await page.goto(BASE + "?key=" + KEY, { waitUntil: "load" });
  await page.waitForFunction(() => document.body.classList.contains("desk"), null, { timeout: 10000 });
  check(true, "desktop mode detected");
  check(await page.locator('.chips[data-k="model"] [data-v="small"]').count() === 1, "native speech models offered");

  // ---- a link and a file, one run
  await page.locator('.chips[data-k="model"] [data-v="tiny"]').dispatchEvent("click");   // inside a folded section
  await page.click('.chips[data-k="n"] [data-v="1"]');
  await page.click("#tabLink");
  await page.fill("#link", MEDIA_URL + "talk_40s.mp4");
  await page.press("#link", "Enter");
  await page.setInputFiles("#file", join(MEDIA, "tiny.mp4"));
  check(await page.locator(".qi").count() === 2, "link + file queued");
  const t0 = Date.now();
  await page.click("#go");
  await idle();
  const states = await page.$$eval(".qi", q => q.map(x => x.dataset.st + ":" + x.querySelector(".qs").textContent));
  check(states.every(s => s.startsWith("done")), "native engine finished both", `${states.join(", ")} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await page.click(".qi >> nth=0");
  await page.waitForFunction(() => document.querySelectorAll("#out .clip").length > 0);
  check(/talk/.test(await page.locator(".qi >> nth=0").textContent()), "link job shows the video's title", await page.locator(".qi .n >> nth=0").textContent());

  // ---- studio edit on the native engine: trim + 1:1 + style
  const uid = await page.locator("#out .clip").first().getAttribute("data-uid"), vsel = `#out .clip[data-uid="${uid}"] video`;
  const old = await page.locator(vsel).getAttribute("src");
  await page.locator(`#out .clip[data-uid="${uid}"] [data-edit]`).click();
  await page.locator("#studio:not(.hide)").waitFor();
  const srcOk = await page.$eval("#stVid", v => new Promise(r => { if (v.readyState >= 1) r(v.duration); v.addEventListener("loadedmetadata", () => r(v.duration), { once: true }); setTimeout(() => r(0), 8000); }));
  check(srcOk > 30, "studio previews the source from the app", `${srcOk?.toFixed?.(1)}s`);
  check(await page.$eval("#stTl", c => c.width > 0), "timeline drawn from the app's waveform");
  await page.click('[data-nudge="end:-1"]');
  await page.click("#stTabLook");
  await page.click('[data-ek="format"] [data-v="1:1"]');
  await page.click('[data-estyle="boxed"]');
  await page.locator("#stPlay").focus();
  await page.keyboard.press(`${mod}+Enter`);
  await page.waitForFunction(([s, o]) => document.querySelector(s)?.getAttribute("src") !== o || /⚠/.test(document.querySelector("#stStatus").textContent), [vsel, old], { timeout: 300000, polling: 500 });
  const dims = await page.$eval(vsel, v => new Promise(r => { v.preload = "metadata"; v.load(); v.addEventListener("loadedmetadata", () => r([v.videoWidth, v.videoHeight]), { once: true }); setTimeout(() => r([0, 0]), 8000); }));
  check(dims[0] === 1080 && dims[1] === 1080, "edit re-rendered natively in 1:1", `${dims.join("x")} · ${await page.locator("#stStatus").textContent()}`);
  await page.click("#stClose");

  // ---- clip from the transcript
  await page.click("#tTx");
  const w = page.locator("#tx w");
  await w.nth(3).click(); await w.nth(Math.min((await w.count()) - 2, 45)).click({ modifiers: ["Shift"] });
  const n0 = await page.locator("#out .clip").count();
  await page.click("#mkclip");
  await page.locator("#studio:not(.hide)").waitFor();
  await page.click("#stRender");
  await page.waitForFunction(n => document.querySelectorAll("#out .clip").length > n || /⚠/.test(document.querySelector("#stStatus").textContent), n0, { timeout: 300000, polling: 500 });
  check(await page.locator("#out .clip .score.mine").count() === 1, "transcript clip made natively", await page.locator("#stStatus").textContent());
  await page.click("#stClose");

  // ---- .zip pulls the files from the app
  await page.click("#tClips");
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click("#zip")]);
  check((await dl.createReadStream()) && /\.zip$/.test(dl.suggestedFilename()), ".zip export", dl.suggestedFilename());

  // ---- close the tab mid-run and come back: the job is still followed in the queue and its clips load
  await page.setInputFiles("#file", join(MEDIA, "talk_40s.mp4"));
  await page.click("#go");
  await page.waitForFunction(async () => (await (await fetch("api/jobs", { cache: "no-store" })).json()).some(j => j.status === "running" && !j.has_result),
    null, { timeout: 60000, polling: 300 });   // the app has the video and is working on it
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => document.body.classList.contains("desk"));
  await page.waitForFunction(() => document.querySelectorAll(".qi").length > 0, null, { timeout: 10000 });
  const resumed = await page.$$eval(".qi", q => q.map(x => x.dataset.st));
  check(resumed[0] === "running", "a running job is still shown after reopening", resumed.join(", "));
  await page.waitForFunction(() => document.querySelector(".qi")?.dataset.st === "done", null, { timeout: 300000, polling: 1000 });
  await page.click(".qi >> nth=0");
  await page.waitForFunction(() => document.querySelectorAll("#out .clip").length > 0, null, { timeout: 20000 });
  check(true, "its clips load when it finishes", `${await page.locator("#out .clip").count()} clip(s)`);

  // ---- cancel
  await page.setInputFiles("#file", join(MEDIA, "talk_80s.mp4"));
  await page.click("#go");
  await page.waitForFunction(() => /Transcrib|Analys|Render|line/i.test(document.querySelector("#plabel").textContent), null, { timeout: 60000 });
  await page.click("#cancel");
  await idle(60000);
  const c = await page.$eval(".qi:last-child", q => q.dataset.st);
  check(c === "ready" && !(await page.locator("#out .card.err").count()), "cancel stops the native job", c);

  // ---- past jobs come back after a reload
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll(".qi").length > 0);
  const saved = await page.locator(".qi").count();
  await page.click(".qi >> nth=0");
  await page.waitForFunction(() => document.querySelectorAll("#out .clip").length > 0, null, { timeout: 15000 });
  check(saved >= 2, "past jobs reload with their clips", `${saved} saved, ${await page.locator("#out .clip").count()} clips in the first`);

  // ---- removing a past job deletes it from the computer: it stays gone after a reload
  page.once("dialog", d => d.accept());
  await page.locator(".qi .x").first().click();
  await page.waitForFunction(n => document.querySelectorAll(".qi").length === n - 1, saved, { timeout: 10000 });
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => document.body.classList.contains("desk"));
  await page.waitForTimeout(1500);
  check(await page.locator(".qi").count() === saved - 1, "removed job stays deleted after a reload", `${saved} → ${await page.locator(".qi").count()}`);
} catch (e) {
  check(false, "desktop workflow", e.message.split("\n")[0]);
  await page.screenshot({ path: join(HERE, "web-out", "desk-pro.png"), fullPage: true }).catch(() => {});
  console.log(srvLog.split("\n").filter(l => /Error|Traceback|line \d+/.test(l)).slice(-8).join("\n"));
}
check(!errors.length, "no page errors", errors.slice(0, 2).join(" || "));
await browser.close(); srv.kill(); media.close();
await rm(JOBS, { recursive: true, force: true });
console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
