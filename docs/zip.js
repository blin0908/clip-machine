// Minimal .zip writer (stored, no compression: video is already compressed). Builds the archive from Blob parts,
// so a few hundred MB of clips never sit in one big array. Names are UTF-8.
const TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(bytes, crc = 0) {
  crc = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) crc = TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return ~crc >>> 0;
}
function dosTime(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
           date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
/** files: [{ name, data: Blob | string }] → Blob (application/zip) */
export async function zip(files) {
  const enc = new TextEncoder(), parts = [], central = [], { time, date } = dosTime(new Date());
  let offset = 0;
  for (const f of files) {
    const blob = typeof f.data === "string" ? new Blob([f.data]) : f.data;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const name = enc.encode(f.name), crc = crc32(bytes), size = bytes.length;
    if (offset + size > 0xFFFFFFFF) throw new Error("Too much video for one .zip (over 4 GB). Download fewer clips at a time.");
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034B50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true);
    h.setUint32(18, size, true); h.setUint32(22, size, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(h.buffer, name, blob);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014B50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true); c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true);
    c.setUint32(20, size, true); c.setUint32(24, size, true); c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(c.buffer, name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((a, p) => a + (p.byteLength ?? p.length), 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054B50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, e.buffer], { type: "application/zip" });
}
/** "The Biggest Mistake I Made!" → "the-biggest-mistake-i-made" */
export const slug = (s, n = 48) => String(s || "clip").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n).replace(/-+$/, "") || "clip";

export function fileBase(clip, which) {
  const suffix = which === "short" ? "-short" : clip.short ? "-long" : "";
  const cut = which === "short" ? clip.short : clip;
  return `${clip.idx}${suffix}-${slug(cut.title, 40)}`;
}

export function youtubeUploadCsv(clips) {
  const rows = [["filename", "title", "description", "hashtag"]];
  for (const clip of clips) {
    if (!clip.kept) continue;
    const filename = fileBase(clip, clip.short ? "short" : "long") + ".mp4";
    const post = clip.title ?? "";
    const title = (clip.captions?.shorts || post).slice(0, 100).replace(/[\uD800-\uDBFF]$/u, "");
    const description = [post, (clip.hashtags || []).join(" ")].filter(Boolean).join("\n\n");
    rows.push([filename, title, description, "#Shorts"]);
  }
  return rows.map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\r\n") + "\r\n";
}
