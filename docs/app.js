import { FFmpeg } from "./vendor/ffmpeg/index.js";
import { toBlobURL } from "./vendor/util/index.js";
import * as X from "./formula.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CORE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
const PN = { tiktok: "TikTok", reels: "Reels", shorts: "YT Shorts", facebook: "Facebook", snapchat: "Snapchat", x: "X" };
const opts = { platform: "all", n: "3", version: "both", quality: "fast", model: "Xenova/whisper-base.en",
               captions: "1", hook: "1", tighten: "1", enhance: "1", layout: "fit" };
let ffmpeg = null, logs = [], wakeLock = null, results = [];

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
$("#file").onchange = e => { const f = e.target.files[0]; $("#fname").textContent = f ? `📎 ${f.name} (${(f.size / 1e6).toFixed(0)} MB)` : "Choose a video"; $("#go").disabled = !f; };
$("#cancel").onclick = () => location.reload();

function setStage(label, pct, msg = "") {
  $("#prog").classList.remove("hide");
  $("#plabel").textContent = label; $("#ppct").textContent = Math.round(pct) + "%";
  $("#pbar").style.width = Math.max(0, Math.min(100, pct)) + "%"; $("#pmsg").textContent = msg;
}
const STAGES = { load: [0, 8], audio: [8, 14], asr: [14, 60], score: [60, 62], render: [62, 100] };
const stage = (k, pct, label, msg) => { const [a, b] = STAGES[k]; setStage(label, a + (b - a) * pct / 100, msg); };

// ---------------------------------------------------------------- ffmpeg helpers
async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  stage("load", 10, "Loading video engine…", "First run downloads ~30 MB. It's cached after that.");
  ffmpeg = new FFmpeg();
  ffmpeg.on("log", ({ message }) => { logs.push(message); if (logs.length > 4000) logs.splice(0, 2000); });
  await ffmpeg.load({ coreURL: await toBlobURL(`${CORE}/ffmpeg-core.js`, "text/javascript"),
                      wasmURL: await toBlobURL(`${CORE}/ffmpeg-core.wasm`, "application/wasm") });
  await ffmpeg.createDir("/fonts");
  await ffmpeg.writeFile("/fonts/Montserrat-Black.ttf", new Uint8Array(await (await fetch("./fonts/Montserrat-Black.ttf")).arrayBuffer()));
  await ffmpeg.createDir("/in");
  return ffmpeg;
}
async function run(args, onTime) {
  logs = [];
  const h = ({ time }) => onTime && time > 0 && onTime(time / 1e6);
  ffmpeg.on("progress", h);
  const code = await ffmpeg.exec(args);
  ffmpeg.off("progress", h);
  return { code, log: logs.join("\n") };
}
function probeLog(log) {
  const d = log.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const v = log.match(/Video: (\w+).*?, (\d{2,5})x(\d{2,5})/);
  const fps = log.match(/([\d.]+) fps/);
  return { duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0, vcodec: v?.[1], width: v ? +v[2] : 0, height: v ? +v[3] : 0,
           fps: fps ? +fps[1] : 30, hasVideo: !!v, acodec: (log.match(/Audio: (\w+)/) || [])[1] };
}

// ---------------------------------------------------------------- transcription
function transcribe(pcm, windows, model) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./asr-worker.js", import.meta.url), { type: "module" });
    let dev = "";
    w.onmessage = ({ data: d }) => {
      if (d.type === "load") stage("asr", 0, "Loading speech model…", `${(d.loaded / 1e6).toFixed(0)} / ${(d.total / 1e6).toFixed(0)} MB (cached after first use)`);
      if (d.type === "device") dev = d.device === "webgpu" ? " · GPU" : "";
      if (d.type === "progress") stage("asr", 100 * d.done / d.total, "Transcribing…", `${X.fmtT(d.upto)} done${dev}`);
      if (d.type === "done") { w.terminate(); resolve(d.words); }
      if (d.type === "error") { w.terminate(); reject(new Error("Speech model: " + d.message)); }
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
  if (o.layout === "crop") vf = `scale=-2:${H},crop=${W}:${H}`;
  else vf = `split[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=${o.hd ? 24 : 16}:4,eq=brightness=-0.08[bg];` +
            `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2`;
  if (o.enhance) {
    vf += ",unsharp=5:5:0.45:5:5:0,eq=contrast=1.04:saturation=1.07";
    if (keep.length > 1) {
      let t = 0; const z = [];
      keep.forEach(([a, b], k) => { const s = t; t += b - a; if (k % 2) z.push(`between(on,${Math.floor(s * fps)},${Math.max(Math.floor(t * fps) - 1, Math.floor(s * fps))})`); });
      if (z.length) vf += `,zoompan=z='if(${z.join("+")},1.08,1)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps}`;
    }
  }
  if (hasASS) vf += ",ass=/sub.ass:fontsdir=/fonts";
  const clean = o.enhance ? "highpass=f=80,afftdn=nr=10:nf=-40,equalizer=f=3200:t=q:w=1.2:g=2.5,acompressor=threshold=-20dB:ratio=2.5:attack=10:release=150:makeup=2," : "";
  return { fc: `[0:v]${pre},${vf}[v];[0:a]${apre},${clean}loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a]`, fps, W, H };
}

