// Find clips by description on the website (docs/search.js + search-worker.js). Chrome by default; also
//   BROWSER=firefox-desktop node web-find.mjs   /   BROWSER=webkit-desktop node web-find.mjs
//  1. parity: the browser engine cuts the same windows as the desktop engine (search.py) for fixed transcripts in
//     English, Spanish and Japanese, scores them within SCORE_TOL, and offers the same clips. Both run the same 8-bit
//     ONNX file on the same token ids, one text at a time, but onnxruntime's int8 kernels round differently in
//     WebAssembly and natively, so a window's score can differ by up to about 0.009 (the fp32 model would agree
//     exactly, but it is a 470 MB download). So the picks must match, except where a case sits within that
//     tolerance of a decision: two windows tied within 2 x SCORE_TOL, or a match strength within 3 x SCORE_TOL of the
//     "nothing matches" threshold. Those are counted and capped at MAX_TOLERATED.
//  2. workflow: clip media/talk_40s.mp4, then search its transcript from the box in the clips area: a match becomes a
//     new clip through the normal render and quality gate, an unrelated query says nothing matches, and the keys work.
// The first run downloads the search model (about 135 MB) into this test's browser profile, as the site does.
//
//   node web-find.mjs
import { chromium, webkit, firefox } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url)), ROOT = resolve(HERE, "..");
const DOCS = resolve(ROOT, "docs"), MEDIA = resolve(HERE, "media"), PROFILES = join(HERE, "web-out", "profiles");
const PY = process.env.PYTHON || [".venv/bin/python", ".venv/Scripts/python.exe"].map(p => join(ROOT, p)).find(existsSync) || "python";
const SCORE_TOL = 0.01, MAX_TOLERATED = 0.15;     // measured: largest gap 0.0089 over 51 cases, 6 near-ties
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml",
  ".ttf": "font/ttf", ".woff2": "font/woff2", ".png": "image/png", ".mp4": "video/mp4" };
const HARNESS = `<!doctype html><meta charset="utf-8"><script type="module">import * as S from "./search.js"; window.S = S; window.ready = true;</script>`;
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/__find.html") { res.writeHead(200, { "Content-Type": "text/html" }).end(HARNESS); return; }
  const f = join(DOCS, p.endsWith("/") ? p + "index.html" : p);
  if (!f.startsWith(DOCS)) { res.writeHead(403).end(); return; }
  try { const b = await readFile(f); res.writeHead(200, { "Content-Type": MIME[extname(f)] || "application/octet-stream" }).end(b); }
  catch { res.writeHead(404).end("not found"); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/`;
let fails = 0;
const check = (ok, name, detail = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  · " + detail : ""}`); return ok; };

// the desktop engine's answers (also runs its own ranking checks)
const tmp = await mkdtemp(join(tmpdir(), "clip-find-"));
const dumpFile = join(tmp, "desktop.json");
try { execFileSync(PY, [join(HERE, "search_parity.py"), "--dump", dumpFile], { stdio: ["ignore", "ignore", "inherit"] }); check(true, "desktop engine ranking checks (search_parity.py)"); }
catch { check(false, "desktop engine ranking checks (search_parity.py)", "run it on its own to see which"); }
const desk = existsSync(dumpFile) ? JSON.parse(await readFile(dumpFile, "utf8")) : [];

await mkdir(PROFILES, { recursive: true });
const TYPES = { "chrome-desktop": [chromium, { channel: "chrome" }], "webkit-desktop": [webkit, {}], "firefox-desktop": [firefox, {}] };
const BROWSER = process.env.BROWSER || "chrome-desktop";
if (!TYPES[BROWSER]) throw new Error(`BROWSER must be one of ${Object.keys(TYPES).join(", ")}`);
const [btype, bopts] = TYPES[BROWSER];
// WebKit on macOS can't open a persistent profile in Playwright, so it gets a fresh context (and downloads the model each run)
const ctx = btype === webkit
  ? await (await webkit.launch({ headless: true })).newContext({ viewport: { width: 1360, height: 900 } })
  : await btype.launchPersistentContext(join(PROFILES, `find-${BROWSER}`), { headless: true, ...bopts, viewport: { width: 1360, height: 900 } });
