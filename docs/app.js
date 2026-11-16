import { FFmpeg } from "./vendor/ffmpeg/index.js";
import { toBlobURL } from "./vendor/util/index.js";
import * as X from "./formula.js";
import { zip, slug, fileBase, youtubeUploadCsv } from "./zip.js";
import { createStudio } from "./studio.js";

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTC = t => { t = Math.max(0, t || 0); return `${X.fmtT(t)}.${Math.floor((t % 1) * 10)}`; };
const icon = id => `<svg class="i" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const CORE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
const PN = { tiktok: "TikTok", reels: "Reels", shorts: "YT Shorts", facebook: "Facebook", snapchat: "Snapchat", x: "X" };
const DEF = { platform: "all", n: "3", version: "both", quality: "fast", model: "Xenova/whisper-base.en", format: "9:16",
              captions: "1", hook: "1", tighten: "1", enhance: "1", layout: "fit", style: "pop", hl: "#FFF000", size: "m", pos: "bottom",
              logo: "1", lpos: "tl", lsize: "m", lop: "0.7", lang: "en" };
const opts = { ...DEF };
// Spoken languages offered in the picker (Whisper codes). English uses the English-only models on the web, which are
// faster and more accurate for English; any other language switches to the multilingual model of the same size.
const LANGS = [["en", "English"], ["ar", "Arabic"], ["zh", "Chinese"], ["cs", "Czech"], ["da", "Danish"], ["nl", "Dutch"], ["fi", "Finnish"],
  ["fr", "French"], ["de", "German"], ["el", "Greek"], ["he", "Hebrew"], ["hi", "Hindi"], ["hu", "Hungarian"], ["id", "Indonesian"],
  ["it", "Italian"], ["ja", "Japanese"], ["ko", "Korean"], ["ms", "Malay"], ["no", "Norwegian"], ["pl", "Polish"], ["pt", "Portuguese"],
  ["ro", "Romanian"], ["ru", "Russian"], ["es", "Spanish"], ["sv", "Swedish"], ["tl", "Tagalog"], ["th", "Thai"], ["tr", "Turkish"],
  ["uk", "Ukrainian"], ["vi", "Vietnamese"]];
// DESK = set when this page is served by the desktop app: videos and links are processed by its native engine
// (faster-whisper + ffmpeg on this computer) instead of in the browser.
let DESK = null;
// A session = one source video: its file, transcript, settings and clips. The queue is the list of sessions.
let sessions = [], active = null, running = false, wakeLock = null, nextId = 1;
let selUid = null, filterKept = false, sortBy = "score";

// ---------------------------------------------------------------- small UI helpers
function toast(t) { const el = $("#toast"); el.textContent = t; el.classList.add("on"); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("on"), 2400); }
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); }
  catch { const a = document.createElement("textarea"); a.value = t; document.body.appendChild(a); a.select(); document.execCommand("copy"); a.remove(); }
}
function download(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }
const typing = e => e.target.closest?.("input, textarea, select, [contenteditable]") && !(e.target.type === "color");

// ---------------------------------------------------------------- settings (chips, presets)
function setChip(k, v, save = true) {
  if (k === "lang") {                              // a dropdown, not chips
    const sel = $("#lang");
    if (![...sel.options].some(o => o.value === v)) return;
    sel.value = v; opts.lang = v;
    $("#langSum").textContent = sel.selectedOptions[0].textContent.replace("Detect automatically", "auto-detect");
    if (save) { saveLast(); markCustom(); }
    return;
  }
  const g = document.querySelector(`.chips[data-k="${k}"]`);
  if (!g) return;
  const b = g.querySelector(`.chip[data-v="${CSS.escape(v)}"]`);
  if (k === "hl") {                               // a swatch, or the custom colour well
    if (!/^#[0-9a-f]{6}$/i.test(v)) return;
    g.querySelectorAll(".chip[data-v]").forEach(c => c.setAttribute("aria-pressed", c === b));
    $("#hlc").parentElement.dataset.on = !b;
    $("#hlc").value = v.toLowerCase();
    opts.hl = v.toUpperCase();
  } else {
    if (!b || b.disabled) return;
    g.querySelectorAll(".chip").forEach(c => c.setAttribute("aria-pressed", c === b));
    opts[k] = v;
  }
  if (k === "platform") showPlat();
  if (["logo", "lpos"].includes(k) && typeof paintBrand === "function") paintBrand();
  lookSummary();
  if (save) { saveLast(); markCustom(); }
}
$$(".chips[data-k]").forEach(g => g.addEventListener("click", e => {
  const b = e.target.closest(".chip[data-v]"); if (!b || b.disabled) return;
  setChip(g.dataset.k, b.dataset.v);
}));
$("#hlc").addEventListener("input", e => setChip("hl", e.target.value));
$("#lang").innerHTML = LANGS.map(([c, n]) => `<option value="${c}">${n}</option>`).join("");
$("#lang").addEventListener("change", e => { setChip("lang", e.target.value); preloadASR(); });
$("#cta").addEventListener("input", () => { saveLast(); markCustom(); });
function showPlat() {
  const p = X.F.platforms[opts.platform];
  $("#pnote").textContent = p.note;
  const s = `${p.short[0]}–${p.short[1]}s`, l = p.long ? `${p.long[0]}–${p.long[1]}s` : null;
  $("#vboth").textContent = l ? `Short ${s} + long ${l}` : "Short + long";
  $("#vshort").textContent = `Short only · ${s}`;
  $("#vlong").textContent = l ? `Long only · ${l}` : "Long only";
  $("#vboth").disabled = $("#vlong").disabled = !l;
  if (!l && opts.version !== "short") setChip("version", "short", false);
}
function lookSummary() {
  const lg = opts.logo === "1" && brand.url ? " · logo" : "";
  $("#lookSum").textContent = (opts.captions === "1" ? `${opts.style} · ${opts.size.toUpperCase()} · ${opts.format}` : `no captions · ${opts.format}`) + lg;
}

const PKEY = "clipmachine.presets", LKEY = "clipmachine.last";
const store = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
                set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const BKEY = "clipmachine.logo";
const brand = { url: store.get(BKEY, null), bytes: null, v: 1 };     // the brand logo (see "brand logo" below)
const BUILTIN = {
  "Default · vertical, all platforms": {},
  "Podcast → YouTube Shorts": { platform: "shorts", n: "5", version: "both", style: "pop", layout: "fit" },
  "Talking head → TikTok, filled": { platform: "tiktok", n: "5", layout: "crop", style: "pop", size: "l" },
  "Feed square · 1:1": { platform: "all", format: "1:1", style: "boxed", version: "short" },
  "Landscape highlights · 16:9": { platform: "x", format: "16:9", style: "clean", version: "long", layout: "fit" },
};
const snapshot = () => ({ ...opts, cta: $("#cta").value.trim().slice(0, 80) });
function applySettings(s) {
  const all = { ...DEF, ...s };
  for (const k of Object.keys(DEF)) setChip(k, all[k], false);
  $("#cta").value = s.cta || "";
  showPlat(); lookSummary();
}
let saveT;
function saveLast() { clearTimeout(saveT); saveT = setTimeout(() => store.set(LKEY, snapshot()), 300); }
function fillPresets(sel = "") {
  const saved = store.get(PKEY, {});
  $("#preset").innerHTML = `<option value="">Custom settings</option><optgroup label="Starters">${Object.keys(BUILTIN).map(n => `<option value="b:${esc(n)}">${esc(n)}</option>`).join("")}</optgroup>` +
    (Object.keys(saved).length ? `<optgroup label="Saved">${Object.keys(saved).map(n => `<option value="s:${esc(n)}">${esc(n)}</option>`).join("")}</optgroup>` : "");
  $("#preset").value = sel;
  $("#pdel").disabled = !sel.startsWith("s:");
}
function markCustom() { if ($("#preset").value) { $("#preset").value = ""; $("#pdel").disabled = true; } }
$("#preset").onchange = e => {
  const v = e.target.value; if (!v) return;
  const s = v.startsWith("b:") ? BUILTIN[v.slice(2)] : store.get(PKEY, {})[v.slice(2)];
  if (s) { applySettings(s); store.set(LKEY, snapshot()); toast(`Preset applied: ${v.slice(2)}`); }
  $("#pdel").disabled = !v.startsWith("s:");
};
$("#psave").onclick = () => { $("#psaveForm").classList.toggle("hide"); if (!$("#psaveForm").classList.contains("hide")) $("#pname").focus(); };
$("#psaveForm").onsubmit = e => {
  e.preventDefault();
  const n = $("#pname").value.trim().slice(0, 40); if (!n) return $("#pname").focus();
  const saved = store.get(PKEY, {}); saved[n] = snapshot(); store.set(PKEY, saved);
  fillPresets("s:" + n); $("#psaveForm").classList.add("hide"); $("#pname").value = "";
  toast(`Saved preset "${n}"`);
};
$("#pdel").onclick = () => {
  const v = $("#preset").value; if (!v.startsWith("s:")) return;
  const saved = store.get(PKEY, {}); delete saved[v.slice(2)]; store.set(PKEY, saved); fillPresets(""); toast("Preset deleted");
};

// ---------------------------------------------------------------- progress
function setStage(label, pct, msg = "") {
  $("#prog").classList.remove("hide");
  const many = sessions.filter(s => s.batch).length;
  const pre = running && many > 1 ? `Video ${sessions.filter(s => s.batch && (s.status === "done" || s.status === "error")).length + 1} of ${many} · ` : "";
  $("#plabel").textContent = pre + label; $("#ppct").textContent = Math.round(pct) + "%";
  $("#pbar").style.width = Math.max(0, Math.min(100, pct)) + "%"; $("#pmsg").textContent = msg;
  const s = sessions.find(x => x.status === "running");
  if (s) { s.pct = pct; s.msg = label.replace(/…$/, ""); paintQueueItem(s); }
}
const STAGES = { load: [0, 8], audio: [8, 14], asr: [14, 60], score: [60, 62], render: [62, 100] };
const stage = (k, pct, label, msg) => { const [a, b] = STAGES[k]; setStage(label, a + (b - a) * pct / 100, msg); };
// stage timings for benchmarks: window.__perf = [{ k, ms }, ...]
const perf = { t: 0, rows: [], start() { this.rows = []; this.t = performance.now(); window.__perf = this.rows; },
  lap(k) { const n = performance.now(); this.rows.push({ k, ms: Math.round(n - this.t) }); this.t = n; } };

// ---------------------------------------------------------------- ffmpeg engines
// One engine = one ffmpeg.wasm worker (single-threaded). E0 probes, reads audio and renders; on multi-core
// computers extra engines render other moments at the same time, and a separate edit engine re-renders studio
// edits while a batch keeps going. Each engine has one source mounted at /in.
const newEngine = () => ({ ff: null, logs: [], cache: new Map(), mounted: null, file: null });
const E0 = newEngine();
let EE = null, core = null, font = null;
const getCore = () => core ||= Promise.all([toBlobURL(`${CORE}/ffmpeg-core.js`, "text/javascript"), toBlobURL(`${CORE}/ffmpeg-core.wasm`, "application/wasm")])
  .catch(e => { core = null; throw e; });
const getFont = () => font ||= fetch("./fonts/Montserrat-Black.ttf").then(r => r.arrayBuffer()).catch(e => { font = null; throw e; });
async function loadEngine(E, quiet = false) {
  if (E.ff) return E.ff;
  if (!quiet) stage("load", 10, "Loading video engine…", "First run downloads ~30 MB. It's cached after that.");
  markUsed();
  const ff = new FFmpeg();
  ff.on("log", ({ message }) => { E.logs.push(message); if (E.logs.length > 4000) E.logs.splice(0, 2000); });
  const [coreURL, wasmURL] = await getCore();
  await ff.load({ coreURL, wasmURL });
  await ff.createDir("/fonts");
  await ff.writeFile("/fonts/Montserrat-Black.ttf", new Uint8Array((await getFont()).slice(0)));   // a copy: writeFile hands its buffer to the worker
  await ff.createDir("/in");
  E.ff = ff; E.mounted = null; E.logoV = 0;
  return ff;
}
// Throw an engine away (a fresh worker gets a fresh WebAssembly heap: WebKit never gives memory back).
function dropEngine(E) { try { E.ff?.terminate(); } catch {} E.ff = null; E.mounted = null; E.file = null; E.cache.clear(); }
async function mountSrc(E, sess) {
  if (E.mounted === sess.id) return;
  try { await E.ff.unmount("/in"); } catch {}
  await E.ff.mount("WORKERFS", { files: [sess.file] }, "/in");
  E.mounted = sess.id; E.file = sess.file;
}
const UA = navigator.userAgent;
const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);   // every iOS browser is WebKit
const IS_WEBKIT = IS_IOS || (/AppleWebKit/.test(UA) && !/Chrome|Chromium|Edg|Firefox|Android/.test(UA));
const TIGHT = IS_WEBKIT || /Android|Mobi/i.test(UA);          // little WebAssembly memory to spare: one engine only
// How many clips to render at once: several on desktop Chrome/Firefox/Edge, one where memory is tight.
function renderSlots() {
  if (TIGHT) return 1;
  const cores = navigator.hardwareConcurrency || 2, gb = navigator.deviceMemory || 4;
  return Math.max(1, Math.min(3, Math.floor(cores / 2), Math.floor(gb / 2)));
}
const editEngine = () => TIGHT ? E0 : (EE ||= newEngine());
async function spareEngine(sess) {
  const E = newEngine();
  await withTimeout(loadEngine(E, true), 40000);
  await mountSrc(E, sess);
  return E;
}
// Safari/WebKit can run out of WebAssembly memory after transcribing a longer video: the video engine then
// stalls without an error (tested: WebKit fails above ~1 min of speech on an 8 GB Mac; Chrome and Firefox don't).
const OOM = "This browser ran out of memory for video editing. " + (IS_IOS
  ? "On iPhone and iPad every browser uses Safari's engine, which tops out around a minute of video. Use a shorter video, or a computer with Chrome or the free desktop app."
  : "Safari is the usual cause with videos over about a minute. Try Chrome, Edge or Firefox, a shorter video, or the free desktop app.")
  + (IS_WEBKIT ? " If this tab has already clipped a video, open Clip Machine in a new tab first: Safari keeps that memory even after a reload." : "");
const DESKTOP_URL = "https://github.com/blin0908/clip-machine/releases/latest";
const linkDesktop = html => html.replace(/(the (?:free )?desktop app)/, `<a href="${DESKTOP_URL}" target="_blank" rel="noopener">$1</a>`);
// A tab opened with noopener gets a fresh WebKit process; a reload keeps the old one, with the memory it holds.
const linkTab = html => html.replace(/(open Clip Machine in a new tab)/, `<a href="${esc(location.href)}" target="_blank" rel="noopener">$1</a>`);
// Safari: remember (for this tab only) that it has loaded the engines, so a reload can offer a fresh tab first.
const USED = "clipmachine.tabUsed";
const markUsed = () => { if (IS_WEBKIT && !DESK) try { sessionStorage.setItem(USED, "1"); } catch {} };
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, bad) => setTimeout(() => bad(new Error(OOM)), ms))]);
async function writeFS(path, data, E = E0) { E.cache.set(path, data); await E.ff.writeFile(path, data); }
async function resetFFmpeg(E = E0) {      // a fresh engine with the source re-mounted, to recover a stalled worker
  try { E.ff?.terminate(); } catch {}
  E.ff = null;
  const file = E.file, id = E.mounted;
  await withTimeout((async () => {
    await loadEngine(E, true);
    if (file) { await E.ff.mount("WORKERFS", { files: [file] }, "/in"); E.mounted = id; E.file = file; }
    for (const [p, d] of E.cache) await E.ff.writeFile(p, d instanceof Uint8Array ? d.slice() : d);
  })(), 40000);
}
async function run(args, onTime, retry = true, E = E0) {
  E.logs = [];
  // stalled = the engine never printed a single line within 60 s (WebKit's out-of-memory signature). A long silence
  // mid-run is NOT treated as a stall: slow browsers (Firefox, older phones) can go quiet while loading caption fonts.
  const t0 = Date.now(); let last = 0, stalled = false;
  const h = ({ time }) => { last = Date.now(); if (onTime && time > 0) onTime(time / 1e6); };
  const lg = () => { last = Date.now(); };
  const ff = E.ff;
  if (!ff) throw new Error("Cancelled.");
  ff.on("progress", h); ff.on("log", lg);
  const wd = setInterval(() => {
    const now = Date.now();
    // Safari also stalls mid-render when memory runs out: 2 minutes of total silence there is a stall, not a slow step
    if ((!last && now - t0 > 60000) || (IS_WEBKIT && last && now - last > 120000)) { stalled = true; clearInterval(wd); try { ff.terminate(); } catch {} }
  }, 3000);
  try {
    const code = await ff.exec(args);
    return { code, log: E.logs.join("\n") };
  } catch (e) {
    if (!stalled) throw e;
    if (!retry) throw new Error(OOM);
    await resetFFmpeg(E);
    return run(args, onTime, false, E);
  } finally {
    clearInterval(wd); try { ff.off("progress", h); ff.off("log", lg); } catch {}
  }
}
function probeLog(log) {
  const d = log.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const v = log.split("\n").filter(l => !/attached pic/.test(l)).join("\n").match(/Video: (\w+).*?, (\d{2,5})x(\d{2,5})/);  // cover art isn't video
  const fps = log.match(/([\d.]+) fps/);
  return { duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0, vcodec: v?.[1], width: v ? +v[2] : 0, height: v ? +v[3] : 0,
           fps: fps ? +fps[1] : 30, hasVideo: !!v, acodec: (log.match(/Audio: (\w+)/) || [])[1],
           square: !/SAR (?!1:1)\d+:\d+/.test(log.match(/Video: .*/)?.[0] || "") };
}

// ---------------------------------------------------------------- paste a link
// A web page can only download a video file whose server allows it (CORS). Video sites don't, so those go to the desktop app.
const SITES = { "youtube.com": "YouTube", "youtu.be": "YouTube", "tiktok.com": "TikTok", "twitch.tv": "Twitch", "x.com": "X", "twitter.com": "X",
  "instagram.com": "Instagram", "facebook.com": "Facebook", "fb.watch": "Facebook", "vimeo.com": "Vimeo", "kick.com": "Kick", "reddit.com": "Reddit",
  "rumble.com": "Rumble", "dailymotion.com": "Dailymotion", "soundcloud.com": "SoundCloud", "snapchat.com": "Snapchat", "linkedin.com": "LinkedIn", "threads.net": "Threads" };
const siteOf = host => { host = host.toLowerCase(); for (const d in SITES) if (host === d || host.endsWith("." + d)) return SITES[d]; return null; };
let linkAbort = null;
const mb = n => (n / 1e6).toFixed(n < 1e7 ? 1 : 0);
async function fetchVideo(url, prog) {       // download with progress, prog(pct | null, msg); throws on CORS/network/non-video
  linkAbort = new AbortController();
  prog(0, "Connecting…");
  try {
    const r = await fetch(url, { signal: linkAbort.signal });
    if (!r.ok) throw Object.assign(new Error(`The link returned an error (${r.status}).`), { kind: "http" });
    const type = (r.headers.get("content-type") || "").split(";")[0].trim();
    if (/^text\/|json|xml/.test(type)) throw Object.assign(new Error("That link opens a web page, not a video file."), { kind: "page" });
    const total = +r.headers.get("content-length") || 0;
    const parts = []; let got = 0;
    if (r.body?.getReader) {
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); got += value.length;
        prog(total ? 100 * got / total : null, total ? `${mb(got)} of ${mb(total)} MB · ${Math.round(100 * got / total)}%` : `${mb(got)} MB downloaded`);
      }
    } else { const b = await r.arrayBuffer(); parts.push(new Uint8Array(b)); got = b.byteLength; }
    if (!got) throw Object.assign(new Error("That link returned an empty file."), { kind: "http" });
    prog(100, `${mb(got)} MB · done`);
    let name = "video.mp4";
    try { name = decodeURIComponent(new URL(r.url || url).pathname.split("/").pop()) || name; } catch {}
    if (!/\.[a-z0-9]{2,4}$/i.test(name)) name += ".mp4";
    return new File(parts, name, { type: type && type !== "application/octet-stream" ? type : "video/mp4" });
  } finally { linkAbort = null; }
}
function linkProg(pct, msg) {                 // inline bar under the link box; null = size unknown, creep toward 95%
  const bar = $("#lbar"), el = $("#lprog");
  if (pct == null) pct = Math.min(95, (parseFloat(bar.style.width) || 0) + (95 - (parseFloat(bar.style.width) || 0)) * 0.02);
  bar.style.width = pct + "%"; el.setAttribute("aria-valuenow", Math.round(pct)); $("#lmsg").textContent = msg;
}
function setTab(link) {
  $("#tabFile").setAttribute("aria-selected", !link); $("#tabLink").setAttribute("aria-selected", link);
  $("#paneFile").classList.toggle("hide", link); $("#paneLink").classList.toggle("hide", !link);
  if (link) $("#link").focus();
}
function linkNote(title, why) {
  $("#lnote").innerHTML = `<b>${esc(title)}</b> ${esc(why)}<div class="btns">` +
    `<a class="lbtn pri" href="${DESKTOP_URL}" target="_blank" rel="noopener">Get the free desktop app</a>` +
    `<button type="button" class="lbtn" data-act="copy">Copy link</button>` +
    `<button type="button" class="lbtn" data-act="file">Upload a file instead</button></div>`;
  $("#lnote").classList.remove("hide");
}
$("#tabFile").onclick = () => setTab(false);
$("#tabLink").onclick = () => setTab(true);
$("#link").oninput = () => $("#lnote").classList.add("hide");
$("#lcancel").onclick = () => linkAbort?.abort();
$("#lnote").onclick = e => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "file") setTab(false);
  if (act === "copy") navigator.clipboard?.writeText($("#link").value.trim()).then(() => toast("Link copied. Paste it into the desktop app."), () => toast("Couldn't copy. Select the link and copy it."));
};
$("#linkForm").onsubmit = async e => {
  e.preventDefault();
  let raw = $("#link").value.trim(), u;
  if (!raw) { $("#link").focus(); return; }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = "https://" + raw;
  try {
    u = new URL(raw);
    if (/\s/.test($("#link").value.trim()) || !/^https?:$/.test(u.protocol) || !/\.|^localhost$|^\[/.test(u.hostname)) throw 0;
  } catch { linkNote("That doesn't look like a link.", "Copy the full address from your browser or the app's Share button, then paste it here."); return; }
  $("#link").value = raw;
  if (DESK) { addSources([{ link: u.href }]); $("#link").value = ""; setTab(false); toast("Link added. The desktop app downloads it when you press Find the moments."); return; }
  const site = siteOf(u.hostname);
  if (site) { linkNote(`${site} links need the free desktop app.`, `${site} doesn't let websites download its videos. The desktop app downloads it on your own computer and makes the clips. It's free too, and works on Mac, Windows and Linux.`); return; }
  $("#lnote").classList.add("hide"); $("#lbar").style.width = "0%"; $("#lprog").classList.remove("hide");
  $("#link").disabled = $("#linkGo").disabled = $("#tabFile").disabled = true;
  try {
    const f = await fetchVideo(u.href, linkProg);
    addFiles([f]); setTab(false); $("#link").value = "";
    toast("Video added. Pick your settings, then Find the moments.");
  } catch (err) {
    if (err.name === "AbortError") toast("Download cancelled.");
    else if (err.kind === "page") linkNote(err.message, "Paste a link that goes straight to an .mp4 or .mov file, or use the desktop app, which handles links to most video sites.");
    else if (err.kind === "http") linkNote(err.message, "Check the link opens the video in your browser, or download the video and upload the file.");
    else linkNote("That site won't let this page download the video.", "Most websites block it. The desktop app downloads it on your own computer instead, or you can save the video and upload the file.");
  } finally {
    $("#lprog").classList.add("hide");
    $("#link").disabled = $("#linkGo").disabled = $("#tabFile").disabled = false;
  }
};

// ---------------------------------------------------------------- queue
const isMedia = f => /^(video|audio)\//.test(f.type) || /\.(mp4|mov|m4v|mkv|webm|avi|mp3|m4a|wav|aac|ogg|flac)$/i.test(f.name);
function addFiles(list) {
  const files = [...list].filter(isMedia);
  if (!files.length) { if (list.length) toast("Those aren't video or audio files."); return; }
  addSources(files.map(f => ({ file: f })));
}
const shortLink = u => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, "") + x.pathname + x.search).slice(0, 60); } catch { return u.slice(0, 60); } };
function addSources(srcs) {
  const added = srcs.map(({ file = null, link = null }) => ({ id: nextId++, file, link, name: file ? file.name : shortLink(link),
    title: file ? file.name.replace(/\.[^.]+$/, "") : shortLink(link), status: running ? "queued" : "ready", pct: 0, msg: "", clips: [], batch: running, url: null }));
  sessions.push(...added);
  if (!active || (!active.clips.length && active.status !== "running")) setActive(added[0]);
  paintQueue(); paintGo(); preloadASR();
  if (running) toast(`${added.length} video${added.length > 1 ? "s" : ""} added to the queue`);
}
$("#file").onchange = e => { addFiles(e.target.files); e.target.value = ""; };
$("#emptyAdd").onclick = () => $("#file").click();
function setActive(s) {
  if (active === s) { paintQueue(); renderBoard(); return; }
  active = s; selUid = null; txState.dirty = true;
  paintQueue(); renderBoard();
  if (!$("#pTx").hidden) renderTranscript();
  if (s?.remote && !s.loaded && !s.loading && s.status === "done") {             // a past desktop job: fetch its clips and transcript
    s.loading = true;
    api(`api/jobs/${encodeURIComponent(s.jid)}`).then(j => loadRemote(s, j)).catch(e => { s.status = "error"; s.err = friendly(e); })
      .finally(() => { s.loading = false; paintQueue(); if (active === s) { renderBoard(); if (!$("#pTx").hidden) renderTranscript(); } });
  }
}
function qStatus(s) {
  if (s.status === "running") return s.msg || "Working";
  if (s.status === "queued") return s.prep?.words ? "Transcribed · renders next" : s.prep ? "Audio read · transcribes next" : "Queued";
  if (s.status === "error") return "Error: " + (s.err || "").slice(0, 60);
  if (s.remote && !s.loaded) return s.loading ? "Loading…" : "Saved on this computer";
  if (s.status === "done") return `${s.clips.length} clip${s.clips.length === 1 ? "" : "s"}${s.info ? " · " + X.fmtT(s.capped || s.info.duration) : ""}`;
  return s.file ? `Ready · ${mb(s.file.size)} MB` : "Ready · link";
}
function paintQueue() {
  const q = $("#queue");
  q.innerHTML = sessions.map(s => `<div class="qi" role="button" tabindex="0" data-sid="${s.id}" data-st="${s.status}" aria-current="${s === active}">
      <span class="n" title="${esc(s.name)}">${esc(s.name)}</span>
      <span class="s"><span class="dot"></span><span class="qs">${esc(qStatus(s))}</span></span>
      ${s.status === "running" || s.status === "queued" ? "" : `<button class="x" data-rm="${s.id}" aria-label="Remove ${esc(s.name)}">${icon("x")}</button>`}
      ${s.status === "running" ? `<span class="qb"><i style="width:${s.pct || 0}%"></i></span>` : ""}</div>`).join("");
  $("#fname").textContent = sessions.length ? "Add more videos" : "Add videos";
}
function paintQueueItem(s) {
  const el = document.querySelector(`.qi[data-sid="${s.id}"]`); if (!el) return;
  el.querySelector(".qs").textContent = qStatus(s);
  const b = el.querySelector(".qb i"); if (b) b.style.width = (s.pct || 0) + "%";
}
function paintGo() {
  const n = sessions.filter(s => s.status === "ready").length;
  $("#go").disabled = running || !n;
  $("#goLabel").textContent = running ? "Working…" : n > 1 ? `Find the moments · ${n} videos` : "Find the moments";
}
$("#queue").addEventListener("click", e => {
  const rm = e.target.closest("[data-rm]");
  if (rm) { removeSession(+rm.dataset.rm); return; }
  const it = e.target.closest(".qi"); if (it) setActive(sessions.find(s => s.id === +it.dataset.sid));
});
$("#queue").addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("qi")) { e.preventDefault(); e.target.click(); } });
async function removeSession(id) {
  const s = sessions.find(x => x.id === id); if (!s || s.status === "running" || s.status === "queued") return;
  if (jobNow?.sess === s) { toast("Wait for this video's edit to finish rendering."); return; }
  if (s.remote) {                                   // desktop app: removing deletes the job and its files from this computer
    if (!confirm(`Delete "${s.name}" from this computer? Its clips and the saved video are removed.`)) return;
    const r = await fetch(`api/jobs/${encodeURIComponent(s.jid)}`, { method: "DELETE" }).catch(() => null);
    if (!r || (!r.ok && r.status !== 404)) { toast("Couldn't delete it. Check the desktop app is still running."); return; }
  } else if (s.clips.some(c => c.kept) && !confirm(`Remove "${s.name}" and its kept clips?`)) return;
  for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].sess === s) {   // drop its edits still waiting to render
    const [j] = jobs.splice(i, 1); j.state = "failed"; j.resolve?.({ ok: false, msg: "The video was removed." });
  }
  for (const c of s.clips) revokeClip(c);
  if (s.url) URL.revokeObjectURL(s.url);
  sessions = sessions.filter(x => x !== s);
  for (const E of [EE, E0]) if (E?.mounted === s.id) { E.mounted = null; E.file = null; }
  if (active === s) { active = null; setActive(sessions.at(-1) || null); }
  paintQueue(); paintGo(); renderBoard();
}
const srcURL = s => s.remote ? `api/jobs/${encodeURIComponent(s.jid)}/source` : (s.url ||= URL.createObjectURL(s.file));

// drag & drop anywhere
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
addEventListener("dragenter", e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $("#dropzone").classList.remove("hide"); });
addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener("dragleave", e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $("#dropzone").classList.add("hide"); } });
addEventListener("drop", e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; $("#dropzone").classList.add("hide"); addFiles(e.dataTransfer.files); });

// ---------------------------------------------------------------- transcription
// The speech worker keeps its model loaded between videos (and starts loading it when a file is picked), except on
// Safari/iOS: there the model and the video engine never hold memory at the same time (see processSession), so the
// worker is dropped as soon as the words are back.
let asrW = null, asrReject = null;
const asrWorker = () => asrW ||= (markUsed(), new Worker(new URL("./asr-worker.js", import.meta.url), { type: "module" }));
const dropASR = () => { try { asrW?.terminate(); } catch {} asrW = null; };
const asrModel = () => opts.lang === "en" ? opts.model : opts.model.replace(/\.en$/, "");   // multilingual twin of the chosen size
function preloadASR() { if (!IS_WEBKIT && !DESK) asrWorker().postMessage({ type: "preload", model: asrModel() }); }
const ASR_SILENCE = 150000;      // no word from the speech model for this long = stalled (out of memory), not slow
function transcribe(pcm, windows, model, keep = false, language = "en") {
  return new Promise((resolve, reject) => {
    const w = asrWorker();
    let dev = "", dog = 0;
    const stall = () => { clearTimeout(dog); dog = setTimeout(() => { asrReject = null; dropASR();
      reject(new Error("The speech model stopped responding. " + (IS_WEBKIT ? "Safari keeps memory from earlier videos in a tab, even after a reload. To carry on, open Clip Machine in a new tab, or use Chrome or the free desktop app." : "Reload the page and try again."))); }, ASR_SILENCE); };
    stall();
    asrReject = e => { clearTimeout(dog); reject(e); };
    w.onmessage = ({ data: d }) => {
      stall();
      if (d.type === "load") stage("asr", 0, d.loaded < d.total ? "Loading speech model…" : "Preparing speech model…",
        d.loaded < d.total ? `${(d.loaded / 1e6).toFixed(0)} / ${(d.total / 1e6).toFixed(0)} MB (cached after first use)` : "Takes a moment on the first video only.");
      if (d.type === "device") { dev = d.device === "webgpu" ? " · GPU" : ""; perf.lap(`model load (${d.device})`); }
      if (d.type === "progress") stage("asr", 100 * d.done / d.total, "Transcribing…", `${X.fmtT(d.upto)} done${dev}`);
      if (d.type === "done") { clearTimeout(dog); asrReject = null; if (IS_WEBKIT && !keep) dropASR(); resolve(d.words); }
      if (d.type === "error") { clearTimeout(dog); asrReject = null; dropASR(); reject(new Error("Speech model: " + d.message)); }
    };
    w.postMessage({ audio: pcm, windows, model, language });
  });
}

// ---------------------------------------------------------------- render + quality gate
// look = the per-cut choices the studio can change: { style, hl, size, pos, format, layout, cx, cy, tighten, captions, hook }
const lookFrom = o => ({ style: o.style, hl: o.hl, size: o.size, pos: o.pos, format: o.format, layout: o.layout, cx: 0.5, cy: 0.5,
                         tighten: o.tighten, captions: o.captions, hook: o.hook,
                         logo: !!o.logo, lpos: o.lpos || "tl", lsize: o.lsize || "m", lop: X.logoOpacity(o.lop) });
function filterGraph(m, keep, info, o, hasASS) {
  const [W, H] = X.frameSize(o.format, o.hd);
  const fps = Math.round(Math.min(Math.max(info.fps || 30, 23), 60));
  let pre = `fps=${fps}`;
  if (o.enhance && info.height && info.height < 720) pre = "hqdn3d=2:1.5:3:3," + pre;
  let apre = "anull";
  if (keep.length > 1) {
    const sel = keep.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join("+");
    pre += `,select='${sel}',setpts=N/FRAME_RATE/TB`; apre = `aselect='${sel}',asetpts=N/SR/TB`;
  }
  let vf;
  const sharpen = o.enhance ? ",unsharp=5:5:0.45:5:5:0,eq=contrast=1.04:saturation=1.07" : "";
  const cx = Math.min(1, Math.max(0, o.cx ?? 0.5)).toFixed(3), cy = Math.min(1, Math.max(0, o.cy ?? 0.5)).toFixed(3);
  if (o.layout === "crop") vf = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-ow)*${cx}:(ih-oh)*${cy}${sharpen}`;
  else {
    // blurred backdrop: blur a 1/8-size copy and scale it up (looks the same, ~5x less work than blurring full size);
    // only the visible video gets sharpened, since sharpening a blur is wasted work
    const bw = Math.round(W / 16) * 2, bh = Math.round(H / 16) * 2;
    vf = `split[a][b];[a]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=${o.hd ? 3 : 2}:2,` +
         `scale=${W}:${H}:flags=bilinear,eq=brightness=-0.08[bg];` +
         `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease${sharpen}[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2`;
  }
  if (o.enhance && keep.length > 1) {
    let t = 0; const z = [];
    keep.forEach(([a, b], k) => { const s = t; t += b - a; if (k % 2) z.push(`between(on,${Math.floor(s * fps)},${Math.max(Math.floor(t * fps) - 1, Math.floor(s * fps))})`); });
    if (z.length) vf += `,zoompan=z='if(${z.join("+")},1.08,1)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps}`;
  }
  // brand logo (input #1): laid over the picture under the captions, so a long headline draws on top of it
  const lg = o.logo ? `[pv];${X.logoChain(o.format, o, "[pv]", 1, o.hd)}` : "";
  vf += lg;
  if (hasASS) vf += ",ass=/sub.ass:fontsdir=/fonts";
  vf += ",setsar=1";   // square pixels: scale/crop rounding otherwise leaves SAR 10240:10239 (players show 719 px)
  const clean = o.enhance ? "highpass=f=80,afftdn=nr=10:nf=-40,equalizer=f=3200:t=q:w=1.2:g=2.5,acompressor=threshold=-20dB:ratio=2.5:attack=10:release=150:makeup=2," : "";
  const aout = `${clean}loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a]`;
  if (!info.hasVideo) {    // audio-only source (podcast, voice memo): captions over a moving waveform
    const ass = hasASS ? ",ass=/sub.ass:fontsdir=/fonts" : "";
    return { fc: `[0:a]${apre},asplit[aw][am];color=c=0x101018:s=${W}x${H}:r=${fps}[bg];` +
      `[aw]showwaves=s=${W}x${Math.round(H * 0.22)}:mode=cline:colors=0xF2C230:rate=${fps}[wv];` +
      `[bg][wv]overlay=0:(H-h)/2:shortest=1,format=yuv420p${lg}${ass},setsar=1[v];[am]${aout}`, fps, W, H, audiogram: true };
  }
  return { fc: `[0:v]${pre},${vf}[v];[0:a]${apre},${aout}`, fps, W, H };
}