async function renderClip(path, info, m, o, cta, onPct) {
  const keep = X.keepIntervals(m, o.tighten);
  const plat = X.F.platforms[o.platform];
  const hasASS = (o.captions && m.words.length) || (o.hook && m.title) || cta;
  if (hasASS) await ffmpeg.writeFile("/sub.ass", X.buildASS(m, plat, keep, { captions: o.captions, hook: o.hook, cta }));
  const { fc, fps, W, H } = filterGraph(m, keep, info, o, hasASS);
  const dur = m.end - m.start, expected = keep.reduce((a, [x, y]) => a + y - x, 0);
  const r = await run(["-ss", m.start.toFixed(3), "-t", dur.toFixed(3), "-i", path, "-filter_complex", fc, "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", o.hd ? "veryfast" : "ultrafast", "-crf", o.hd ? "20" : "22", "-pix_fmt", "yuv420p",
    "-r", String(fps), "-g", String(fps * 2), "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", "-shortest", "/out.mp4"],
    t => onPct(Math.min(85, 85 * t / Math.max(expected, 1))));
  if (r.code !== 0) throw new Error("Render failed: " + r.log.split("\n").slice(-4).join(" "));
  // measure the finished file
  const q = await run(["-hide_banner", "-nostats", "-i", "/out.mp4", "-vf", "blackdetect=d=0.5:pix_th=0.10,freezedetect=n=-60dB:d=2",
    "-af", "silencedetect=n=-45dB:d=2,ebur128=peak=true", "-f", "null", "-"], t => onPct(85 + 13 * t / Math.max(expected, 1)));
  const data = await ffmpeg.readFile("/out.mp4");
  await run(["-ss", "0.6", "-i", "/out.mp4", "-frames:v", "1", "-vf", "scale=360:-2", "/thumb.jpg"]);
  let thumb = null; try { thumb = URL.createObjectURL(new Blob([(await ffmpeg.readFile("/thumb.jpg")).buffer], { type: "image/jpeg" })); await ffmpeg.deleteFile("/thumb.jpg"); } catch {}
  await ffmpeg.deleteFile("/out.mp4");
  const blob = new Blob([data.buffer], { type: "video/mp4" });
  const quality = qualityChecks(q.log, { expected, W, H, sizeMB: blob.size / 1e6, m, captions: o.captions });
  const fillers = o.tighten ? m.words.filter(w => w.s >= m.start && w.s <= m.end && X.F.fillerSet.has(w.w.toLowerCase().replace(/[^a-z]/g, ""))).length : 0;
  return { blob, url: URL.createObjectURL(blob), thumb, quality, duration: +expected.toFixed(1), cuts: keep.length - 1, fps,
           size_mb: +(blob.size / 1e6).toFixed(1), fillers_cut: fillers, enhanced: o.enhance, srt: X.buildSRT(m, keep) };
}

