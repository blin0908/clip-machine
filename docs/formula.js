// Port of clipper.py's moment scoring, so the web app and the Mac app pick clips the same way.
// Constants (platform presets, hype words, weights) come from formula.json, generated from clipper.py.
export let F = null;
export async function loadFormula() {
  F = await (await fetch("./formula.json")).json();
  F.hypeEntries = Object.entries(F.hype);
  F.stopSet = new Set(F.stop); F.weakSet = new Set(F.weak);
  F.midSet = new Set(F.midstart); F.fillerSet = new Set(F.fillers);
  for (const p of Object.values(F.platforms)) p.sweet = p.long || p.short;
  return F;
}

export const HOP = 0.5, SR = 16000;
const HOOK_RX = () => /\?|\b(you|your|why|how|what if|imagine|never|stop|nobody|secret|here's|this is|the \w+est)\b|\d/gi;
const LAUGH_RX = () => /\b(ha(ha)+|lol|lmao)\b|\[(laugh|laughter|laughing)[^\]]*\]|\((laugh|laughs|laughter|laughing)\)/gi;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const count = (rx, t) => (t.match(rx) || []).length;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

// ---------------------------------------------------------------- audio
export function loudnessCurve(pcm) {
  const hop = SR * HOP, n = Math.floor(pcm.length / hop);
  if (!n) return new Float32Array(1);
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * hop, k = j + hop; j < k; j++) s += pcm[j] * pcm[j];
    db[i] = 20 * Math.log10(Math.sqrt(s / hop + 1e-10));
  }
  const sorted = Array.from(db).sort((a, b) => a - b);
  const floor = sorted[Math.floor(n * 0.05)];
  for (let i = 0; i < n; i++) db[i] = Math.max(db[i], floor);
  const med = Array.from(db).sort((a, b) => a - b)[Math.floor(n / 2)];
  const m = mean(Array.from(db));
  const sd = Math.sqrt(mean(Array.from(db, x => (x - m) ** 2))) || 1;
  return db.map(x => (x - med) / sd);
}

/** Split long audio into ~28 s windows, cutting at the quietest moment near each boundary. */
export function asrWindows(loud, duration) {
  const out = []; let s = 0;
  while (s < duration - 0.5) {
    let e = Math.min(duration, s + 28);
    if (e < duration) {
      let best = e, bestV = Infinity;
      for (let t = e - 4; t <= e; t += HOP) { const v = loud[Math.floor(t / HOP)] ?? 0; if (v < bestV) { bestV = v; best = t; } }
      e = best;
    }
    out.push([s, e]); s = e;
  }
  return out;
}

