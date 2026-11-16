// Fast unit checks for docs/formula.js (the web app's scoring, trimming and caption logic).
//   node --test tests/formula.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
globalThis.fetch = async () => ({ json: async () => JSON.parse(readFileSync(resolve(ROOT, "docs/formula.json"), "utf8")) });
const X = await import(pathToFileURL(resolve(ROOT, "docs/formula.js")).href);
await X.loadFormula();

const PY = process.env.PYTHON || [".venv/bin/python", ".venv/Scripts/python.exe"].map(p => resolve(ROOT, p)).find(existsSync) || "python";
const W = (w, s, e) => ({ w, s, e });
const SR = 16000;
function speechWithPause(total = 9, pause = [3, 5.8]) {     // tone "speech" with a near-silent gap
  const pcm = new Float32Array(SR * total);
  for (let i = 0; i < pcm.length; i++) {
    const t = i / SR;
    pcm[i] = t >= pause[0] && t <= pause[1] ? (Math.random() - 0.5) * 1e-4 : 0.2 * Math.sin(2 * Math.PI * 220 * t) * (0.6 + 0.4 * Math.sin(6 * Math.PI * t));
  }
  return pcm;
}

test("quiet map finds a real pause even when word timings hide it", () => {
  const q = X.quietMap(speechWithPause());
  const runs = X.quietRuns(q, 0, 9);
  assert.equal(runs.length, 1);
  assert.ok(Math.abs(runs[0][0] - 3) < 0.1 && Math.abs(runs[0][1] - 5.8) < 0.1, JSON.stringify(runs));
  // Whisper-in-the-browser style timings: "world" stretches over the whole pause
  const m = { start: 0, end: 9, words: [W("hello", 0.2, 2.9), W("world", 2.9, 6.0), W("again", 6.0, 8.8)] };
  assert.deepEqual(X.keepIntervals(m, true), [[0, 9]]);             // word gaps alone see nothing
  const keep = X.keepIntervals(m, true, q);
  assert.equal(keep.length, 2);
  assert.ok(9 - keep.reduce((a, [x, y]) => a + y - x, 0) > 2.3, "most of the 2.8 s pause is cut");
  assert.ok(X.longestQuiet(q, 0, 9) > 2.7);
});

test("continuous sound has no quiet runs", () => {
  const q = X.quietMap(speechWithPause(6, [99, 99]));
  assert.deepEqual(X.quietRuns(q, 0, 6), []);
  assert.deepEqual(X.quietRuns(null, 0, 6), []);
});

test("pause cutting matches the desktop engine on the same words", () => {
  const words = [W("so", 0.1, 0.4), W("um", 0.45, 0.8), W("this", 0.85, 1.2), W("is", 2.6, 2.8), W("the", 2.85, 3.0),
                 W("uh", 3.1, 3.5), W("thing", 3.6, 4.1), W("okay", 6.0, 6.5)];
  const m = { start: 0, end: 7, words };
  const js = X.keepIntervals(m, true);
  const py = JSON.parse(execFileSync(PY, ["-c", `
import sys, json; sys.path.insert(0, ${JSON.stringify(ROOT)})
import clipper
m = clipper.Moment(start=0, end=7, words=json.loads(sys.argv[1]))
print(json.dumps(clipper.keep_intervals(m, True)))`, JSON.stringify(words)], { encoding: "utf8" }).trim().split("\n").at(-1));
  assert.deepEqual(js, py);
});