function qualityChecks(log, { expected, W, H, sizeMB, m, captions }) {
  const c = [], add = (k, ok, detail, hard) => c.push({ k, ok: !!ok, detail, hard });
  const p = probeLog(log);
  add("Upload-ready format", p.vcodec === "h264" && p.acodec === "aac" && p.width === W && p.height === H, `${p.vcodec} ${p.width}×${p.height} + ${p.acodec}`, true);
  add("Length matches the edit", Math.abs(p.duration - expected) < 0.8, `${p.duration.toFixed(1)}s (expected ${expected.toFixed(1)}s)`, true);
  add("Under upload size limits", sizeMB < 250, `${sizeMB.toFixed(1)} MB`, true);
  const I = [...log.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1)?.[1], P = [...log.matchAll(/Peak:\s+(-?[\d.]+|-inf) dBFS/g)].at(-1)?.[1];
  const black = [...log.matchAll(/black_duration:([\d.]+)/g)].reduce((a, x) => a + +x[1], 0);
  const silence = [...log.matchAll(/silence_duration: ([\d.]+)/g)].map(x => +x[1]);
  const freeze = [...log.matchAll(/freeze_duration: ([\d.]+)/g)].reduce((a, x) => a + +x[1], 0);
  add("Even loudness (−14 LUFS ±2)", I != null && +I >= -16.5 && +I <= -11.5, I != null ? `${I} LUFS` : "not measured", false);
  add("No clipping", P == null || P === "-inf" || +P <= -0.3, `true peak ${P} dBFS`, false);
  add("No black frames", black < 0.5, `${black.toFixed(1)}s black`, true);
  add("No dead silence", !silence.length, silence.length ? `${Math.max(...silence).toFixed(1)}s silent stretch` : "none over 2s", true);
  add("Picture keeps moving", freeze < 0.6 * Math.max(p.duration, 1), freeze ? `${freeze.toFixed(1)}s frozen` : "no long freezes", false);
  const sw = X.spoken(m.words.filter(w => w.s >= m.start && w.s <= m.end));
  if (captions && sw.length) add("Starts and ends on whole words", sw[0].s - m.start < 0.5 && m.end - sw.at(-1).e < 0.8, "clean in/out points", false);
  return c;
}
const passed = q => q.every(x => x.ok || !x.hard);

async function makeCut(path, info, m, o, cta, onPct) {
  let r = await renderClip(path, info, m, o, cta, onPct);
  if (!passed(r.quality)) {                                        // re-render once in safe mode
    r = await renderClip(path, info, m, { ...o, tighten: false, enhance: false }, cta, onPct);
    r.retried = true;
  }
  return r;
}