/** Group word timestamps into sentence-ish segments. */
export function segmentsFromWords(words) {
  const segs = []; let cur = [];
  const flush = () => { if (cur.length) segs.push({ s: cur[0].s, e: cur.at(-1).e, text: cur.map(w => w.w).join(" "), words: cur }); cur = []; };
  words.forEach((w, i) => {
    const prev = cur.at(-1);
    if (prev && (w.s - prev.e > 1.0 || w.s - cur[0].s > 12)) flush();
    cur.push(w);
    if (/[.!?]["')\]]*$/.test(w.w)) flush();
  });
  flush();
  return segs;
}

// ---------------------------------------------------------------- scoring
const isFiller = w => F.fillerSet.has(w.w.toLowerCase().replace(/[^a-z]/g, ""));
export const spoken = ws => ws.filter(w => !isFiller(w));

function units(segs, duration) {
  let u = segs.filter(s => s.e > s.s);
  if (u.length < 4) { u = []; for (let t = 0; t < Math.max(duration - 1, 1); t += 5) u.push({ s: t, e: Math.min(duration, t + 5), text: "", words: [] }); }
  return u;
}

function features(s, e, text, words, loud, firstText, plat) {
  const lo = Math.floor(s / HOP), hi = Math.max(Math.floor(e / HOP), lo + 1);
  let seg = Array.from(loud.slice(lo, hi)); if (!seg.length) seg = [0];
  const top = seg.slice().sort((a, b) => a - b).slice(-Math.max(1, Math.floor(seg.length / 3)));
  const head = Array.from(loud.slice(lo, lo + 3 / HOP));
  const tail = seg.slice(-Math.max(1, Math.floor(seg.length / 4)));
  const first1 = Array.from(loud.slice(lo, lo + 1 / HOP));
  const firstWords = words.filter(w => w.s < s + 1.5).map(w => w.w).join(" ");
  const low = text.toLowerCase();
  const kw = F.hypeEntries.filter(([k]) => new RegExp("\\b" + esc(k) + "\\b").test(low));
  const dur = Math.max(e - s, 1);
  const headWords = words.filter(w => w.s < s + 3).map(w => w.w).join(" ") || firstText.slice(0, 60);
  const hookLang = count(HOOK_RX(), headWords) + F.hypeEntries.filter(([k]) => headWords.toLowerCase().includes(k)).reduce((a, [, w]) => a + w, 0);
  let gaps = 0; for (let i = 1; i < words.length; i++) { const g = words[i].s - words[i - 1].e; if (g > 0.7) gaps += g; }
  const lead = words.length ? words[0].s - s : 0;
  const [ls, hs] = plat.sweet;
  const fit = dur >= ls && dur <= hs ? 1 : Math.max(0, 1 - Math.min(Math.abs(dur - ls), Math.abs(dur - hs)) / 20);
  const sd = Math.sqrt(mean(seg.map(x => (x - mean(seg)) ** 2)));
  const firstWord = ((firstText || "").match(/^\W*([a-zA-Z']+)/) || [])[1]?.toLowerCase() || "";
  return {
    energy: mean(top), peak: Math.max(...seg), swing: sd,
    hype: kw.reduce((a, [, w]) => a + w, 0), laugh: count(LAUGH_RX(), text), exclaim: (text.match(/!/g) || []).length,
    pace: words.length / dur, hook: mean(head) + 0.8 * Math.min(hookLang, 4), first1: mean(first1),
    payoff: mean(tail) - mean(seg), ends_clean: /[.!?]\W*$/.test(text) ? 1 : 0,
    midstart: F.midSet.has(firstWord) ? 1 : 0, deadair: (gaps + Math.max(lead, 0)) / dur, fit,
    sponsor: F.sponsor.filter(k => low.includes(k)).length,
    _kw: kw.sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k), _hookLang: hookLang,
    _firstHook: HOOK_RX().test(firstWords) || F.hypeEntries.some(([k]) => firstWords.toLowerCase().includes(k)),
  };
}

export function findMoments(segs, loud, duration, n, platformKey, version) {
  const base = F.platforms[platformKey] || F.platforms.all;
  const rng = (version !== "short" && base.long) ? base.long : base.short;
  const plat = { ...base, sweet: rng };
  const minLen = rng[0], maxLen = Math.min(rng[1] + 2, base.hard_max);
  const U = units(segs, duration);
  let cands = [];
  for (let i = 0; i < U.length; i++) {
    for (let j = i; j < U.length; j++) {
      const words = U.slice(i, j + 1).flatMap(u => u.words);
      const s = Math.max(0, words.length ? words[0].s - 0.12 : U[i].s);
      const e = Math.min(duration, words.length ? words.at(-1).e + 0.35 : U[j].e);
      if (e - s > maxLen) break;
      if (e - s < minLen) continue;
      const text = U.slice(i, j + 1).map(u => u.text).join(" ").trim();
      cands.push({ s, e, text, words, f: features(s, e, text, words, loud, U[i].text, plat) });
    }
  }
  if (!cands.length) {
    const words = U.flatMap(u => u.words), text = U.map(u => u.text).join(" "), e = Math.min(duration, base.hard_max);
    cands = [{ s: 0, e, text, words, f: features(0, e, text, words, loud, text, plat) }];
  }
  const keys = Object.keys(F.weights), raw = new Set(F.raw);
  const cols = keys.map(k => cands.map(c => c.f[k]));
  const z = cands.map(() => ({}));
  keys.forEach((k, ki) => {
    const col = cols[ki], m = mean(col), sd = Math.sqrt(mean(col.map(x => (x - m) ** 2))) || 1;
    cands.forEach((c, ci) => { z[ci][k] = raw.has(k) ? col[ci] : (col[ci] - m) / sd; });
  });
  cands.forEach((c, ci) => { c.z = z[ci]; c.score = keys.reduce((a, k) => a + F.weights[k] * z[ci][k], 0); });
  cands.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of cands) {
    if (picked.some(m => !(c.e + 2 <= m.start || c.s >= m.end + 2))) continue;
    picked.push({ start: +c.s.toFixed(2), end: +c.e.toFixed(2), raw: c.score, text: c.text, words: c.words,
                  reasons: reasons(c.z, c.f), checklist: checklist(c.z, c.f, c.e - c.s, plat),
                  signals: Object.fromEntries(keys.map(k => [k, Math.round(c.z[k] * 100) / 100])) });   // for learning from results
    if (picked.length >= n) break;
  }
  if (picked.length) {
    const hi = picked[0].raw, lo = Math.min(...picked.map(m => m.raw));
    for (const m of picked) {
      const passed = m.checklist.filter(x => x.ok).length / m.checklist.length;
      m.score = Math.round(45 + 30 * (hi > lo ? (m.raw - lo) / (hi - lo) : 1) + 24 * passed);
      m.title = title(m, segs);
      m.hashtags = tags(m.text, base.tags);
    }
  }
  return picked;
}

function reasons(z, f) {
  const o = [];
  if (z.energy > 0.8 || z.peak > 1) o.push("loud / high-energy spike");
  if (f._kw.length) o.push("hype words: " + f._kw.join(", "));
  if (f.laugh) o.push("laughter");
  if (z.hook > 0.8) o.push("strong opening hook");
  if (z.payoff > 0.8) o.push("builds to a payoff");
  if (z.pace > 1) o.push("fast, punchy delivery");
  if (f.sponsor) o.push("⚠ may contain an ad read");
  return o.length ? o : ["steady, complete thought"];
}

function checklist(z, f, dur, plat) {
  const [lo, hi] = plat.sweet;
  const first = z.first1 > 0 || f._firstHook;
  return [
    { k: "Something happens in the first second", ev: "Official + Test", ok: first, tip: first ? "Swipe / skip rate is a documented signal" : "Slow first second: open on the action" },
    { k: "Hook in the first 3 seconds", ev: "Official", ok: z.hook > 0 || f._hookLang >= 2, tip: z.hook > 0 ? "Opens loud or with a question / bold claim" : "Weak opener: the headline overlay helps" },
    { k: "Starts on a fresh thought", ev: "Test", ok: !f.midstart, tip: f.midstart ? "Opens on 'and/so/but', may feel mid-thought" : "Doesn't open mid-sentence" },
    { k: `Length in ${plat.name} test range (${lo}–${hi}s)`, ev: "Data", ok: dur >= lo - 1 && dur <= hi + 1, tip: `${Math.round(dur)}s` },
    { k: "High emotional energy", ev: "Data", ok: z.energy > 0 || f.laugh > 0 || f.hype >= 3, tip: z.energy > 0 ? "Above this video's average" : "Calmer than average" },
    { k: "Builds to a payoff / clean ending", ev: "Test", ok: !!f.ends_clean && z.payoff > -0.5, tip: "Full payoff on the first pass. Loop bonuses are unverified." },
    { k: "Little dead air", ev: "Test", ok: f.deadair < 0.12, tip: `${Math.round(f.deadair * 100)}% silence (Cut dead air removes it)` },
    { k: "No ad read", ev: "Test", ok: !f.sponsor, tip: f.sponsor ? "Contains sponsor language" : "" },
  ];
}

function title(m, segs) {
  const sents = segs.filter(s => s.s >= m.start - 0.3 && s.e <= m.end + 0.5 && s.text).map(s => s.text);
  if (!sents.length) return "Wait for it…";
  const strength = t => F.hypeEntries.filter(([k]) => t.toLowerCase().includes(k)).reduce((a, [, w]) => a + w, 0)
    + count(HOOK_RX(), t) * 0.7 + (t.match(/!/g) || []).length - Math.abs(t.length - 45) / 25;
  let best = sents.reduce((a, b) => strength(b) > strength(a) ? b : a).replace(/^[\s.,-]+|[\s.,-]+$/g, "");
  best = best.replace(/\b(um+|uh+m?|erm|er|hmm+|ah+|mhm)\b,?\s*/gi, "").trim().replace(/^(and|but|so|because|like)[,\s]+/i, "");
  best = best.charAt(0).toUpperCase() + best.slice(1);
  if (best.length > 60) best = best.slice(0, 60).replace(/\s+\S*$/, "").replace(/[,;:-]+$/, "") + "…";
  return best;
}

function tags(text, k) {
  const cnt = {};
  for (const w of text.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || [])
    if (w.length >= 5 && !w.includes("'") && !F.stopSet.has(w) && !F.weakSet.has(w)) cnt[w] = (cnt[w] || 0) + 1;
  return Object.entries(cnt).sort((a, b) => b[1] * (1 + b[0].length / 10) - a[1] * (1 + a[0].length / 10) || a[0].localeCompare(b[0]))
    .slice(0, Math.max(k, 1)).map(([w]) => "#" + w);
}

export function postCopy(m, sourceTitle) {
  const t = m.title, h = m.hashtags;
  return {
    tiktok: `${t} ${h.slice(0, 3).join(" ")}`.trim(), shorts: t.slice(0, 100), reels: `${t}\n\n${h.slice(0, 3).join(" ")}`.trim(),
    facebook: sourceTitle ? `${t} (from ${sourceTitle.slice(0, 60)})` : t, snapchat: t.slice(0, 80), x: `${t} ${h.slice(0, 1).join(" ")}`.trim(),
  };
}

export function shorten(m, segs, loud, lo, hi) {
  if (m.end - m.start <= hi + 1) return null;
  let ends = segs.map(s => s.e).filter(e => e >= m.start + lo && e <= Math.min(m.start + hi, m.end));
  if (!ends.length) ends = m.words.map(w => w.e).filter(e => e >= m.start + lo && e <= m.start + hi);
  if (!ends.length) ends = [m.start + (lo + hi) / 2];
  const punch = e => { const i = Math.floor(e / HOP); return mean(Array.from(loud.slice(Math.max(0, i - 2 / HOP), i + 1))); };
  const e = ends.reduce((a, b) => punch(b) > punch(a) ? b : a);
  const words = m.words.filter(w => w.e <= e + 0.05);
  const end = Math.min(m.end, words.length ? words.at(-1).e + 0.35 : e);
  return { ...m, end: +end.toFixed(2), words, text: words.map(w => w.w).join(" "), short: true };
}

// ---------------------------------------------------------------- edit decisions
// Fine-grained quiet map (absolute level every 50 ms). Browser Whisper stretches a word's timing over the pause after
// it, so word gaps alone miss real dead air; this finds it from the audio itself.
// "Quiet" = 25 dB under typical speech level, which lines up with the gate's −45 dB check after loudness normalising.
export function quietMap(pcm, step = 0.05) {
  const hop = Math.round(SR * step), n = Math.floor(pcm.length / hop), db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * hop, k = j + hop; j < k; j++) s += pcm[j] * pcm[j];
    db[i] = 10 * Math.log10(s / hop + 1e-12);
  }
  const sorted = Array.from(db).sort((a, b) => a - b);
  const speech = sorted[Math.floor(n * 0.7)] ?? -20;
  return { step, db, thr: speech - 25 };
}
// Quiet runs inside [a, b] (absolute seconds) at least minLen long, as [start, end] pairs.
export function quietRuns(q, a, b, minLen = 0.5) {
  if (!q) return [];
  const out = []; let run = null;
  const i0 = Math.max(0, Math.floor(a / q.step)), i1 = Math.min(q.db.length, Math.ceil(b / q.step));
  for (let i = i0; i <= i1; i++) {
    const quiet = i < i1 && q.db[i] < q.thr;
    if (quiet && run == null) run = i;
    if (!quiet && run != null) { const s = run * q.step, e = i * q.step; if (e - s >= minLen) out.push([s, e]); run = null; }
  }
  return out;
}
export const longestQuiet = (q, a, b) => quietRuns(q, a, b, 0).reduce((m, [s, e]) => Math.max(m, e - s), 0);

export function keepIntervals(m, tighten, q = null) {
  const dur = m.end - m.start;
  const ws = m.words.filter(w => w.s >= m.start && w.s <= m.end);
  if (!tighten || ws.length < 2) return [[0, dur]];
  const cut = [];
  // dead air the audio shows, trimmed to leave ~0.15 s of breath on each side
  for (const [s, e] of quietRuns(q, m.start, m.end, 0.5)) cut.push([s - m.start + 0.15, e - m.start - 0.15]);
  for (let i = 1; i < ws.length; i++) {
    const gs = ws[i - 1].e - m.start + 0.18, ge = ws[i].s - m.start - 0.12;
    if (ge - gs > 0.35) cut.push([gs, ge]);
  }
  for (const w of ws) if (isFiller(w)) cut.push([w.s - m.start - 0.02, w.e - m.start + 0.04]);
  const sorted = cut.map(([a, b]) => [Math.max(0, a), Math.min(dur, b)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of sorted) {
    if (merged.length && a <= merged.at(-1)[1] + 0.12) merged.at(-1)[1] = Math.max(merged.at(-1)[1], b);
    else merged.push([a, b]);
  }
  const keep = []; let cur = 0;
  for (const [a, b] of merged) { if (a > cur) keep.push([cur, a]); cur = Math.max(cur, b); }
  if (cur < dur) keep.push([cur, dur]);
  const k = keep.filter(([a, b]) => b - a > 0.08).map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)]);
  return k.length ? k : [[0, dur]];
}