// ---------------------------------------------------------------- brand logo
// One logo per browser (a PNG data URL, at most 512 px). Inside the desktop app the app's copy is the source of truth.
// ---------------------------------------------------------------- caption fonts for other scripts
// Montserrat ships with the page; a clip in Greek, Arabic, Hebrew, Hindi, Thai, Japanese, Korean or Chinese needs its
// Noto Sans Black, fetched once per page (the service worker keeps pinned CDN files across visits).
const fontBytes = new Map();
async function fontIntoEngine(E, f) {
  if (!f?.url) return;
  const path = `/fonts/${f.file}`;
  if (E.cache.has(path)) return;
  if (!fontBytes.has(f.file)) {
    const r = await fetch(f.url).catch(() => null);
    if (!r?.ok) throw new Error(`Couldn't load the ${f.label} caption font (${f.mb} MB). Check your connection and try again.`);
    fontBytes.set(f.file, new Uint8Array(await r.arrayBuffer()));
  }
  E.cache.set(path, fontBytes.get(f.file));
  await E.ff.writeFile(path, fontBytes.get(f.file).slice());   // a copy: writeFile hands its buffer to the worker
}
async function brandIntoEngine(E) {
  if (E.logoV === brand.v) return;
  brand.bytes ||= new Uint8Array(await (await fetch(brand.url)).arrayBuffer());
  E.cache.set("/logo.png", brand.bytes);
  await E.ff.writeFile("/logo.png", brand.bytes.slice());   // a copy: writeFile hands its buffer to the worker
  E.logoV = brand.v;
}
function setBrand(url) {                      // url: a PNG data URL, or null to remove
  brand.url = url; brand.bytes = null; brand.v++;
  try { url ? localStorage.setItem(BKEY, JSON.stringify(url)) : localStorage.removeItem(BKEY); } catch {}
  paintBrand();
}
function paintBrand() {
  $("#logoPrev").hidden = !brand.url;
  if (brand.url) $("#logoPrev img").src = brand.url;
  $("#logoPick").textContent = brand.url ? "Replace logo" : "Add a logo";
  $("#logoDel").hidden = !brand.url;
  $("#brandSum").textContent = !brand.url ? "no logo" : opts.logo === "1" ? `logo · ${opts.lpos === "tr" ? "top right" : "top left"}` : "logo off";
  document.querySelectorAll('#brandOpts .chips').forEach(g => g.classList.toggle("off", !brand.url));
  lookSummary();
}
// any image → a PNG at most 512 px on its long side (keeps transparency)
async function toLogoPNG(file) {
  const img = await createImageBitmap(file);
  const k = Math.min(1, 512 / Math.max(img.width, img.height));
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(img.width * k)); cv.height = Math.max(1, Math.round(img.height * k));
  cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
  const blob = await new Promise(r => cv.toBlob(r, "image/png"));
  const url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
  return { blob, url };
}
$("#logoPick").onclick = () => $("#logoFile").click();
$("#logoFile").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const { blob, url } = await toLogoPNG(f);
    if (DESK) {
      const r = await fetch("api/brand/logo", { method: "POST", headers: { "Content-Type": "image/png" }, body: blob });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "The desktop app didn't take the logo.");
    }
    setBrand(url); setChip("logo", "1");
    toast("Logo added. New clips get it in the corner.");
  } catch (err) { toast("Couldn't use that image: " + (err.message || "try a PNG or JPG")); }
});
$("#logoDel").onclick = async () => {
  if (DESK) await fetch("api/brand/logo", { method: "DELETE" }).catch(() => {});
  setBrand(null); toast("Logo removed");
};

