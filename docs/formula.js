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
const HOOK_RX = () => /[?？؟]|\b(you|your|why|how|what if|imagine|never|stop|nobody|secret|here's|this is|the \w+est)\b|\d/gi;
const LAUGH_RX = () => /\b(ha(ha)+|lol|lmao)\b|\[(laugh|laughter|laughing)[^\]]*\]|\((laugh|laughs|laughter|laughing)\)|(?:ja){3,}|k{4,}|(?:rs){2,}|\bmdr\b|(?:ха){2,}|哈{2,}|呵{2,}|[ㅋㅎ]{2,}|(?:하){2,}|ه{3,}|(?:हा){2,}|(?:ฮ่า){2,}|ฮ่าๆ|[（(]笑[)）]/gi;
// Is phrase k in lowercased text as a whole word? Unicode-aware (\b is ASCII-only here); scripts without word
// spaces (Chinese, Japanese, Korean, Thai…) match anywhere. Mirrors has_key in clipper.py.
const NOSPACE_KEY = /[\u0E00-\u0EFF\u1000-\u109F\u1780-\u17FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/;
const WORD_CH = /[\p{L}\p{M}\p{N}_]/u;
export function hasKey(low, k) {
  if (NOSPACE_KEY.test(k)) return low.includes(k);
  for (let i = low.indexOf(k); i >= 0; i = low.indexOf(k, i + 1)) {
    const j = i + k.length;
    if ((i === 0 || !WORD_CH.test(low[i - 1])) && (j >= low.length || !WORD_CH.test(low[j]))) return true;
  }
  return false;
}
const hypeIn = t => { const low = t.toLowerCase().replace(/\u2019/g, "'").replace(/i\u0307/g, "i"); return F.hypeEntries.filter(([k]) => hasKey(low, k)); };
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
  const flush = () => { if (cur.length) segs.push({ s: cur[0].s, e: cur.at(-1).e, text: joinWords(cur.map(w => w.w)), words: cur }); cur = []; };
  words.forEach((w, i) => {
    const prev = cur.at(-1);
    if (prev && (w.s - prev.e > 1.0 || w.s - cur[0].s > 12)) flush();
    cur.push(w);
    if (SENT_END.test(w.w)) flush();
  });
  flush();
  return segs;
}