export function remap(t, keep) {
  let out = 0;
  for (const [a, b] of keep) { if (t < a) return out; if (t <= b) return out + (t - a); out += b - a; }
  return out;
}

const assTime = t => { t = Math.max(t, 0); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = (t % 60).toFixed(2).padStart(5, "0"); return `${h}:${String(m).padStart(2, "0")}:${s}`; };
const clean = w => w.replace(/\\/g, "").replace(/{/g, "(").replace(/}/g, ")").toUpperCase();

// Caption styles: pop = bold white, active word yellow + scaled; clean = plain white phrases; boxed = white on black box.
export const STYLES = { pop: "Pop (active word highlight)", clean: "Clean (plain phrases)", boxed: "Boxed (black box)" };

// Output frames. 9:16 is the default; the others are for feeds (1:1, 4:5) and landscape players (16:9).
export const FORMATS = { "9:16": [9, 16], "4:5": [4, 5], "1:1": [1, 1], "16:9": [16, 9] };
export function frameSize(format = "9:16", hd = true) {
  const [a, b] = FORMATS[format] || FORMATS["9:16"], s = hd ? 1080 : 720, even = x => Math.round(x / 2) * 2;
  return a <= b ? [s, even(s * b / a)] : [even(s * a / b), s];
}
// "#ffd400" → ASS colour "&H0000D4FF&" (ASS stores blue, green, red)
export function assColour(hex, fallback = "#FFF000") {
  const h = /^#?[0-9a-f]{6}$/i.test(hex || "") ? hex.replace("#", "") : fallback.replace("#", "");
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
}
const SIZES = { s: 0.82, m: 1, l: 1.2 };
/** Where captions sit for a format/position, in subtitle pixels: { PX, PY, align, marginV, marginLR, hookTop, scale }. */
export function captionLayout(plat, { format = "9:16", size = "m", pos = "bottom" } = {}) {
  const [PX, PY] = frameSize(format, true), tall = format === "9:16";
  const scale = Math.min(1, Math.max(0.62, PY / 1920 * 1.45)) * (SIZES[size] || 1);
  const hookTop = tall ? plat.hook_top : Math.round(PY * 0.07);
  const marginLR = tall ? plat.right : Math.round(PX * 0.07);
  const align = pos === "top" ? 8 : pos === "middle" ? 5 : 2;
  const marginV = pos === "top" ? hookTop + Math.round(PY * 0.11) : pos === "middle" ? 0 : tall ? plat.cap_bottom : Math.round(PY * 0.1);
  return { PX, PY, align, marginV, marginLR, hookTop, scale };
}
// Brand logo: a square box in a top corner, under the captions. Mirrors logo_box / logo_chain in clipper.py.
export const LOGO_SIZES = { s: 0.09, m: 0.12, l: 0.15 }, LOGO_OPACITY = [0.5, 0.7, 1];
export function logoBox(format = "9:16", { lpos = "tl", lsize = "m" } = {}, hd = true) {
  const [W, H] = frameSize(format, hd), m = Math.min(W, H);
  const box = Math.round(m * (LOGO_SIZES[lsize] || LOGO_SIZES.m) / 2) * 2;
  const mx = Math.round(m * 0.05), my = format === "9:16" ? Math.round(H * 0.045) : mx;
  return { W, H, box, mx, my, right: lpos === "tr" };
}
export function logoOpacity(v) {
  const n = Number(v);
  return Number.isFinite(n) && v !== "" && v != null ? LOGO_OPACITY.reduce((a, o) => Math.abs(o - n) < Math.abs(a - n) ? o : a) : 0.7;
}
/** Filtergraph piece: scale logo input #idx into its box and lay it over inLabel (the caller continues the chain). */
export function logoChain(format, look, inLabel, idx, hd = true) {
  const b = logoBox(format, look, hd);
  return `[${idx}:v]scale=w=${b.box}:h=${b.box}:force_original_aspect_ratio=decrease,format=rgba,` +
         `colorchannelmixer=aa=${logoOpacity(look?.lop).toFixed(2)}[lg];${inLabel}[lg]overlay=x=${b.right ? `W-w-${b.mx}` : b.mx}:y=${b.my}`;
}
export function buildASS(m, plat, keep, { captions = true, hook = true, cta = "", style = "pop", hl = "#FFF000", size = "m", pos = "bottom", format = "9:16" } = {}) {
  const font = "Montserrat Thin Black";   // the family name stored inside fonts/Montserrat-Black.ttf
  const L0 = captionLayout(plat, { format, size, pos }), k = L0.scale, R = L0.marginLR, n = x => Math.round(x * k);
  const hk = Math.min(1, L0.scale / (SIZES[size] || 1)), nh = x => Math.round(x * hk);   // headline ignores the size choice
  const tail = `${L0.align},${R},${R},${L0.marginV},1`;
  const CAPS = {
    pop:   `Style: Cap,${font},${n(84)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,${n(7)},${n(3)},${tail}`,
    clean: `Style: Cap,${font},${n(70)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,${n(4)},${n(2)},${tail}`,
    boxed: `Style: Cap,${font},${n(72)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,${n(16)},0,${tail}`,
  };
  const cap = CAPS[style] || CAPS.pop, HL = assColour(hl);
  let out = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${L0.PX}\nPlayResY: ${L0.PY}\nWrapStyle: 0\n\n[V4+ Styles]\n` +
    `Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    `${cap}\n` +
    `Style: Hook,${font},${nh(58)},&H00111111,&H00111111,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,3,${nh(20)},0,8,${R + 20},${R + 20},${L0.hookTop},1\n` +
    `Style: Cta,${font},${nh(58)},&H00111111,&H00111111,&H0000E6FF,&H00000000,0,0,0,0,100,100,0,0,3,${nh(20)},0,8,${R + 20},${R + 20},${L0.hookTop},1\n\n` +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const L = [];
  // headline / end card: braces would start an override tag, a backslash an escape (\N = line break), a newline a new event
  const safe = s => String(s).replace(/[\r\n]+/g, " ").replace(/\\/g, "/").replace(/{/g, "(").replace(/}/g, ")");
  if (hook && m.title) L.push(`Dialogue: 1,${assTime(0)},${assTime(3.2)},Hook,,0,0,0,,{\\fad(120,250)}${safe(m.title)}`);
  if (cta) { const tot = keep.reduce((a, [x, y]) => a + y - x, 0); L.push(`Dialogue: 1,${assTime(Math.max(3.4, tot - 2.8))},${assTime(tot)},Cta,,0,0,0,,{\\fad(150,0)}${safe(cta)}`); }
  const T = t => remap(t - m.start, keep);
  for (const g of captionGroups(m, { captions, style })) {
    if (style === "clean") {             // one event per phrase, no per-word highlight
      const s = T(g.s); let e = T(g.e); if (e - s > 3.5) e = s + 3.5;
      L.push(`Dialogue: 0,${assTime(s)},${assTime(Math.max(e, s + 0.05))},Cap,,0,0,0,,${g.words.map(x => safe(x.w)).join(" ")}`);
      continue;
    }
    g.words.forEach((w, wi) => {
      const s = T(w.s); let e = T(wi + 1 < g.words.length ? g.words[wi + 1].s : g.e);
      if (e - s > 1.6) e = s + 1.6;
      const hi = style === "boxed" ? `{\\c${HL}}` : `{\\c${HL}\\fscx112\\fscy112}`;
      const lo = style === "boxed" ? `{\\c&HFFFFFF&}` : `{\\c&HFFFFFF&\\fscx100\\fscy100}`;
      const parts = g.words.map((x, j) => j === wi ? `${hi}${clean(x.w)}${lo}` : clean(x.w));
      L.push(`Dialogue: 0,${assTime(s)},${assTime(Math.max(e, s + 0.05))},Cap,,0,0,0,,${parts.join(" ")}`);
    });
  }
  return out + L.join("\n") + "\n";
}
/** The caption phrases a cut shows (3 words, 4 for "clean"), each { s, e, words } in source time. Shared by the
 *  subtitle file and the studio's live preview, so what you see before rendering is what renders. */
