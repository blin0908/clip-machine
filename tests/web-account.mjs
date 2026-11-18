// Accounts + settings sync in a real browser: local Worker (wrangler dev + temp D1) and the site from docs/.
// Two separate browser contexts play two devices.   node tests/web-account.mjs
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(REPO, "server"), WR = join(SERVER, "node_modules", ".bin", "wrangler");
const API_PORT = 8960 + Math.floor(Math.random() * 30), WEB_PORT = 8930 + Math.floor(Math.random() * 30);
const API = `http://127.0.0.1:${API_PORT}`, WEB = `http://localhost:${WEB_PORT}/`;
const persist = mkdtempSync(join(tmpdir(), "cm-acct-"));
let fails = 0;
const check = (ok, name, info = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  · " + info : ""}`); if (!ok) fails++; };
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };

execFileSync(WR, ["d1", "execute", "clipmachine", "--local", "--env", "dev", "--persist-to", persist, "--file", "schema.sql"], { cwd: SERVER, stdio: "ignore", env });
const api = spawn(WR, ["dev", "--local", "--env", "dev", "--port", String(API_PORT), "--ip", "127.0.0.1", "--persist-to", persist, "--show-interactive-dev-session=false"], { cwd: SERVER, stdio: "ignore", env });
const web = spawn(join(REPO, ".venv", "bin", "python"), ["-m", "http.server", String(WEB_PORT), "--bind", "127.0.0.1", "-d", join(REPO, "docs")], { stdio: "ignore" });
const up = async u => { for (let i = 0; i < 120; i++) { try { if ((await fetch(u)).ok) return; } catch {} await new Promise(r => setTimeout(r, 500)); } throw new Error("not up: " + u); };

