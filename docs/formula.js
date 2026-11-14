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
                  reasons: reasons(c.z, c.f), checklist: checklist(c.z, c.f, c.e - c.s, plat) });
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
  best = best.replace(/\b(um+|uh+|erm|hmm+)\b,?\s*/gi, "").trim().replace(/^(and|but|so|because|like)[,\s]+/i, "");
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
export function keepIntervals(m, tighten) {
  const dur = m.end - m.start;
  const ws = m.words.filter(w => w.s >= m.start && w.s <= m.end);
  if (!tighten || ws.length < 2) return [[0, dur]];
  const cut = [];
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

export function buildASS(m, plat, keep, { captions = true, hook = true, cta = "" } = {}) {
  const R = plat.right, font = "Montserrat Thin Black";   // the family name stored inside fonts/Montserrat-Black.ttf
  let out = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n[V4+ Styles]\n` +
    `Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    `Style: Cap,${font},84,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,7,3,2,${R},${R},${plat.cap_bottom},1\n` +
    `Style: Hook,${font},58,&H00111111,&H00111111,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,3,20,0,8,${R + 20},${R + 20},${plat.hook_top},1\n` +
    `Style: Cta,${font},58,&H00111111,&H00111111,&H0000E6FF,&H00000000,0,0,0,0,100,100,0,0,3,20,0,8,${R + 20},${R + 20},${plat.hook_top},1\n\n` +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const L = [];
  const safe = s => s.replace(/{/g, "(").replace(/}/g, ")");
  if (hook && m.title) L.push(`Dialogue: 1,${assTime(0)},${assTime(3.2)},Hook,,0,0,0,,{\\fad(120,250)}${safe(m.title)}`);
  if (cta) { const tot = keep.reduce((a, [x, y]) => a + y - x, 0); L.push(`Dialogue: 1,${assTime(Math.max(3.4, tot - 2.8))},${assTime(tot)},Cta,,0,0,0,,{\\fad(150,0)}${safe(cta)}`); }
  const words = captions ? spoken(m.words.filter(w => w.s >= m.start - 0.05 && w.s <= m.end)) : [];
  const T = t => remap(t - m.start, keep);
  const groups = []; for (let i = 0; i < words.length; i += 3) groups.push(words.slice(i, i + 3));
  groups.forEach((g, gi) => {
    const gEnd = gi + 1 < groups.length ? groups[gi + 1][0].s : g.at(-1).e + 0.3;
    g.forEach((w, wi) => {
      const s = T(w.s); let e = T(wi + 1 < g.length ? g[wi + 1].s : gEnd);
      if (e - s > 1.6) e = s + 1.6;
      const parts = g.map((x, k) => k === wi ? `{\\c&H00F0FF&\\fscx112\\fscy112}${clean(x.w)}{\\c&HFFFFFF&\\fscx100\\fscy100}` : clean(x.w));
      L.push(`Dialogue: 0,${assTime(s)},${assTime(Math.max(e, s + 0.05))},Cap,,0,0,0,,${parts.join(" ")}`);
    });
  });
  return out + L.join("\n") + "\n";
}

export function buildSRT(m, keep) {
  const words = spoken(m.words.filter(w => w.s >= m.start - 0.05 && w.s <= m.end));
  const ts = t => { t = remap(t - m.start, keep); const h = Math.floor(t / 3600), mi = Math.floor(t % 3600 / 60), s = Math.floor(t % 60), ms = Math.floor((t % 1) * 1000);
    return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`; };
  const out = []; for (let i = 0, n = 1; i < words.length; i += 7, n++) { const g = words.slice(i, i + 7); out.push(`${n}\n${ts(g[0].s)} --> ${ts(g.at(-1).e)}\n${g.map(x => x.w).join(" ")}\n`); }
  return out.join("\n");
}

export const fmtT = t => { t = Math.floor(t || 0); return t >= 3600 ? `${Math.floor(t / 3600)}:${String(Math.floor(t % 3600 / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}` : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