export function captionGroups(m, { captions = true, style = "pop" } = {}) {
  const words = captions ? spoken(m.words.filter(w => w.s >= m.start - 0.05 && w.s <= m.end)) : [];
  const per = style === "clean" ? 4 : 3, out = [];
  for (let i = 0; i < words.length; i += per) out.push({ words: words.slice(i, i + per) });
  out.forEach((g, i) => { g.s = g.words[0].s; g.e = i + 1 < out.length ? out[i + 1].words[0].s : g.words.at(-1).e + 0.3; });
  return out;
}
export const captionText = w => clean(w);

// ---------------------------------------------------------------- editor helpers
/** Caption lines (≈6 spoken words) inside a cut, each holding references to its word objects. */
export function captionLines(words, start, end, per = 6) {
  const ws = spoken(words.filter(w => w.s >= start - 0.05 && w.s <= end));
  const out = [];
  for (let i = 0; i < ws.length; i += per) { const g = ws.slice(i, i + per); out.push({ s: g[0].s, e: g.at(-1).e, text: g.map(w => w.w).join(" "), words: g }); }
  return out;
}

/** Apply edited line texts to a transcript (in place). Same word count keeps every timing; otherwise the
 *  new words are spread across the line's time span by length. Empty text removes the words from captions. */
export function applyLineEdits(transcript, lines, texts) {
  lines.forEach((ln, i) => {
    const t = (texts[i] ?? ln.text).trim();
    if (t === ln.text) return;
    const toks = t.split(/\s+/).filter(Boolean);
    let repl;
    if (toks.length === ln.words.length) repl = ln.words.map((w, k) => ({ ...w, w: toks[k] }));
    else {
      const total = toks.reduce((a, x) => a + x.length + 1, 0) || 1, span = Math.max(ln.e - ln.s, 0.1);
      let t0 = ln.s;
      repl = toks.map(x => { const d = span * (x.length + 1) / total; const w = { w: x, s: t0, e: t0 + d * 0.9 }; t0 += d; return w; });
    }
    const first = transcript.indexOf(ln.words[0]);
    if (first < 0) return;
    const drop = new Set(ln.words);
    const kept = transcript.filter(w => !drop.has(w));
    const at = kept.findIndex(w => w.s > ln.words[0].s - 1e-6 && transcript.indexOf(w) > first);
    kept.splice(at < 0 ? kept.length : at, 0, ...repl);
    transcript.splice(0, transcript.length, ...kept.sort((a, b) => a.s - b.s));
  });
  return transcript;
}

