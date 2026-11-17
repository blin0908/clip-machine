// Hand a clip to a real editor: a CMX 3600 EDL (Premiere, Resolve, Avid, Final Cut via a converter) and a Final Cut
// Pro 7 XML sequence (Premiere and DaVinci Resolve import it, with the vertical sequence size, every cut, and the
// payoff as a marker). Both point at the ORIGINAL source file, so the editor finishes from full-quality media.
// Timecode: the source starts at 00:00:00:00, the sequence at 01:00:00:00 (the broadcast convention editors expect).

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

/** fps → the timecode base editors use: 29.97 → { base: 30, ntsc: true }. */
export function rate(fps) {
  fps = +fps > 0 ? +fps : 30;
  const base = Math.round(fps), ntsc = Math.abs(fps - base) > 0.005 && Math.abs(fps * 1.001 - base) < 0.01;
  return { fps: ntsc ? base / 1.001 : base, base, ntsc };
}
/** seconds → whole frames at this rate */
export const frames = (t, r) => Math.round(t * r.fps);
/** frames → HH:MM:SS:FF (non-drop-frame, counted on the nominal base) */
export function tc(f, r) {
  const b = r.base, ff = f % b, s = Math.floor(f / b), p = n => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`;
}

/** The pieces of source this cut keeps, in source frames, laid end to end on the record side.
 *  keep: [[a, b], …] seconds relative to cut.start (from X.keepIntervals) */
export function events(cut, keep, r) {
  const START = 3600 * r.base;                       // 01:00:00:00
  let rec = START;
  const out = [];
  for (const [a, b] of keep) {
    const si = frames(cut.start + a, r), so = frames(cut.start + b, r);
    if (so <= si) continue;
    out.push({ si, so, ri: rec, ro: rec + (so - si) });
    rec += so - si;
  }
  return out;
}
/** Where a source time lands in the sequence (null if outside the cut). A time inside a removed pause snaps to
 *  the next kept frame. */
export function recordFrame(t, cut, ev, r) {
  const f = frames(t, r);
  for (const e of ev) if (f < e.so) return f >= e.si ? e.ri + (f - e.si) : e.ri;
  return null;
}

const reelName = name => (String(name || "SOURCE").replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase() || "SOURCE").slice(0, 8);

/** CMX 3600 EDL. One event per kept stretch, audio + video. */
export function edl({ title, cut, keep, fps, source }) {
  const r = rate(fps), ev = events(cut, keep, r), reel = reelName(source);
  const lines = [`TITLE: ${String(title || "Clip").replace(/[\r\n]+/g, " ").slice(0, 70)}`, "FCM: NON-DROP FRAME", ""];
  ev.forEach((e, i) => {
    lines.push(`${String(i + 1).padStart(3, "0")}  ${reel.padEnd(8)} AA/V  C        ${tc(e.si, r)} ${tc(e.so, r)} ${tc(e.ri, r)} ${tc(e.ro, r)}`);
    lines.push(`* FROM CLIP NAME: ${String(source || "source").replace(/[\r\n]+/g, " ")}`);
    lines.push("");
  });
  return lines.join("\r\n");
}

function rateXML(r) { return `<rate><timebase>${r.base}</timebase><ntsc>${r.ntsc ? "TRUE" : "FALSE"}</ntsc></rate>`; }
function pathURL(path) {
  if (!path) return "";
  if (/^file:/.test(path)) return path;
  const p = String(path).replace(/\\/g, "/");
  const abs = /^[A-Za-z]:\//.test(p) ? "/" + p : p;          // C:/Users/… → /C:/Users/…
  return "file://localhost" + abs.split("/").map(s => encodeURIComponent(s).replace(/%3A/g, ":")).join("/");
}

/** Final Cut Pro 7 XML (xmeml v5): a vertical sequence with every kept stretch on V1 + A1/A2, linked to the
 *  source file, the clip scaled the way it was framed, and markers for the hook and the payoff. */
export function xmeml({ title, cut, keep, fps, source, path, W = 1080, H = 1920, srcW = 1920, srcH = 1080, layout = "crop",
                        duration, payoff = null }) {
  const r = rate(fps), ev = events(cut, keep, r), R = rateXML(r);
  const total = ev.length ? ev.at(-1).ro - ev[0].ri : 0, srcDur = frames(duration || cut.end + 1, r);
  // framing: crop layouts fill the frame (scale to cover); "fit" shows the whole picture (scale to fit the width)
  const cover = Math.max(W / srcW, H / srcH), contain = Math.min(W / srcW, H / srcH);
  const scale = +(100 * (layout === "fit" ? contain : cover)).toFixed(2);
  const fileXML = (first) => first
    ? `<file id="src-1"><name>${esc(source)}</name>${path ? `<pathurl>${esc(pathURL(path))}</pathurl>` : ""}${R}<duration>${srcDur}</duration>` +
      `<timecode>${R}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>` +
      `<media><video><samplecharacteristics>${R}<width>${srcW}</width><height>${srcH}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></video>` +
      `<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio></media></file>`
    : `<file id="src-1"/>`;
  const motion = `<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>` +
    `<parameter authoringApp="PremierePro"><parameterid>scale</parameterid><name>Scale</name><valuemin>0</valuemin><valuemax>1000</valuemax><value>${scale}</value></parameter></effect></filter>`;
  const rel = e => `<start>${e.ri - ev[0].ri}</start><end>${e.ro - ev[0].ri}</end><in>${e.si}</in><out>${e.so}</out>`;
  const links = i => `<link><linkclipref>v${i}</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>${i + 1}</clipindex></link>` +
    [1, 2].map(ch => `<link><linkclipref>a${ch}-${i}</linkclipref><mediatype>audio</mediatype><trackindex>${ch}</trackindex><clipindex>${i + 1}</clipindex><groupindex>1</groupindex></link>`).join("");
  const vItems = ev.map((e, i) => `<clipitem id="v${i}"><name>${esc(source)}</name><enabled>TRUE</enabled><duration>${srcDur}</duration>${R}${rel(e)}${fileXML(i === 0)}${motion}${links(i)}</clipitem>`).join("");
  const aTrack = ch => `<track>${ev.map((e, i) => `<clipitem id="a${ch}-${i}"><name>${esc(source)}</name><enabled>TRUE</enabled><duration>${srcDur}</duration>${R}${rel(e)}<file id="src-1"/>` +
    `<sourcetrack><mediatype>audio</mediatype><trackindex>${ch}</trackindex></sourcetrack>${links(i)}</clipitem>`).join("")}</track>`;
  const marks = [];
  const pf = payoff != null ? recordFrame(payoff, cut, ev, r) : null;
  if (pf != null) marks.push({ name: "Payoff", f: pf - ev[0].ri });
  const markXML = marks.map(m => `<marker><name>${esc(m.name)}</name><comment></comment><in>${m.f}</in><out>-1</out></marker>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5"><sequence id="seq-1"><name>${esc(title || "Clip")}</name>` +
    `<duration>${total}</duration>${R}<timecode>${R}<string>${tc(3600 * r.base, r)}</string><frame>${3600 * r.base}</frame><displayformat>NDF</displayformat></timecode>` +
    `${markXML}<media><video><format><samplecharacteristics>${R}<width>${W}</width><height>${H}</height><pixelaspectratio>square</pixelaspectratio>` +
    `<fielddominance>none</fielddominance></samplecharacteristics></format><track>${vItems}</track></video>` +
    `<audio><numOutputChannels>2</numOutputChannels>${aTrack(1)}${aTrack(2)}</audio></media></sequence></xmeml>\n`;
}

/** A short how-to that travels with the files. */
export function readme({ title, source, path }) {
  return [`${title}`, "", "Finish this clip in your editor:",
    "  Premiere Pro: File > Import > the .xml file. If it asks for media, point it at the source video below.",
    "  DaVinci Resolve: File > Import > Timeline > the .xml file (tick 'Automatically import source clips' and",
    "    'Use sizing information'). If the picture comes in smaller than the frame, set Project Settings > Image Scaling >",
    "    'Mismatched resolution files' to 'Center crop with no resizing' and import again.",
    "  Avid, or anything else: import the .edl. Reel names come from the source file name.",
    "  Captions: import the .srt as a caption track.",
    "", `Source video: ${path || source}`,
    "The sequence starts at 01:00:00:00 and is the vertical size of the cut. Each pause Clip Machine removed is a cut.",
    "Framing is centred: adjust Position in Effect Controls / Inspector if the subject is off-centre.", ""].join("\n");
}
