import { FFmpeg } from "./vendor/ffmpeg/index.js";
import { toBlobURL } from "./vendor/util/index.js";
import * as X from "./formula.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CORE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
const PN = { tiktok: "TikTok", reels: "Reels", shorts: "YT Shorts", facebook: "Facebook", snapchat: "Snapchat", x: "X" };
const opts = { platform: "all", n: "3", version: "both", quality: "fast", model: "Xenova/whisper-base.en",
               captions: "1", hook: "1", tighten: "1", enhance: "1", layout: "fit", style: "pop" };
let wakeLock = null, results = [], S = null, busy = false, srcFile = null;   // S = current session (source, transcript, settings)

// ---------------------------------------------------------------- UI wiring
document.querySelectorAll(".chips").forEach(g => g.addEventListener("click", e => {
  const b = e.target.closest(".chip"); if (!b || b.disabled) return;
  g.querySelectorAll(".chip").forEach(c => c.setAttribute("aria-pressed", c === b));
  opts[g.dataset.k] = b.dataset.v;
  if (g.dataset.k === "platform") showPlat();
}));
function toast(t) { const el = $("#toast"); el.textContent = t; el.classList.add("on"); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("on"), 2000); }
function showPlat() {
  const p = X.F.platforms[opts.platform];
  $("#pnote").textContent = p.note;
  const s = `${p.short[0]}–${p.short[1]}s`, l = p.long ? `${p.long[0]}–${p.long[1]}s` : null;
  $("#vboth").textContent = l ? `Short ${s} + long ${l}` : "Short + long";
  $("#vshort").textContent = `Short only · ${s}`;
  $("#vlong").textContent = l ? `Long only · ${l}` : "Long only";
  $("#vboth").disabled = $("#vlong").disabled = !l;
  if (!l && opts.version !== "short") $("#vshort").click();
}
$("#file").onchange = e => { const f = e.target.files[0]; $("#fname").textContent = f ? `📎 ${f.name} (${(f.size / 1e6).toFixed(0)} MB)` : "Choose a video"; $("#go").disabled = !f; if (f) preloadASR(); };
$("#cancel").onclick = () => linkAbort ? linkAbort.abort() : location.reload();

function setStage(label, pct, msg = "") {
  $("#prog").classList.remove("hide");
  $("#plabel").textContent = label; $("#ppct").textContent = Math.round(pct) + "%";
  $("#pbar").style.width = Math.max(0, Math.min(100, pct)) + "%"; $("#pmsg").textContent = msg;
}
const STAGES = { load: [0, 8], audio: [8, 14], asr: [14, 60], score: [60, 62], render: [62, 100] };
const stage = (k, pct, label, msg) => { const [a, b] = STAGES[k]; setStage(label, a + (b - a) * pct / 100, msg); };
// stage timings for benchmarks: window.__perf = [{ k, ms }, ...]
const perf = { t: 0, rows: [], start() { this.rows = []; this.t = performance.now(); window.__perf = this.rows; },
  lap(k) { const n = performance.now(); this.rows.push({ k, ms: Math.round(n - this.t) }); this.t = n; } };

// ---------------------------------------------------------------- ffmpeg helpers
// One engine = one ffmpeg.wasm worker, which is single-threaded. E0 probes, reads audio and re-renders edits; on
// multi-core computers extra engines render different moments at the same time (each keeps its own files + log).
const newEngine = () => ({ ff: null, logs: [], cache: new Map() });
const E0 = newEngine();
let core = null, font = null;
const getCore = () => core ||= Promise.all([toBlobURL(`${CORE}/ffmpeg-core.js`, "text/javascript"), toBlobURL(`${CORE}/ffmpeg-core.wasm`, "application/wasm")])
  .catch(e => { core = null; throw e; });