async function renderClip(sess, m, look, cta, onPct, E = E0) {
  const o = { ...sess.o, ...look };
  const keep = X.keepIntervals(m, o.tighten, sess.quiet);
  const plat = X.F.platforms[o.platform];
  const hasASS = (o.captions && m.words.length) || (o.hook && m.title) || cta;
  if (hasASS) await writeFS("/sub.ass", X.buildASS(m, plat, keep, { captions: o.captions, hook: o.hook, cta, style: o.style, hl: o.hl, size: o.size, pos: o.pos, format: o.format }), E);
  if (hasASS) await fontIntoEngine(E, X.captionFont(m));
  o.logo = !!(o.logo && brand.url);
  if (o.logo) await brandIntoEngine(E);
  const { fc, fps, W, H, audiogram } = filterGraph(m, keep, sess.info, o, hasASS);
  const dur = m.end - m.start, expected = keep.reduce((a, [x, y]) => a + y - x, 0);
  // the quality detectors ride along on the render (black/freeze on the final picture, silence/loudness on the final audio),
  // so the clip isn't decoded a second time just to check it
  const taps = `;[v]split[vo][vq];[vq]blackdetect=d=0.5:pix_th=0.10,freezedetect=n=-60dB:d=2,nullsink` +
               `;[a]asplit[ao][aq];[aq]silencedetect=n=-45dB:d=2,ebur128=peak=true,anullsink`;
  const r = await run(["-ss", m.start.toFixed(3), "-t", dur.toFixed(3), "-i", sess.path, ...(o.logo ? ["-i", "/logo.png"] : []), "-filter_complex", fc + taps, "-map", "[vo]", "-map", "[ao]",
    "-c:v", "libx264", "-preset", o.hd ? "veryfast" : "ultrafast", "-crf", o.hd ? "20" : "22", "-pix_fmt", "yuv420p",
    "-r", String(fps), "-g", String(fps * 2), "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", "-shortest", "/out.mp4"],
    t => onPct(Math.min(95, 95 * t / Math.max(expected, 1))), true, E);
  perf.lap(`render ${expected.toFixed(0)}s`);
  if (r.code !== 0) throw new Error("Render failed: " + r.log.split("\n").slice(-4).join(" "));
  // format, size and length come from the finished file itself (a header read, no decoding)
  const q = await run(["-hide_banner", "-i", "/out.mp4"], null, true, E);
  perf.lap("check");
  const data = await E.ff.readFile("/out.mp4");
  await run(["-ss", "0.6", "-i", "/out.mp4", "-frames:v", "1", "-vf", "scale=360:-2", "/thumb.jpg"], null, true, E);
  let thumb = null; try { thumb = URL.createObjectURL(new Blob([(await E.ff.readFile("/thumb.jpg")).buffer], { type: "image/jpeg" })); await E.ff.deleteFile("/thumb.jpg"); } catch {}
  await E.ff.deleteFile("/out.mp4");
  perf.lap("thumb");
  const blob = new Blob([data.buffer], { type: "video/mp4" });
  const quality = qualityChecks(q.log, r.log, { expected, W, H, sizeMB: blob.size / 1e6, m, captions: o.captions, audiogram });
  const fillers = o.tighten ? m.words.filter(w => w.s >= m.start && w.s <= m.end && X.F.fillerSet.has(w.w.toLowerCase().replace(/[^a-z]/g, ""))).length : 0;
  return { blob, url: URL.createObjectURL(blob), thumb, quality, duration: +expected.toFixed(1), cuts: keep.length - 1, fps, W, H,
           size_mb: +(blob.size / 1e6).toFixed(1), fillers_cut: fillers, enhanced: o.enhance, srt: X.buildSRT(m, keep), look: { ...look } };
}

