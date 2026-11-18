// Edge cases the workflow test (web-pro.mjs) doesn't walk through: unsaved studio edits surviving a clip switch,
// Reset, caption text edits reaching the rendered .srt, captions/headline off, two renders queued back to back,
// dragging the timeline, the card's short/long tabs, the results log + CSV, removing a video, and an audio-only source.
//
//   node web-edge.mjs                     # Chrome desktop
//   BROWSER=webkit-desktop node web-edge.mjs
import { chromium, webkit, firefox } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DOCS = resolve(HERE, "../docs"), MEDIA = resolve(HERE, "media"), OUT = resolve(HERE, "web-out");
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
const TYPES = { "chrome-desktop": [chromium, { channel: "chrome" }], "webkit-desktop": [webkit, {}], "firefox-desktop": [firefox, {}] };
const name = process.env.BROWSER || "chrome-desktop";
const [type, launch] = TYPES[name];
let fails = 0;
const check = (ok, what, detail = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${what}${detail ? "  · " + detail : ""}`); return ok; };
const mod = process.platform === "darwin" ? "Meta" : "Control";
const RED_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAQCAYAAAB3AH1ZAAAAI0lEQVR4nO3OIQEAAAwEoetfeovxBoGnq1tKQEBAQEBAYB142QD8LgetqmMAAAAASUVORK5CYII=", "base64");
// the colour of one pixel of a clip's video at t seconds (canvas readback)
const pixel = (uid, x, y, t = 1) => page.evaluate(async ([u, x, y, t]) => {
  const v = document.querySelector(`#out .clip[data-uid="${u}"] video`);
  v.muted = true; if (v.readyState < 2) { v.load(); await new Promise(r => { v.addEventListener("loadeddata", r, { once: true }); setTimeout(r, 8000); }); }
  v.currentTime = t; await new Promise(r => { v.addEventListener("seeked", r, { once: true }); setTimeout(r, 4000); });
  const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight;
  const g = c.getContext("2d"); g.drawImage(v, 0, 0); return [...g.getImageData(x, y, 1, 1).data.slice(0, 3)];
}, [uid, x, y, t]);

await mkdir(OUT, { recursive: true });
const browser = await type.launch({ headless: true, ...launch });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
ctx.setDefaultTimeout(30000);
const page = await ctx.newPage();
const errors = []; page.on("pageerror", e => errors.push(e.message));
const idle = (ms = 900000) => page.waitForFunction(() => document.querySelector("#prog").classList.contains("hide") &&
  ![...document.querySelectorAll(".qi")].some(q => q.dataset.st === "running" || q.dataset.st === "queued"), null, { timeout: ms, polling: 1000 });
const rendered = (uid, old) => page.waitForFunction(([u, o]) => {
  const v = document.querySelector(`#out .clip[data-uid="${u}"] video`);
  return (v && v.getAttribute("src") !== o) || /⚠/.test(document.querySelector("#stStatus").textContent);
}, [uid, old], { timeout: 600000, polling: 500 });
const srcOf = uid => page.locator(`#out .clip[data-uid="${uid}"] video`).getAttribute("src");

