// Debug helper: run one file in WebKit with extra URL options, print the stage every 15 s, report done/crash.
import { webkit } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
const DOCS = resolve("../docs"), file = process.argv[2], q = process.argv[3] || "";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".ttf": "font/ttf" };
const srv = createServer(async (rq, r) => { const p = join(DOCS, decodeURIComponent(new URL(rq.url, "http://x").pathname).replace(/\/$/, "/index.html"));
  try { r.writeHead(200, { "Content-Type": MIME[extname(p)] || "application/octet-stream" }).end(await readFile(p)); } catch { r.writeHead(404).end(); } });
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const b = await webkit.launch(); const page = await (await b.newContext()).newPage();
await page.addInitScript(() => { const W = window.Worker; window.__ff = { n: 0, last: [], exec: [] };
  window.Worker = class extends W { constructor(...a) { super(...a);
    this.addEventListener("message", e => { const d = e.data; if (d?.type === "LOG") { window.__ff.n++; window.__ff.last.push(d.data.message); if (window.__ff.last.length > 12) window.__ff.last.shift(); } });
    const pm = this.postMessage.bind(this); this.postMessage = (m, t) => { if (m?.type === "EXEC") { window.__ff.exec.push(m.data.args.join(" ").slice(0, 400)); window.__ff.full = m.data.args; }
      if (m?.type === "WRITE_FILE" && m.data.path === "/sub.ass") window.__ff.ass = typeof m.data.data === "string" ? m.data.data : new TextDecoder().decode(m.data.data); return pm(m, t); }; } }; });
let crashed = false; page.on("crash", () => { crashed = true; console.log("CRASH"); });
page.on("console", m => console.log("console:", m.type(), m.text().slice(0, 200)));
page.on("worker", w => console.log("worker:", w.url().split("/").pop()));
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${srv.address().port}/?model=Xenova/whisper-tiny.en&n=1${q}`);
await page.setInputFiles("#file", file); await page.click("#go");
for (;;) {
  await new Promise(r => setTimeout(r, 5000));
  if (crashed) break;
  const st = await Promise.race([new Promise(r => setTimeout(() => r({ prog: "eval failed: page unresponsive" }), 10000)), page.evaluate(() => ({ prog: document.querySelector("#prog").textContent.replace(/\s+/g, " ").slice(0, 80),
    done: !!document.querySelector("#out .card.err, #out .card.msg") || (document.querySelectorAll("#out .clip").length && document.querySelector("#prog").classList.contains("hide")),
    out: document.querySelector("#out").textContent.replace(/\s+/g, " ").slice(0, 120), ff: window.__ff.n, last: window.__ff.last.slice(-3).join(" | ").slice(0, 300), exec: window.__ff.exec.at(-1) })).catch(e => ({ prog: "eval failed " + e.message.slice(0, 60) }))]);
  console.log(((Date.now() - t0) / 1000).toFixed(0) + "s", st.done ? "DONE " + st.out : st.prog, "| fflogs", st.ff, "|", st.last);
  if (false && /Finding/.test(st.prog || "") && !globalThis.__saved) {
    const d = await page.evaluate(() => ({ args: window.__ff.full, ass: window.__ff.ass }));
    (await import("node:fs")).writeFileSync("web-out/render-cmd.json", JSON.stringify(d)); globalThis.__saved = 1; console.log("   saved render command"); break;
  }
  if (/Finding|Transcribing…60/.test(st.prog || "")) {
    for (const w of page.workers()) {
      const r = await Promise.race([w.evaluate(() => ({ alive: true, mem: self.performance?.memory?.usedJSHeapSize ?? null })).then(x => JSON.stringify(x)).catch(e => "err " + e.message.slice(0, 80)),
        new Promise(r => setTimeout(() => r("NO RESPONSE (thread blocked)"), 5000))]);
      console.log("   worker", w.url().split("/").pop(), "→", r);
    }
  }
  if (st.exec && st.exec !== globalThis.__lastExec) { console.log("   EXEC:", st.exec); globalThis.__lastExec = st.exec; }
  if (st.done || st.prog.startsWith("eval failed") || Date.now() - t0 > 900000) break;
}
await b.close().catch(() => {}); srv.close();
