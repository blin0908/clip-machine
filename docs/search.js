// Find clips by description: type what you're looking for ("the part about pricing") and the best-matching moments
// become new clips. Sentence-aligned windows of the transcript are embedded with a small multilingual model
// (search-worker.js on the web, search.py in the desktop app: the same weights) and ranked by cosine similarity
// against the query. Matches go through the normal cut, render and quality gate as new clips.
// The windows, scores and picks mirror search.py line for line (checked by tests/search_parity.py).
import { units, segmentsFromWords } from "./formula.js";

export const WIN_MIN = 15, WIN_MAX = 40;
// e5 scores every pair of texts 0.70-0.90, so "good enough" is judged two ways at once: how close the best window is
// (top) and how far it stands out from this video's typical window (top - median). See search.py for the calibration.
export const MIN_TOP = 0.79, MIN_MATCH = 0.835, PICK_SPREAD = 0.03;
export const MODEL_MB = 135;              // the 8-bit model + tokenizer, downloaded once

const r2 = x => +x.toFixed(2);
export const cleanQuery = q => String(q ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, 200);

/** One window per sentence: it and the sentences after it, up to WIN_MIN..WIN_MAX seconds. Mirrors search.windows. */
export function searchWindows(words, duration) {
  const U = units(segmentsFromWords(words), duration), out = [];
  for (let i = 0; i < U.length; i++) {
    let j = i;
    while (j + 1 < U.length && U[j].e - U[i].s < WIN_MIN && U[j + 1].e - U[i].s <= WIN_MAX) j++;
    const ws = U.slice(i, j + 1).flatMap(u => u.words);
    if (!ws.length) continue;
    const text = U.slice(i, j + 1).map(u => u.text).join(" ").trim();
    out.push({ start: r2(Math.max(0, ws[0].s - 0.12)), end: r2(Math.min(duration, ws.at(-1).e + 0.35)), text });
  }
  const full = out.filter(w => w.end - w.start >= WIN_MIN / 2);      // the last few sentences make stubs: drop them
  return full.length ? full : out;
}

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b), h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}
export const matchStrength = scores => { const top = Math.max(...scores); return top + (top - median(scores)); };

