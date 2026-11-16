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

const LOG = join(JOBS, "results_log.json"), STUDIO = join(JOBS, "studio_import.json");
const srv = spawn(PY, ["app.py"], { cwd: ROOT, env: { ...process.env, CLIP_PORT: String(PORT), CLIP_JOBS: JOBS, CLIP_KEY: KEY, CLIP_LOG: LOG, CLIP_STUDIO: STUDIO }, stdio: ["ignore", "pipe", "pipe"] });
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
const RED_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAQCAYAAAB3AH1ZAAAAI0lEQVR4nO3OIQEAAAwEoetfeovxBoGnq1tKQEBAQEBAYB142QD8LgetqmMAAAAASUVORK5CYII=", "base64");
try {
  await page.addInitScript(() => {
    if (localStorage.getItem("clipmachine.log") === null) {
      localStorage.setItem("clipmachine.log", JSON.stringify([
        { id: "a8b1c9fe", title: "Previously saved in browser", platform: "shorts", checkpoint: "24h", views: "123" },
      ]));
    }
  });
  await page.goto(BASE + "?key=" + KEY, { waitUntil: "load" });
  await page.waitForFunction(() => document.body.classList.contains("desk"), null, { timeout: 10000 });
  check(true, "desktop mode detected");
  check(await page.locator('.chips[data-k="model"] [data-v="small"]').count() === 1, "native speech models offered");

  // ---- brand kit: the logo is stored by the app and burned in natively
  await page.setInputFiles("#logoFile", { name: "logo.png", mimeType: "image/png", buffer: RED_PNG });
  await page.waitForFunction(() => !document.querySelector("#logoPrev").hidden);
  await page.locator('.chips[data-k="lpos"] [data-v="tr"]').dispatchEvent("click");
  await page.locator('.chips[data-k="lop"] [data-v="1"]').dispatchEvent("click");
  check((await page.evaluate(async () => (await fetch("api/brand/logo", { cache: "no-store" })).status)) === 200, "the desktop app keeps the logo");

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

  // ---- desktop results are shared across browsers and exported by the server
  const firstClip = page.locator("#out .clip").first();
  await firstClip.locator("details.more > summary").click();
  const log = firstClip.locator(".logf");
  await log.getByLabel("Platform", { exact: true }).selectOption("shorts");
  await log.getByLabel("Checkpoint").selectOption("72h");
  await log.getByLabel("Shown in Shorts feed").fill("2048");
  await log.getByLabel("Shorts-feed share (%)").fill("92.7");
  await log.getByLabel("Average view duration (mm:ss)").fill("00:17");
  const [post] = await Promise.all([
    page.waitForResponse(r => r.url() === BASE + "api/log" && r.request().method() === "POST"),
    log.getByRole("button", { name: "Save result" }).click(),
  ]);
  const row = await post.json();
  check(post.ok() && row.feed_shown === "2048" && row.job && row.clip, "the desktop saves Shorts metrics with their source clip");
  let sig = {}; try { sig = JSON.parse(row.signals); } catch {}
  check(Number.isFinite(sig.hook) && Object.keys(sig).length === 15 && +row.score > 0, "the native engine's scoring signals are saved with the result", row.signals);
  const disk = JSON.parse(await readFile(LOG, "utf8"));
  check(disk.length === 2 && disk.some(r => r.id === row.id) && disk.some(r => r.title === "Previously saved in browser"),
    "the results file contains the new result and the imported browser entry");
  const other = await browser.newPage({ acceptDownloads: true });
  try {
    await other.goto(BASE + "?key=" + KEY);
    await other.locator("body.desk #tLog").click();
    const savedRow = other.locator("#logtbl tr").filter({ hasText: "Shown in Shorts feed: 2048" });
    check((await savedRow.textContent()).includes("Average view duration: 00:17"), "another browser sees the saved metrics");
    const [csvDownload] = await Promise.all([other.waitForEvent("download"), other.click("#csv")]);
    const csv = await readFile(await csvDownload.path(), "utf8");
    check(csv.includes("feed_shown,feed_share,avg_view_duration") && csv.includes(",2048,92.7,00:17"),
      "desktop CSV exports the saved server values");
    // a YouTube Studio import is kept on the computer, so every browser sees it
    const csvText = `Video title,Views\nTotal,99\n"${row.title.replace(/"/g, '""')}",1500\nNot a clip,3\n`;
    await other.setInputFiles("#studioFile", { name: "Table data.csv", mimeType: "text/csv", buffer: Buffer.from(csvText) });
    await other.locator(".learn-sum").waitFor();
    const saved = JSON.parse(await readFile(STUDIO, "utf8"));
    check(saved.rows.length === 2 && saved.rows[0].values.Views === 1500, "the desktop app saves the Studio import on the computer");
    await page.click("#tClips"); await page.click("#tLog");
    await page.locator(".learn-sum").waitFor();
    const firstSum = (await page.locator(".learn-sum").textContent()).replace(/\s+/g, " ");
    check(/2 videos/.test(firstSum) && /\b1\b matched/.test(firstSum) && /Needs at least 6/.test(await page.locator("#learnOut").textContent()),
      "the other browser sees the import and says how many more clips it needs", firstSum);
    other.once("dialog", dialog => dialog.accept());
    await other.click("#studioDel");
    await other.locator("#learnOut ol").waitFor();
    check(!existsSync(STUDIO), "removing the import deletes it from the computer");
    await page.click("#tClips");
    other.once("dialog", dialog => dialog.accept());
    await savedRow.getByRole("button", { name: "Delete" }).click();
    await savedRow.waitFor({ state: "detached" });
    check(!JSON.parse(await readFile(LOG, "utf8")).some(r => r.id === row.id), "deleting the result updates the saved file");
  } finally {
    await other.close();
  }
  await firstClip.locator("details.more > summary").click();

  const px = await page.evaluate(async () => {     // 1080x1920: the logo box is 130 px, 54 px from the right, 86 px down
    const v = document.querySelector("#out .clip video"); v.muted = true;
    if (v.readyState < 2) { v.load(); await new Promise(r => { v.addEventListener("loadeddata", r, { once: true }); setTimeout(r, 8000); }); }
    v.currentTime = 1; await new Promise(r => { v.addEventListener("seeked", r, { once: true }); setTimeout(r, 4000); });
    const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight;
    const g = c.getContext("2d"); g.drawImage(v, 0, 0); return [...g.getImageData(960, 110, 1, 1).data.slice(0, 3)];
  });
  check(px[0] > 180 && px[1] < 90 && px[2] < 90, "native render has the logo in the top-right corner", px.join(","));

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
  for (let i = 0; i < 200; i++) {                 // wait until the app has the video and is working on it
    const busy = await page.evaluate(async () => (await (await fetch("api/jobs", { cache: "no-store" })).json()).some(j => j.status === "running" && !j.has_result));
    if (busy) break; await page.waitForTimeout(300);
  }
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