// ---------------------------------------------------------------- pipeline
async function go(file) {
  const o = { platform: opts.platform, n: +opts.n, version: opts.version, hd: opts.quality === "hd", captions: opts.captions === "1",
              hook: opts.hook === "1", tighten: opts.tighten === "1", enhance: opts.enhance === "1", layout: opts.layout };
  const cta = $("#cta").value.trim().slice(0, 80);
  $("#out").innerHTML = ""; $("#setup").classList.add("busy");
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  try {
    await getFFmpeg();
    try { await ffmpeg.unmount("/in"); } catch {}
    await ffmpeg.mount("WORKERFS", { files: [file] }, "/in");
    const path = "/in/" + file.name;
    const info = probeLog((await run(["-hide_banner", "-i", path])).log);
    if (!info.duration) throw new Error("Couldn't read that file. Try an MP4 or MOV.");
    if (!info.acodec) throw new Error("That video has no audio track, so there's nothing to transcribe.");
    stage("audio", 0, "Reading audio…");
    const a = await run(["-i", path, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "/audio.raw"], t => stage("audio", 100 * t / info.duration, "Reading audio…", `${X.fmtT(t)} / ${X.fmtT(info.duration)}`));
    if (a.code !== 0) throw new Error("Couldn't decode the audio.");
    const raw = await ffmpeg.readFile("/audio.raw"); await ffmpeg.deleteFile("/audio.raw");
    const pcm = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
    const loud = X.loudnessCurve(pcm);
    const words = await transcribe(pcm, X.asrWindows(loud, info.duration), opts.model);
    stage("score", 50, "Finding the best moments…");
    const segs = X.segmentsFromWords(words);
    const plat = X.F.platforms[o.platform];
    let version = o.version; if (!plat.long) version = "short";
    const pool = X.findMoments(segs, loud, info.duration, o.n + 3, o.platform, version);
    const title = file.name.replace(/\.[^.]+$/, "");
    results = []; let dropped = 0;
    for (const m of pool) {
      if (results.length >= o.n) break;
      const i = results.length, base = 100 * i / o.n, span = 100 / o.n;
      const p = x => stage("render", base + span * x / 100, `Rendering + checking clip ${i + 1} of ${o.n}`, "Keep this tab open.");
      m.captions = X.postCopy(m, title);
      const long = await makeCut(path, info, m, o, version !== "short" ? cta : "", x => p(version === "both" ? x * 0.6 : x));
      if (!passed(long.quality)) { dropped++; continue; }
      const clip = { ...m, ...long, range: `${X.fmtT(m.start)}–${X.fmtT(m.end)}`, short: null };
      if (version === "both") {
        const sm = X.shorten(m, segs, loud, ...plat.short);
        if (sm) {
          const s = await makeCut(path, info, sm, o, "", x => p(60 + x * 0.4));
          if (passed(s.quality)) clip.short = { ...s, range: `${X.fmtT(sm.start)}–${X.fmtT(sm.end)}` };
        }
      }
      results.push(clip); renderResults(title, dropped);
    }
    try { await ffmpeg.unmount("/in"); } catch {}
    $("#prog").classList.add("hide");
    if (!results.length) $("#out").innerHTML = `<div class="card msg">No moment passed the quality gate. Try a different video or turn off "Cut dead air".</div>`;
    else toast(`${results.length} clip${results.length > 1 ? "s" : ""} ready`);
  } catch (err) {
    console.error(err);
    $("#prog").classList.add("hide");
    $("#out").innerHTML = `<div class="card err">⚠ ${esc(err.message || err)}</div>`;
  } finally {
    $("#setup").classList.remove("busy");
    try { await wakeLock?.release(); } catch {}
  }
}
$("#go").onclick = () => { const f = $("#file").files[0]; if (f) go(f); };

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
    `<div class="clips">` + results.map((c, i) => { c.idx = String(i + 1).padStart(2, "0"); const v = c.short || c; return `
    <article class="clip" data-i="${i}">
      <video src="${v.url}" ${v.thumb ? `poster="${v.thumb}"` : ""} controls playsinline preload="metadata"></video>
      <div class="b">
        ${c.short ? `<div class="vtabs"><button data-cut="short" aria-pressed="true">Short · ${c.short.duration}s</button><button data-cut="long" aria-pressed="false">Long · ${c.duration}s</button></div>` : ""}
        <div class="top"><span class="score">${c.score}</span><span class="when">${esc(c.range)}</span></div>
        <div class="ttl">${esc(c.title)}</div>
        <p class="why">${c.reasons.map(esc).join(" · ")}</p>
        <ul class="check">${c.checklist.map(x => `<li class="${x.ok ? "ok" : "no"}"><b>${x.ok ? "✓" : "✗"}</b> ${esc(x.k)}<span class="ev">${esc(x.ev)}</span>${x.tip ? ` <span>${esc(x.tip)}</span>` : ""}</li>`).join("")}</ul>
        <div class="cutbox">${cutHTML(c, v, c.short ? "short" : "long")}</div>
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
  }
  const sh = e.target.closest("[data-share]");
  if (sh) {
    const v = sh.dataset.share === "short" ? c.short : c;
    const f = new File([v.blob], `clip_${c.idx}${sh.dataset.share === "short" ? "_short" : ""}.mp4`, { type: "video/mp4" });
    if (navigator.canShare?.({ files: [f] })) { try { await navigator.share({ files: [f], text: c.captions.tiktok }); } catch {} }
    else { const a = document.createElement("a"); a.href = v.url; a.download = f.name; a.click(); }
  }
});

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
await X.loadFormula();
showPlat(); loadLog();
// URL presets, e.g. ?platform=tiktok&n=1&version=short (handy for sharing a setup)
for (const [k, v] of new URLSearchParams(location.search)) document.querySelector(`.chips[data-k="${k}"] .chip[data-v="${CSS.escape(v)}"]`)?.click();
const src = new URLSearchParams(location.search).get("src");   // e.g. ?src=sample.mp4 (same-origin or CORS-enabled)
if (src) {
  try {
    setStage("Fetching video…", 0);
    const b = await (await fetch(src)).blob();
    const f = new File([b], src.split("/").pop().split("?")[0] || "video.mp4", { type: b.type || "video/mp4" });
    const dt = new DataTransfer(); dt.items.add(f); $("#file").files = dt.files; $("#file").onchange({ target: $("#file") });
    $("#prog").classList.add("hide");
    if (new URLSearchParams(location.search).get("auto") === "1") go(f);
  } catch (e) { $("#prog").classList.add("hide"); toast("Couldn't load ?src video"); }
}