function qualityChecks(fileLog, log, { expected, W, H, sizeMB, m, captions, audiogram }) {
  const c = [], add = (k, ok, detail, hard) => c.push({ k, ok: !!ok, detail, hard });
  const p = probeLog(fileLog);
  add("Upload-ready format", p.vcodec === "h264" && p.acodec === "aac" && p.width === W && p.height === H && p.square,
    `${p.vcodec} ${p.width}×${p.height} + ${p.acodec}${p.square ? "" : ", non-square pixels"}`, true);
  add("Length matches the edit", Math.abs(p.duration - expected) < 0.8, `${p.duration.toFixed(1)}s (expected ${expected.toFixed(1)}s)`, true);
  add("Under upload size limits", sizeMB < 250, `${sizeMB.toFixed(1)} MB`, true);
  const I = [...log.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1)?.[1], P = [...log.matchAll(/Peak:\s+(-?[\d.]+|-inf) dBFS/g)].at(-1)?.[1];
  const black = [...log.matchAll(/black_duration:([\d.]+)/g)].reduce((a, x) => a + +x[1], 0);
  const silence = [...log.matchAll(/silence_duration: ([\d.]+)/g)].map(x => +x[1]);
  const freeze = [...log.matchAll(/freeze_duration: ([\d.]+)/g)].reduce((a, x) => a + +x[1], 0);
  add("Even loudness (−14 LUFS ±2)", I != null && +I >= -16.5 && +I <= -11.5, I != null ? `${I} LUFS` : "not measured", false);
  add("No clipping", P == null || P === "-inf" || +P <= -0.3, `true peak ${P} dBFS`, false);
  add("No black frames", audiogram || black < 0.5, audiogram ? "audiogram (dark card by design)" : `${black.toFixed(1)}s black`, true);
  add("No dead silence", !silence.length, silence.length ? `${Math.max(...silence).toFixed(1)}s silent stretch` : "none over 2s", true);
  add("Picture keeps moving", freeze < 0.6 * Math.max(p.duration, 1), freeze ? `${freeze.toFixed(1)}s frozen` : "no long freezes", false);
  const sw = X.spoken(m.words.filter(w => w.s >= m.start && w.s <= m.end));
  if (captions && sw.length) add("Starts and ends on whole words", sw[0].s - m.start < 0.5 && m.end - sw.at(-1).e < 0.8, "clean in/out points", false);
  return c;
}
const passed = q => q.every(x => x.ok || !x.hard);

// Failures the safe mode (no cuts, no enhancement) can't fix: the content itself is silent or black.
const CONTENT = new Set(["No dead silence", "No black frames"]);
async function makeCut(sess, m, look, cta, onPct, E = E0) {
  let r = await renderClip(sess, m, look, cta, onPct, E);
  const hardFails = r.quality.filter(x => !x.ok && x.hard);
  if (hardFails.length && hardFails.every(x => CONTENT.has(x.k))) return r;   // skip a retry that would fail the same way
  if (!passed(r.quality)) {                                        // re-render once in safe mode
    r = await renderClip(sess, m, { ...look, tighten: false, enhance: false }, cta, onPct, E);
    r.retried = true;
  }
  return r;
}

// ---------------------------------------------------------------- batch pipeline
let cancelled = false, spares = [];
async function go() {
  if (running) return toast("Already working. New videos join the queue.");
  const todo = sessions.filter(s => s.status === "ready");
  if (!todo.length) return toast("Add a video first.");
  running = true; cancelled = false;
  sessions.forEach(s => { s.batch = false; });
  todo.forEach(s => { s.status = "queued"; s.batch = true; });
  if (!active || !active.clips.length) setActive(todo[0]);
  paintQueue(); paintGo();
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  try {
    if (DESK || !IS_WEBKIT)
      for (let s; !cancelled && (s = sessions.find(x => x.status === "queued"));) await (DESK ? processRemote(s) : processSession(s));
    else while (!cancelled && sessions.some(x => x.status === "queued")) {     // Safari: read all, transcribe all, render all
      const q = f => sessions.find(x => x.status === "queued" && f(x));
      for (let s; !cancelled && (s = q(x => !x.prep));) await processSession(s, "read");
      dropEngine(E0);
      for (let s; !cancelled && (s = q(x => x.prep && !x.prep.words));) await processSession(s, "listen");
      dropASR();
      for (let s; !cancelled && (s = q(x => x.prep?.words));) await processSession(s, "cut");
    }
  } finally {
    running = false;
    sessions.filter(s => s.status === "queued").forEach(s => { s.status = "ready"; });
    $("#prog").classList.add("hide");
    paintQueue(); paintGo(); renderBoard();
    try { await wakeLock?.release(); } catch {}
    pump();
  }
}
const runOpts = () => ({ platform: opts.platform, n: +opts.n, version: opts.version, hd: opts.quality === "hd" || !!DESK, captions: opts.captions === "1",
  hook: opts.hook === "1", tighten: opts.tighten === "1", enhance: opts.enhance === "1", layout: opts.layout, style: opts.style,
  hl: opts.hl, size: opts.size, pos: opts.pos, format: opts.format,
  logo: opts.logo === "1" && !!brand.url, lpos: opts.lpos, lsize: opts.lsize, lop: X.logoOpacity(opts.lop) });