/** Best windows first, no two overlapping (2 s apart), all within PICK_SPREAD of the best. Mirrors search.pick. */
export function pickMatches(wins, scores, n) {
  if (!scores.length || Math.max(...scores) < MIN_TOP || matchStrength(scores) < MIN_MATCH) return [];
  const order = wins.map((_, k) => k).sort((a, b) => scores[b] - scores[a] || a - b);
  const best = scores[order[0]], out = [];
  for (const k of order) {
    if (scores[k] < best - PICK_SPREAD || out.length >= n) break;
    const w = wins[k];
    if (out.some(m => !(w.end + 2 <= m.start || w.start >= m.end + 2))) continue;
    out.push({ ...w, score: +scores[k].toFixed(4) });
  }
  return out;
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// ---------------------------------------------------------------- the web engine
let worker = null, seq = 0;
function embedTexts(texts, onStatus) {
  worker ||= new Worker(new URL("./search-worker.js", import.meta.url), { type: "module" });
  const id = ++seq;
  return new Promise((res, rej) => {
    const w = worker;
    const onMsg = ({ data: m }) => {
      if (m.type === "load") onStatus?.({ stage: "load", loaded: m.loaded, total: m.total });
      if (m.id !== id) return;
      if (m.type === "progress") onStatus?.({ stage: "embed", done: m.done, total: m.total });
      else if (m.type === "done") { w.removeEventListener("message", onMsg); res(m.vectors); }
      else if (m.type === "error") { w.removeEventListener("message", onMsg); rej(new Error(m.message)); }
    };
    w.addEventListener("message", onMsg);
    w.onerror = e => { w.removeEventListener("message", onMsg); worker = null; rej(new Error(e.message || "The search model stopped.")); };
    w.postMessage({ id, texts });
  });
}
/** Free the model's memory (Safari keeps a tab's memory tight). The next search loads it again from the cache. */
export function releaseModel() { try { worker?.terminate(); } catch {} worker = null; }

/** Every window with its score, in video order. desk: the desktop app ranks them natively. */
export async function scoreWindows(words, duration, query, { desk = false, onStatus } = {}) {
  query = cleanQuery(query);
  if (desk) {
    const r = await fetch("api/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, words, duration, all: true }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `The desktop app answered ${r.status}.`);
    return j.windows;
  }
  const wins = searchWindows(words, duration);
  if (!wins.length) return [];
  const v = await embedTexts(["query: " + query, ...wins.map(w => "passage: " + w.text)], onStatus);
  return wins.map((w, k) => ({ ...w, score: dot(v[k + 1], v[0]) }));
}

/** The best-matching moments for query, best first ([] when nothing matches well enough). */
export async function findMatches(words, duration, query, n = 3, opts = {}) {
  if (!cleanQuery(query) || !words?.length) return [];
  const all = await scoreWindows(words, duration, query, opts);
  return pickMatches(all.map(({ score, ...w }) => w), all.map(w => w.score), n);
}

// ---------------------------------------------------------------- the box in the clips area
// deps: the workspace hooks from app.js (kept small so app.js only wires this up)
export function mountFind(deps) {
  const $ = s => document.querySelector(s);
  const form = $("#findForm"), input = $("#findq"), btn = $("#findGo"), msg = $("#findMsg");
  if (!form) return;
  let busy = false;
  const say = (t, kind = "") => { msg.textContent = t; msg.dataset.kind = kind; msg.hidden = !t; };
  const quote = q => `“${q.length > 60 ? q.slice(0, 59) + "…" : q}”`;
  form.addEventListener("submit", async e => {
    e.preventDefault();
    if (busy) return;
    const q = cleanQuery(input.value), sess = deps.active();
    if (!q) { say("Describe the moment you want, for example: the part about pricing."); input.focus(); return; }
    if (!sess?.words?.length) { say("This video has no transcript yet. Run it first, then search it.", "warn"); return; }
    busy = true; btn.disabled = true; form.setAttribute("aria-busy", "true");
    say("Searching the transcript…");
    if (deps.desk()) fetch("api/search", { cache: "no-store" }).then(r => r.json()).then(j => {
      if (busy && !j.ready) say(`Searching on this computer. The first search also downloads the search model (about ${MODEL_MB} MB), so it takes a minute.`);
    }).catch(() => {});
    try {
      const matches = await findMatches(sess.words, sess.info?.duration || sess.words.at(-1).e, q, 3, {
        desk: deps.desk(),
        onStatus: s => {
          if (s.stage === "load") say(`Loading the search model (first time only, about ${MODEL_MB} MB) · ${Math.round(100 * s.loaded / s.total)}%`);
          else say(`Reading the transcript · ${Math.round(100 * s.done / s.total)}%`);
        },
      });
      if (deps.lowMemory()) releaseModel();
      if (!matches.length) { say(`Nothing in this video matches ${quote(q)} closely enough. Try the words the speaker would use, or a broader description.`, "warn"); return; }
      const fresh = [], already = [];
      for (const m of matches) {
        const have = sess.clips.find(c => [c, c.short].some(v => v && Math.abs(v.start - m.start) < 1.5 && Math.abs(v.end - m.end) < 1.5));
        (have ? already : fresh).push(have || m);
      }
      if (already.length) deps.select(already[0].uid);
      if (!fresh.length) { say(`The best match for ${quote(q)} is already on the board${already.length > 1 ? ` (${already.length} clips)` : ""}.`, "ok"); return; }
      say(`Found ${fresh.length} matching moment${fresh.length > 1 ? "s" : ""}. Rendering ${fresh.length > 1 ? "them" : "it"} as new clip${fresh.length > 1 ? "s" : ""}…`);
      const segs = segmentsFromWords(sess.words);
      const results = await Promise.all(fresh.map(m => deps.render(sess, m, segs, `Matches ${quote(q)}`)));
      const ok = results.filter(r => r?.ok), failed = results.length - ok.length;
      if (ok[0]?.clip) deps.select(ok[0].clip.uid);
      say(ok.length ? `Added ${ok.length} clip${ok.length > 1 ? "s" : ""} matching ${quote(q)}.${failed ? ` ${failed} failed the quality gate.` : ""}`
        : `The matching moment${failed > 1 ? "s" : ""} failed the quality gate. ${results.find(r => r?.msg)?.msg || ""}`.trim(), ok.length ? "ok" : "warn");
    } catch (err) {
      console.error(err);
      say(/fetch|network|Failed to load/i.test(String(err?.message)) ? "Couldn't download the search model. Check the connection and try again (after the first time it works offline)."
        : `Search stopped: ${err?.message || err}`, "warn");
    } finally { busy = false; btn.disabled = false; form.removeAttribute("aria-busy"); }
  });
  input.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.stopPropagation(); if (input.value) { input.value = ""; say(""); } else input.blur(); }
  });
  // "/" jumps to the box from the clips board (not while typing, or with the studio open)
  addEventListener("keydown", e => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || deps.busyKeys(e)) return;
    if (form.closest(".hide, [hidden]") || !form.offsetParent) return;
    e.preventDefault(); input.focus(); input.select();
  });
}