ctx.setDefaultTimeout(30000);
try {
  // ---- 1. parity
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(BASE + "__find.html");
  await page.waitForFunction(() => window.ready);
  const t0 = Date.now();
  const web = await page.evaluate(async cases => {
    const out = [];
    for (const c of cases) {
      const all = await S.scoreWindows(c.words, c.duration, c.query);
      out.push({ windows: all, picks: S.pickMatches(all.map(({ score, ...w }) => w), all.map(w => w.score), 3) });
    }
    return out;
  }, desk.map(({ words, duration, query }) => ({ words, duration, query })));
  check(web.length === desk.length && desk.length > 40, "browser engine ran every case", `${web.length} cases in ${((Date.now() - t0) / 1000).toFixed(0)}s (incl. model load)`);
  const S = await page.evaluate(() => ({ MIN_MATCH: S.MIN_MATCH }));
  const strength = ws => { const sc = ws.map(w => w.score).sort((a, b) => a - b), h = sc.length >> 1, top = sc.at(-1);
    return top + top - (sc.length % 2 ? sc[h] : (sc[h - 1] + sc[h]) / 2); };
  let sameWins = 0, samePicks = 0, sameTop = 0, maxDiff = 0;
  const bad = [], tolerated = [];
  desk.forEach((d, i) => {
    const w = web[i]; if (!w) return;
    const wins = w.windows.length === d.windows.length && w.windows.every((x, k) => x.start === d.windows[k].start && x.end === d.windows[k].end && x.text === d.windows[k].text);
    if (!wins) { bad.push(`${d.src}/${d.query}: different windows`); return; }
    sameWins++;
    w.windows.forEach((x, k) => { maxDiff = Math.max(maxDiff, Math.abs(x.score - d.windows[k].score)); });
    const sorted = [...d.windows].sort((a, b) => b.score - a.score);
    const tie = sorted.length > 1 && sorted[0].score - sorted[1].score < 2 * SCORE_TOL;
    const edge = Math.abs(strength(d.windows) - S.MIN_MATCH) < 3 * SCORE_TOL;
    const top = ws => ws.reduce((a, b) => b.score > a.score ? b : a, ws[0])?.start;
    if (top(w.windows) === top(d.windows)) sameTop++; else if (!tie) bad.push(`${d.src}/${d.query}: a different best window`);
    const key = ps => ps.map(p => `${p.start}-${p.end}`).join(",");
    if (key(w.picks) === key(d.picks)) samePicks++;
    else if (tie || edge || (w.picks[0] && d.picks[0] && key([w.picks[0]]) === key([d.picks[0]]))) tolerated.push(`${d.src}/${d.query} (${tie ? "tie" : edge ? "at the threshold" : "same first pick, different extras"}: web ${key(w.picks) || "none"} vs desktop ${key(d.picks) || "none"})`);
    else bad.push(`${d.src}/${d.query}: web ${key(w.picks) || "none"} vs desktop ${key(d.picks) || "none"}`);
  });
  check(sameWins === desk.length, "both engines cut the same sentence windows", `${sameWins}/${desk.length}`);
  check(maxDiff < SCORE_TOL, `window scores agree within ${SCORE_TOL}`, `largest difference ${maxDiff.toFixed(5)}`);
  check(!bad.some(b => /best window/.test(b)), "both engines rank the same window first (or a tie within tolerance)", `${sameTop}/${desk.length} identical`);
  check(!bad.length && tolerated.length <= MAX_TOLERATED * desk.length, "both engines offer the same clips, or differ only within tolerance",
    `${samePicks}/${desk.length} identical, ${tolerated.length} within tolerance${bad.length ? " · FAILED: " + bad.slice(0, 3).join(" | ") : ""}`);
  for (const t of tolerated) console.log(`      within tolerance: ${t}`);
  check(!errors.length, "no page errors (parity)", errors.join(" | "));
  await page.close();

  // ---- 2. the box in the clips area, on a real run of talk_40s.mp4
  const app = await ctx.newPage();
  const errs = []; app.on("pageerror", e => errs.push(e.message));
  await app.goto(BASE + "?model=Xenova/whisper-tiny.en&n=1&version=long&platform=tiktok", { waitUntil: "load" });
  await app.evaluate(() => localStorage.clear());
  await app.setInputFiles("#file", join(MEDIA, "talk_40s.mp4"));
  await app.click("#go");
  await app.waitForFunction(() => document.querySelector("#prog").classList.contains("hide") && document.querySelector('.qi[data-st="done"]'), null, { timeout: 900000, polling: 1000 });
  const n0 = await app.locator("#out .clip").count();
  check(n0 >= 1 && await app.locator("#findq").isVisible(), "the search box shows on the clips board", `${n0} clip(s)`);
  check(await app.evaluate(() => document.activeElement?.id !== "findq"), "search box not focused yet");
  await app.locator("body").click({ position: { x: 5, y: 5 } });
  await app.keyboard.press("/");
  check(await app.evaluate(() => document.activeElement?.id === "findq"), "/ jumps to the search box");

  if (BROWSER === "webkit-desktop") {
    // Safari can't load the search model after the speech model in one tab, so the box says so (and adds nothing)
    await app.keyboard.type("the biggest mistake I ever made");
    await app.keyboard.press("Enter");
    await app.waitForFunction(() => document.querySelector("#findMsg").dataset.kind === "warn", null, { timeout: 10000, polling: 100 });
    const said = await app.locator("#findMsg").textContent();
    check(/Safari/.test(said) && /Chrome, Firefox or the desktop app/.test(said) && await app.locator("#out .clip").count() === n0,
      "Safari: says search needs Chrome, Firefox or the desktop app, adds no clip", said);
  } else {
  // an unrelated query: a clear message, no clip
  await app.keyboard.type("a recipe for chocolate cake");
  await app.keyboard.press("Enter");
  await app.waitForFunction(() => { const m = document.querySelector("#findMsg"); return m.dataset.kind === "warn" || m.dataset.kind === "ok"; }, null, { timeout: 300000, polling: 250 });
  const none = await app.locator("#findMsg").textContent();
  check(/Nothing in this video matches/.test(none) && await app.locator("#out .clip").count() === n0, "unrelated query: says nothing matches, adds no clip", none);
  await app.keyboard.press("Escape");
  check(await app.inputValue("#findq") === "" && await app.locator("#findMsg").isHidden(), "Esc clears the box");

  // a real description: a new clip from the matching moment, labelled with the query, through the quality gate
  await app.fill("#findq", "the biggest mistake I ever made");
  await app.click("#findGo");
  await app.waitForFunction(() => { const m = document.querySelector("#findMsg"); return (m.dataset.kind === "warn" || m.dataset.kind === "ok"); }, null, { timeout: 600000, polling: 500 });
  const said = await app.locator("#findMsg").textContent();
  const added = /^Added 1 clip/.test(said), already = /already on the board/.test(said);
  check(added || already, "a description finds the moment", said);
  if (added) {
    check(await app.locator("#out .clip").count() === n0 + 1, "the match became a new clip");
    const card = app.locator("#out .clip").filter({ hasText: "Matches “the biggest mistake I ever made”" });
    check(await card.count() === 1, "the new clip says which description it matched");
    const v = await card.locator("video").evaluate(v => new Promise(r => { if (v.readyState >= 1) r(v.duration); v.addEventListener("loadedmetadata", () => r(v.duration), { once: true }); setTimeout(() => r(0), 8000); }));
    check(v > 8 && v < 25, "the new clip covers the opening", `${v.toFixed(1)}s`);
    check(/Matches/.test(await app.locator("#out .clip.sel").textContent()), "the new clip is selected on the board");
    // searching again for the same thing points at it instead of rendering a copy
    await app.fill("#findq", "the biggest mistake I ever made");
    await app.press("#findq", "Enter");
    await app.waitForFunction(() => /already on the board/.test(document.querySelector("#findMsg").textContent), null, { timeout: 120000, polling: 250 });
    check(await app.locator("#out .clip").count() === n0 + 1, "the same search again doesn't duplicate the clip");
  }
  }
  check(!errs.length, "no page errors (workflow)", errs.join(" | "));
} catch (err) {
  console.error(err); fails++;
} finally {
  const br = ctx.browser(); await ctx.close(); if (br) await br.close(); server.close(); await rm(tmp, { recursive: true, force: true });
}
console.log(`\n${fails ? fails + " failed" : "all checks passed"}`);
process.exit(fails ? 1 : 0);
