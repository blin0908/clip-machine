// Fast unit checks for docs/formula.js (the web app's scoring, trimming and caption logic).
//   node --test tests/formula.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
globalThis.fetch = async () => ({ json: async () => JSON.parse(readFileSync(resolve(ROOT, "docs/formula.json"), "utf8")) });
const X = await import(resolve(ROOT, "docs/formula.js"));
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
    assert.match(ass, /Montserrat Thin Black/);
    assert.ok(ass.split("\n").filter(l => l.startsWith("Dialogue:")).length >= 1, style);
  }
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

test("caption groups drive both the preview and the subtitle file", () => {
  const m = { start: 0, end: 5, words: [W("a", 0.2, 0.5), W("um", 0.6, 0.8), W("b", 0.9, 1.2), W("c", 1.3, 1.6), W("d", 1.7, 2.0)] };
  const g = X.captionGroups(m, { style: "pop" });
  assert.deepEqual(g.map(x => x.words.map(w => w.w)), [["a", "b", "c"], ["d"]]);          // fillers never show
  assert.equal(g[0].e, g[1].s);
  assert.deepEqual(X.captionGroups(m, { captions: false }), []);
});

test(".zip export is a valid archive", async () => {
  const { zip, crc32, slug } = await import(resolve(ROOT, "docs/zip.js"));
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
