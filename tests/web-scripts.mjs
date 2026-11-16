// Captions in every writing system, drawn by the browser engine (ffmpeg.wasm + libass) with the fonts the app
// loads for that script. Fails if libass reports a missing glyph or a caption comes out blank, and writes a
// contact sheet (web-out/scripts.png) to look at. Downloads the Noto caption fonts from jsDelivr on first run.
//
//   node web-scripts.mjs                  # Chrome
//   BROWSER=firefox-desktop node web-scripts.mjs
import { chromium, webkit, firefox } from "playwright";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DOCS = resolve(HERE, "../docs"), OUT = resolve(HERE, "web-out");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".ttf": "font/ttf" };
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname), f = join(DOCS, p.endsWith("/") ? p + "index.html" : p);
  if (!f.startsWith(DOCS)) { res.writeHead(403).end(); return; }
  try { const b = await readFile(f); res.writeHead(200, { "Content-Type": MIME[extname(f)] || "application/octet-stream" }).end(b); }
  catch { res.writeHead(404).end("not found"); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/`;
const TYPES = { "chrome-desktop": [chromium, { channel: "chrome" }], "webkit-desktop": [webkit, {}], "firefox-desktop": [firefox, {}] };
const name = process.env.BROWSER || "chrome-desktop";
const [type, launch] = TYPES[name];

const SAMPLES = {
  polish: ["Zażółć", "gęślą", "jaźń"], russian: ["Привет", "как", "дела"], vietnamese: ["Xin", "chào", "thế", "giới"],
  greek: ["Γειά", "σου", "κόσμε"], japanese: ["これは", "本当に", "すごい"], chinese: ["这是", "真的", "很棒"],
  korean: ["이것은", "정말", "대단해"], arabic: ["هذا", "رائع", "حقا"], hebrew: ["זה", "באמת", "מדהים"],
  hindi: ["यह", "सच", "में", "अद्भुत"], thai: ["นี่", "มัน", "สุดยอด"],
};

const browser = await type.launch({ headless: true, ...launch });
const page = await (await browser.newContext()).newPage();
page.setDefaultTimeout(180000);
await page.goto(BASE + "index.html");
const results = await page.evaluate(async samples => {
  const { FFmpeg } = await import("./vendor/ffmpeg/index.js");
  const { toBlobURL } = await import("./vendor/util/index.js");
  const X = await import("./formula.js");
  const CORE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
  const ff = new FFmpeg(); let logs = [];
  ff.on("log", ({ message }) => logs.push(message));
  await ff.load({ coreURL: await toBlobURL(`${CORE}/ffmpeg-core.js`, "text/javascript"), wasmURL: await toBlobURL(`${CORE}/ffmpeg-core.wasm`, "application/wasm") });
  await ff.createDir("/fonts");
  await ff.writeFile("/fonts/Montserrat-Black.ttf", new Uint8Array(await (await fetch("./fonts/Montserrat-Black.ttf")).arrayBuffer()));
  const out = [];
  for (const [k, ws] of Object.entries(samples)) {
    // the last word highlighted: for right-to-left text it must sit at the left end of the line
    const m = { start: 0, end: 3, title: ws.join(" "), words: ws.map((w, i) => ({ w, s: 0.1 + i * 0.3, e: 0.35 + i * 0.3 })) };
    const f = X.captionFont(m);
    if (f.url && !(await ff.listDir("/fonts")).some(e => e.name === f.file))
      await ff.writeFile(`/fonts/${f.file}`, new Uint8Array(await (await fetch(f.url)).arrayBuffer()));
    await ff.writeFile("/sub.ass", X.buildASS(m, X.F.platforms.tiktok, [[0, 3]], { style: "pop" }));
    logs = [];
    const t = (0.1 + (ws.length - 1) * 0.3 + 0.1).toFixed(2);
    const code = await ff.exec(["-loglevel", "verbose", "-f", "lavfi", "-i", "color=c=0x334455:s=1080x1920:d=3", "-vf", "ass=/sub.ass:fontsdir=/fonts,scale=360:640",
      "-ss", t, "-frames:v", "1", "/f.png"]);
    const png = code === 0 ? await ff.readFile("/f.png") : null;
    const missing = logs.filter(l => /Glyph 0x[0-9A-F]+ not found|fontselect: failed/i.test(l));
    let ink = 0, url = "";
    if (png) {
      const img = await createImageBitmap(new Blob([png], { type: "image/png" }));
      const c = new OffscreenCanvas(img.width, img.height), g = c.getContext("2d"); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, img.width, img.height).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200) ink++;   // white or yellow caption pixels
      url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(new Blob([png], { type: "image/png" })); });
    }
    out.push({ k, font: f.name, code, ink, missing: missing.slice(0, 3), url });
  }
  ff.terminate();
  return out;
}, SAMPLES);

let fails = 0;
for (const r of results) {
  const ok = r.code === 0 && r.ink > 400 && !r.missing.length;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${r.k} in ${r.font}  · ${r.ink} caption pixels${r.missing.length ? " · " + r.missing.join(" | ") : ""}`);
}
// contact sheet of the caption strips
await mkdir(OUT, { recursive: true });
const sheet = await page.evaluate(async rs => {
  const W = 360, H = 260, cols = 4, rows = Math.ceil(rs.length / cols), c = new OffscreenCanvas(W * cols, H * rows), g = c.getContext("2d");
  for (const [i, r] of rs.entries()) {
    if (!r.url) continue;
    const img = await createImageBitmap(await (await fetch(r.url)).blob());
    g.drawImage(img, 0, 0, W, 130, (i % cols) * W, Math.floor(i / cols) * H, W, 130);            // headline
    g.drawImage(img, 0, 300, W, 130, (i % cols) * W, Math.floor(i / cols) * H + 130, W, 130);   // caption
  }
  const b = await c.convertToBlob({ type: "image/png" });
  return [...new Uint8Array(await b.arrayBuffer())];
}, results);
await writeFile(join(OUT, "scripts.png"), Buffer.from(sheet));
await browser.close(); server.close();
console.log(fails ? `\n${fails} failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