// ---------------------------------------------------------------- joining words
// Chinese, Japanese, Thai, Lao, Khmer and Burmese don't put spaces between words; everything else does.
// Mirrors clipper.join_words: captions and subtitle files must come out identical in both engines.
const NOSPACE = /[\u0E00-\u0EFF\u1000-\u109F\u1780-\u17FF\u2E80-\u2FFF\u3000-\u303F\u3040-\u30FF\u3100-\u312F\u3190-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFF60]/;
// A sentence ends on . ! ? (or 。！？ ؟ ।), optionally followed by closing quotes or brackets. Mirrors clipper.SENT_END.
export const SENT_END = /[.!?\u3002\uFF01\uFF1F\u061F\u0964]["'\u2019\u201D)\]\u300D\u300F\u00BB]*$/;
// No space either side of an apostrophe split off by the speech model (French s'est, l'équipe, English don't).
const APOS = /['\u2019]/;
export const wordGap = (a, b) => { a = String(a); b = String(b);
  return NOSPACE.test(a.slice(-1)) || NOSPACE.test(b.charAt(0)) || (a && b && (APOS.test(b.charAt(0)) || APOS.test(a.slice(-1)))) ? "" : " "; };
/** Join words (raw) or display parts built from them (parts, e.g. with highlight tags), spacing by the raw words. */
export function joinWords(raw, parts = raw) {
  let out = "";
  parts.forEach((p, i) => { out += (i ? wordGap(raw[i - 1], raw[i]) : "") + p; });
  return out;
}

// ---------------------------------------------------------------- scoring
const isFiller = w => F.fillerSet.has(w.w.toLowerCase().replace(/[^a-z]/g, ""));
export const spoken = ws => ws.filter(w => !isFiller(w));

const CLAUSE_END = /[,;:\uFF0C\u3001\uFF1B\uFF1A]["'\u2019\u201D)\]\u300D\u300F\u00BB]*$/;
// Long segments (Whisper can return one for a comma-only stretch of Chinese or Japanese) are split at sentence ends,
// clauses and pauses, since clip boundaries snap to segments. Mirrors clipper._split_long.
function splitLong(sg) {
  const ws = sg.words || [];
  if (sg.e - sg.s <= 12 || !ws.length) return [sg];
  const out = []; let cur = [];
  const flush = () => { if (cur.length) out.push({ s: cur[0].s, e: cur.at(-1).e, text: joinWords(cur.map(w => w.w)), words: cur }); cur = []; };
  for (const w of ws) {
    if (cur.length && (w.s - cur.at(-1).e > 1.0 || w.s - cur[0].s > 12)) flush();
    cur.push(w);
    if (SENT_END.test(w.w) || (CLAUSE_END.test(w.w) && w.e - cur[0].s >= 5)) flush();
  }
  flush();
  return out;
}
export function units(segs, duration) {
  let u = segs.filter(s => s.e > s.s).flatMap(splitLong);
  if (u.length < 4) {          // too few (e.g. no speech): 5 s blocks, with their words
    const words = segs.flatMap(s => s.words || []);
    u = [];
    for (let t = 0; t < Math.max(duration - 1, 1); t += 5) {
      const ws = words.filter(w => w.s >= t && w.s < t + 5);
      u.push({ s: t, e: Math.min(duration, t + 5), text: joinWords(ws.map(w => w.w)), words: ws });
    }
  }
  return u;
}

export function features(s, e, text, words, loud, firstText, plat) {
  const lo = Math.floor(s / HOP), hi = Math.max(Math.floor(e / HOP), lo + 1);
  let seg = Array.from(loud.slice(lo, hi)); if (!seg.length) seg = [0];
  const top = seg.slice().sort((a, b) => a - b).slice(-Math.max(1, Math.floor(seg.length / 3)));
  const head = Array.from(loud.slice(lo, lo + 3 / HOP));
  const tail = seg.slice(-Math.max(1, Math.floor(seg.length / 4)));
  const first1 = Array.from(loud.slice(lo, lo + 1 / HOP));
  const firstWords = words.filter(w => w.s < s + 1.5).map(w => w.w).join(" ");
  const low = text.toLowerCase();
  const kw = hypeIn(text);
  const dur = Math.max(e - s, 1);
  const headWords = words.filter(w => w.s < s + 3).map(w => w.w).join(" ") || firstText.slice(0, 60);
  const hookLang = count(HOOK_RX(), headWords) + hypeIn(headWords).reduce((a, [, w]) => a + w, 0);
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
    payoff: mean(tail) - mean(seg), ends_clean: SENT_END.test(text.trim()) ? 1 : 0,
    midstart: F.midSet.has(firstWord) ? 1 : 0, deadair: (gaps + Math.max(lead, 0)) / dur, fit,
    sponsor: F.sponsor.filter(k => low.includes(k)).length,
    _kw: kw.sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k), _hookLang: hookLang,
    _firstHook: HOOK_RX().test(firstWords) || hypeIn(firstWords).length > 0,
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
  const norm = { mu: {}, sd: {}, flat: {}, plat };          // this video's baseline, so a short cut is scored the same way
  keys.forEach((k, ki) => {
    const col = cols[ki], m = mean(col), sd = Math.sqrt(mean(col.map(x => (x - m) ** 2)));
    const flat = sd <= 1e-6 * Math.max(1, Math.abs(m));     // doesn't vary: neutral (mirrors clipper.find_moments)
    norm.mu[k] = m; norm.sd[k] = flat ? 1 : sd; norm.flat[k] = flat;
    cands.forEach((c, ci) => { z[ci][k] = raw.has(k) ? col[ci] : flat ? 0 : (col[ci] - m) / sd; });
  });
  cands.forEach((c, ci) => { c.z = z[ci]; c.score = keys.reduce((a, k) => a + F.weights[k] * z[ci][k], 0); });
  cands.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of cands) {
    if (picked.some(m => !(c.e + 2 <= m.start || c.s >= m.end + 2))) continue;
    picked.push({ start: +c.s.toFixed(2), end: +c.e.toFixed(2), raw: c.score, text: c.text, words: c.words,
                  reasons: reasons(c.z, c.f), checklist: checklist(c.z, c.f, c.e - c.s, plat),
                  signals: Object.fromEntries(keys.map(k => [k, Math.round(c.z[k] * 100) / 100])), norm });   // for learning from results
    if (picked.length >= n) break;
  }
  if (picked.length) {
    const hi = picked[0].raw, lo = Math.min(...picked.map(m => m.raw));
    for (const m of picked) {
      m.rel = hi > lo ? (m.raw - lo) / (hi - lo) : 1;
      m.score = score(m.rel, m.checklist);
      m.title = title(m, segs);
      m.hashtags = tags(m.text, base.tags);
    }
  }
  return picked;
}

// The 0-100 moment score: rank among this video's moments, nudged by how many checks pass (clipper._score).
export function score(rel, list) {
  const passed = list.filter(x => x.ok).length / Math.max(list.length, 1);
  return Math.round(45 + 30 * rel + 24 * passed);
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

export function title(m, segs) {
  // long segments split into sentences/clauses first, or a clip inside one long segment would have no title
  const sents = segs.flatMap(splitLong).filter(s => s.s >= m.start - 0.3 && s.e <= m.end + 0.5 && s.text).map(s => s.text);
  if (!sents.length) return "Wait for it…";
  const strength = t => hypeIn(t).reduce((a, [, w]) => a + w, 0)
    + count(HOOK_RX(), t) * 0.7 + (t.match(/!/g) || []).length - Math.abs(t.length - 45) / 25;
  let best = sents.reduce((a, b) => strength(b) > strength(a) ? b : a).replace(/^[\s.,-]+|[\s.,-]+$/g, "");
  best = best.replace(/\b(um+|uh+m?|erm|er|hmm+|ah+|mhm)\b,?\s*/gi, "").trim().replace(/^(and|but|so|because|like)[,\s]+/i, "");
  best = best.charAt(0).toUpperCase() + best.slice(1);
  if (NOSPACE.test(best) && best.length > 30) {            // Chinese/Japanese/Thai: ~2x wider per character, no spaces to cut at
    let cut = best.slice(0, 30); const i = Math.max(...[",", "，", "、", "；", ";"].map(c => cut.lastIndexOf(c)));
    if (i >= 10) cut = cut.slice(0, i);
    best = cut.replace(/[,，、；;:：\s-]+$/, "") + "…";
  } else if (best.length > 60) best = best.slice(0, 60).replace(/\s+\S*$/, "").replace(/[,;:-]+$/, "") + "…";
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

// Short cut with the SAME opening, ending on the strongest sentence end between lo and hi seconds. If the long cut's
// payoff lands later than a short can reach, there's no short: returns null and says why in m.shortNote.
// Mirrors clipper.shorten.
export function shorten(m, segs, loud, lo, hi) {
  m.shortNote = "";
  if (m.end - m.start <= hi + 1) return null;
  let ends = segs.map(s => s.e).filter(e => e >= m.start + lo && e <= Math.min(m.start + hi, m.end));
  if (!ends.length) ends = m.words.map(w => w.e).filter(e => e >= m.start + lo && e <= m.start + hi);
  if (!ends.length) ends = [m.start + (lo + hi) / 2];
  const punch = e => { const i = Math.floor(e / HOP); return i < loud.length ? mean(Array.from(loud.slice(Math.max(0, i - 2 / HOP), i + 1))) : 0; };
  const e = ends.reduce((a, b) => punch(b) > punch(a) ? b : a);
  const later = segs.map(s => s.e).filter(x => x > m.start + hi && x <= m.end + 0.05);
  if (later.length) {
    const peak = later.reduce((a, b) => punch(b) > punch(a) ? b : a);
    if (punch(peak) - punch(e) >= F.payoffMargin) {
      m.shortNote = `No short cut: the payoff lands ${Math.round(peak - m.start)}s in, and a short with the same opening has to end by ${hi}s.`;
      return null;
    }
  }
  const words = m.words.filter(w => w.e <= e + 0.05);
  const end = Math.min(m.end, words.length ? words.at(-1).e + 0.35 : e);
  const sm = { ...m, end: +end.toFixed(2), words, text: joinWords(words.map(w => w.w)), short: true };
  if (m.norm) {   // score the short on its own: its length, ending and dead air differ from the long cut's
    const keys = Object.keys(F.weights), raw = new Set(F.raw), plat = { ...m.norm.plat, sweet: [lo, hi] };
    const first = (segs.find(s => s.s >= m.start - 0.3) || { text: sm.text }).text;
    const f = features(sm.start, sm.end, sm.text, words, loud, first, plat);
    const z = Object.fromEntries(keys.map(k => [k, raw.has(k) ? f[k] : m.norm.flat[k] ? 0 : (f[k] - m.norm.mu[k]) / m.norm.sd[k]]));
    sm.checklist = checklist(z, f, sm.end - sm.start, plat);
    sm.reasons = reasons(z, f);
    sm.score = score(m.rel ?? 1, sm.checklist);
  }
  return sm;
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
// Greek capitals drop their accents and breathings (ΚΌΣΜΕ is written ΚΟΣΜΕ); the diaeresis stays.
const GREEK = /[\u0370-\u03FF\u1F00-\u1FFF]/;
const upper = w => { w = w.toUpperCase(); return GREEK.test(w) ? w.normalize("NFD").replace(/[\u0300\u0301\u0313\u0314\u0342]/g, "").normalize("NFC") : w; };
const clean = w => upper(w.replace(/\\/g, "").replace(/{/g, "(").replace(/}/g, ")"));

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
// ---------------------------------------------------------------- caption fonts
// Montserrat Black ships with the app; other scripts use the matching Noto Sans Black (table in formula.json, from
// clipper.CAPTION_FONTS). Checked in this order: Japanese mixes kana with Chinese characters, so kana decides it.
const SCRIPTS = [["ko", /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/], ["ja", /[\u3040-\u30FF]/], ["zh", /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/],
  ["arabic", /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/], ["hebrew", /[\u0590-\u05FF]/],
  ["devanagari", /[\u0900-\u097F]/], ["thai", /[\u0E00-\u0E7F]/], ["greek", /[\u0370-\u03FF\u1F00-\u1FFF]/]];
// common characters written differently in Traditional and Simplified Chinese: mostly Traditional → the TC font.
const ZH_TRAD = "這們說時國會對來為無麼後過還現開關點體發應實學問經長頭見讓話車東門書裡個樣嗎習邊錢員氣電動區專業務場總結據歡謝愛覺聽寫買賣讀認識號錯難歲鐘頁視腦網線戲聲魚鳥馬飛雲風廣漢語萬億兩幾誰";
const ZH_SIMP = "这们说时国会对来为无么后过还现开关点体发应实学问经长头见让话车东门书里个样吗习边钱员气电动区专业务场总结据欢谢爱觉听写买卖读认识号错难岁钟页视脑网线戏声鱼鸟马飞云风广汉语万亿两几谁";
const countIn = (text, set) => { let n = 0; for (const c of text) if (set.includes(c)) n++; return n; };
export const scriptOf = text => {
  text = text || "";
  const k = (SCRIPTS.find(([, rx]) => rx.test(text)) || ["latin"])[0];
  return k === "zh" && countIn(text, ZH_TRAD) > countIn(text, ZH_SIMP) ? "zhtc" : k;
};
/** The caption font entry ({ name, file, url?, label?, mb? }) for a cut, from the script of its headline and spoken words. */
export function captionFont(m) {
  const words = (m.words || []).filter(w => w.s >= m.start - 0.05 && w.s <= m.end).map(w => w.w).join(" ");
  return F.captionFonts[scriptOf(`${m.title || ""} ${words}`)];
}

export function buildASS(m, plat, keep, { captions = true, hook = true, cta = "", style = "pop", hl = "#FFF000", size = "m", pos = "bottom", format = "9:16" } = {}) {
  const font = captionFont(m).name;
  const L0 = captionLayout(plat, { format, size, pos }), k = L0.scale, R = L0.marginLR, n = x => Math.round(x * k);
  const hk = Math.min(1, L0.scale / (SIZES[size] || 1)), nh = x => Math.round(x * hk);   // headline ignores the size choice
  // Boxes use BorderStyle 4 (one box per line, padded by a transparent outline): BorderStyle 3 notches around tall glyphs.
  // Encoding -1: full Unicode bidi across override tags (1 scrambles highlighted Arabic/Hebrew lines).
  const tail = `${L0.align},${R},${R},${L0.marginV},-1`;
  const CAPS = {
    pop:   `Style: Cap,${font},${n(84)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,${n(7)},${n(3)},${tail}`,
    clean: `Style: Cap,${font},${n(70)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,${n(4)},${n(2)},${tail}`,
    boxed: `Style: Cap,${font},${n(72)},&H00FFFFFF,&H00FFFFFF,&HFF000000,&H00000000,0,0,0,0,100,100,0,0,4,${n(16)},0,${tail}`,
  };
  const cap = CAPS[style] || CAPS.pop, HL = assColour(hl);
  let out = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${L0.PX}\nPlayResY: ${L0.PY}\nWrapStyle: 0\n\n[V4+ Styles]\n` +
    `Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    `${cap}\n` +
    `Style: Hook,${font},${nh(58)},&H00111111,&H00111111,&HFFFFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,4,${nh(20)},0,8,${R + 20},${R + 20},${L0.hookTop},-1\n` +
    `Style: Cta,${font},${nh(58)},&H00111111,&H00111111,&HFF00E6FF,&H0000E6FF,0,0,0,0,100,100,0,0,4,${nh(20)},0,8,${R + 20},${R + 20},${L0.hookTop},-1\n\n` +
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
      L.push(`Dialogue: 0,${assTime(s)},${assTime(Math.max(e, s + 0.05))},Cap,,0,0,0,,${joinWords(g.words.map(x => x.w), g.words.map(x => safe(x.w)))}`);
      continue;
    }
    g.words.forEach((w, wi) => {
      const s = T(w.s); let e = T(wi + 1 < g.words.length ? g.words[wi + 1].s : g.e);
      if (e - s > 1.6) e = s + 1.6;
      const hi = style === "boxed" ? `{\\c${HL}}` : `{\\c${HL}\\fscx112\\fscy112}`;
      const lo = style === "boxed" ? `{\\c&HFFFFFF&}` : `{\\c&HFFFFFF&\\fscx100\\fscy100}`;
      const parts = g.words.map((x, j) => j === wi ? `${hi}${clean(x.w)}${lo}` : clean(x.w));
      L.push(`Dialogue: 0,${assTime(s)},${assTime(Math.max(e, s + 0.05))},Cap,,0,0,0,,${joinWords(g.words.map(x => x.w), parts)}`);
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
  for (let i = 0; i < ws.length; i += per) { const g = ws.slice(i, i + per); out.push({ s: g[0].s, e: g.at(-1).e, text: joinWords(g.map(w => w.w)), words: g }); }
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
  const out = []; for (let i = 0, n = 1; i < words.length; i += 7, n++) { const g = words.slice(i, i + 7); out.push(`${n}\n${ts(g[0].s)} --> ${ts(g.at(-1).e)}\n${joinWords(g.map(x => x.w))}\n`); }
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
// ---------------------------------------------------------------- results log: one post per cut per platform
const POST_ID = [/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/, /tiktok\.com\/@[\w.-]+\/video\/(\d+)/,
  /instagram\.com\/(?:reels?|p)\/([\w-]+)/, /facebook\.com\/(?:reel\/|.*[?&]v=|watch\/\?v=)(\d+)/, /(?:x|twitter)\.com\/\w+\/status\/(\d+)/,
  /snapchat\.com\/spotlight\/([\w-]+)/];
/** A post's link or id → the platform's id (mirrors app.post_id). */
export function postId(value) {
  const v = String(value ?? "").trim();
  for (const rx of POST_ID) { const m = v.match(rx); if (m) return m[1]; }
  return v.startsWith("http") ? v.split("?")[0].replace(/\/+$/, "").split("/").pop().slice(0, 80) : v.slice(0, 80);
}
/** Why this result can't be logged, or null (mirrors app.log_conflict). */
export function logConflict(rows, row) {
  const pid = row.post || "";
  if (!pid) return null;
  const sameCut = r => (r.job ?? "") === (row.job ?? "") && (r.clip ?? "") === (row.clip ?? "") && (r.cut ?? "") === (row.cut ?? "");
  for (const r of rows) {
    if (r.platform !== row.platform) continue;
    if (r.post === pid && !sameCut(r)) return `Post ${pid} is already logged for "${String(r.title || "another clip").slice(0, 60)}".`;
    if (r.post && r.post !== pid && sameCut(r)) return `This cut is already logged on that platform as post ${r.post}. One post per platform: log new numbers against that post, or delete its rows first.`;
    if (r.post === pid && r.checkpoint === row.checkpoint) return `The ${row.checkpoint} numbers for post ${pid} are already logged. Delete that row to replace them.`;
  }
  return null;
}

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