try {
  await page.goto(BASE + "?model=Xenova/whisper-tiny.en&n=2&version=both&platform=tiktok", { waitUntil: "load" });
  await page.evaluate(() => localStorage.clear());

  // ---- brand kit: a logo in the top-right corner at full opacity, on every clip
  await page.setInputFiles("#logoFile", { name: "logo.png", mimeType: "image/png", buffer: RED_PNG });
  await page.waitForFunction(() => !document.querySelector("#logoPrev").hidden);
  await page.locator('.chips[data-k="lpos"] [data-v="tr"]').dispatchEvent("click");   // inside a folded section
  await page.locator('.chips[data-k="lop"] [data-v="1"]').dispatchEvent("click");
  check(/logo · top right/.test(await page.locator("#brandSum").textContent()), "logo added and set to top right", await page.locator("#brandSum").textContent());

  await page.setInputFiles("#file", join(MEDIA, "talk_80s.mp4"));
  await page.click("#go");
  await idle();
  const uids = await page.$$eval("#out .clip", a => a.map(x => x.dataset.uid));
  check(uids.length >= 2, "two clips to work with", String(uids.length));
  // 720x1280 web render: the logo box is 86 px, 36 px from the right edge, 58 px from the top
  const px = await pixel(uids[0], 640, 72);
  check(px[0] > 180 && px[1] < 90 && px[2] < 90, "the logo is burned into the top-right corner", px.join(","));

  // ---- card tabs: short ↔ long
  const card = page.locator(`#out .clip[data-uid="${uids[0]}"]`);
  if (await card.locator('[data-cut="long"]').count()) {
    const s0 = await srcOf(uids[0]);
    await card.locator('[data-cut="long"]').click();
    const s1 = await srcOf(uids[0]);
    await card.locator('[data-cut="short"]').click();
    check(s0 !== s1 && (await srcOf(uids[0])) === s0, "card switches between short and long cuts");
  }

  // ---- unsaved edits survive switching clips; Reset restores
  await card.locator("[data-edit]").click();
  await page.locator("#studio:not(.hide)").waitFor();
  const lg = await page.$eval("#stLogo", el => !el.hidden && el.style.right !== "" && el.getBoundingClientRect().width > 0);
  check(lg, "studio preview shows the logo in its corner");
  const len0 = await page.locator("#stLen").textContent();
  await page.click('[data-nudge="end:-1"]'); await page.click('[data-nudge="end:-1"]');
  const len1 = await page.locator("#stLen").textContent();
  await page.locator("#stPlay").focus();
  await page.keyboard.press("]");
  const other = await page.locator("#stNum").textContent();
  await page.keyboard.press("[");
  const len2 = await page.locator("#stLen").textContent();
  check(len1 !== len0 && len2 === len1, "unsaved trim survives switching clips", `${len0} → ${len1} → (${other}) → ${len2}`);
  await page.click("#stReset");
  check((await page.locator("#stLen").textContent()) === len0, "Reset restores the original cut", await page.locator("#stLen").textContent());

  // ---- timeline drag moves the out point (after two frames, so the scan sees the timeline redrawn by Reset)
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(250);
  const box = await page.locator("#stTl").boundingBox();
  const outX = await page.evaluate(() => {
    const cv = document.querySelector("#stTl"); const r = cv.getBoundingClientRect();
    // find the out bracket by scanning for the brightest accent-blue column in the top band
    const g = cv.getContext("2d"), d = g.getImageData(0, 0, cv.width, cv.height).data, sx = cv.width / r.width;
    let best = -1;
    for (let x = cv.width - 1; x >= 0; x--) { let n = 0; for (let y = 0; y < cv.height; y += 2) { const i = (y * cv.width + x) * 4; if (d[i] > 100 && d[i] < 150 && d[i + 1] > 150 && d[i + 1] < 190 && d[i + 2] > 235) n++; } if (n > cv.height * 0.36) { best = x; break; } }   // the bracket runs the full height (n counts every other row); waveform bars don't
    return best < 0 ? null : best / sx;
  });
  if (outX != null) {
    const y = box.y + box.height * 0.5;
    await page.mouse.move(box.x + outX, y); await page.mouse.down();
    await page.mouse.move(box.x + outX - 60, y, { steps: 6 }); await page.mouse.up();
    const len3 = await page.locator("#stLen").textContent();
    check(len3 !== len0, "dragging the out bracket trims the clip", `${len0} → ${len3}`);
    await page.click("#stReset");
  } else check(false, "found the out bracket on the timeline");

  // ---- caption text edit reaches the rendered .srt; captions + headline off still render
  await page.click("#stTabText").catch(() => {});
  const line = page.locator(".ed-line").first();
  const orig = await line.inputValue();
  await line.fill("ZEBRA " + orig.split(" ").slice(1).join(" "));
  await line.dispatchEvent("change");
  const old0 = await srcOf(uids[0]);
  await page.locator("#stPlay").focus();
  await page.keyboard.press(`${mod}+Enter`);

  // ---- second render queued right behind the first: next clip, captions + headline off
  await page.keyboard.press("]");
  await page.click("#stTabLook");
  await page.click('[data-ek="captions"] [data-v="0"]');
  await page.click('[data-ek="hook"] [data-v="0"]');
  const capHidden = await page.$eval("#stCap", el => !el.textContent.trim() || getComputedStyle(el).display === "none" || el.hidden);
  check(capHidden, "captions off hides the preview captions");
  const old1 = await srcOf(uids[1]);
  await page.locator("#stPlay").focus();
  await page.keyboard.press(`${mod}+Enter`);
  await rendered(uids[0], old0);
  await rendered(uids[1], old1);
  const st = await page.locator("#stStatus").textContent();
  check(!/⚠/.test(st), "two renders queued back to back both finish", st);
  await page.click("#stClose");
  const srt = await page.evaluate(async u => {
    const a = document.querySelector(`#out .clip[data-uid="${u}"] a[href][download$=".srt"], #out .clip[data-uid="${u}"] a[download*=".srt"]`);
    return a ? (await fetch(a.href)).text() : null;
  }, uids[0]);
  check(srt && /ZEBRA/i.test(srt), "edited caption text is in the clip's .srt", srt ? srt.split("\n").slice(0, 3).join(" | ") : "no .srt link");

  // ---- transcript reflects the edit
  await page.click("#tTx");
  check(/ZEBRA/i.test(await page.locator("#tx").textContent()), "transcript shows the edited word");

  // ---- two clips from the transcript, queued behind a running edit: both must land (they used to share one slot)
  await page.click("#tClips");
  await page.locator(`#out .clip[data-uid="${uids[1]}"] [data-edit]`).click();
  await page.locator("#studio:not(.hide)").waitFor();
  await page.click('[data-nudge="start:1"]');
  await page.click("#stRender");
  await page.click("#stClose");
  const mine0 = await page.locator("#out .clip .score.mine").count();
  await page.click("#tTx");
  const tw = page.locator("#tx w"), twc = await tw.count();
  for (const [a, b] of [[1, Math.min(30, twc - 3)], [Math.min(40, twc - 30), Math.min(75, twc - 2)]]) {
    await tw.nth(a).click(); await tw.nth(b).click({ modifiers: ["Shift"] });
    await page.click("#mkclip");
    await page.locator("#studio:not(.hide)").waitFor();
    await page.click("#stRender");
    await page.click("#stClose");
  }
  await page.waitForFunction(n => document.querySelectorAll("#out .clip .score.mine").length >= n + 2, mine0, { timeout: 600000, polling: 1000 }).catch(() => {});
  check(await page.locator("#out .clip .score.mine").count() === mine0 + 2, "two transcript clips queued back to back both land",
    `${mine0} → ${await page.locator("#out .clip .score.mine").count()}`);
  await page.click("#tClips");

  // ---- results log + CSV
  const c0 = page.locator(`#out .clip[data-uid="${uids[0]}"]`);
  await c0.locator("details.more > summary").click();
  const log = c0.locator(".logf");
  const platform = log.getByLabel("Platform", { exact: true });
  const shortsMetrics = {
    "Shown in Shorts feed": "2000",
    "Shorts-feed share (%)": "92.7",
    "Average view duration (mm:ss)": "00:17",
  };
  await platform.selectOption("shorts");
  await log.getByLabel("Checkpoint").selectOption("72h");
  for (const [label, value] of Object.entries(shortsMetrics)) await log.getByLabel(label, { exact: true }).fill(value);
  await platform.selectOption("reels");
  for (const label of Object.keys(shortsMetrics)) {
    const field = log.getByLabel(label, { exact: true });
    check(await field.isHidden() && await field.isDisabled(), `${label} is hidden and excluded for Reels`);
  }
  await log.getByLabel("Views", { exact: true }).fill("567");
  await log.locator("[type=submit]").click();
  await platform.selectOption("shorts");
  await log.getByLabel("Checkpoint").selectOption("72h");
  for (const [label, value] of Object.entries(shortsMetrics)) await log.getByLabel(label, { exact: true }).fill(value);
  await log.getByLabel("Views", { exact: true }).fill("1234");
  await log.locator("[type=submit]").click();
  await page.click("#tLog");
  const shortsRow = await page.locator("#logtbl tr").filter({ hasText: "YT Shorts" }).textContent();
  check(["72h", "1234", "Shown in Shorts feed: 2000", "Shorts-feed share: 92.7%", "Average view duration: 00:17"]
    .every(value => shortsRow.includes(value)), "the 72h Shorts metrics show in the results log", shortsRow);
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), page.click("#csv")]);
  const [header, reelsRow, shortsCsvRow] = (await readFile(await dl.path(), "utf8")).split("\n");
  const cells = line => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map(x => x[1].replace(/""/g, '"'));
  const col = (line, name) => cells(line)[header.split(",").indexOf(name)];
  check(header.endsWith(",feed_shown,feed_share,avg_view_duration,score,signals"), "CSV has the Shorts metric, score and signal column names", header);
  check(reelsRow.includes('"reels"') && ["feed_shown", "feed_share", "avg_view_duration"].every(k => col(reelsRow, k) === ""), "CSV leaves Shorts metrics blank for Reels");
  check(shortsCsvRow.includes('"72h","1234"') && col(shortsCsvRow, "feed_shown") === "2000" && col(shortsCsvRow, "feed_share") === "92.7" && col(shortsCsvRow, "avg_view_duration") === "00:17",
    "CSV exports the checkpoint and raw Shorts metric values");
  let sig = {}; try { sig = JSON.parse(col(shortsCsvRow, "signals")); } catch {}
  check(Number.isFinite(sig.hook) && Number.isFinite(sig.deadair) && +col(shortsCsvRow, "score") > 0, "a logged post keeps the clip's score and scoring signals", col(shortsCsvRow, "signals"));

  // ---- learn from results: a YouTube Studio export matched to logged clips
  check(await page.locator("#learnOut ol").isVisible(), "the learn panel explains how to export from YouTube Studio");
  const realTitle = await page.evaluate(() => JSON.parse(localStorage.getItem("clipmachine.log")).at(-1).title);
  await page.evaluate(() => {                       // six earlier posts: the stronger the hook, the better they did
    const keys = ["energy", "peak", "swing", "hype", "laugh", "exclaim", "pace", "hook", "first1", "payoff", "ends_clean", "midstart", "deadair", "fit", "sponsor"];
    const rows = JSON.parse(localStorage.getItem("clipmachine.log"));
    for (let i = 1; i <= 6; i++) rows.push({ id: "seed" + i, platform: "shorts", cut: "short", checkpoint: "7d", title: `Seeded clip number ${i} about pricing`,
      score: String(60 + i), signals: JSON.stringify(Object.fromEntries(keys.map(k => [k, k === "hook" ? i / 2 : k === "deadair" ? -i / 4 : 0]))) });
    localStorage.setItem("clipmachine.log", JSON.stringify(rows));
  });
  await page.click("#tClips"); await page.click("#tLog");
  const studioCsv = "Content,Video title,Video publish time,Views,Average percentage viewed (%)\nTotal,,,9999,50\n" +
    [1, 2, 3, 4, 5, 6].map(i => `v${i},Seeded clip number ${i} about pricing #shorts,"Nov ${i}, 2026",${i * 300},${30 + i * 5}`).join("\n") +
    `\nv7,"${realTitle.replace(/"/g, '""')}","Nov 9, 2026",4000,40\nv8,Some video that was never logged,"Nov 9, 2026",10,20\n`;
  await page.setInputFiles("#studioFile", { name: "Table data.csv", mimeType: "text/csv", buffer: Buffer.from(studioCsv) });
  await page.locator("#learnOut table.sig").waitFor({ timeout: 10000 });
  const sum = await page.locator(".learn-sum").textContent();
  check(/8 videos/.test(sum) && /\b7\b matched/.test(sum), "the Studio export matches 7 of its 8 videos to logged clips", sum.replace(/\s+/g, " "));
  check(await page.locator("#learnMetric").inputValue() === "Average percentage viewed (%)", "the report judges by average percentage viewed by default");
  const take = await page.locator(".learn-take").textContent();
  check(/strong opening hook/.test(take) && /dead air/.test(take), "the report names the signals the best clips share", take);
  check((await page.locator("table.sig tr").nth(1).textContent()).startsWith("Clip Machine's own score"), "the report starts with Clip Machine's own score");
  await page.locator("#learnMetric").selectOption("Views");
  check(/Link to Views/.test(await page.locator("table.sig").textContent()), "switching the metric redraws the report");
  check(await page.evaluate(() => !!JSON.parse(localStorage.getItem("clipmachine.studio"))?.rows?.length), "the website keeps the import in this browser");
  page.once("dialog", d => d.accept());
  await page.click("#studioDel");
  await page.locator("#learnOut ol").waitFor();
  check(await page.evaluate(() => localStorage.getItem("clipmachine.studio") === null), "removing the import clears it");
  await page.evaluate(() => localStorage.setItem("clipmachine.log", JSON.stringify(JSON.parse(localStorage.getItem("clipmachine.log")).filter(r => !/^seed/.test(r.id)))));
  await page.click("#tClips");

  // ---- remove the video
  await page.locator(".qi .x").first().click();
  check(await page.locator(".qi").count() === 0 && await page.locator("#empty").isVisible(), "removing the video clears the board");

  // ---- audio-only source: studio still previews and renders
  await page.goto(BASE + "?model=Xenova/whisper-tiny.en&n=1&version=short", { waitUntil: "load" });
  await page.setInputFiles("#file", join(MEDIA, "audio_only.m4a"));
  await page.click("#go");
  await idle();
  const au = await page.locator("#out .clip").first().getAttribute("data-uid");
  await page.locator(`#out .clip[data-uid="${au}"] [data-edit]`).click();
  await page.locator("#studio:not(.hide)").waitFor();
  const ao = await srcOf(au);
  await page.click('[data-nudge="start:1"]');
  await page.click("#stRender");
  await rendered(au, ao);
  check(!/⚠/.test(await page.locator("#stStatus").textContent()), "audio-only clip edits and re-renders", await page.locator("#stStatus").textContent());
  await page.click("#stClose");
} catch (e) {
  check(false, "edge workflow", e.message.split("\n")[0]);
  await page.screenshot({ path: join(OUT, `edge-${name}.png`), fullPage: true }).catch(() => {});
}
check(!errors.length, "no page errors", errors.slice(0, 2).join(" || "));
await browser.close(); server.close();
console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