const browser = await chromium.launch({ channel: "chrome" });
try {
  await up(API + "/v1/health"); await up(WEB);
  const device = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: "block" });
    const page = await ctx.newPage(); const errs = [], csp = [];
    page.on("pageerror", e => errs.push(e.message));
    page.on("console", m => { if (/Content Security Policy|Refused to/i.test(m.text())) csp.push(m.text()); });
    return { ctx, page, errs, csp };
  };

  // ---- no API configured → no account button, no errors, no CSP violations
  const A = await device();
  await A.page.goto(WEB + "workspace.html"); await A.page.waitForSelector("#go");
  await A.page.waitForTimeout(800);
  check(await A.page.locator("#acctBtn.hide").count() === 1, "without an API the account button stays hidden");
  check(A.csp.length === 0, "the page loads with no Content-Security-Policy violations", A.csp[0] || "");

  // ---- device A: point at the local API, create an account
  await A.page.evaluate(api => localStorage.setItem("clipmachine.api", api), API);
  await A.page.evaluate(() => localStorage.setItem("clipmachine.presets", JSON.stringify({ "From device A": { n: 5 } })));
  await A.page.reload(); await A.page.waitForSelector("#acctBtn:not(.hide)", { timeout: 15000 });
  check((await A.page.locator("#acctBtn").textContent()).includes("Sign in"), "account button appears when the API is reachable");
  await A.page.click("#acctBtn"); await A.page.click('[data-mode="signup"]');
  await A.page.fill("#acctEmail", "nope"); await A.page.fill("#acctPw", "x"); await A.page.click(".acct-go");
  await A.page.waitForSelector("#acctErr:not([hidden])");
  check(/valid email/i.test(await A.page.locator("#acctErr").textContent()), "a bad email gets a plain-English error", await A.page.locator("#acctErr").textContent());
  const email = `e2e-${Date.now()}@example.com`, pw = "a long test passphrase";
  await A.page.fill("#acctEmail", email); await A.page.fill("#acctPw", pw); await A.page.click(".acct-go");
  await A.page.waitForSelector("#acctBtn .acct-av", { timeout: 15000 });
  await A.page.waitForFunction(() => document.querySelector("#acctBtn")?.dataset.state === "ok", null, { timeout: 15000 });
  check(true, "signed up and synced on device A");
  const tok = await A.page.evaluate(() => JSON.parse(localStorage.getItem("clipmachine.session")).token);
  const srv = await (await fetch(API + "/v1/sync", { headers: { authorization: "Bearer " + tok } })).json();
  check("From device A" in (srv.data?.presets || {}), "device A's presets reached the server", JSON.stringify(srv.data?.presets || null));
  check(!JSON.stringify(srv).includes("blob:") && Object.keys(srv.data).every(k => ["presets", "last", "logo", "log", "learnMetric", "studio"].includes(k)),
    "only settings are synced", Object.keys(srv.data).join(","));

  // ---- device B: has its own preset, signs in, ends up with both
  const B = await device();
  await B.page.goto(WEB + "workspace.html"); await B.page.waitForSelector("#go");
  await B.page.evaluate(api => { localStorage.setItem("clipmachine.api", api); localStorage.setItem("clipmachine.presets", JSON.stringify({ "From device B": { n: 1 } })); }, API);
  await B.page.reload(); await B.page.waitForSelector("#acctBtn:not(.hide)", { timeout: 15000 });
  await B.page.click("#acctBtn"); await B.page.fill("#acctEmail", email); await B.page.fill("#acctPw", "wrong password here"); await B.page.click(".acct-go");
  await B.page.waitForSelector("#acctErr:not([hidden])");
  check(/don't match/i.test(await B.page.locator("#acctErr").textContent()), "wrong password is refused with a clear message");
  await B.page.fill("#acctPw", pw);
  await Promise.all([B.page.waitForEvent("load", { timeout: 15000 }).catch(() => null), B.page.click(".acct-go")]);   // pulls, merges, reloads
  await B.page.waitForSelector("#acctBtn .acct-av", { timeout: 15000 });
  const presetsB = await B.page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("clipmachine.presets"))).sort());
  check(presetsB.join("|") === "From device A|From device B", "signing in merges presets from both devices", presetsB.join(", "));
  const optB = await B.page.locator("#preset option").allTextContents().catch(() => []);
  check(optB.some(t => t.includes("From device A")), "the merged preset shows in device B's preset menu", optB.filter(t => /device/.test(t)).join(", "));

  // ---- a change on B reaches A
  await B.page.evaluate(() => localStorage.setItem("clipmachine.last", JSON.stringify({ n: 8, marker: "B-was-here" })));
  await B.page.waitForFunction(() => document.querySelector("#acctBtn")?.dataset.state === "ok" && localStorage.getItem("clipmachine.syncHash"), null, { timeout: 15000 });
  await B.page.waitForTimeout(5000);
  await A.page.click("#acctBtn"); await A.page.click("#acctSync");
  await A.page.waitForFunction(() => JSON.parse(localStorage.getItem("clipmachine.last") || "{}").marker === "B-was-here", null, { timeout: 15000 }).catch(() => {});
  check(await A.page.evaluate(() => JSON.parse(localStorage.getItem("clipmachine.last") || "{}").marker) === "B-was-here", "an edit on device B arrives on device A");

  // ---- export, sign out, delete
  await A.page.waitForLoadState("load"); await A.page.waitForSelector("#acctBtn .acct-av", { timeout: 15000 });
  await A.page.click("#acctBtn");
  const [dl] = await Promise.all([A.page.waitForEvent("download"), A.page.click("#acctExport")]);
  check(dl.suggestedFilename() === "clip-machine-account.json", "Download my data gives a JSON file");
  await A.page.click("#acctOut");
  await A.page.waitForSelector("#acctBtn:has-text('Sign in')");
  check(await A.page.evaluate(() => !localStorage.getItem("clipmachine.session") && !!localStorage.getItem("clipmachine.presets")),
    "signing out forgets the session but keeps settings in the browser");
  await B.page.click("#acctBtn"); await B.page.click(".acct-more.danger summary");
  B.page.once("dialog", d => d.accept());
  await B.page.fill("#acctDelPw", pw); await B.page.click("#acctDelForm button[type=submit]");
  await B.page.waitForSelector("#acctBtn:has-text('Sign in')", { timeout: 15000 });
  const gone = await fetch(API + "/v1/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: pw }) });
  check(gone.status === 401, "after Delete account the login no longer exists");
  check(A.errs.length === 0 && B.errs.length === 0, "no page errors", [...A.errs, ...B.errs][0] || "");
  check(A.csp.length === 0 && B.csp.length === 0, "no CSP violations while signed in", [...A.csp, ...B.csp][0] || "");
} catch (e) { check(false, "account flow", e.message.split("\n")[0]); }
finally { await browser.close(); api.kill(); web.kill(); rmSync(persist, { recursive: true, force: true }); }
console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