test("trim nudges land between words, never inside one", () => {
  const t = [W("one", 1, 1.4), W("two", 1.4, 1.9), W("three", 1.9, 2.5), W("four", 2.5, 3.1), W("five", 3.1, 3.8),
             W("six", 3.8, 4.4), W("seven", 4.4, 5.0), W("eight", 5.0, 5.6), W("nine", 5.6, 6.2)];
  const later = X.nudge(t, 1, 6.2, "start", +1);
  assert.ok(later.start >= 1.4 - 0.12 && later.start <= 1.4, JSON.stringify(later));
  assert.ok(later.start >= 1.4 + 0.02 - 0.12);                  // not inside "one"
  const earlier = X.nudge(t, 1, 6.2, "end", -1);
  assert.ok(earlier.end < 5.6, `ends before "nine" starts: ${earlier.end}`);
  assert.equal(X.nudge(t, 1, 4.5, "end", -1).end, 4.5);          // would leave < 3 s: no change
});

test("headline and end-card text can't break the subtitle file", () => {
  const plat = X.F.platforms.all;
  const m = { start: 0, end: 5, title: "C:\\new {\\b1}bold\nsecond line", words: [W("hi", 0.5, 0.9)] };
  const ass = X.buildASS(m, plat, [[0, 5]], { captions: true, hook: true, cta: "Pick one\\N{x}" });
  const events = ass.split("\n").filter(l => l.startsWith("Dialogue:"));
  assert.equal(events.length, 3, "one hook, one CTA, one caption: no injected events");
  const hook = events.find(l => l.includes(",Hook,"));
  assert.ok(!/\\N|\\b1|\n/.test(hook.split("}").slice(1).join("}")), hook);
  assert.ok(!/\\N/.test(events.find(l => l.includes(",Cta,")).replace("{\\fad(150,0)}", "")));
});

test("caption styles all produce events and use the bundled font name", () => {
  const m = { start: 0, end: 4, title: "", words: [W("a", 0.2, 0.5), W("b", 0.6, 0.9), W("c", 1.0, 1.3), W("d", 1.4, 1.8)] };
  for (const style of ["pop", "clean", "boxed"]) {
    const ass = X.buildASS(m, X.F.platforms.tiktok, [[0, 4]], { style, hook: false });
    assert.match(ass, /Style: Cap,Montserrat Black,/);
    assert.ok(ass.split("\n").filter(l => l.startsWith("Dialogue:")).length >= 1, style);
  }
});