// phase: "all" = the whole run. On Safari the queue runs in three passes instead, so that only three big WebAssembly
// instances are ever started, each after the previous one is gone: "read" (every video's audio, one video engine),
// "listen" (every transcript, one speech model), "cut" (score + render, one fresh video engine). Tested in WebKit: a
// second speech model, or a video engine started while the model is loaded, stalls.
async function processSession(sess, phase = "all") {
  const fresh = phase === "all" || phase === "read", cut = phase === "cut";
  const o = fresh ? runOpts() : sess.o;
  sess.status = "running"; sess.err = null;
  if (fresh) {
    sess.pct = 0; sess.msg = "Starting"; sess.dropped = 0; sess.prep = null;
    for (const c of sess.clips) revokeClip(c);
    sess.clips = []; sess.o = o; sess.cta = $("#cta").value.trim().slice(0, 80);
  }
  if (!active || (!active.clips.length && active.status !== "done")) setActive(sess);
  paintQueue(); renderBoard();
  spares = [];
  try {
    perf.start();
    // Where memory is tight, each video starts on a fresh engine, so one video's leftovers (or a failed render)
    // can't starve the next one in the queue
    if (phase === "all" && TIGHT && E0.ff && E0.mounted !== sess.id) dropEngine(E0);
    let words, loud, quiet, info, pcm;
    if (!fresh) ({ words, loud, quiet, info, pcm } = sess.prep);
    if (fresh) {
    await withTimeout(loadEngine(E0), 90000);
    perf.lap("engine");
    await mountSrc(E0, sess);
    const path = sess.path = "/in/" + sess.file.name;
    info = probeLog((await run(["-hide_banner", "-i", path])).log);
    if (!info.duration) throw new Error("Couldn't read that file. Try an MP4 or MOV.");
    if (!info.acodec) throw new Error("That video has no audio track, so there's nothing to transcribe.");
    if (info.duration < 3) throw new Error("That video is under 3 seconds, too short to clip.");
    if (info.duration > 3 * 3600) throw new Error("That video is over 3 hours. Trim it first, or use the desktop app.");
    // Safari / iOS: past ~85 s the WebAssembly engines run out of memory (or freeze the tab), so clip the first
    // 80 s, which works reliably there, and say so on the results instead of failing
    let capped = 0;
    if (IS_WEBKIT && info.duration > 85) { capped = info.duration; info.duration = 80; }
    else if (info.duration > 45 * 60) toast(`Long video (${X.fmtT(info.duration)}): this can take a while. Keep the tab open and the screen on.`);
    sess.info = info; sess.capped = capped;
    stage("audio", 0, "Reading audio…");
    const a = await run(["-i", path, ...(capped ? ["-t", String(info.duration)] : []), "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "/audio.raw"], t => stage("audio", 100 * t / info.duration, "Reading audio…", `${X.fmtT(t)} / ${X.fmtT(info.duration)}`));
    if (a.code !== 0) throw new Error("Couldn't decode the audio.");
    const raw = await E0.ff.readFile("/audio.raw"); await E0.ff.deleteFile("/audio.raw");
    pcm = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
    let peak = 0; for (let k = 0; k < pcm.length; k += 4) { const x = Math.abs(pcm[k]); if (x > peak) peak = x; }
    if (peak < 1e-4) throw new Error("The audio is silent, so there's nothing to clip. Check the file has sound.");
    loud = X.loudnessCurve(pcm); quiet = X.quietMap(pcm);
    perf.lap("probe+audio");
    // warm up extra engines for parallel rendering while the speech model works (a failed one is simply not used)
    spares = Array.from({ length: renderSlots() - 1 }, () => spareEngine(sess).catch(e => { console.warn("spare engine failed:", e?.message || e); return null; }));
    if (phase === "read") { sess.prep = { loud, quiet, info, pcm }; sess.status = "queued"; sess.msg = ""; return; }
    }
    if (phase === "all" || phase === "listen") {
    if (IS_WEBKIT) dropEngine(E0);               // Safari: give the speech model the whole WebAssembly budget...
    words = await transcribe(pcm, X.asrWindows(loud, info.duration), asrModel(), phase === "listen", opts.lang);
    if (cancelled) throw new Error("Cancelled.");
    perf.lap("transcribe");
    if (phase === "listen") { Object.assign(sess.prep, { words, pcm: null }); sess.status = "queued"; sess.msg = ""; return; }
    }
    if (!E0.ff) await withTimeout(loadEngine(E0, true), 90000);   // ...then a fresh engine renders
    await mountSrc(E0, sess);
    stage("score", 50, "Finding the best moments…");
    const segs = X.segmentsFromWords(words);
    const plat = X.F.platforms[o.platform];
    let version = o.version; if (!plat.long) version = "short";
    const pool = X.findMoments(segs, loud, info.duration, o.n + 3, o.platform, version);
    Object.assign(sess, { words, segs, loud, quiet, version });
    txState.dirty = true;
    perf.lap("score");
    const engines = [E0, ...(await Promise.all(spares)).filter(Boolean)];
    perf.lap(`engines x${engines.length}`);
    const look = lookFrom(o);
    // Each engine takes the next-best moment, renders its long + short cut, then takes another, until n clips pass.
    // Moments render side by side, but clips are always listed in score order.
    const frac = new Map();
    let next = 0, inflight = 0, ok = 0, failed = null;
    const show = () => {
      const f = [...frac.values()].reduce((a, x) => a + x, 0);
      stage("render", 100 * Math.min(1, (ok + f) / o.n), engines.length > 1 ? `Rendering + checking clips · ${ok} of ${o.n} done` : `Rendering + checking clip ${Math.min(ok + 1, o.n)} of ${o.n}`,
            engines.length > 1 ? `${engines.length} at a time · keep this tab open.` : "Keep this tab open.");
    };
    // with "Cut dead air" off, a moment holding a 2 s silence would fail the gate: skip it before rendering
    const tooQuiet = mm => !o.tighten && X.longestQuiet(quiet, mm.start, mm.end) > 1.9;
    async function moment(m, E, idx) {
      if (tooQuiet(m)) return null;
      const p = x => { frac.set(idx, x / 100); show(); };
      m.captions = X.postCopy(m, sess.title);
      const long = await makeCut(sess, m, look, version !== "short" ? sess.cta : "", x => p(version === "both" ? x * 0.6 : x), E);
      if (!passed(long.quality)) return null;
      const clip = { ...m, ...long, rank: idx, range: `${X.fmtT(m.start)}–${X.fmtT(m.end)}`, short: null, view: "long", cta: version !== "short" ? sess.cta : "" };
      if (version === "both") {
        const sm = X.shorten(m, segs, loud, ...plat.short);
        if (sm && !tooQuiet(sm)) {
          const s = await makeCut(sess, sm, look, "", x => p(60 + x * 0.4), E);
          if (passed(s.quality)) { clip.short = { ...s, start: sm.start, end: sm.end, title: sm.title, range: `${X.fmtT(sm.start)}–${X.fmtT(sm.end)}`, cta: "" }; clip.view = "short"; }
        }
      }
      return clip;
    }
    async function worker(E) {
      while (!failed && !cancelled && ok + inflight < o.n && next < pool.length) {
        const idx = next++; inflight++;
        try {
          const clip = await moment(pool[idx], E, idx);
          if (cancelled) break;
          if (clip) { ok++; addClip(sess, clip); }
          else sess.dropped++;
        } catch (e) { failed ||= e; }
        finally { inflight--; frac.delete(idx); show(); }
      }
    }
    show();
    await Promise.all(engines.map(worker));      // workers never reject; the first error stops new work, then surfaces
    if (cancelled) throw new Error("Cancelled.");
    if (failed) throw failed;
    sess.status = "done"; sess.prep = null;
    sess.clips.sort((a, b) => a.rank - b.rank).forEach((c, i) => { c.idx = String(i + 1).padStart(2, "0"); });
    if (sess.clips.length) toast(`${sess.title}: ${sess.clips.length} clip${sess.clips.length > 1 ? "s" : ""} ready`);
  } catch (err) {
    if (cancelled) { sess.status = sess.clips.length ? "done" : "ready"; sess.msg = ""; }
    else { console.error(err); sess.status = "error"; sess.err = friendly(err); }
    if (err?.message === OOM) dropEngine(E0);      // a stalled engine is dead weight: the next video loads a fresh one
  } finally {
    // spare engines are per run (memory); E0 keeps the source mounted for edits
    for (const sp of spares) sp.then(E => { try { E?.ff?.terminate(); } catch {} });
    spares = [];
    paintQueue(); renderBoard();
  }
}
// Browsers word a failed download differently (Safari "Load failed", Chrome "Failed to fetch", Firefox "NetworkError…");
// none of them says what to do, so translate.
function friendly(err) {
  const msg = String(err?.message || err || "Something went wrong.");
  if (/^(Load failed|Failed to fetch|NetworkError when attempting to fetch resource\.?|Network request failed)$/i.test(msg.trim()) || /Failed to fetch dynamically imported module/i.test(msg))
    return "A download failed (the video engine or speech model). Check your internet connection and try again. After one complete run, the app also works offline.";
  return msg;
}
function cancelBatch() {
  if (linkAbort) return linkAbort.abort();
  if (!running) return;
  cancelled = true;
  if (DESK) {
    const s = sessions.find(x => x.status === "running");
    curXHR?.abort();
    if (s?.jid) api(`api/jobs/${encodeURIComponent(s.jid)}/cancel`, {}).catch(() => {});
    toast("Cancelling…");
    return;
  }
  try { E0.ff?.terminate(); } catch {}
  E0.ff = null; E0.mounted = null;
  for (const sp of spares) sp.then(E => { try { E?.ff?.terminate(); } catch {} });
  if (asrReject) { dropASR(); asrReject(new Error("Cancelled.")); asrReject = null; }
  toast("Cancelled. Clips that finished are kept.");
}
$("#cancel").onclick = cancelBatch;
$("#go").onclick = go;
let uidN = 1;
function addClip(sess, clip) {
  clip.uid = uidN++; clip.sid = sess.id;
  clip.idx = String(sess.clips.length + 1).padStart(2, "0");
  sess.clips.push(clip);
  if (sess === active) renderBoard();
  else paintQueueItem(sess);
}
function revokeClip(c) { for (const v of [c, c.short]) if (v) { URL.revokeObjectURL(v.url); if (v.thumb) URL.revokeObjectURL(v.thumb); if (v.srtURL) URL.revokeObjectURL(v.srtURL); } }

// ---------------------------------------------------------------- desktop app engine
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(url, body, method = body ? "POST" : "GET") {
  const r = await fetch(url, body ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { method, cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || (r.status === 403 ? "The desktop app needs its access link again: open the link it printed when it started." : `The desktop app answered ${r.status}.`)), { status: r.status });
  return j;
}
let curXHR = null;
function upload(url, fd, onPct) {
  return new Promise((res, rej) => {
    const x = curXHR = new XMLHttpRequest();
    x.open("POST", url);
    x.upload.onprogress = e => { if (e.lengthComputable) onPct(100 * e.loaded / e.total); };
    x.onload = () => { curXHR = null; let j = {}; try { j = JSON.parse(x.responseText); } catch {} x.status < 400 ? res(j) : rej(new Error(j.error || `Upload failed (${x.status}).`)); };
    x.onerror = () => { curXHR = null; rej(new Error("Couldn't reach the desktop app. Is it still running?")); };
    x.onabort = () => { curXHR = null; rej(new Error("Cancelled.")); };
    x.send(fd);
  });
}
const oFromJob = o => ({ platform: o.platform || "all", n: o.n || 5, version: o.version || "both", hd: true, captions: o.captions !== false, hook: o.hook !== false,
  tighten: o.tighten !== false, enhance: o.enhance !== false, layout: o.layout === "crop" ? "crop" : "fit", style: o.style || "pop",
  hl: o.hl || "#FFF000", size: o.size || "m", pos: o.pos || "bottom", format: o.format || "9:16",
  logo: o.logo === true, lpos: o.lpos || "tl", lsize: o.lsize || "m", lop: X.logoOpacity(o.lop) });
// Poll a desktop job until it finishes. A missed answer or two (the app busy, the laptop waking up) is retried;
// only a real error, a deleted job, or about 30 s without any answer stops it.
async function pollRemote(id, tick) {
  for (let miss = 0; ;) {
    await sleep(800);
    let j;
    try { j = await api(`api/jobs/${encodeURIComponent(id)}`); miss = 0; }
    catch (err) {
      if (err.status === 404) throw new Error("The desktop app no longer has this job. It may have been deleted.");
      if (err.status === 403 || ++miss > 35) throw err;
      continue;
    }
    if (j.status === "error") throw new Error(j.msg === "Cancelled" ? "Cancelled." : (j.msg || "Something went wrong."));
    if (j.status === "done") return j;
    tick(j);
  }
}
// A job still running when the page was opened (the tab was closed mid-run): follow it in the queue.
async function watchRemote(sess) {
  try {
    await pollRemote(sess.jid, j => { sess.pct = j.pct || 0; sess.msg = j.status === "queued" ? "Waiting in line" : `${j.msg || "Working"} · ${Math.round(j.pct || 0)}%`; paintQueueItem(sess); if (active === sess) renderBoard(); });
    sess.status = "done"; sess.msg = "";
    toast(`${sess.name}: clips ready`);
    if (active === sess) { active = null; setActive(sess); }
  } catch (err) { sess.status = "error"; sess.err = friendly(err); }
  finally { paintQueue(); paintGo(); if (active === sess) renderBoard(); }
}
async function processRemote(sess) {
  const o = runOpts();
  sess.status = "running"; sess.pct = 0; sess.msg = "Starting"; sess.err = null; sess.dropped = 0;
  for (const c of sess.clips) revokeClip(c);
  sess.clips = []; sess.o = o; sess.cta = $("#cta").value.trim().slice(0, 80);
  if (!active || (!active.clips.length && active.status !== "done")) setActive(sess);
  paintQueue(); renderBoard();
  const b = { n: o.n, platform: o.platform, version: o.version, hook: o.hook ? "1" : "0", tighten: o.tighten ? "1" : "0", enhance: o.enhance ? "1" : "0",
              captions: o.captions ? "1" : "0", style: o.style, layout: o.layout, cta: sess.cta, model: opts.model, lang: opts.lang, format: o.format, hl: o.hl, size: o.size, pos: o.pos,
              logo: o.logo ? "1" : "0", lpos: o.lpos, lsize: o.lsize, lop: String(o.lop) };
  try {
    let id;
    if (sess.file) {
      const fd = new FormData(); fd.append("file", sess.file, sess.file.name);
      for (const [k, v] of Object.entries(b)) fd.append(k, v);
      id = (await upload("api/jobs", fd, p => setStage("Sending the video to the app…", p * 0.15, `${Math.round(p)}% of ${mb(sess.file.size)} MB`))).id;
    } else id = (await api("api/jobs", { url: sess.link, label: sess.link, ...b })).id;
    sess.jid = id;
    const j = await pollRemote(id, j => setStage(j.status === "queued" ? "Waiting in line…" : (j.msg || "Working…"), j.pct || 0,
      j.status === "running" ? "Running on this computer · you can close this tab and come back" : ""));
    await loadRemote(sess, j);
    sess.status = "done";
    if (sess.clips.length) toast(`${sess.title}: ${sess.clips.length} clip${sess.clips.length > 1 ? "s" : ""} ready`);
  } catch (err) {
    if (cancelled) { sess.status = sess.clips.length ? "done" : "ready"; sess.msg = ""; sess.jid = null; }
    else { console.error(err); sess.status = "error"; sess.err = friendly(err); }
  } finally { paintQueue(); renderBoard(); }
}
async function loadRemote(sess, job) {
  const res = job.result || { clips: [] };
  const tr = await api(`api/jobs/${encodeURIComponent(sess.jid)}/transcript`);
  sess.words = tr.words || [];
  sess.quiet = tr.quiet?.db?.length ? { step: tr.quiet.step, thr: tr.quiet.thr, db: Float32Array.from(tr.quiet.db) } : null;
  sess.info = { duration: tr.duration || res.duration || 0, hasVideo: tr.has_video !== false };
  sess.title = res.title || sess.title;
  if (!sess.file && res.title) sess.name = res.title;     // a link: show the video's real title, not the URL
  sess.version = res.version || "both";
  sess.o ||= oFromJob(job.opts || {});
  sess.cta ??= job.opts?.cta || "";
  sess.remote = true; sess.loaded = true; sess.dropped = res.dropped_for_quality || 0;
  syncRemoteClips(sess, res);
  txState.dirty = true;
}
function syncRemoteClips(sess, res) {
  const base = `files/${encodeURIComponent(sess.jid)}/`;
  const cut = v => ({ ...v, url: `${base}${encodeURIComponent(v.file)}?v=${v.rev || 0}`, thumb: v.thumb ? `${base}${encodeURIComponent(v.thumb)}?v=${v.rev || 0}` : null,
                      srtHref: `${base}${encodeURIComponent(v.srt)}?dl=1&v=${v.rev || 0}`, blob: null, srt: null, look: { ...lookFrom(sess.o), ...(v.look || {}) } });
  res.clips.forEach((c, i) => {
    const next = { ...cut(c), jidx: i, rank: c.custom ? 1e6 + i : i, captions: c.captions || {}, reasons: c.reasons || [], checklist: c.checklist || [],
                   short: c.short ? cut(c.short) : null };
    const have = sess.clips.find(x => x.jidx === i);
    if (have) {
      const keep = { uid: have.uid, sid: have.sid, idx: have.idx, kept: have.kept, view: next.short ? have.view : "long" };
      for (const k of Object.keys(have)) delete have[k];
      Object.assign(have, next, keep);
    } else { next.view = c.short ? "short" : "long"; addClip(sess, next); }
  });
}
async function remoteEdit(job) {
  const d = job.d, sess = job.sess, id = encodeURIComponent(sess.jid);
  const rev0 = (await api(`api/jobs/${id}`)).edit_rev || 0;
  await api(`api/jobs/${id}/edit`, { clip: job.c ? job.c.jidx : -1, cut: job.cut, start: d.start, end: d.end, title: d.title, style: d.look.style,
    look: d.look, cta: d.cta ?? "", words: sess.words.filter(w => w.s >= d.start - 0.5 && w.s <= d.end + 0.5) });
  for (;;) {
    await sleep(700);
    const j = await api(`api/jobs/${id}`);
    if (j.status === "editing") { job.pct = j.pct || 0; notifyJob(job); }
    if (j.status === "done" && ((j.edit_rev || 0) > rev0 || j.edit_error)) {
      if (j.edit_error) return { ok: false, msg: j.edit_error };
      syncRemoteClips(sess, j.result);
      const c = job.c || sess.clips.find(x => x.jidx === j.result.clips.length - 1);
      c.view = job.cut === "short" ? "short" : "long";
      return { ok: true, clip: c };
    }
  }
}
// Desktop only (the website is always current): once a day, ask GitHub for the latest release and offer it if newer.
const newerVersion = (a, b) => { const p = s => String(s || "").replace(/^v/, "").split(".").map(n => parseInt(n, 10) || 0);
  const x = p(a), y = p(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
async function checkUpdate() {
  const K = "clipmachine.update", now = Date.now(); let c = store.get(K, null);
  if (!c?.tag || now - c.at > 864e5) {
    try {
      const r = await fetch("https://api.github.com/repos/blin0908/clip-machine/releases/latest", { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
      if (!r.ok) return; const j = await r.json(); if (!/^v?\d+\.\d+/.test(j.tag_name || "")) return;
      c = { at: now, tag: j.tag_name, url: /^https:\/\/github\.com\//.test(j.html_url) ? j.html_url : "https://github.com/blin0908/clip-machine/releases/latest" };
      store.set(K, c);
    } catch { return; }
  }
  if (!newerVersion(c.tag, X.F.version)) return;
  $("#ver").innerHTML = `Version ${esc(X.F.version)}. <a class="upd" href="${esc(c.url)}" target="_blank" rel="noopener">Download ${esc(c.tag)}</a>`;
  toast(`Clip Machine ${c.tag} is out. The download link is at the bottom of the settings.`);
}
async function enterDesktop(info) {
  DESK = info;
  document.body.classList.add("desk");
  DEF.model = "base"; DEF.lang = "auto";
  $("#lang").insertAdjacentHTML("afterbegin", `<option value="auto">Detect automatically</option>`);   // faster-whisper detects the language first
  if (!store.get(LKEY, {}).lang) setChip("lang", "auto", false);
  $('.chips[data-k="model"]').innerHTML = `<button class="chip" data-v="tiny">Fastest</button><button class="chip" data-v="base" aria-pressed="true">Balanced</button><button class="chip" data-v="small">Most accurate (slower)</button>`;
  $("#qualityRow").hidden = true;                   // the desktop app always exports full HD
  $(".lhint").textContent = "Paste a YouTube, TikTok, Twitch, X or any video link. The desktop app downloads it on this computer.";
  $("#link").placeholder = "Paste a YouTube, TikTok or video link";
  $(".tag").textContent = "Desktop app · runs on this computer";
  $("#logStorage").textContent = "Saved on the computer running Clip Machine.";
  $(".foot.private").firstChild.textContent = "Your videos stay on the computer running Clip Machine: nothing goes to a cloud service. ";
  const tl = $(".toplink"); tl.href = "classic"; tl.removeAttribute("target"); tl.setAttribute("aria-label", "Classic view"); tl.querySelector("span").textContent = "Classic view";
  try {                                            // the app's logo is the one that renders
    const r = await fetch("api/brand/logo", { cache: "no-store" });
    if (r.ok) { const b = await r.blob(); setBrand(await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); })); }
    else if (r.status === 404) setBrand(null);
  } catch {}
  try {                                            // past jobs on this computer, newest first
    const list = await api("api/jobs");
    const busy = j => (j.status === "queued" || j.status === "running") && !j.has_result;   // an edit on a finished job doesn't count
    for (const j of list.filter(j => j.status === "done" || busy(j) || (j.has_result && j.status !== "error")).slice(0, 15)) {
      const s = { id: nextId++, jid: j.id, file: null, link: null, name: String(j.label || j.id).split("/").pop().slice(0, 80), title: String(j.label || j.id).slice(0, 80),
                  status: busy(j) ? "running" : "done", remote: true, loaded: false, clips: [], pct: j.pct || 0, msg: busy(j) ? "Working" : "", url: null };
      sessions.push(s);
      if (busy(j)) watchRemote(s);
    }
  } catch {}
}

// ---------------------------------------------------------------- edit renders (studio)
// Studio renders queue up and run one at a time on the edit engine, so you can move on to the next clip while
// one renders. Where memory is tight, the edit engine is E0 and edits wait for the batch to finish.
const jobs = [];
let jobNow = null;
const jobKey = (c, cut) => `${c.uid}:${cut}`;
let newSeq = 0;
function jobFor(c, cut) {
  const all = [jobNow, ...jobs].filter(Boolean);
  return c ? all.find(j => j.key === jobKey(c, cut)) || null : all.filter(j => !j.c && j.cut === cut).pop() || null;   // new clips: the latest
}
function queueRender(job) {
  job.key = job.c ? jobKey(job.c, job.cut) : `new:${++newSeq}`;      // every clip made from the transcript is its own job
  const dup = job.c ? jobs.findIndex(j => j.key === job.key) : -1;
  if (dup >= 0) { const [old] = jobs.splice(dup, 1); old.resolve?.({ ok: false, superseded: true }); }   // the newest edit of a cut wins
  job.state = "queued"; job.pct = 0;
  const p = new Promise(res => { job.resolve = res; });
  jobs.push(job); notifyJob(job); pump();
  return p;
}
async function pump() {
  if (jobNow || !jobs.length) return;
  const E = editEngine();
  if (E === E0 && running && !jobs[0].sess.remote) { jobs.forEach(j => { j.state = "waiting"; notifyJob(j); }); return; }   // resumes when the batch ends
  const job = jobNow = jobs.shift();
  job.state = "running"; notifyJob(job);
  let result = { ok: false };
  if (job.sess.remote) {
    try { result = await remoteEdit(job); }
    catch (err) { console.error(err); result = { ok: false, msg: friendly(err) }; }
    job.state = result.ok ? "done" : "failed"; job.result = result; jobNow = null;
    if (job.sess === active) renderBoard();
    notifyJob(job); job.resolve(result); pump();
    return;
  }
  try {
    await withTimeout(loadEngine(E, true), 60000);
    await mountSrc(E, job.sess);
    const d = job.d;
    const m = { start: d.start, end: d.end, title: d.title, words: job.sess.words.filter(w => w.s >= d.start - 0.5 && w.s <= d.end + 0.5) };
    const r = await makeCut(job.sess, m, d.look, d.cta, x => { job.pct = x; notifyJob(job); }, E);
    if (!passed(r.quality)) {
      URL.revokeObjectURL(r.url); if (r.thumb) URL.revokeObjectURL(r.thumb);
      const why = r.quality.filter(x => !x.ok && x.hard).map(x => `${x.k} (${x.detail})`).join(", ");
      result = { ok: false, msg: `That edit failed the quality gate: ${why}. Your previous version is kept.` };
    } else {
      const fields = { start: d.start, end: d.end, title: d.title, cta: d.cta, range: `${X.fmtT(d.start)}–${X.fmtT(d.end)}`, edited: true };
      let c = job.c;
      if (!c) {                                   // a new clip made from the transcript
        c = { ...m, ...r, ...fields, score: null, custom: true, reasons: ["Picked from the transcript"], checklist: [], hashtags: [], short: null, view: "long" };
        c.captions = X.postCopy({ ...c, hashtags: [] }, job.sess.title);
        addClip(job.sess, c);
      } else {
        const target = job.cut === "short" ? c.short : c;
        URL.revokeObjectURL(target.url); if (target.thumb) URL.revokeObjectURL(target.thumb); if (target.srtURL) URL.revokeObjectURL(target.srtURL);
        target.srtURL = null;
        Object.assign(target, r, fields);
        if (job.cut === "long") c.title = d.title;
        c.captions = X.postCopy({ ...c, title: c.title, hashtags: c.hashtags || [] }, job.sess.title);
        c.view = job.cut === "short" ? "short" : "long";
      }
      result = { ok: true, clip: c };
    }
  } catch (err) {
    console.error(err);
    result = { ok: false, msg: friendly(err) };
    if (E !== E0) { try { E.ff?.terminate(); } catch {} E.ff = null; E.mounted = null; }
  } finally {
    job.state = result.ok ? "done" : "failed"; job.result = result;
    jobNow = null;
    if (job.sess === active) renderBoard();
    notifyJob(job);
    job.resolve(result);
    pump();
  }
}
function notifyJob(job) {
  const el = job.c && document.querySelector(`.clip[data-uid="${job.c.uid}"] .vw`);
  if (el) {
    let r = el.querySelector(".rendering");
    const live = job.state === "queued" || job.state === "running" || job.state === "waiting";
    if (live && !r) { r = document.createElement("div"); r.className = "rendering"; el.appendChild(r); }
    if (r) { if (live) r.textContent = jobLabel(job); else r.remove(); }
  }
  studio.onJob(job);
}
const jobLabel = j => j.state === "running" ? `Rendering ${j.cut === "new" ? "new clip" : j.cut + " cut"} · ${Math.round(j.pct)}%`
  : j.state === "waiting" ? "Waits for the batch to finish" : "Queued to render";

// ---------------------------------------------------------------- clips board
function boardList(s = active) {
  if (!s) return [];
  let l = s.clips.slice();
  if (filterKept) l = l.filter(c => c.kept);
  if (sortBy === "time") l.sort((a, b) => a.start - b.start);
  else l.sort((a, b) => (a.custom - b.custom) || ((a.rank ?? 1e9) - (b.rank ?? 1e9)) || a.uid - b.uid);
  return l;
}
const cutOf = c => c.view === "short" && c.short ? c.short : c;
function qualityHTML(v) {
  const q = v.quality || [], ok = q.filter(x => x.ok).length, warn = q.length - ok;
  return `<details class="qc"><summary><span class="qbadge ${warn ? "warn" : ""}">Quality ${ok}/${q.length}</span>${v.retried ? ' <span class="st">safe mode</span>' : ""}${v.edited ? ' <span class="st">edited</span>' : ""}</summary>
    <ul class="check">${q.map(x => `<li class="${x.ok ? "ok" : "no"}"><b>${x.ok ? "✓" : "✗"}</b><span>${esc(x.k)} · ${esc(x.detail)}</span></li>`).join("")}</ul></details>`;
}
function vmeta(v) {
  return `${v.duration}s · ${v.W && v.H ? `${v.W}×${v.H}` : ""} · ${v.size_mb} MB${v.cuts ? ` · ${v.cuts} cut${v.cuts > 1 ? "s" : ""}` : ""}${v.fillers_cut ? ` · ${v.fillers_cut} um/uh` : ""}`;
}
const srtURL = v => v.srtHref || (v.srtURL ||= URL.createObjectURL(new Blob([v.srt], { type: "text/plain" })));
const blobOf = async v => v.blob ||= await fetch(v.url).then(r => { if (!r.ok) throw new Error("Couldn't fetch the clip from the desktop app."); return r.blob(); });
const srtOf = async v => v.srt ??= await fetch(v.srtHref).then(r => r.ok ? r.text() : "");
function cardHTML(c) {
  const v = cutOf(c), which = v === c ? "long" : "short", ar = (v.look?.format || "9:16").replace(":", "/");
  const order = active.o.platform !== "all" ? [active.o.platform] : ["tiktok", "reels", "shorts", "facebook"];
  const job = jobFor(c, which) || jobFor(c, which === "long" ? "short" : "long");
  return `<article class="clip${c.uid === selUid ? " sel" : ""}" data-uid="${c.uid}">
    <div class="vw"><video src="${v.url}" ${v.thumb ? `poster="${v.thumb}"` : ""} controls playsinline preload="metadata" style="--ar:${ar}"></video>
      <div class="badge">${c.custom ? `<span class="score mine">Yours</span>` : `<span class="score" title="Moment score">${c.score}</span>`}</div>
      ${job && job.state !== "done" && job.state !== "failed" ? `<div class="rendering">${esc(jobLabel(job))}</div>` : ""}</div>
    <div class="b">
      ${c.short ? `<div class="vtabs" role="group" aria-label="Cut"><button data-cut="short" aria-pressed="${v === c.short}">Short ${c.short.duration}s</button><button data-cut="long" aria-pressed="${v === c}">Long ${c.duration}s</button></div>` : ""}
      <div class="row"><span class="when">${esc(c.idx)} · ${esc(v.range || c.range)}</span></div>
      <h3 class="ttl">${esc(v.title || c.title)}</h3>
      ${c.reasons?.length ? `<p class="why">${c.reasons.map(esc).join(" · ")}</p>` : ""}
      <div class="cutbox">${qualityHTML(v)}<div class="vmeta">${vmeta(v)}</div></div>
      <div class="acts">
        <button class="btn sm grow" data-edit>${icon("edit")}Edit</button>
        <button class="btn sm keep" data-keep aria-pressed="${!!c.kept}" aria-label="Keep this clip (K)">${icon("star")}Keep</button>
        <button class="btn sm" data-share="${which}" aria-label="Download this cut">${icon("dl")}</button>
      </div>
      <details class="more"><summary>More: captions, .srt, checklist, log a post</summary><div class="in-more">
        <div class="copyrow">${order.filter(k => c.captions?.[k]).map(k => `<button class="btn sm" data-copy="${esc(c.captions[k])}">Copy ${PN[k]} caption</button>`).join("")}</div>
        <a class="btn sm" href="${srtURL(v)}" download="${fileBase(c, which)}.srt">${icon("dl")}Subtitles (.srt)</a>
        ${c.checklist?.length ? `<ul class="check">${c.checklist.map(x => `<li class="${x.ok ? "ok" : "no"}"><b>${x.ok ? "✓" : "✗"}</b><span>${esc(x.k)} <span class="ev">${esc(x.ev)}</span>${x.tip ? ` ${esc(x.tip)}` : ""}</span></li>`).join("")}</ul>` : ""}
        ${logForm(c)}
      </div></details>
    </div></article>`;
}
function renderBoard() {
  const s = active;
  $("#empty").classList.toggle("hide", !!s);
  $("#board").classList.toggle("hide", !s || !s.clips.length);
  $("#nClips").textContent = s?.clips.length ? s.clips.length : "";
  const out = $("#out");
  if (!s) { out.innerHTML = ""; return; }
  if (!s.clips.length) {
    if (s.remote && !s.loaded && s.status === "done") { out.innerHTML = `<div class="card note" style="color:var(--mute);padding:24px;text-align:center">Loading "${esc(s.name)}"…</div>`; return; }
    const note = t => `<div class="card note msg-note" style="color:var(--mute);font-size:14px;padding:24px;border:1px dashed var(--line2);border-radius:12px;text-align:center">${t}</div>`;
    out.innerHTML = s.status === "error" ? `<div class="card err">${linkTab(linkDesktop(esc(s.err)))}</div>`
      : s.status === "done" ? `<div class="card msg">No moment in "${esc(s.title)}" passed the quality gate. Try a different video, or turn off "Cut dead air" under Edits.</div>`
      : s.status === "running" ? note(s.remote ? `Working on it on this computer (${esc(s.msg || "starting")}). The clips appear here when it finishes.` : "Working on it. Clips appear here as each one passes the quality gate.")
      : s.status === "queued" ? note(`"${esc(s.title)}" is in the queue.`)
      : note(`<b style="color:var(--text)">${esc(s.name)}</b> is ready. Check the settings on the left, then press <b style="color:var(--text)">Find the moments</b>.`);
    return;
  }
  const plat = X.F.platforms[s.o.platform];
  $("#bTitle").textContent = s.title;
  $("#bMeta").textContent = `${s.clips.length} clip${s.clips.length > 1 ? "s" : ""} · formatted for ${plat.name} · ${plat.note}` +
    (s.dropped ? ` · The quality gate replaced ${s.dropped} clip${s.dropped > 1 ? "s" : ""} that failed a hard check.` : "");
  const kept = s.clips.filter(c => c.kept).length;
  $("#nKept").textContent = kept || "";
  $("#fAll").setAttribute("aria-pressed", !filterKept); $("#fKept").setAttribute("aria-pressed", filterKept);
  const list = boardList();
  $("#zipLabel").textContent = filterKept ? `Download kept (${list.length})` : `Download all (${list.length})`;
  $("#zip").disabled = !list.length;
  const order = s.o.platform !== "all" ? [s.o.platform] : ["tiktok", "reels", "shorts", "facebook"];
  const cap = s.capped ? `<p class="capnote">${IS_IOS ? "On iPhone and iPad" : "In Safari"}, only the first 80 seconds of this ${X.fmtT(s.capped)} video were clipped: past that, Safari's engine runs out of memory. ` +
    `For the whole video, use Chrome, Edge or Firefox on a computer, or ${linkDesktop("the free desktop app")}.</p>` : "";
  $("#bNotes").innerHTML = cap + `<details class="tips"><summary>Before you post: platform checklist</summary><div class="cols">${order.map(k => X.F.platforms[k]?.publish?.length ?
    `<div><h3>${esc(X.F.platforms[k].name)}</h3><ul>${X.F.platforms[k].publish.map(x => `<li>${esc(x)}</li>`).join("")}</ul><p class="st">Judge it by: ${X.F.platforms[k].judge.map(esc).join(" · ")}</p></div>` : "").join("")}</div></details>`;
  out.innerHTML = list.length ? `<div class="clips">${list.map(cardHTML).join("")}</div>`
    : `<div class="card note" style="color:var(--mute);padding:24px;text-align:center;border:1px dashed var(--line2);border-radius:12px">No kept clips yet. Press <kbd>K</kbd> or the Keep button on a clip.</div>`;
  out.querySelectorAll(".logf").forEach(setMetricLabels);
}
$("#fAll").onclick = () => { filterKept = false; renderBoard(); };
$("#fKept").onclick = () => { filterKept = true; renderBoard(); };
$("#sort").onchange = e => { sortBy = e.target.value; renderBoard(); };
const findClip = uid => { for (const s of sessions) { const c = s.clips.find(x => x.uid === uid); if (c) return [s, c]; } return [null, null]; };
function toggleKeep(c) {
  c.kept = !c.kept;
  const b = document.querySelector(`.clip[data-uid="${c.uid}"] [data-keep]`);
  if (b) b.setAttribute("aria-pressed", c.kept);
  $("#nKept").textContent = active.clips.filter(x => x.kept).length || "";
  if (filterKept) renderBoard();
  toast(c.kept ? "Kept" : "Removed from kept");
}
function select(uid, focus = true) {
  selUid = uid;
  $$("#out .clip").forEach(el => el.classList.toggle("sel", +el.dataset.uid === uid));
  const el = document.querySelector(`.clip[data-uid="${uid}"]`);
  if (el && focus) el.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}
$("#out").addEventListener("click", async e => {
  const cp = e.target.closest("[data-copy]");
  if (cp) { await copyText(cp.dataset.copy); toast("Caption copied"); return; }
  const art = e.target.closest(".clip"); if (!art) return;
  const [s, c] = findClip(+art.dataset.uid); if (!c) return;
  if (!e.target.closest("video, details, a, button, input, select")) select(c.uid, false);
  const cutBtn = e.target.closest("[data-cut]");
  if (cutBtn) { c.view = cutBtn.dataset.cut; select(c.uid, false); const html = cardHTML(c); art.outerHTML = html; setMetricLabels(document.querySelector(`.clip[data-uid="${c.uid}"] .logf`)); return; }
  if (e.target.closest("[data-edit]")) { select(c.uid, false); studio.open(s, c, c.view === "short" && c.short ? "short" : "long"); return; }
  if (e.target.closest("[data-keep]")) { toggleKeep(c); return; }
  const sh = e.target.closest("[data-share]");
  if (sh) {
    const which = sh.dataset.share, v = which === "short" ? c.short : c;
    const f = new File([await blobOf(v)], fileBase(c, which) + ".mp4", { type: "video/mp4" });
    if (TIGHT && navigator.canShare?.({ files: [f] })) { try { await navigator.share({ files: [f], text: c.captions?.tiktok }); } catch {} }
    else download(f, f.name);
  }
});
$("#zip").onclick = async () => {
  const list = boardList(); if (!list.length) return;
  const btn = $("#zip"); btn.disabled = true; $("#zipLabel").textContent = "Packing…";
  try {
    const files = [{ name: "youtube.csv", data: youtubeUploadCsv(list) }];
    for (const c of list) {
      for (const which of c.short ? ["short", "long"] : ["long"]) {
        const v = which === "short" ? c.short : c, base = fileBase(c, which);
        files.push({ name: base + ".mp4", data: await blobOf(v) }, { name: base + ".srt", data: await srtOf(v) });
      }
      const caps = Object.entries(c.captions || {}).map(([k, t]) => `${PN[k] || k}\n${t}\n`).join("\n");
      files.push({ name: `${c.idx}-captions.txt`, data: `${c.title}\n${c.range}${c.score != null ? ` · score ${c.score}` : ""}\n\n${caps}` });
    }
    download(await zip(files), `${slug(active.title)}-clips.zip`);
    toast(`Packed ${list.length} clip${list.length > 1 ? "s" : ""}`);
  } catch (err) { toast(err.message || "Couldn't make the .zip"); }
  finally { btn.disabled = false; renderBoard(); }
};

// ---------------------------------------------------------------- transcript tab
const txState = { dirty: true, sid: null, a: null, b: null, anchor: null, hits: [], cur: -1 };
function renderTranscript() {
  const s = active, tx = $("#tx");
  if (!s?.words?.length) {
    tx.innerHTML = `<p class="msg" style="display:block">${s ? (s.status === "running" ? "The transcript appears here once speech recognition finishes." : "Run this video to get its transcript.") : "Add a video to see its transcript."}</p>`;
    $("#mkclip").disabled = true; $("#selinfo").textContent = ""; txState.sid = null;
    return;
  }
  if (!txState.dirty && txState.sid === s.id) return;
  txState.dirty = false; txState.sid = s.id; txState.a = txState.b = txState.anchor = null;
  const inClip = new Array(s.words.length).fill(false);
  for (const c of s.clips) for (const v of [c, c.short]) if (v) s.words.forEach((w, i) => { if (w.s >= v.start && w.s <= v.end) inClip[i] = true; });
  const paras = []; let cur = null;
  s.words.forEach((w, i) => {
    if (!cur || w.s - s.words[i - 1].e > 1.2 || (cur.n > 40 && /[.?!。！？]$/.test(s.words[i - 1].w))) { cur = { t: w.s, html: [], raw: [], n: 0 }; paras.push(cur); }
    cur.html.push(`<w data-i="${i}" class="${inClip[i] ? "inclip" : ""}${X.F.fillerSet.has(w.w.toLowerCase().replace(/[^a-z]/g, "")) ? " filler" : ""}">${esc(w.w)}</w>`); cur.raw.push(w.w); cur.n++;
  });
  tx.innerHTML = paras.map(p => `<p><button class="tcb" data-t="${p.t}" aria-label="Open the studio at ${X.fmtT(p.t)}">${X.fmtT(p.t)}</button><span>${X.joinWords(p.raw, p.html)}</span></p>`).join("");
  paintSel(); runSearch();
}
function paintSel() {
  $$("#tx w.on").forEach(el => el.classList.remove("on"));
  const s = active, { a, b } = txState;
  if (a == null || !s?.words) { $("#mkclip").disabled = true; $("#selinfo").textContent = ""; return; }
  const words = $$("#tx w");
  for (let i = a; i <= b; i++) words[i]?.classList.add("on");
  const t0 = s.words[a].s, t1 = s.words[b].e, d = t1 - t0;
  $("#selinfo").textContent = `${fmtTC(t0)} → ${fmtTC(t1)} · ${d.toFixed(1)}s${d < 3 ? " · select at least 3 s" : ""}`;
  $("#mkclip").disabled = d < 3;
}
function selFromRange() {
  const sel = getSelection(); if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
  const r = sel.getRangeAt(0); if (!$("#tx").contains(r.commonAncestorContainer)) return false;
  const hit = $$("#tx w").filter(el => r.intersectsNode(el) && el.textContent.trim());
  if (!hit.length) return false;
  txState.a = +hit[0].dataset.i; txState.b = +hit.at(-1).dataset.i; txState.anchor = txState.a;
  paintSel(); return true;
}
$("#tx").addEventListener("mouseup", e => {
  if (e.target.closest(".tcb")) return;
  if (selFromRange()) return;
  const w = e.target.closest("w"); if (!w) return;
  const i = +w.dataset.i;
  if (e.shiftKey && txState.anchor != null) { txState.a = Math.min(txState.anchor, i); txState.b = Math.max(txState.anchor, i); }
  else { txState.anchor = txState.a = txState.b = i; }
  paintSel();
});
$("#tx").addEventListener("keyup", () => selFromRange());
$("#tx").addEventListener("click", e => {
  const b = e.target.closest(".tcb"); if (!b || !active) return;
  const t = +b.dataset.t, c = active.clips.find(x => t >= x.start - 1 && t <= x.end);
  if (c) studio.open(active, c, "long", t); else studio.openNew(active, t, t + 15);
});
$("#mkclip").onclick = () => {
  const s = active, { a, b } = txState; if (a == null) return;
  studio.openNew(s, s.words[a].s, s.words[b].e, s.words.slice(a, b + 1).map(w => w.w).join(" "));
};
const norm = w => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
function runSearch() {
  const q = $("#txq").value.trim(), s = active;
  $$("#tx w.hit").forEach(el => el.classList.remove("hit", "cur"));
  txState.hits = []; txState.cur = -1;
  if (!q || !s?.words) { $("#txhits").textContent = ""; return; }
  const toks = q.split(/\s+/).map(norm).filter(Boolean), ws = s.words.map(w => norm(w.w)), els = $$("#tx w");
  for (let i = 0; i + toks.length <= ws.length; i++) {
    if (toks.every((t, k) => k === toks.length - 1 ? ws[i + k].startsWith(t) : ws[i + k] === t)) {
      txState.hits.push(i); for (let k = 0; k < toks.length; k++) els[i + k]?.classList.add("hit");
    }
  }
  $("#txhits").textContent = txState.hits.length ? `0/${txState.hits.length}` : "0";
  if (txState.hits.length) stepHit(1);
}
function stepHit(d) {
  const h = txState.hits; if (!h.length) return;
  $$("#tx w.cur").forEach(el => el.classList.remove("cur"));
  txState.cur = (txState.cur + d + h.length) % h.length;
  const els = $$("#tx w"), i = h[txState.cur], n = $("#txq").value.trim().split(/\s+/).filter(Boolean).length;
  for (let k = 0; k < n; k++) els[i + k]?.classList.add("cur");
  els[i]?.scrollIntoView({ block: "center" });
  $("#txhits").textContent = `${txState.cur + 1}/${h.length}`;
}
$("#txq").addEventListener("input", runSearch);
$("#txq").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); } });
$("#txnext").onclick = () => stepHit(1);
$("#txprev").onclick = () => stepHit(-1);

