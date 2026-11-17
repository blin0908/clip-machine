// Editor hand-off files (docs/nle.js): CMX 3600 EDL + Final Cut Pro 7 XML for Premiere Pro / DaVinci Resolve.
//   node --test tests/nle.test.mjs
// Set OTIO_PY to a Python with opentimelineio + otio-fcp-adapter + otio-cmx3600-adapter to also parse the files
// with the industry's interchange library (what Resolve-adjacent tools use).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as N from "../docs/nle.js";

const cut = { start: 70.42, end: 95.31 }, keep = [[0, 6.2], [7.05, 15.5], [16.3, 24.89]];
const base = { title: "It's a guess & a <reveal>", cut, keep, source: "scout police (1).mp4", path: "/Users/x/Movies/scout police (1).mp4",
               W: 1080, H: 1920, srcW: 1920, srcH: 1080, layout: "crop", duration: 96, payoff: 93.5 };

test("rates and timecode", () => {
  assert.deepEqual(N.rate(29.97), { fps: 30 / 1.001, base: 30, ntsc: true });
  assert.deepEqual(N.rate(25), { fps: 25, base: 25, ntsc: false });
  assert.equal(N.rate(23.976).base, 24);
  assert.equal(N.tc(3600 * 30, N.rate(30)), "01:00:00:00");
  assert.equal(N.tc(30 * 61 + 7, N.rate(30)), "00:01:01:07");
});

test("events tile the record side with no gaps and match the kept source", () => {
  const r = N.rate(25), ev = N.events(cut, keep, r);
  assert.equal(ev.length, 3);
  assert.equal(ev[0].ri, 3600 * 25);
  for (let i = 1; i < ev.length; i++) assert.equal(ev[i].ri, ev[i - 1].ro);
  ev.forEach((e, i) => { assert.equal(e.si, Math.round((cut.start + keep[i][0]) * 25)); assert.equal(e.so - e.si, e.ro - e.ri); });
  assert.equal(N.recordFrame(cut.start + 6.5, cut, ev, r), ev[1].ri);          // inside a removed pause: next kept frame
  assert.equal(N.recordFrame(200, cut, ev, r), null);
});

test("EDL is CMX 3600 shaped", () => {
  const e = N.edl({ ...base, fps: 29.97 }).split("\r\n");
  assert.equal(e[0], "TITLE: It's a guess & a <reveal>");
  assert.equal(e[1], "FCM: NON-DROP FRAME");
  const evs = e.filter(l => /^\d{3}  /.test(l));
  assert.equal(evs.length, 3);
  for (const l of evs) assert.match(l, /^\d{3}  [A-Z0-9 ]{8} AA\/V  C        (\d\d:\d\d:\d\d:\d\d ){3}\d\d:\d\d:\d\d:\d\d$/);
  assert.ok(e.includes("* FROM CLIP NAME: scout police (1).mp4"));
});

test("XML is well formed and escapes names", () => {
  const x = N.xmeml({ ...base, fps: 30 });
  assert.match(x, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE xmeml>\n<xmeml version="5">/);
  assert.ok(x.includes("<name>It&apos;s a guess &amp; a &lt;reveal&gt;</name>"));
  assert.ok(x.includes("<pathurl>file://localhost/Users/x/Movies/scout%20police%20(1).mp4</pathurl>"));
  assert.ok(x.includes("<width>1080</width><height>1920</height>"));
  assert.equal((x.match(/<file id="src-1">/g) || []).length, 1);           // the file is described once, then referenced
  assert.equal(N.xmeml({ ...base, fps: 30, path: "C:\\Clips\\a b.mp4" }).match(/<pathurl>([^<]+)/)[1], "file://localhost/C:/Clips/a%20b.mp4");
});

test("both files parse in OpenTimelineIO and agree", { skip: !process.env.OTIO_PY && "set OTIO_PY to run" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "nle-"));
  for (const fps of [23.976, 25, 29.97, 30, 59.94]) {
    writeFileSync(join(dir, `c${fps}.xml`), N.xmeml({ ...base, fps }));
    writeFileSync(join(dir, `c${fps}.edl`), N.edl({ ...base, fps }));
  }
  const out = JSON.parse(execFileSync(process.env.OTIO_PY, ["-c", `
import sys, glob, json, opentimelineio as otio
res = {}
for f in sorted(glob.glob(sys.argv[1] + "/c*.*")):
    fps = float(f.rsplit("/c", 1)[1].rsplit(".", 1)[0])
    exact = {29.97: 30000/1001, 59.94: 60000/1001, 23.976: 24000/1001}.get(fps, fps)
    tl = otio.adapters.read_from_file(f, **({"rate": exact} if f.endswith(".edl") else {}))
    v = [c for c in [t for t in tl.tracks if t.kind == "Video"][0] if isinstance(c, otio.schema.Clip)]
    res[f.rsplit("/", 1)[1]] = {"src": [[round(c.source_range.start_time.to_seconds(), 2), round(c.source_range.end_time_exclusive().to_seconds(), 2)] for c in v],
        "audio": len([t for t in tl.tracks if t.kind == "Audio"]),
        "markers": [[m.name, round(m.marked_range.start_time.to_seconds(), 1)] for m in tl.tracks.markers]}
print(json.dumps(res))`, dir], { encoding: "utf8" }));
  for (const fps of [23.976, 25, 29.97, 30, 59.94]) {
    const x = out[`c${fps}.xml`], e = out[`c${fps}.edl`];
    assert.equal(x.src.length, 3); assert.deepEqual(x.src, e.src);
    x.src.forEach(([a, b], i) => { assert.ok(Math.abs(a - (cut.start + keep[i][0])) < 0.05 && Math.abs(b - (cut.start + keep[i][1])) < 0.05, `${fps} ${i}`); });
    assert.equal(x.audio, 2);
    assert.equal(x.markers.length, 1); assert.equal(x.markers[0][0], "Payoff");
    assert.ok(Math.abs(x.markers[0][1] - 21.43) <= 0.1, `${fps}: payoff at ${x.markers[0][1]}`);   // 6.2 + 8.45 + (93.5 - 86.72)
  }
});