test("each script gets its own caption font, and the bundled font really has that name", async () => {
  const { readFileSync } = await import("node:fs");
  const ttf = readFileSync(resolve(ROOT, "docs/fonts/Montserrat-Black.ttf"));
  assert.ok(ttf.includes(Buffer.from("Montserrat Black", "utf16le").swap16()), "family name inside the bundled font");
  const cases = { "Hello there": "latin", "Zażółć gęślą": "latin", "Привет": "latin", "Xin chào thế giới": "latin", "Γειά σου": "greek",
    "これは本当": "ja", "这是真的": "zh", "이것은 정말": "ko", "مرحبا": "arabic", "שלום": "hebrew", "नमस्ते": "devanagari", "สวัสดี": "thai" };
  for (const [t, k] of Object.entries(cases)) assert.equal(X.scriptOf(t), k, t);
  const files = new Set();
  for (const [k, f] of Object.entries(X.F.captionFonts)) {
    assert.ok(f.name && f.file && !files.has(f.file), k); files.add(f.file);
    if (k !== "latin") assert.match(f.url, /^https:\/\/cdn\.jsdelivr\.net\/npm\/@expo-google-fonts\/[a-z-]+@\d+\.\d+\.\d+\/900Black\//, k);
  }
  const m = { start: 0, end: 3, title: "", words: [W("这是", 0.2, 0.6), W("真的", 0.7, 1.1)] };
  assert.match(X.buildASS(m, X.F.platforms.tiktok, [[0, 3]], {}), /Style: Cap,Noto Sans SC Black,[\s\S]*Style: Hook,Noto Sans SC Black,/);
  // Encoding -1 = full bidi across highlight tags, so right-to-left lines keep their word order
  const rtl = X.buildASS({ start: 0, end: 3, title: "", words: [W("هذا", 0.2, 0.6), W("رائع", 0.7, 1.1)] }, X.F.platforms.tiktok, [[0, 3]], {});
  assert.equal(rtl.match(/^Style: .*,-1$/gm).length, 3);
  // Greek capitals lose accents and breathings but keep the diaeresis
  const gr = X.buildASS({ start: 0, end: 3, title: "", words: [W("κόσμε", 0.2, 0.6), W("Ϊ́ἄ", 0.7, 1.1)] }, X.F.platforms.tiktok, [[0, 3]], {});
  assert.match(gr, /ΚΟΣΜΕ/); assert.match(gr, /ΪΑ/); assert.doesNotMatch(gr, /ΚΌΣΜΕ/);
});

test("caption line edits keep timings when the word count matches", () => {
  const tr = [W("helo", 1, 1.5), W("wrld", 1.6, 2.0), W("again", 2.1, 2.6)];
  const lines = X.captionLines(tr, 0.5, 3);
  X.applyLineEdits(tr, lines, ["hello world again"]);
  assert.deepEqual(tr.map(w => w.w), ["hello", "world", "again"]);
  assert.deepEqual(tr.map(w => w.s), [1, 1.6, 2.1]);
});

test("caption line edits spread new words across the line", () => {
  const tr = [W("a", 1, 1.5), W("b", 1.6, 2.0)];
  X.applyLineEdits(tr, X.captionLines(tr, 0.5, 3), ["one two three"]);
  assert.equal(tr.length, 3);
  assert.ok(tr.every((w, i) => i === 0 || w.s >= tr[i - 1].s));
  assert.ok(tr[0].s >= 1 && tr.at(-1).e <= 2.0 + 1e-9);
});

test("SRT timestamps follow the cuts", () => {
  const m = { start: 10, end: 20, words: [W("a", 10.5, 10.8), W("b", 15.5, 15.9)] };
  const srt = X.buildSRT(m, [[0, 2], [5, 10]]);
  assert.match(srt, /00:00:00,500 --> 00:00:02,900/);
});

test("time formatting", () => {
  assert.equal(X.fmtT(65), "1:05");
  assert.equal(X.fmtT(3725), "1:02:05");
  assert.equal(X.fmtT(undefined), "0:00");
});

test("speech windows cover the whole video without overlap", () => {
  const loud = new Float32Array(400).map((_, i) => Math.sin(i / 3));
  const w = X.asrWindows(loud, 200);
  assert.equal(w[0][0], 0);
  assert.ok(Math.abs(w.at(-1)[1] - 200) < 1e-9);
  w.forEach(([s, e], i) => { assert.ok(e - s <= 28 + 1e-9 && e > s); if (i) assert.equal(s, w[i - 1][1]); });
});

test("moments respect platform lengths and don't overlap", () => {
  const words = [];
  for (let t = 0; t < 300; t += 0.4) words.push(W(["this", "is", "insane", "wait", "what", "here's", "the", "secret"][Math.floor(t * 2.5) % 8], t, t + 0.3));
  const segs = X.segmentsFromWords(words);
  const loud = new Float32Array(600).map((_, i) => Math.sin(i / 7));
  const ms = X.findMoments(segs, loud, 300, 5, "tiktok", "short");
  assert.ok(ms.length >= 1);
  const [lo, hi] = X.F.platforms.tiktok.short;
  for (const m of ms) assert.ok(m.end - m.start >= lo - 1 && m.end - m.start <= hi + 1, `${m.start}-${m.end}`);
  const sorted = [...ms].sort((a, b) => a.start - b.start);
  sorted.forEach((m, i) => { if (i) assert.ok(m.start >= sorted[i - 1].end - 1e-6, "no overlap"); });
});

test("both engines save the same scoring signals on each moment", () => {
  const words = [];
  for (let t = 0; t < 120; t += 0.4) words.push(W(["why", "is", "this", "insane", "here's", "the", "secret.", "so"][Math.floor(t * 2.5) % 8], t, t + 0.3));
  const segs = X.segmentsFromWords(words);
  const loud = Array.from({ length: 240 }, (_, i) => +(Math.sin(i / 5) + (i % 37 === 0 ? 2 : 0)).toFixed(3));
  const js = X.findMoments(segs, Float32Array.from(loud), 120, 3, "tiktok", "short");
  const py = JSON.parse(execFileSync(PY, ["-c", `
import sys, json; sys.path.insert(0, ${JSON.stringify(ROOT)})
import numpy as np, clipper
a = json.loads(sys.stdin.read())
ms = clipper.find_moments(a["segs"], np.array(a["loud"], dtype=np.float32), 120, 3, platform="tiktok", version="short")
print(json.dumps([dict(start=m.start, signals=m.signals) for m in ms]))`], { input: JSON.stringify({ segs, loud }), encoding: "utf8" }).trim().split("\n").at(-1));
  assert.ok(js.length >= 2);
  assert.deepEqual(Object.keys(js[0].signals).sort(), Object.keys(X.F.weights).sort());
  assert.equal(py.length, js.length);
  js.forEach((m, i) => {
    assert.ok(Math.abs(m.start - py[i].start) < 0.02, `moment ${i}: ${m.start} vs ${py[i].start}`);
    for (const k of Object.keys(m.signals)) assert.ok(Math.abs(m.signals[k] - py[i].signals[k]) <= 0.011, `${k}: ${m.signals[k]} vs ${py[i].signals[k]}`);
  });
});

test("captions in every script come out the same in both engines, spaced the way each language is written", () => {
  const mk = ws => ({ start: 0, end: 6, title: ws.join(""), words: ws.map((w, i) => W(w, 0.2 + i * 0.5, 0.6 + i * 0.5)) });
  const samples = { zh: ["这是", "真的", "很棒", "。", "我们", "走吧"], ja: ["これは", "本当に", "すごい", "です。"], th: ["นี่", "มัน", "สุดยอด", "มาก"],
    ko: ["이것은", "정말", "대단해", "요"], ar: ["هذا", "رائع", "حقا", "؟"], el: ["Γειά", "σου", "κόσμε", "Ϊ́ἄ"], he: ["זה", "באמת", "מדהים"], mixed: ["我的", "iPhone", "很", "好", "OK"], ru: ["Привет", "как", "дела"] };
  const cases = [];
  for (const [k, ws] of Object.entries(samples)) for (const style of ["pop", "clean", "boxed"]) cases.push({ k, style, m: mk(ws) });
  const py = JSON.parse(execFileSync(PY, ["-c", `
import sys, json, tempfile, pathlib; sys.path.insert(0, ${JSON.stringify(ROOT)})
import clipper
a = json.loads(sys.stdin.read()); d = pathlib.Path(tempfile.mkdtemp()); out = []
for c in a:
    m = clipper.Moment(**c["m"])
    clipper.write_ass(m, d / "t.ass", clipper.PLATFORMS["tiktok"], [(0, 6)], True, True, "", c["style"], {})
    clipper.write_srt(m, d / "t.srt", [(0, 6)])
    out.append([(d / "t.ass").read_text(encoding="utf-8"), (d / "t.srt").read_text(encoding="utf-8")])
print(json.dumps(out))`], { input: JSON.stringify(cases), encoding: "utf8" }).trim().split("\n").at(-1));
  cases.forEach((c, i) => {
    assert.equal(X.buildASS(c.m, X.F.platforms.tiktok, [[0, 6]], { style: c.style }), py[i][0], `${c.k} ${c.style} .ass`);
    assert.equal(X.buildSRT(c.m, [[0, 6]]), py[i][1], `${c.k} .srt`);
  });
  assert.match(py[0][1], /这是真的很棒。我们走吧/);                 // Chinese: no spaces between words
  assert.match(py.find((_, i) => cases[i].k === "ko")[1], /이것은 정말 대단해 요/);   // Korean keeps them
  assert.equal(X.joinWords(["我的", "iPhone", "很"]), "我的iPhone很");
  assert.equal(X.joinWords(["Hello", "world"], ["<b>Hello</b>", "world"]), "<b>Hello</b> world");
  for (const t of ["Done.", 'He said "yes."', "真的很棒。", "هل انت بخير؟"]) assert.ok(X.SENT_END.test(t), t);
  for (const t of ["真的很棒", "café", "not yet"]) assert.ok(!X.SENT_END.test(t), t);
});

test("a YouTube Studio export is read whatever columns it has", () => {
  const csv = '\uFEFFContent,Video title,Video publish time,Duration,Views,Watch time (hours),Average percentage viewed (%),Average view duration\r\n' +
    'Total,,,,"1,290",3.1,52.3,0:28\r\n' +
    'abc123,"Why this is insane, honestly","Nov 1, 2026",34,"1,200",2.9,61.5%,0:41\r\n' +
    'def456,"She said ""no"" #shorts","Nov 2, 2026",20,90,0.2,30.1,0:12\r\n';
  const t = X.studioTable(csv);
  assert.deepEqual(t.columns, ["Duration", "Views", "Watch time (hours)", "Average percentage viewed (%)", "Average view duration"]);
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.rows[0], { title: "Why this is insane, honestly", published: "Nov 1, 2026",
    values: { Duration: 34, Views: 1200, "Watch time (hours)": 2.9, "Average percentage viewed (%)": 61.5, "Average view duration": 41 } });
  assert.equal(t.rows[1].title, 'She said "no" #shorts');
  assert.throws(() => X.studioTable("Views,Likes\n1,2\n"), /Video title/);
  assert.ok(Number.isNaN(X.studioNumber("n/a")));
  assert.equal(X.studioNumber("1:02:03"), 3723);
});