// ---------------------------------------------------------------- workspace tabs
const TABS = { tClips: "pClips", tTx: "pTx", tLog: "pLog" };
function showTab(id) {
  for (const [t, p] of Object.entries(TABS)) { $("#" + t).setAttribute("aria-selected", t === id); $("#" + p).hidden = t !== id; }
  if (id === "tTx") renderTranscript();
  if (id === "tLog") loadLog();
}
for (const t of Object.keys(TABS)) $("#" + t).onclick = () => showTab(t);
$(".wtabs").addEventListener("keydown", e => {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  const ids = Object.keys(TABS), i = ids.indexOf(document.activeElement.id); if (i < 0) return;
  const n = ids[(i + (e.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length]; showTab(n); $("#" + n).focus();
});

// ---------------------------------------------------------------- results log
const LOGKEY = "clipmachine.log";
const SHORTS_METRICS = [
  { name: "feed_shown", label: "Shown in Shorts feed", inputmode: "numeric" },
  { name: "feed_share", label: "Shorts-feed share", inputmode: "decimal", unit: "%" },
  { name: "avg_view_duration", label: "Average view duration", inputmode: "text", unit: "mm:ss" },
];
const readBrowserLog = () => store.get(LOGKEY, []);
const writeBrowserLog = rows => store.set(LOGKEY, rows);
let importingLog = null;
let logRequest = 0;
function importBrowserLog() {
  if (importingLog) return importingLog;
  const rows = readBrowserLog();
  if (!rows.length) return;
  const ids = new Set(rows.map(row => row.id));
  importingLog = api("api/log/import", rows).then(() => {
    writeBrowserLog(readBrowserLog().filter(row => !ids.has(row.id)));
  }).finally(() => { importingLog = null; });
  return importingLog;
}
function logForm(c) {
  const def = active?.o?.platform !== "all" ? active.o.platform : "tiktok";
  const shortsFields = SHORTS_METRICS.map(({ name, label, inputmode, unit }) => {
    const hint = unit ? `${label} (${unit})` : label;
    return `<input name="${name}" inputmode="${inputmode}" placeholder="${hint}" aria-label="${hint}" class="wide">`;
  }).join("");
  return `<form class="logf" data-uid="${c.uid}"><span class="wide st">Log a post</span>
    <select name="platform" aria-label="Platform">${Object.keys(PN).map(k => `<option value="${k}" ${k === def ? "selected" : ""}>${PN[k]}</option>`).join("")}</select>
    <select name="cut" aria-label="Cut">${c.short ? `<option value="short">Short cut</option><option value="long">Long cut</option>` : `<option value="single">Clip</option>`}</select>
    <input name="posted" type="date" aria-label="Posted on"><select name="checkpoint" aria-label="Checkpoint"><option>24h</option><option>72h</option><option>7d</option></select>
    <input name="views" inputmode="numeric" placeholder="Views" aria-label="Views" class="wide">
    <input name="metric1" aria-label="Metric 1"><input name="metric2" aria-label="Metric 2"><input name="metric3" aria-label="Metric 3" class="wide">
    ${shortsFields}
    <input name="notes" placeholder="Notes: what you changed (one variable at a time)" aria-label="Notes" class="wide">
    <button class="btn sm pri wide" type="submit">Save result</button></form>`;
}
function setMetricLabels(f) {
  if (!f) return;
  const p = X.F.platforms[f.platform.value];
  ["metric1", "metric2", "metric3"].forEach((n, i) => {
    f[n].placeholder = p.judge[i] || n;
    f[n].setAttribute("aria-label", p.judge[i] || n);
  });
  const showShorts = f.platform.value === "shorts";
  for (const { name } of SHORTS_METRICS) {
    const field = f.elements.namedItem(name);
    field.hidden = field.disabled = !showShorts;
  }
}
$("#out").addEventListener("change", e => { const f = e.target.closest(".logf"); if (f && e.target.name === "platform") setMetricLabels(f); });
$("#out").addEventListener("submit", async e => {
  const f = e.target.closest(".logf"); if (!f) return; e.preventDefault();
  const [sess, c] = findClip(+f.dataset.uid); if (!c) return;
  const submit = f.querySelector('[type="submit"]');
  if (submit.disabled) return;
  const p = X.F.platforms[f.platform.value], row = Object.fromEntries(new FormData(f));
  ["metric1", "metric2", "metric3"].forEach((n, i) => { if (row[n]) row[n] = `${p.judge[i] || n}: ${row[n]}`; });
  row.title = c.title;
  if (c.score != null) row.score = String(c.score);
  if (c.signals && Object.keys(c.signals).length) row.signals = JSON.stringify(c.signals);   // what the scorer saw, to compare with results later
  submit.disabled = true;
  try {
    if (DESK) {
      await api("api/log", { ...row, job: sess.jid, clip: c.file });
    } else {
      const id = Math.random().toString(36).slice(2, 10);
      const logged = new Date().toISOString().slice(0, 16).replace("T", " ");
      writeBrowserLog([...readBrowserLog(), { ...row, id, logged }]);
    }
    f.reset(); setMetricLabels(f); loadLog(); toast("Result saved");
  } catch {
    toast("Couldn't save the result. Check the desktop app and try again.");
  } finally {
    submit.disabled = false;
  }
});
function logMetrics(row) {
  const metrics = [row.metric1, row.metric2, row.metric3].filter(Boolean);
  for (const { name, label, unit } of SHORTS_METRICS) {
    const value = row[name];
    if (value != null && value !== "") metrics.push(`${label}: ${value}${unit === "%" ? unit : ""}`);
  }
  return metrics.map(esc).join("<br>");
}
async function loadLog() {
  const request = ++logRequest;
  try {
    if (DESK) await importBrowserLog();
    const [rows] = await Promise.all([DESK ? api("api/log") : readBrowserLog(), loadStudio()]);
    if (request === logRequest) renderLog(rows);
  } catch {
    if (request === logRequest) $("#logtbl").textContent = "Couldn't load the results. Check the desktop app and reopen the log.";
  }
}
function renderLog(rows) {
  logRows = rows; renderLearn();
  $("#logtbl").innerHTML = rows.length ? `<div class="lwrap"><table class="ltable"><tr><th>Platform</th><th>Clip</th><th>At</th><th>Views</th><th>Metrics</th><th><span class="sr">Delete</span></th></tr>` +
    rows.slice().reverse().map(r => `<tr><td>${esc(PN[r.platform] || r.platform)}<br><span class="st">${esc(r.posted)}</span></td><td>${esc(String(r.title ?? "").slice(0, 40))}<br><span class="st">${esc(r.cut)}</span></td><td>${esc(r.checkpoint)}</td><td>${esc(r.views)}</td><td>${logMetrics(r)}${r.notes ? `<br><span class="st">${esc(r.notes)}</span>` : ""}</td><td><button class="x" data-dellog="${esc(r.id)}" aria-label="Delete">${icon("x")}</button></td></tr>`).join("") + `</table></div>` : "No results logged yet.";
}
$("#logtbl").addEventListener("click", async e => {
  const button = e.target.closest("[data-dellog]");
  if (!button || button.disabled || !confirm("Delete this entry?")) return;
  const id = button.dataset.dellog;
  button.disabled = true;
  try {
    if (DESK) await api(`api/log/${encodeURIComponent(id)}`, undefined, "DELETE");
    else writeBrowserLog(readBrowserLog().filter(row => row.id !== id));
    await loadLog();
  } catch {
    toast("Couldn't delete the result. Check the desktop app and try again.");
  } finally {
    button.disabled = false;
  }
});
$("#csv").onclick = async () => {
  if (DESK) {
    try {
      await importBrowserLog();
      const response = await fetch("api/log.csv", { cache: "no-store" });
      if (!response.ok) throw new Error("CSV download failed");
      download(await response.blob(), "clip_results.csv");
    } catch {
      toast("Couldn't export the results. Check the desktop app and try again.");
    }
    return;
  }
  const cols = ["logged", "platform", "cut", "title", "posted", "checkpoint", "views", "metric1", "metric2", "metric3", "notes",
    ...SHORTS_METRICS.map(({ name }) => name), "score", "signals"];
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  download(new Blob([[cols.join(","), ...readBrowserLog().map(r => cols.map(k => q(r[k])).join(","))].join("\n")], { type: "text/csv" }), "clip_results.csv");
};

// ---------------------------------------------------------------- learning from results (YouTube Studio import)
// Studio's export is matched to logged clips by title; each logged clip carries the scoring signals it was picked on,
// so the report shows which signals the best clips share. Website: kept in this browser. Desktop: kept on the computer.
const STUDIOKEY = "clipmachine.studio", METRICKEY = "clipmachine.learnMetric";
let ytImport = null, logRows = [];
async function loadStudio() {
  try { ytImport = DESK ? (await api("api/studio")).studio || null : store.get(STUDIOKEY, null); } catch { ytImport = null; }
}
async function saveStudio(v) {
  if (DESK) await (v ? api("api/studio", v) : api("api/studio", undefined, "DELETE"));
  else if (v) {
    ytImport = v; store.set(STUDIOKEY, v);
    if (!store.get(STUDIOKEY, null)) throw new Error("This browser's storage is full, so the import is shown but won't be kept after a reload. Export a shorter date range.");
  }
  else try { localStorage.removeItem(STUDIOKEY); } catch {}
  ytImport = v;
}
const fmtSig = (k, v) => k === "score" ? String(Math.round(v)) : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2);
function rhoCell(r) {
  const a = Math.abs(r), w = Math.min(50, a * 50), strength = a >= 0.5 ? "Strong" : a >= 0.3 ? "Moderate" : a >= 0.1 ? "Weak" : "None";
  const dir = a < 0.1 ? "" : r > 0 ? " · better" : " · worse";
  return `<span class="rho"><span class="bar" aria-hidden="true"><i class="${r >= 0 ? "up" : "down"}" style="left:${r >= 0 ? 50 : 50 - w}%;width:${w}%"></i></span><span>${strength}${dir} <span class="st">${r.toFixed(2)}</span></span></span>`;
}
const listOf = xs => xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs.at(-1);
function renderLearn() {
  const out = $("#learnOut");
  if (!ytImport?.rows?.length) {
    out.innerHTML = `<ol><li>In YouTube Studio, open <b>Analytics</b> and choose <b>Advanced mode</b>.</li>
      <li>Set a date range that covers your clips, and keep the <b>Video title</b> column. Add <b>Average percentage viewed</b> if it isn't there.</li>
      <li>Choose <b>Export current view</b> → <b>Comma-separated values (.csv)</b>, unzip it, and import the table file (one row per video).</li></ol>
      <p>Videos are matched to your logged posts by title, so log each post from the clip it came from.</p>`;
    return;
  }
  const m = X.matchStudio(ytImport.rows, logRows), cols = (ytImport.columns || []).filter(c => !/^(video )?duration$/i.test(c.trim()));   // a video's length isn't a result
  let metric = store.get(METRICKEY, "");
  if (!cols.includes(metric)) metric = cols.find(c => /average percentage viewed/i.test(c)) || cols.find(c => /^views$/i.test(c)) || cols[0] || "";
  const rep = metric ? X.signalReport(m.matched, metric) : { n: 0, enough: false, signals: [] };
  const withSig = m.matched.filter(x => x.clip.signals).length;
  let html = `<div class="learn-sum"><span>${ytImport.rows.length} videos in ${esc(ytImport.file || "the import")} · <b>${m.matched.length}</b> matched to logged clips${withSig < m.matched.length ? ` (${withSig} with saved signals)` : ""}</span>
    ${cols.length ? `<label>Judge by <select id="learnMetric">${cols.map(c => `<option ${c === metric ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>` : ""}
    <button class="btn sm" type="button" id="studioDel">Remove import</button></div>`;
  if (!cols.length) html += `<p>This export has no number columns. Add Views or Average percentage viewed in Advanced mode, then export again.</p>`;
  else if (!rep.enough) html += `<p>Needs at least ${X.MIN_LEARN} matched clips with saved signals; this import has ${rep.n}. Posts logged before this update don't have their signals, so log new posts from the clips board.</p>`;
  else {
    const others = rep.signals.filter(x => x.key !== "score"), own = rep.signals.find(x => x.key === "score");
    const up = others.filter(x => x.rho >= 0.3).slice(0, 3).map(x => x.label.toLowerCase()), down = others.filter(x => x.rho <= -0.3).slice(0, 2).map(x => x.label.toLowerCase());
    const what = esc(metric.replace(/\s*\(.*?\)\s*/g, " ").trim().toLowerCase());
    const take = (up.length ? `Your best clips score higher on <b>${esc(listOf(up))}</b>.` : "No signal stands out yet.") +
      (down.length ? ` Clips that score higher on <b>${esc(listOf(down))}</b> did worse.` : "") +
      (own ? own.rho >= 0.3 ? ` Clip Machine's own score is tracking ${what} so far.` : own.rho <= -0.3 ? ` Clip Machine's own score is pointing the wrong way on ${what} so far.` : ` Clip Machine's own score isn't predicting ${what} yet.` : "");
    html += `<p class="learn-take">${take}</p>
      <p>${rep.early ? `Early read from ${rep.n} clips` : `Based on ${rep.n} clips`} <span class="ev">Test</span> ${rep.early ? "Patterns this small can flip. Change one thing at a time and keep logging." : "A pattern in your own clips, not proof of what caused it."}</p>
      <div class="lwrap"><table class="ltable sig"><tr><th>Signal</th><th>Best third</th><th>Worst third</th><th>Link to ${esc(metric)}</th></tr>
      ${rep.signals.map(x => `<tr class="${x.key === "score" ? "own" : ""}"><td>${esc(x.label)}</td><td>${fmtSig(x.key, x.best)}</td><td>${fmtSig(x.key, x.worst)}</td><td>${rhoCell(x.rho)}</td></tr>`).join("")}</table></div>
      <p>Signal levels are relative to each clip's source video (0 = that video's average moment).</p>`;
  }
  if (m.matched.length) html += `<details><summary>Matched clips (${m.matched.length})</summary><ul>${m.matched.map(x =>
    `<li>${esc(x.clip.title)}${normTitleSame(x) ? "" : ` → ${esc(x.studio.title)}`}${metric && Number.isFinite(x.studio.values[metric]) ? ` · ${esc(String(x.studio.values[metric]))}` : ""}${x.clip.signals ? "" : " · no saved signals"}</li>`).join("")}</ul></details>`;
  if (m.unmatchedStudio.length) html += `<details><summary>Studio videos with no logged clip (${m.unmatchedStudio.length})</summary><ul>${m.unmatchedStudio.slice(0, 40).map(x => `<li>${esc(x.title)}</li>`).join("")}${m.unmatchedStudio.length > 40 ? `<li>…and ${m.unmatchedStudio.length - 40} more</li>` : ""}</ul></details>`;
  out.innerHTML = html;
}
const normTitleSame = x => X.normTitle(x.clip.title) === X.normTitle(x.studio.title);
$("#studioPick").onclick = () => $("#studioFile").click();
$("#studioFile").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  if (f.size > 5e6) { toast("That file is over 5 MB. Export a shorter date range, or only the Content report."); return; }
  try {
    const t = X.studioTable(await f.text());
    if (!t.rows.length) throw new Error("That export has no videos in it. Pick a date range that includes your uploads and export again.");
    await saveStudio({ file: f.name.slice(0, 120), imported: new Date().toISOString().slice(0, 10), columns: t.columns.slice(0, 60), rows: t.rows.slice(0, 5000) });
    renderLearn(); toast(`Imported ${Math.min(t.rows.length, 5000)} videos from YouTube Studio`);
  } catch (err) { renderLearn(); toast(err.status ? "Couldn't save the import. Check the desktop app and try again." : err.message); }
});
$("#learnOut").addEventListener("change", e => { if (e.target.id === "learnMetric") { store.set(METRICKEY, e.target.value); renderLearn(); } });
$("#learnOut").addEventListener("click", async e => {
  if (e.target.closest("#studioDel") && confirm("Remove the YouTube Studio import? Your results log stays.")) {
    try { await saveStudio(null); renderLearn(); } catch { toast("Couldn't remove the import. Check the desktop app and try again."); }
  }
});