const getFont = () => font ||= fetch("./fonts/Montserrat-Black.ttf").then(r => r.arrayBuffer()).catch(e => { font = null; throw e; });
async function loadEngine(E, quiet = false) {
  if (E.ff) return E.ff;
  if (!quiet) stage("load", 10, "Loading video engine…", "First run downloads ~30 MB. It's cached after that.");
  const ff = new FFmpeg();
  ff.on("log", ({ message }) => { E.logs.push(message); if (E.logs.length > 4000) E.logs.splice(0, 2000); });
  const [coreURL, wasmURL] = await getCore();
  await ff.load({ coreURL, wasmURL });
  await ff.createDir("/fonts");
  await ff.writeFile("/fonts/Montserrat-Black.ttf", new Uint8Array((await getFont()).slice(0)));   // a copy: writeFile hands its buffer to the worker
  await ff.createDir("/in");
  E.ff = ff;
  return ff;
}
const getFFmpeg = quiet => loadEngine(E0, quiet);
// How many clips to render at once: several on desktop Chrome/Firefox/Edge, one where memory is tight
// (Safari and every iOS browser hit a WebAssembly memory ceiling; phones in general have little to spare).
function renderSlots() {
  if (IS_WEBKIT || /Android|Mobi/i.test(UA)) return 1;
  const cores = navigator.hardwareConcurrency || 2, gb = navigator.deviceMemory || 4;
  return Math.max(1, Math.min(3, Math.floor(cores / 2), Math.floor(gb / 2)));
}
async function spareEngine() {               // an extra engine with the current source mounted
  const E = newEngine();
  await withTimeout(loadEngine(E, true), 40000);
  await E.ff.mount("WORKERFS", { files: [srcFile] }, "/in");
  return E;
}
// Safari/WebKit can run out of WebAssembly memory after transcribing a longer video: the video engine then
// stalls without an error (tested: WebKit fails above ~1 min of speech on an 8 GB Mac; Chrome and Firefox don't).
const UA = navigator.userAgent;
const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);   // every iOS browser is WebKit
const IS_WEBKIT = IS_IOS || (/AppleWebKit/.test(UA) && !/Chrome|Chromium|Edg|Firefox|Android/.test(UA));
const OOM = "This browser ran out of memory for video editing. " + (IS_IOS
  ? "On iPhone and iPad every browser uses Safari's engine, which tops out around a minute of video. Use a shorter video, or a computer with Chrome or the free desktop app."
  : "Safari is the usual cause with videos over about a minute. Try Chrome, Edge or Firefox, a shorter video, or the free desktop app.");