test("Studio videos match logged clips by title, one to one", () => {
  assert.equal(X.titleSimilarity("Why THIS is insane!! #shorts", "why this is insane"), 1);
  assert.equal(X.titleSimilarity("Here's the secret nobody tells you about pricing your work", "Here's the secret nobody tells you"), 0.95);
  assert.ok(X.titleSimilarity("Here's the secret", "A totally different video") < 0.6);
  const sig = JSON.stringify({ hook: 1.2 });
  const log = [
    { title: "Why this is insane", cut: "short", checkpoint: "24h", signals: sig, score: "88" },
    { title: "Why this is insane", cut: "short", checkpoint: "7d" },                       // same clip, later check-in
    { title: "Here is the secret", cut: "long", checkpoint: "24h" },
    { title: "", cut: "long" },
  ];
  const studio = [{ title: "why this is insane #shorts", values: { Views: 10 } }, { title: "Why this is insane (part 2)", values: { Views: 5 } }, { title: "Unrelated", values: { Views: 1 } }];
  const m = X.matchStudio(studio, log);
  assert.equal(m.matched.length, 1);
  assert.equal(m.matched[0].studio.values.Views, 10);
  assert.deepEqual(m.matched[0].clip.signals, { hook: 1.2 });
  assert.equal(m.matched[0].clip.score, 88);
  assert.equal(m.matched[0].clip.rows, 2);
  assert.equal(m.unmatchedStudio.length, 2);
  assert.equal(m.unmatchedClips.length, 1);
});