// ---------------------------------------------------------------- keyboard
$("#keysBtn").onclick = () => $("#keys").showModal();
$("#keys").addEventListener("click", e => { if (e.target.closest("[data-close]") || e.target === $("#keys")) $("#keys").close(); });
addEventListener("keydown", e => {
  if (studio.isOpen()) return;                          // the studio has its own keys
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); if (!$("#go").disabled) go(); return; }
  if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "?") { e.preventDefault(); $("#keys").open ? $("#keys").close() : $("#keys").showModal(); return; }
  if ($("#pClips").hidden || $("#keys").open) return;
  const list = boardList(); if (!list.length) return;
  const i = list.findIndex(c => c.uid === selUid);
  const cols = Math.max(1, Math.round($("#out .clips")?.clientWidth / ($("#out .clip")?.offsetWidth + 16)) || 1);
  const mv = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
  if (mv) { e.preventDefault(); select(list[Math.min(list.length - 1, Math.max(0, i < 0 ? 0 : i + mv))].uid); return; }
  const c = list[i]; if (!c) return;
  if (e.key === "Enter" && !e.target.closest("button, a, summary, video")) { e.preventDefault(); studio.open(active, c, c.view === "short" && c.short ? "short" : "long"); }
  else if (e.key.toLowerCase() === "k") { e.preventDefault(); toggleKeep(c); }
  else if (e.key === " " && !e.target.closest("button, a, summary, video")) { e.preventDefault(); const v = document.querySelector(`.clip[data-uid="${c.uid}"] video`); v.paused ? v.play() : v.pause(); }
});