const DESKTOP_URL = "https://github.com/blin0908/clip-machine/releases/latest";
// Turn "the (free) desktop app" in an already-escaped message into a download link.
const linkDesktop = html => html.replace(/(the (?:free )?desktop app)/, `<a href="${DESKTOP_URL}" target="_blank" rel="noopener">$1</a>`);

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
function useFile(f) {
  const dt = new DataTransfer(); dt.items.add(f); $("#file").files = dt.files; $("#file").onchange({ target: $("#file") });
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
  const site = siteOf(u.hostname);
  if (site) { linkNote(`${site} links need the free desktop app.`, `${site} doesn't let websites download its videos. The desktop app downloads it on your own computer and makes the clips. It's free too, and works on Mac, Windows and Linux.`); return; }
  $("#lnote").classList.add("hide"); $("#lbar").style.width = "0%"; $("#lprog").classList.remove("hide");
  $("#link").disabled = $("#linkGo").disabled = $("#tabFile").disabled = $("#go").disabled = true;
  try {
    const f = await fetchVideo(u.href, linkProg);
    useFile(f); setTab(false);
    toast("Video loaded. Pick your settings, then tap Find the moments.");
  } catch (err) {
    if (err.name === "AbortError") toast("Download cancelled.");
    else if (err.kind === "page") linkNote(err.message, "Paste a link that goes straight to an .mp4 or .mov file, or use the desktop app, which handles links to most video sites.");
    else if (err.kind === "http") linkNote(err.message, "Check the link opens the video in your browser, or download the video and upload the file.");
    else linkNote("That site won't let this page download the video.", "Most websites block it. The desktop app downloads it on your own computer instead, or you can save the video and upload the file.");
  } finally {
    $("#lprog").classList.add("hide");
    $("#link").disabled = $("#linkGo").disabled = $("#tabFile").disabled = false;
    $("#go").disabled = !$("#file").files[0];
  }
};
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, bad) => setTimeout(() => bad(new Error(OOM)), ms))]);
async function writeFS(path, data, E = E0) { E.cache.set(path, data); await E.ff.writeFile(path, data); }
async function resetFFmpeg(E = E0) {      // a fresh engine with the source re-mounted, to recover a stalled worker
  try { E.ff?.terminate(); } catch {}
  E.ff = null;
  await withTimeout((async () => {
    await loadEngine(E, true);
    if (srcFile) await E.ff.mount("WORKERFS", { files: [srcFile] }, "/in");
    for (const [p, d] of E.cache) await E.ff.writeFile(p, d);
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
  ff.on("progress", h); ff.on("log", lg);
  const wd = setInterval(() => {
    const now = Date.now();
    if (!last && now - t0 > 60000) { stalled = true; clearInterval(wd); try { ff.terminate(); } catch {} }
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

// ---------------------------------------------------------------- transcription
// The speech worker keeps its model loaded between videos (and starts loading it when a file is picked), except on
// Safari/iOS, where the worker is dropped after each run to leave WebAssembly memory for the video engine.
let asrW = null;
const asrWorker = () => asrW ||= new Worker(new URL("./asr-worker.js", import.meta.url), { type: "module" });
const dropASR = () => { try { asrW?.terminate(); } catch {} asrW = null; };
function preloadASR() { if (!IS_WEBKIT) asrWorker().postMessage({ type: "preload", model: opts.model }); }
function transcribe(pcm, windows, model) {
  return new Promise((resolve, reject) => {
    const w = asrWorker();
    let dev = "";
    w.onmessage = ({ data: d }) => {
      if (d.type === "load") stage("asr", 0, d.loaded < d.total ? "Loading speech model…" : "Preparing speech model…",
        d.loaded < d.total ? `${(d.loaded / 1e6).toFixed(0)} / ${(d.total / 1e6).toFixed(0)} MB (cached after first use)` : "Takes a moment on the first video only.");
      if (d.type === "device") { dev = d.device === "webgpu" ? " · GPU" : ""; perf.lap(`model load (${d.device})`); }
      if (d.type === "progress") stage("asr", 100 * d.done / d.total, "Transcribing…", `${X.fmtT(d.upto)} done${dev}`);
      if (d.type === "done") { if (IS_WEBKIT) dropASR(); resolve(d.words); }
      if (d.type === "error") { dropASR(); reject(new Error("Speech model: " + d.message)); }
    };
    w.postMessage({ audio: pcm, windows, model });
  });
}

// ---------------------------------------------------------------- render + quality gate
function filterGraph(m, keep, info, o, hasASS) {
  const W = o.hd ? 1080 : 720, H = o.hd ? 1920 : 1280;
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
  if (o.layout === "crop") vf = `scale=-2:${H},crop=${W}:${H}${sharpen}`;
  else {
    // blurred backdrop: blur a 1/8-size copy and scale it up (looks the same, ~5x less work than blurring full size);
    // only the visible video gets sharpened, since sharpening a blur is wasted work
    const bw = Math.round(W / 16) * 2, bh = Math.round(H / 16) * 2;
    vf = `split[a][b];[a]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=${o.hd ? 3 : 2}:2,` +
         `scale=${W}:${H}:flags=bilinear,eq=brightness=-0.08[bg];` +
         `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease${sharpen}[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2`;
  }
  if (o.enhance) {
    if (keep.length > 1) {
      let t = 0; const z = [];
      keep.forEach(([a, b], k) => { const s = t; t += b - a; if (k % 2) z.push(`between(on,${Math.floor(s * fps)},${Math.max(Math.floor(t * fps) - 1, Math.floor(s * fps))})`); });
      if (z.length) vf += `,zoompan=z='if(${z.join("+")},1.08,1)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps}`;
    }
  }
  if (hasASS) vf += ",ass=/sub.ass:fontsdir=/fonts";
  vf += ",setsar=1";   // square pixels: scale/crop rounding otherwise leaves SAR 10240:10239 (players show 719 px)
  const clean = o.enhance ? "highpass=f=80,afftdn=nr=10:nf=-40,equalizer=f=3200:t=q:w=1.2:g=2.5,acompressor=threshold=-20dB:ratio=2.5:attack=10:release=150:makeup=2," : "";
  const aout = `${clean}loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a]`;
  if (!info.hasVideo) {    // audio-only source (podcast, voice memo): captions over a moving waveform
    const ass = hasASS ? ",ass=/sub.ass:fontsdir=/fonts" : "";
    return { fc: `[0:a]${apre},asplit[aw][am];color=c=0x101018:s=${W}x${H}:r=${fps}[bg];` +
      `[aw]showwaves=s=${W}x${Math.round(H * 0.22)}:mode=cline:colors=0xFFE600:rate=${fps}[wv];` +
      `[bg][wv]overlay=0:(H-h)/2:shortest=1,format=yuv420p${ass},setsar=1[v];[am]${aout}`, fps, W, H, audiogram: true };
  }
  return { fc: `[0:v]${pre},${vf}[v];[0:a]${apre},${aout}`, fps, W, H };
}

async function renderClip(path, info, m, o, cta, onPct, E = E0) {
  const keep = X.keepIntervals(m, o.tighten, S?.quiet);
  const plat = X.F.platforms[o.platform];
  const hasASS = (o.captions && m.words.length) || (o.hook && m.title) || cta;
  if (hasASS) await writeFS("/sub.ass", X.buildASS(m, plat, keep, { captions: o.captions, hook: o.hook, cta, style: o.style }), E);
  const { fc, fps, W, H, audiogram } = filterGraph(m, keep, info, o, hasASS);
  const dur = m.end - m.start, expected = keep.reduce((a, [x, y]) => a + y - x, 0);
  // the quality detectors ride along on the render (black/freeze on the final picture, silence/loudness on the final audio),
  // so the clip isn't decoded a second time just to check it
  const taps = `;[v]split[vo][vq];[vq]blackdetect=d=0.5:pix_th=0.10,freezedetect=n=-60dB:d=2,nullsink` +
               `;[a]asplit[ao][aq];[aq]silencedetect=n=-45dB:d=2,ebur128=peak=true,anullsink`;
  const r = await run(["-ss", m.start.toFixed(3), "-t", dur.toFixed(3), "-i", path, "-filter_complex", fc + taps, "-map", "[vo]", "-map", "[ao]",
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
  return { blob, url: URL.createObjectURL(blob), thumb, quality, duration: +expected.toFixed(1), cuts: keep.length - 1, fps,
           size_mb: +(blob.size / 1e6).toFixed(1), fillers_cut: fillers, enhanced: o.enhance, srt: X.buildSRT(m, keep) };
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
async function makeCut(path, info, m, o, cta, onPct, E = E0) {
  let r = await renderClip(path, info, m, o, cta, onPct, E);
  const hardFails = r.quality.filter(x => !x.ok && x.hard);
  if (hardFails.length && hardFails.every(x => CONTENT.has(x.k))) return r;   // skip a retry that would fail the same way
  if (!passed(r.quality)) {                                        // re-render once in safe mode
    r = await renderClip(path, info, m, { ...o, tighten: false, enhance: false }, cta, onPct, E);
    r.retried = true;
  }
  return r;
}

// ---------------------------------------------------------------- pipeline
async function go(file) {
  const o = { platform: opts.platform, n: +opts.n, version: opts.version, hd: opts.quality === "hd", captions: opts.captions === "1",
              hook: opts.hook === "1", tighten: opts.tighten === "1", enhance: opts.enhance === "1", layout: opts.layout, style: opts.style };
  if (busy) return toast("Already working. Cancel first to start over.");
  busy = true;
  let spares = [];
  revokeAll();
  const cta = $("#cta").value.trim().slice(0, 80);
  $("#out").innerHTML = ""; $("#setup").classList.add("busy");
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  try {
    perf.start();
    await getFFmpeg();
    perf.lap("engine");
    try { await E0.ff.unmount("/in"); } catch {}
    srcFile = file;
    await E0.ff.mount("WORKERFS", { files: [file] }, "/in");
    const path = "/in/" + file.name;
    const info = probeLog((await run(["-hide_banner", "-i", path])).log);
    if (!info.duration) throw new Error("Couldn't read that file. Try an MP4 or MOV.");
    if (!info.acodec) throw new Error("That video has no audio track, so there's nothing to transcribe.");
    if (info.duration < 3) throw new Error("That video is under 3 seconds, too short to clip.");
    if (info.duration > 3 * 3600) throw new Error("That video is over 3 hours. Trim it first, or use the desktop app.");
    if (IS_WEBKIT && info.duration > 75) toast(IS_IOS ? "Heads up: on iPhone/iPad, videos over about a minute can run out of memory. Shorter videos work best." : "Heads up: Safari can run out of memory on videos over about a minute. Chrome handles long videos best.");
    else if (info.duration > 45 * 60) toast(`Long video (${X.fmtT(info.duration)}): this can take a while. Keep the tab open and the screen on.`);
    stage("audio", 0, "Reading audio…");
    const a = await run(["-i", path, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "/audio.raw"], t => stage("audio", 100 * t / info.duration, "Reading audio…", `${X.fmtT(t)} / ${X.fmtT(info.duration)}`));
    if (a.code !== 0) throw new Error("Couldn't decode the audio.");
    const raw = await E0.ff.readFile("/audio.raw"); await E0.ff.deleteFile("/audio.raw");
    const pcm = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
    let peak = 0; for (let k = 0; k < pcm.length; k += 4) { const x = Math.abs(pcm[k]); if (x > peak) peak = x; }
    if (peak < 1e-4) throw new Error("The audio is silent, so there's nothing to clip. Check the file has sound.");
    const loud = X.loudnessCurve(pcm), quiet = X.quietMap(pcm);
    perf.lap("probe+audio");
    // warm up extra engines for parallel rendering while the speech model works (a failed one is simply not used)
    spares = Array.from({ length: renderSlots() - 1 }, () => spareEngine().catch(e => { console.warn("spare engine failed:", e?.message || e); return null; }));
    const words = await transcribe(pcm, X.asrWindows(loud, info.duration), opts.model);
    perf.lap("transcribe");
    stage("score", 50, "Finding the best moments…");
    const segs = X.segmentsFromWords(words);
    const plat = X.F.platforms[o.platform];
    let version = o.version; if (!plat.long) version = "short";
    const pool = X.findMoments(segs, loud, info.duration, o.n + 3, o.platform, version);
    const title = file.name.replace(/\.[^.]+$/, "");
    results = []; let dropped = 0;
    S = { path, info, words, segs, loud, quiet, o, cta, version, title };
    perf.lap("score");
    const engines = [E0, ...(await Promise.all(spares)).filter(Boolean)];
    perf.lap(`engines x${engines.length}`);
    // Each engine takes the next-best moment, renders its long + short cut, then takes another, until n clips pass.
    // Moments render side by side, but clips are always shown in score order.
    const frac = new Map(), wins = [];
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
      m.captions = X.postCopy(m, title);
      const long = await makeCut(path, info, m, o, version !== "short" ? cta : "", x => p(version === "both" ? x * 0.6 : x), E);
      if (!passed(long.quality)) return null;
      const clip = { ...m, ...long, range: `${X.fmtT(m.start)}–${X.fmtT(m.end)}`, short: null, view: "long" };
      if (version === "both") {
        const sm = X.shorten(m, segs, loud, ...plat.short);
        if (sm && !tooQuiet(sm)) {
          const s = await makeCut(path, info, sm, o, "", x => p(60 + x * 0.4), E);
          if (passed(s.quality)) { clip.short = { ...s, start: sm.start, end: sm.end, title: sm.title, range: `${X.fmtT(sm.start)}–${X.fmtT(sm.end)}` }; clip.view = "short"; }
        }
      }
      return clip;
    }
    async function worker(E) {
      while (!failed && ok + inflight < o.n && next < pool.length) {
        const idx = next++; inflight++;
        try {
          const clip = await moment(pool[idx], E, idx);
          if (clip) { ok++; wins.push({ idx, clip }); wins.sort((a, b) => a.idx - b.idx); results = wins.map(w => w.clip); renderResults(title, dropped); }
          else dropped++;
        } catch (e) { failed ||= e; }
        finally { inflight--; frac.delete(idx); show(); }
      }
    }
    show();
    await Promise.all(engines.map(worker));      // workers never reject; the first error stops new work, then surfaces
    if (failed) throw failed;
    // the source stays mounted so clips can be edited and re-rendered; it's released when the next video starts
    $("#prog").classList.add("hide");
    if (!results.length) $("#out").innerHTML = `<div class="card msg">No moment passed the quality gate. Try a different video or turn off "Cut dead air".</div>`;
    else toast(`${results.length} clip${results.length > 1 ? "s" : ""} ready`);
  } catch (err) {
    console.error(err);
    $("#prog").classList.add("hide");
    $("#out").innerHTML = `<div class="card err">⚠ ${linkDesktop(esc(err.message || err))}</div>`;
  } finally {
    // spare engines are per run (memory); E0 keeps the source mounted for edits
    for (const sp of spares) sp.then(E => { try { E?.ff?.terminate(); } catch {} });
    busy = false;
    $("#setup").classList.remove("busy");
    try { await wakeLock?.release(); } catch {}
  }
}
$("#go").onclick = () => { const f = $("#file").files[0]; if (f) go(f); };
function revokeAll() {
  for (const c of results) for (const v of [c, c.short]) if (v) { URL.revokeObjectURL(v.url); if (v.thumb) URL.revokeObjectURL(v.thumb); }
}

// ---------------------------------------------------------------- results UI
function qualityHTML(v) {
  const q = v.quality || [], ok = q.filter(x => x.ok).length, warn = q.length - ok;
  return `<details class="qc"><summary><span class="qbadge ${warn ? "warn" : ""}">${warn ? "⚠" : "✓"} Quality ${ok}/${q.length}</span>${v.retried ? ' <span class="st">re-rendered in safe mode</span>' : ""}</summary>
    <ul class="check">${q.map(x => `<li class="${x.ok ? "ok" : "no"}"><b>${x.ok ? "✓" : "✗"}</b> ${esc(x.k)} <span>${esc(x.detail)}</span></li>`).join("")}</ul></details>`;
}
function cutHTML(c, v, which) {
  const name = `${c.idx}${which === "short" ? "_short" : ""}`;
  return qualityHTML(v) + `<div class="meta">${v.size_mb} MB · ${v.fps} fps · ${v.duration}s${v.cuts ? ` · ${v.cuts} cut${v.cuts > 1 ? "s" : ""}` : ""}${v.fillers_cut ? ` · ${v.fillers_cut} um/uh removed` : ""}${v.enhanced ? " · enhanced" : ""}</div>
    <div class="acts"><button class="dl" data-share="${which}">Save / share</button><a class="sec" href="${v.url}" download="clip_${name}.mp4">Download</a><a class="sec" href="${URL.createObjectURL(new Blob([v.srt], { type: "text/plain" }))}" download="clip_${name}.srt">.srt</a></div>`;
}
function renderResults(title, dropped) {
  const plat = X.F.platforms[opts.platform];
  const order = opts.platform !== "all" ? [opts.platform] : ["tiktok", "reels", "shorts", "facebook"];
  const pub = order.map(k => X.F.platforms[k]?.publish?.length ? `<details class="card tight"><summary>Before you post on <b>${esc(X.F.platforms[k].name)}</b></summary><ul class="pub">${X.F.platforms[k].publish.map(x => `<li>${esc(x)}</li>`).join("")}</ul><div class="judge">Judge it by: ${X.F.platforms[k].judge.map(esc).join(" · ")}</div></details>` : "").join("");
  $("#out").innerHTML = `<h2>${esc(title)}</h2><p class="pnote">Formatted for <b>${esc(plat.name)}</b>. ${esc(plat.note)}</p>${pub}` +
    (dropped ? `<p class="pnote">The quality gate replaced ${dropped} clip${dropped > 1 ? "s" : ""} that failed a hard check.</p>` : "") +
    `<div class="clips">` + results.map((c, i) => { c.idx = String(i + 1).padStart(2, "0"); const v = c.view === "short" && c.short ? c.short : c; return `
    <article class="clip" data-i="${i}">
      <video src="${v.url}" ${v.thumb ? `poster="${v.thumb}"` : ""} controls playsinline preload="metadata"></video>
      <div class="b">
        ${c.short ? `<div class="vtabs"><button data-cut="short" aria-pressed="${v === c.short}">Short · ${c.short.duration}s</button><button data-cut="long" aria-pressed="${v === c}">Long · ${c.duration}s</button></div>` : ""}
        <div class="top"><span class="score">${c.score}</span><span class="when">${esc(c.range)}</span></div>
        <div class="ttl">${esc((c.view === "short" && c.short ? c.short.title : c.title) || c.title)}</div>
        <p class="why">${c.reasons.map(esc).join(" · ")}</p>
        <ul class="check">${c.checklist.map(x => `<li class="${x.ok ? "ok" : "no"}"><b>${x.ok ? "✓" : "✗"}</b> ${esc(x.k)}<span class="ev">${esc(x.ev)}</span>${x.tip ? ` <span>${esc(x.tip)}</span>` : ""}</li>`).join("")}</ul>
        <div class="cutbox">${cutHTML(c, v, v === c ? "long" : "short")}</div>
        <button class="sec edbtn" data-edit>✎ Edit this cut: captions, trim, headline, style</button>
        <div class="editor hide"></div>
        <div class="copyrow">${order.filter(k => c.captions[k]).map(k => `<button class="sec" data-copy="${esc(c.captions[k])}">Copy ${PN[k]} caption</button>`).join("")}</div>
        <details style="margin-top:10px"><summary>Log a post</summary>${logForm(i, !!c.short)}</details>
      </div>
    </article>`; }).join("") + `</div>`;
  $("#out").querySelectorAll(".logf").forEach(setMetricLabels);
}

$("#out").addEventListener("click", async e => {
  const cp = e.target.closest("[data-copy]");
  if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); } catch { const a = document.createElement("textarea"); a.value = cp.dataset.copy; document.body.appendChild(a); a.select(); document.execCommand("copy"); a.remove(); } toast("Caption copied"); return; }
  const art = e.target.closest(".clip"); if (!art) return;
  const c = results[+art.dataset.i];
  const cutBtn = e.target.closest("[data-cut]");
  if (cutBtn) {
    const v = cutBtn.dataset.cut === "short" ? c.short : c;
    art.querySelectorAll("[data-cut]").forEach(x => x.setAttribute("aria-pressed", x === cutBtn));
    const vid = art.querySelector("video"); vid.src = v.url; if (v.thumb) vid.poster = v.thumb;
    art.querySelector(".cutbox").innerHTML = cutHTML(c, v, cutBtn.dataset.cut);
    c.view = cutBtn.dataset.cut;
    art.querySelector(".ttl").textContent = v.title || c.title;
    art.querySelector(".editor").classList.add("hide");
  }
  if (e.target.closest("[data-edit]")) openEditor(art, c);
  const nd = e.target.closest("[data-nudge]");
  if (nd) { const [which, dir] = nd.dataset.nudge.split(":"); keepTyped(art, c); const r = X.nudge(c.wl, c.ed.start, c.ed.end, which, +dir); Object.assign(c.ed, r); drawEditor(art, c); }
  const es = e.target.closest("[data-estyle]");
  if (es) { c.ed.style = es.dataset.estyle; art.querySelectorAll("[data-estyle]").forEach(x => x.setAttribute("aria-pressed", x === es)); }
  if (e.target.closest("[data-ecancel]")) art.querySelector(".editor").classList.add("hide");
  if (e.target.closest("[data-rerender]")) rerender(art, c);
  const sh = e.target.closest("[data-share]");
  if (sh) {
    const v = sh.dataset.share === "short" ? c.short : c;
    const f = new File([v.blob], `clip_${c.idx}${sh.dataset.share === "short" ? "_short" : ""}.mp4`, { type: "video/mp4" });
    if (navigator.canShare?.({ files: [f] })) { try { await navigator.share({ files: [f], text: c.captions.tiktok }); } catch {} }
    else { const a = document.createElement("a"); a.href = v.url; a.download = f.name; a.click(); }
  }
});

// ---------------------------------------------------------------- clip editor
function openEditor(art, c) {
  if (!S) return toast("Run a video first.");
  const cut = c.view === "short" && c.short ? "short" : "long", v = cut === "short" ? c.short : c;
  c.wl ??= S.words.map(w => ({ ...w }));                       // this clip's own editable copy of the transcript
  c.ed = { cut, start: v.start, end: v.end, title: v.title ?? c.title, style: S.o.style || "pop" };
  drawEditor(art, c);
  art.querySelector(".editor").classList.remove("hide");
  art.querySelector(".editor").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function drawEditor(art, c) {
  const ed = c.ed;
  c.lines = X.captionLines(c.wl, ed.start, ed.end);
  art.querySelector(".editor").innerHTML = `
    <label class="t">Headline (first 3 seconds)</label>
    <input class="txt ed-title" maxlength="90" value="${esc(ed.title)}">
    <label class="t">Trim <span class="st">${X.fmtT(ed.start)}.${String(Math.round(ed.start * 10) % 10)} → ${X.fmtT(ed.end)}.${String(Math.round(ed.end * 10) % 10)} · ${(ed.end - ed.start).toFixed(1)}s before cuts</span></label>
    <div class="trim"><span>Start</span><button class="sec" data-nudge="start:-1">◀ earlier</button><button class="sec" data-nudge="start:1">later ▶</button></div>
    <div class="trim"><span>End</span><button class="sec" data-nudge="end:-1">◀ earlier</button><button class="sec" data-nudge="end:1">later ▶</button></div>
    <label class="t">Captions: fix any misheard words</label>
    <div class="lines">${c.lines.map((l, i) => `<input class="txt ed-line" data-line="${i}" value="${esc(l.text)}" aria-label="Caption line ${i + 1}">`).join("") || '<p class="msg">No speech in this cut.</p>'}</div>
    <label class="t">Caption style</label>
    <div class="chips">${Object.entries(X.STYLES).map(([k, n]) => `<button class="chip" data-estyle="${k}" aria-pressed="${k === ed.style}">${esc(n)}</button>`).join("")}</div>
    <div class="acts" style="margin-top:14px"><button class="dl" data-rerender>Re-render this cut</button><button class="sec" data-ecancel>Close</button></div>
    <p class="pnote ed-status"></p>`;
}
function keepTyped(art, c) {          // fold typed caption fixes into the clip's transcript before redrawing
  const texts = [...art.querySelectorAll(".ed-line")].map(x => x.value);
  if (texts.length) X.applyLineEdits(c.wl, c.lines, texts);
  c.ed.title = art.querySelector(".ed-title")?.value.trim() ?? c.ed.title;
}
async function rerender(art, c) {
  if (busy) return toast("Wait for the current render to finish.");
  keepTyped(art, c);
  const ed = c.ed, btn = art.querySelector("[data-rerender]"), status = art.querySelector(".ed-status");
  const m = { start: ed.start, end: ed.end, title: ed.title, words: c.wl.filter(w => w.s >= ed.start - 0.5 && w.s <= ed.end + 0.5) };
  const o = { ...S.o, style: ed.style };
  busy = true; btn.disabled = true;
  try {
    const r = await makeCut(S.path, S.info, m, o, ed.cut === "long" && S.version !== "short" ? S.cta : "", x => { btn.textContent = `Rendering… ${Math.round(x)}%`; });
    if (!passed(r.quality)) { status.textContent = "That edit failed the quality gate (see the badge). Your previous version is kept."; return; }
    const target = ed.cut === "short" ? c.short : c;
    URL.revokeObjectURL(target.url); if (target.thumb) URL.revokeObjectURL(target.thumb);
    Object.assign(target, r, { start: ed.start, end: ed.end, title: ed.title, range: `${X.fmtT(ed.start)}–${X.fmtT(ed.end)}` });
    if (ed.cut === "long") c.title = ed.title;
    c.view = ed.cut;
    renderResults(S.title, 0);
    toast("Re-rendered and re-checked");
  } catch (err) { status.textContent = "⚠ " + (err.message || err); }
  finally { busy = false; if (btn.isConnected) { btn.disabled = false; btn.textContent = "Re-render this cut"; } }
}

// ---------------------------------------------------------------- results log (stored on this device)
const LOGKEY = "clipmachine.log";
const readLog = () => { try { return JSON.parse(localStorage.getItem(LOGKEY) || "[]"); } catch { return []; } };
const writeLog = rows => { try { localStorage.setItem(LOGKEY, JSON.stringify(rows)); } catch {} };
function logForm(i, hasShort) {
  const def = opts.platform !== "all" ? opts.platform : "tiktok";
  return `<form class="logf" data-clip="${i}">
    <select name="platform">${Object.keys(PN).map(k => `<option value="${k}" ${k === def ? "selected" : ""}>${PN[k]}</option>`).join("")}</select>
    <select name="cut">${hasShort ? `<option value="short">Short cut</option><option value="long">Long cut</option>` : `<option value="single">Clip</option>`}</select>
    <input name="posted" type="date" aria-label="Posted on"><select name="checkpoint"><option>24h</option><option>7d</option></select>
    <input name="views" inputmode="numeric" placeholder="Views" class="wide">
    <input name="metric1"><input name="metric2"><input name="metric3" class="wide">
    <input name="notes" placeholder="Notes: what you changed (one variable at a time)" class="wide">
    <button class="dl wide" type="submit">Save result</button></form>`;
}
function setMetricLabels(f) { const p = X.F.platforms[f.platform.value]; ["metric1", "metric2", "metric3"].forEach((n, i) => f[n].placeholder = p.judge[i] || n); }
$("#out").addEventListener("change", e => { const f = e.target.closest(".logf"); if (f && e.target.name === "platform") setMetricLabels(f); });
$("#out").addEventListener("submit", e => {
  const f = e.target.closest(".logf"); if (!f) return; e.preventDefault();
  const c = results[+f.dataset.clip], p = X.F.platforms[f.platform.value], row = Object.fromEntries(new FormData(f));
  ["metric1", "metric2", "metric3"].forEach((n, i) => { if (row[n]) row[n] = `${p.judge[i] || n}: ${row[n]}`; });
  Object.assign(row, { id: Math.random().toString(36).slice(2, 10), logged: new Date().toISOString().slice(0, 16).replace("T", " "), title: c.title });
  writeLog([...readLog(), row]); f.reset(); setMetricLabels(f); loadLog(); toast("Result saved on this device");
});
function loadLog() {
  const rows = readLog();
  $("#logtbl").innerHTML = rows.length ? `<div class="lwrap"><table class="ltable"><tr><th>Platform</th><th>Clip</th><th>At</th><th>Views</th><th>Metrics</th><th></th></tr>` +
    rows.slice().reverse().map(r => `<tr><td>${esc(PN[r.platform] || r.platform)}<br><span class="st">${esc(r.posted)}</span></td><td>${esc(r.title).slice(0, 40)}<br><span class="st">${esc(r.cut)}</span></td><td>${esc(r.checkpoint)}</td><td>${esc(r.views)}</td><td>${[r.metric1, r.metric2, r.metric3].filter(Boolean).map(esc).join("<br>")}${r.notes ? `<br><span class="st">${esc(r.notes)}</span>` : ""}</td><td><button class="x" data-dellog="${r.id}" aria-label="Delete">✕</button></td></tr>`).join("") + `</table></div>` : "No results logged yet.";
}
$("#logtbl").addEventListener("click", e => { const d = e.target.closest("[data-dellog]"); if (d && confirm("Delete this entry?")) { writeLog(readLog().filter(r => r.id !== d.dataset.dellog)); loadLog(); } });
$("#csv").onclick = () => {
  const cols = ["logged", "platform", "cut", "title", "posted", "checkpoint", "views", "metric1", "metric2", "metric3", "notes"];
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.join(","), ...readLog().map(r => cols.map(k => q(r[k])).join(","))].join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "clip_results.csv"; a.click();
};

// ---------------------------------------------------------------- boot
// offline support: app files + ffmpeg core are cached after the first visit (http(s) only, not file://)
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});
await X.loadFormula();
showPlat(); loadLog();
// URL presets, e.g. ?platform=tiktok&n=1&version=short (handy for sharing a setup)
for (const [k, v] of new URLSearchParams(location.search)) document.querySelector(`.chips[data-k="${k}"] .chip[data-v="${CSS.escape(v)}"]`)?.click();
const src = new URLSearchParams(location.search).get("src");   // e.g. ?src=sample.mp4 (same-origin or CORS-enabled)
if (src) {
  try {
    const f = await fetchVideo(new URL(src, location.href).href, (p, m) => setStage("Fetching video…", p ?? 0, m));
    useFile(f);
    $("#prog").classList.add("hide");
    if (new URLSearchParams(location.search).get("auto") === "1") go(f);
  } catch (e) { $("#prog").classList.add("hide"); toast("Couldn't load ?src video"); }
}