test("the signal report ranks what the best clips share", () => {
  assert.equal(X.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(X.spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.equal(X.spearman([1, 1, 1], [1, 2, 3]), 0);
  const keys = Object.keys(X.F.weights);
  const mk = (i, views) => ({ clip: { title: "c" + i, score: 60 + i, signals: Object.fromEntries(keys.map(k => [k, k === "hook" ? i : k === "deadair" ? -i : 0])) }, studio: { values: { Views: views } } });
  assert.equal(X.signalReport([mk(1, 5), mk(2, 9)], "Views").enough, false);
  const data = [1, 2, 3, 4, 5, 6, 7].map(i => mk(i, i * 100));
  data.push({ clip: { title: "old", signals: null }, studio: { values: { Views: 1 } } });   // logged before signals were saved: left out
  const r = X.signalReport(data, "Views");
  assert.equal(r.n, 7); assert.ok(r.enough && r.early);
  assert.equal(r.signals[0].key, "score");
  assert.equal(r.signals[0].rho, 1);
  const hook = r.signals.find(x => x.key === "hook"), dead = r.signals.find(x => x.key === "deadair"), pace = r.signals.find(x => x.key === "pace");
  assert.equal(hook.rho, 1); assert.equal(dead.rho, -1); assert.equal(pace.rho, 0);
  assert.deepEqual([hook.best, hook.worst], [6.5, 1.5]);
  assert.equal(r.signals[1].key === "hook" || r.signals[1].key === "deadair", true);
});

test("frame formats and caption branding match the desktop engine", () => {
  const m = { start: 0, end: 6, title: "Big {news}\\ today", words: [W("so", 0.3, 0.6), W("this", 0.7, 1.0), W("is", 1.1, 1.3), W("huge", 1.4, 1.9), W("right", 2.0, 2.4), W("now", 2.5, 2.9)] };
  const looks = [{}, { format: "1:1", hl: "#22ccff", size: "l", pos: "top" }, { format: "16:9", size: "s", pos: "middle" }, { format: "4:5", hl: "#FF4FA3" }];
  const cases = [];
  for (const style of ["pop", "clean", "boxed"]) for (const look of looks) for (const plat of ["tiktok", "x"]) cases.push({ style, look, plat });
  const py = JSON.parse(execFileSync(PY, ["-c", `
import sys, json, tempfile, pathlib; sys.path.insert(0, ${JSON.stringify(ROOT)})
import clipper
a = json.loads(sys.stdin.read()); p = pathlib.Path(tempfile.mkdtemp()) / "t.ass"; out = []
for c in a["cases"]:
    clipper.write_ass(clipper.Moment(**a["m"]), p, clipper.PLATFORMS[c["plat"]], [(0, 6)], True, True, "Pick one", c["style"], c["look"])
    out.append(p.read_text(encoding="utf-8"))
print(json.dumps(out))`], { input: JSON.stringify({ m, cases }), encoding: "utf8" }).trim().split("\n").at(-1));
  cases.forEach((c, i) => assert.equal(X.buildASS(m, X.F.platforms[c.plat], [[0, 6]], { style: c.style, cta: "Pick one", ...c.look }), py[i], JSON.stringify(c)));
  assert.deepEqual(X.frameSize("16:9", false), [1280, 720]);
  assert.equal(X.assColour("#FF4FA3"), "&HA34FFF&");
  assert.equal(X.assColour("nope"), "&H00F0FF&");
});

test("the brand logo sits in the same place in both engines", () => {
  const cases = [];
  for (const format of ["9:16", "4:5", "1:1", "16:9"]) for (const lpos of ["tl", "tr"]) for (const lsize of ["s", "m", "l"])
    for (const lop of [0.5, "0.7", 1, "junk"]) for (const hd of [true, false]) cases.push({ format, look: { lpos, lsize, lop }, hd });
  const py = JSON.parse(execFileSync(PY, ["-c", `
import sys, json; sys.path.insert(0, ${JSON.stringify(ROOT)})
import clipper
a = json.loads(sys.stdin.read())
print(json.dumps([clipper.logo_chain(c["format"], c["look"], "[pv]", 1, 1080 if c["hd"] else 720) for c in a]))`], { input: JSON.stringify(cases), encoding: "utf8" }).trim().split("\n").at(-1));
  cases.forEach((c, i) => assert.equal(X.logoChain(c.format, c.look, "[pv]", 1, c.hd), py[i], JSON.stringify(c)));
  assert.match(X.logoChain("9:16", { lpos: "tr" }, "[pv]", 1), /overlay=x=W-w-54:y=86$/);
  assert.equal(X.logoOpacity("junk"), 0.7);
  assert.equal(X.logoOpacity(0.95), 1);
});

test("caption groups drive both the preview and the subtitle file", () => {
  const m = { start: 0, end: 5, words: [W("a", 0.2, 0.5), W("um", 0.6, 0.8), W("b", 0.9, 1.2), W("c", 1.3, 1.6), W("d", 1.7, 2.0)] };
  const g = X.captionGroups(m, { style: "pop" });
  assert.deepEqual(g.map(x => x.words.map(w => w.w)), [["a", "b", "c"], ["d"]]);          // fillers never show
  assert.equal(g[0].e, g[1].s);
  assert.deepEqual(X.captionGroups(m, { captions: false }), []);
});

test(".zip export is a valid archive", async () => {
  const { zip, crc32, slug } = await import(pathToFileURL(resolve(ROOT, "docs/zip.js")).href);
  assert.equal(crc32(new TextEncoder().encode("123456789")).toString(16), "cbf43926");
  assert.equal(slug("Héllo, World! Ünïcode’s clip"), "hello-world-unicode-s-clip");
  const files = [{ name: "01-a.mp4", data: new Blob([new Uint8Array(5000).map((_, i) => i % 251)]) }, { name: "01-captions ü.txt", data: "hi ü" }];
  const b = new Uint8Array(await (await zip(files)).arrayBuffer()), dv = new DataView(b.buffer);
  const eocd = b.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054B50);
  assert.equal(dv.getUint16(eocd + 10, true), 2);
  let off = dv.getUint32(eocd + 16, true);
  for (const f of files) {                                  // central directory → local header → data, CRC re-checked
    assert.equal(dv.getUint32(off, true), 0x02014B50);
    const crc = dv.getUint32(off + 16, true), size = dv.getUint32(off + 20, true), nlen = dv.getUint16(off + 28, true), lo = dv.getUint32(off + 42, true);
    assert.equal(new TextDecoder().decode(b.subarray(off + 46, off + 46 + nlen)), f.name);
    const data = b.subarray(lo + 30 + dv.getUint16(lo + 26, true), lo + 30 + dv.getUint16(lo + 26, true) + size);
    assert.equal(crc32(data), crc);
    off += 46 + nlen;
  }
});

test("YouTube upload CSV includes one row per kept clip", async () => {
  const { youtubeUploadCsv } = await import(pathToFileURL(resolve(ROOT, "docs/zip.js")).href);
  const post = 'Un café, "one more"\nand then go';
  const shortsTitle = "A".repeat(99) + "🗺️";
  const clips = [
    { idx: "01", kept: true, title: post, short: { title: "Short cut" }, captions: { shorts: shortsTitle }, hashtags: ["#maps", "#travel"] },
    { idx: "02", kept: false, title: "Skip me" },
    { idx: "03", kept: true, title: "One cut" },
  ];
  const parse = csv => JSON.parse(execFileSync(PY, ["-c",
    "import csv, io, json, sys; print(json.dumps(list(csv.reader(io.StringIO(sys.stdin.buffer.read().decode('utf-8'), newline='')))))"],
  { input: csv, encoding: "utf8" }));
  const header = ["filename", "title", "description", "hashtag"];
  assert.deepEqual(parse(youtubeUploadCsv(clips)), [
    header,
    ["01-short-short-cut.mp4", "A".repeat(99), post + "\n\n#maps #travel", "#Shorts"],
    ["03-one-cut.mp4", "One cut", "One cut", "#Shorts"],
  ]);
  assert.deepEqual(parse(youtubeUploadCsv([clips[1]])), [header]);
});