// ---------------------------------------------------------------- studio
const studio = createStudio({
  X, esc, toast, fmtTC, icon, IS_WEBKIT,
  list: () => boardList(), srcURL, lookFrom, queueRender, jobFor, jobLabel, brand: () => brand.url,
  onClose(c) { renderBoard(); if (c) { select(c.uid); document.querySelector(`.clip[data-uid="${c.uid}"] [data-edit]`)?.focus(); } },
  onWords(sess) { txState.dirty = true; if (sess === active && !$("#pTx").hidden) renderTranscript(); },
});

// ---------------------------------------------------------------- empty-state reel (a decorative scrolling waveform with in/out marks)
(function reel() {
  const cv = $("#reel"); if (!cv) return;
  const ctx = cv.getContext("2d"), still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const bars = Array.from({ length: 400 }, (_, i) => 0.25 + 0.75 * Math.abs(Math.sin(i * 0.37) * Math.sin(i * 0.071 + 1) + 0.25 * Math.sin(i * 1.7)));
  let off = 0;
  function draw() {
    if ($("#empty").classList.contains("hide")) { requestAnimationFrame(draw); return; }
    const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    const bw = 4, n = Math.ceil(w / bw) + 1, a = w * 0.36, b = w * 0.64;
    for (let k = 0; k < n; k++) {
      const x = k * bw - (off % bw), v = bars[(Math.floor(off / bw) + k) % bars.length], bh = v * (h - 30);
      ctx.fillStyle = x > a && x < b ? "#f2c230" : "#3a3e47";
      ctx.fillRect(x, (h - bh) / 2, bw - 1.5, bh);
    }
    ctx.fillStyle = "rgba(242,194,48,.10)"; ctx.fillRect(a, 0, b - a, h);
    ctx.fillStyle = "#f2c230"; ctx.fillRect(a - 2, 0, 3, h); ctx.fillRect(b, 0, 3, h);
    ctx.fillRect(a - 2, 0, 10, 3); ctx.fillRect(b - 7, 0, 10, 3); ctx.fillRect(a - 2, h - 3, 10, 3); ctx.fillRect(b - 7, h - 3, 10, 3);
    ctx.fillStyle = "#ff5a4e"; ctx.fillRect(a + (b - a) * ((off / 3) % 100) / 100, 0, 2, h);
    if (!still) { off += 0.6; requestAnimationFrame(draw); }
  }
  draw();
})();

// ---------------------------------------------------------------- boot
// offline support: app files + ffmpeg core are cached after the first visit (http(s) only, not file://)
// (the service worker is registered after the desktop check below: the desktop app's pages aren't cached)
await X.loadFormula();
if (!/github\.io$/.test(location.hostname) && location.protocol.startsWith("http")) {
  try { const r = await fetch("api/info", { cache: "no-store" }); if (r.ok) { const j = await r.json(); if (j.desktop) await enterDesktop(j); } } catch {}
}
if (!DESK && "serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});
$("#ver").textContent = `Version ${X.F.version}.`;
// Safari after a reload: this tab still holds the engines' memory from before, and the speech model won't start again
// (WebKit frees it only with the tab's process). Offer a fresh tab before a file is picked.
if (IS_WEBKIT && !DESK) {
  let used = false; try { used = sessionStorage.getItem(USED) === "1"; } catch {}
  if (used) $("#tabFile").closest("[role=tablist]").insertAdjacentHTML("beforebegin",
    `<p class="capnote fresh" id="freshTab">Safari keeps the memory from videos this tab has already clipped, even after a reload, so the next one would stall. ` +
    `<a class="btn sm" href="${esc(location.href)}" target="_blank" rel="noopener">Open a fresh tab</a></p>`);
}
if (DESK) checkUpdate();
fillPresets("");
if (innerWidth < 1000) $$(".grp[open]").forEach(d => { d.open = false; });   // phones: settings folded so the button and progress stay in reach
const params = new URLSearchParams(location.search);
// URL presets, e.g. ?platform=tiktok&n=1&version=short (handy for sharing a setup) win over the last-used settings
const urlSet = [...params.keys()].some(k => k in DEF);
applySettings(urlSet ? {} : store.get(LKEY, {}));
for (const [k, v] of params) if (k in DEF) setChip(k, v, false);
paintBrand(); loadLog(); paintQueue(); renderBoard();
const src = params.get("src");   // e.g. ?src=sample.mp4 (same-origin or CORS-enabled)
if (src) {
  try {
    const f = await fetchVideo(new URL(src, location.href).href, (p, m) => setStage("Fetching video…", p ?? 0, m));
    $("#prog").classList.add("hide");
    addFiles([f]);
    if (params.get("auto") === "1") go();
  } catch (e) { $("#prog").classList.add("hide"); toast("Couldn't load ?src video"); }
}