/** Move a cut's start or end to the previous/next word boundary in the full transcript. */
export function nudge(transcript, start, end, which, dir) {
  const ws = spoken(transcript);
  if (which === "start") {
    const cands = dir < 0 ? ws.filter(w => w.s < start - 0.05) : ws.filter(w => w.s > start + 0.2);
    const w = dir < 0 ? cands.at(-1) : cands[0];
    if (!w || (dir > 0 && w.s > end - 3)) return { start, end };
    const prev = ws[ws.indexOf(w) - 1];             // never start inside the word before
    return { start: +Math.min(w.s, Math.max(0, w.s - 0.12, prev ? prev.e + 0.02 : 0)).toFixed(2), end };
  }
  const cands = dir < 0 ? ws.filter(w => w.e < end - 0.45) : ws.filter(w => w.e > end - 0.3);
  const w = dir < 0 ? cands.at(-1) : cands[0];
  if (!w || (dir < 0 && w.e < start + 3)) return { start, end };
  const next = ws[ws.indexOf(w) + 1];               // never end inside the word after (it would show in captions, half-spoken)
  return { start, end: +Math.max(w.s + 0.1, Math.min(w.e + 0.35, next ? next.s - 0.01 : Infinity)).toFixed(2) };
}

export function buildSRT(m, keep) {
  const words = spoken(m.words.filter(w => w.s >= m.start - 0.05 && w.s <= m.end));
  const ts = t => { t = remap(t - m.start, keep); const h = Math.floor(t / 3600), mi = Math.floor(t % 3600 / 60), s = Math.floor(t % 60), ms = Math.floor((t % 1) * 1000);
    return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`; };
  const out = []; for (let i = 0, n = 1; i < words.length; i += 7, n++) { const g = words.slice(i, i + 7); out.push(`${n}\n${ts(g[0].s)} --> ${ts(g.at(-1).e)}\n${g.map(x => x.w).join(" ")}\n`); }
  return out.join("\n");
}

export const fmtT = t => { t = Math.floor(t || 0); return t >= 3600 ? `${Math.floor(t / 3600)}:${String(Math.floor(t % 3600 / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}` : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };

// ---------------------------------------------------------------- learning from results
// Read a YouTube Studio export, match its videos to logged clips by title, and compare each scoring signal with how
// the clips actually did. Small samples prove little, so the report says how many clips it rests on.

/** RFC 4180 CSV: quoted fields, "" escapes, CRLF or LF, a leading BOM. */
export function parseCSV(text) {
  const rows = []; let row = [], cell = "", q = false;
  text = String(text).replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ""));
}

/** A Studio cell as a number: "1,234" → 1234, "12.5%" → 12.5, "1:05" → 65 (seconds). Anything else → NaN. */
export function studioNumber(v) {
  const s = String(v ?? "").trim().replace(/%$/, "").trim();
  if (!s) return NaN;
  if (/^\d+(:\d{1,2}){1,2}$/.test(s)) return s.split(":").reduce((a, x) => a * 60 + +x, 0);
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return +s.replace(/,/g, "");
  return /^-?\d*\.?\d+(e-?\d+)?$/i.test(s) ? +s : NaN;
}

/** Parse a Studio "Export current view" CSV into { columns: numeric column names, rows: [{ title, published, values }] }. */
export function studioTable(text) {
  const rows = parseCSV(text);
  const isTitle = c => /^(video )?title$/i.test(c.trim()) || /video title/i.test(c);
  const h = rows.findIndex(r => r.some(isTitle));
  if (h < 0) throw new Error("No video title column found. In YouTube Studio, open Analytics → Advanced mode, show the Video title column, then Export current view as CSV.");
  const head = rows[h].map(c => c.trim()), ti = head.findIndex(isTitle), pi = head.findIndex(c => /publish/i.test(c));
  const data = rows.slice(h + 1).filter(r => (r[ti] || "").trim() && !r.slice(0, 2).some(c => /^total$/i.test(c.trim())));
  const columns = head.filter((c, i) => c && i !== ti && i !== pi && !/^(content|video)$/i.test(c) &&
    data.filter(r => Number.isFinite(studioNumber(r[i]))).length >= Math.max(1, data.length * 0.8));
  return {
    columns,
    rows: data.map(r => ({ title: r[ti].trim(), published: pi >= 0 ? (r[pi] || "").trim() : "",
                           values: Object.fromEntries(columns.map(c => [c, studioNumber(r[head.indexOf(c)])])) })),
  };
}

export const normTitle = t => String(t ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/#\w+/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
/** 1 = same title; 0.95 = one is the other cut short (Shorts titles stop at 100 characters); else word overlap. */
export function titleSimilarity(a, b) {
  const A = normTitle(a), B = normTitle(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const [s, l] = A.length < B.length ? [A, B] : [B, A];
  if (s.length >= 12 && l.startsWith(s)) return 0.95;
  const x = new Set(A.split(" ")), y = new Set(B.split(" "));
  let both = 0; for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/** Pair Studio videos with logged clips, one to one, best title match first (at least 0.6 similar).
 *  Log rows for the same clip and cut (its 24 h, 72 h and 7 d check-ins) count as one clip. */
export function matchStudio(studioRows, logRows) {
  const clips = new Map();
  for (const r of logRows) {
    const k = normTitle(r.title) + "|" + (r.cut || "");
    if (!normTitle(r.title)) continue;
    const c = clips.get(k) || { title: r.title, cut: r.cut || "", platform: r.platform, signals: null, score: null, rows: 0 };
    c.rows++;
    if (!c.signals && r.signals) { try { const s = typeof r.signals === "string" ? JSON.parse(r.signals) : r.signals; if (s && typeof s === "object") c.signals = s; } catch {} }
    if (c.score == null && r.score !== "" && Number.isFinite(+r.score) && r.score != null) c.score = +r.score;
    clips.set(k, c);
  }
  const list = [...clips.values()], pairs = [];
  list.forEach((c, ci) => studioRows.forEach((s, si) => { const sim = titleSimilarity(c.title, s.title); if (sim >= 0.6) pairs.push([sim, ci, si]); }));
  pairs.sort((a, b) => b[0] - a[0]);
  const usedC = new Set(), usedS = new Set(), matched = [];
  for (const [sim, ci, si] of pairs) {
    if (usedC.has(ci) || usedS.has(si)) continue;
    usedC.add(ci); usedS.add(si); matched.push({ clip: list[ci], studio: studioRows[si], sim });
  }
  return { matched, unmatchedStudio: studioRows.filter((_, i) => !usedS.has(i)), unmatchedClips: list.filter((_, i) => !usedC.has(i)) };
}

export const SIGNAL_LABELS = {
  score: "Clip Machine's own score", energy: "High energy", peak: "Loudest peak", swing: "Changes in volume", hype: "Hype words",
  laugh: "Laughter", exclaim: "Exclamations", pace: "Fast delivery", hook: "Strong opening hook", first1: "Something happens in the first second",
  payoff: "Builds to a payoff", ends_clean: "Ends on a full sentence", midstart: "Starts mid-thought", deadair: "Dead air",
  fit: "Length fits the platform", sponsor: "Ad read",
};
const ranks = xs => {
  const o = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]), r = new Array(xs.length);
  for (let i = 0; i < o.length;) { let j = i; while (j + 1 < o.length && o[j + 1][0] === o[i][0]) j++; for (let k = i; k <= j; k++) r[o[k][1]] = (i + j) / 2 + 1; i = j + 1; }
  return r;
};
/** Spearman rank correlation (−1…1); 0 when either side doesn't vary. */
export function spearman(xs, ys) {
  const a = ranks(xs), b = ranks(ys), ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}
export const MIN_LEARN = 6;
/** For each signal: rank correlation with the chosen Studio metric, and its average in the best and worst third of clips. */
export function signalReport(matched, metric) {
  const data = matched.filter(m => m.clip.signals && Number.isFinite(m.studio.values?.[metric]));
  if (data.length < MIN_LEARN) return { n: data.length, enough: false, signals: [] };
  const ys = data.map(m => m.studio.values[metric]), order = ys.map((y, i) => [y, i]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
  const third = Math.max(2, Math.floor(data.length / 3)), best = order.slice(0, third), worst = order.slice(-third);
  const keys = ["score", ...Object.keys(F.weights)];
  const signals = keys.map(k => {
    const xs = data.map(m => k === "score" ? m.clip.score : m.clip.signals[k]);
    if (xs.some(x => !Number.isFinite(x))) return null;
    const avg = idx => Math.round(mean(idx.map(i => xs[i])) * 100) / 100;
    return { key: k, label: SIGNAL_LABELS[k] || k, rho: Math.round(spearman(xs, ys) * 100) / 100, best: avg(best), worst: avg(worst) };
  }).filter(Boolean).sort((a, b) => (b.key === "score") - (a.key === "score") || Math.abs(b.rho) - Math.abs(a.rho));
  return { n: data.length, enough: true, early: data.length < 15, signals };
}
