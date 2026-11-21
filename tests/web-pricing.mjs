// Pricing page + Supporter checkout in a real browser: local Worker with a stand-in for Stripe, the site from docs/.
//   node tests/web-pricing.mjs
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(REPO, "server"), WR = join(SERVER, "node_modules", ".bin", "wrangler");
const API_PORT = 9010 + Math.floor(Math.random() * 30), WEB_PORT = 9050 + Math.floor(Math.random() * 30), STRIPE_PORT = 9090 + Math.floor(Math.random() * 30);
const API = `http://127.0.0.1:${API_PORT}`, WEB = `http://localhost:${WEB_PORT}/`, WHSEC = "whsec_browser_test";
const persist = mkdtempSync(join(tmpdir(), "cm-price-"));
let fails = 0;
const check = (ok, name, info = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  · " + info : ""}`); if (!ok) fails++; };
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };

// stand-in Stripe: checkout returns a page on this server; that page "pays" by sending the signed webhooks, then
// sends the browser to success_url, like the real Checkout would.
const calls = [];
let api;
const sendHook = async ev => {
  const raw = JSON.stringify(ev), t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${createHmac("sha256", WHSEC).update(`${t}.${raw}`).digest("hex")}`;
  return (await fetch(API + "/v1/stripe/webhook", { method: "POST", body: raw, headers: { "content-type": "application/json", "stripe-signature": sig } })).status;
};
const stripe = createServer((req, res) => {
  let b = ""; req.on("data", c => b += c); req.on("end", async () => {
    const p = Object.fromEntries(new URLSearchParams(b));
    if (req.url === "/v1/checkout/sessions") {
      calls.push(p); res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ id: "cs_" + calls.length, url: `http://127.0.0.1:${STRIPE_PORT}/pay/${calls.length - 1}` }));
    }
    if (req.url === "/v1/billing_portal/sessions") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ url: `http://127.0.0.1:${STRIPE_PORT}/portal` })); }
    const m = /^\/pay\/(\d+)$/.exec(req.url);
    if (m) {
      const c = calls[+m[1]], uid = c.client_reference_id, now = Math.floor(Date.now() / 1000);
      await sendHook({ id: "evt_a" + m[1], type: "checkout.session.completed", created: now, livemode: false,
        data: { object: { mode: c.mode, payment_status: "paid", client_reference_id: uid, customer: "cus_b", subscription: c.mode === "subscription" ? "sub_b" : null } } });
      if (c.mode === "subscription") await sendHook({ id: "evt_b" + m[1], type: "customer.subscription.created", created: now, livemode: false,
        data: { object: { id: "sub_b", customer: "cus_b", status: "active", metadata: { user_id: uid }, cancel_at_period_end: false,
          items: { data: [{ current_period_end: now + 86400 * 365, price: { recurring: { interval: c["line_items[0][price_data][recurring][interval]"] } } }] } } } });
      res.writeHead(302, { location: c.success_url }); return res.end();
    }
    if (req.url === "/portal") { res.setHeader("content-type", "text/html"); return res.end("<h1>Stripe portal stand-in</h1>"); }
    res.statusCode = 404; res.end("{}");
  });
}).listen(STRIPE_PORT, "127.0.0.1");

execFileSync(WR, ["d1", "execute", "clipmachine", "--local", "--env", "dev", "--persist-to", persist, "--file", "schema.sql"], { cwd: SERVER, stdio: "ignore", env });
api = spawn(WR, ["dev", "--local", "--env", "dev", "--port", String(API_PORT), "--ip", "127.0.0.1", "--persist-to", persist, "--show-interactive-dev-session=false",
  "--var", "STRIPE_SECRET_KEY:sk_test_browser", "--var", `STRIPE_WEBHOOK_SECRET:${WHSEC}`, "--var", `STRIPE_API:http://127.0.0.1:${STRIPE_PORT}`,
  "--var", `ALLOWED_ORIGINS:http://localhost:${WEB_PORT}`], { cwd: SERVER, stdio: "ignore", env });
const web = spawn(join(REPO, ".venv", "bin", "python"), ["-m", "http.server", String(WEB_PORT), "--bind", "127.0.0.1", "-d", join(REPO, "docs")], { stdio: "ignore" });
const up = async u => { for (let i = 0; i < 120; i++) { try { if ((await fetch(u)).ok) return; } catch {} await new Promise(r => setTimeout(r, 500)); } throw new Error("not up: " + u); };

const browser = await chromium.launch({ channel: "chrome" });
try {
  await up(API + "/v1/health"); await up(WEB);
  const device = async (opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block", ...opts });
    const page = await ctx.newPage(); const errs = [], csp = [];
    page.on("pageerror", e => errs.push(e.message));
    page.on("console", m => { if (/Content Security Policy|Refused to/i.test(m.text())) csp.push(m.text()); });
    return { ctx, page, errs, csp };
  };

  // ---- no API configured: plans visible, nothing to buy, no errors
  const A = await device({ locale: "en-US" });
  await A.page.goto(WEB + "pricing.html"); await A.page.waitForTimeout(500);
  check(await A.page.locator("[data-buy]:disabled").count() === 2, "without payments the buy buttons say they open soon");
  check((await A.page.textContent("[data-sub]")) === "US$30", "yearly USD Supporter shows US$30", await A.page.textContent("[data-sub]"));
  await A.page.click('[data-period="month"]');
  check((await A.page.textContent("[data-sub]")) === "US$3", "monthly shows US$3");
  await A.page.click('[data-cur="cad"]');
  check((await A.page.textContent("[data-sub]")) === "CA$4", "CAD monthly shows CA$4");
  check(A.errs.length === 0 && A.csp.length === 0, "no page errors or CSP violations", (A.errs[0] || A.csp[0] || ""));
  const canadian = await device({ locale: "en-CA" });
  await canadian.page.goto(WEB + "pricing.html"); await canadian.page.waitForTimeout(300);
  check((await canadian.page.textContent("[data-sub]")) === "CA$40", "a Canadian browser defaults to CAD", await canadian.page.textContent("[data-sub]"));
  for (const w of [375, 320]) {
    const P = await device({ viewport: { width: w, height: 800 } });
    await P.page.goto(WEB + "pricing.html");
    const over = await P.page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(over <= 0, `no sideways scroll at ${w}px`, `${over}px`);
    await P.ctx.close();
  }

  // ---- payments on: test-mode banner, sign-in detour, checkout, badge
  const B = await device({ locale: "en-US" });
  await B.page.goto(WEB + "pricing.html");
  await B.page.evaluate(a => localStorage.setItem("clipmachine.api", a), API);
  await B.page.reload(); await B.page.waitForSelector("#pStatus:not([hidden])");
  check(/Test mode/.test(await B.page.textContent("#pStatus")), "test-mode banner shows");
  check(await B.page.locator("[data-buy]:disabled").count() === 0, "buy buttons are live");
  await B.page.click('[data-buy="sub"]');
  await B.page.waitForURL(/workspace\.html/); await B.page.waitForSelector("#acct[open]");
  check(true, "not signed in: Become a supporter opens sign-in in the workspace");
  await B.page.click('[data-mode="signup"]');
  await B.page.fill("#acctEmail", `buyer-${Date.now()}@example.com`); await B.page.fill("#acctPw", "correct horse battery");
  await B.page.click(".acct-go");
  await B.page.waitForURL(/pricing\.html/, { timeout: 15000 });
  check(true, "after signing up it comes back to pricing");
  await B.page.click('[data-buy="sub"]');           // yearly USD is the default
  await B.page.waitForURL(/pricing\.html\?thanks=1/, { timeout: 15000 });
  const c = calls.at(-1);
  check(c.mode === "subscription" && c["line_items[0][price_data][unit_amount]"] === "3000" && c["line_items[0][price_data][recurring][interval]"] === "year",
        "checkout asks Stripe for a US$30 yearly subscription", JSON.stringify([c.mode, c["line_items[0][price_data][unit_amount]"]]));
  check(/Thank you/.test(await B.page.textContent("#pStatus")), "the thank-you message shows after checkout");
  await B.page.goto(WEB + "workspace.html"); await B.page.waitForSelector("#acctBtn:not(.hide)");
  await B.page.click("#acctBtn"); await B.page.waitForSelector("#acctBill:not([hidden])", { timeout: 10000 });
  const bill = await B.page.textContent("#acctBill");
  check(/Supporter/.test(bill) && /yearly/.test(bill) && /Manage billing/.test(bill), "the account shows the Supporter badge and Manage billing", bill.replace(/\s+/g, " ").trim());
  await B.page.click("#acctBillMgr"); await B.page.waitForURL(/\/portal$/);
  check(true, "Manage billing opens Stripe's portal");

  // ---- one-time, custom amount, CAD
  await B.page.goto(WEB + "pricing.html"); await B.page.click('[data-cur="cad"]');
  await B.page.fill("#pCustom", "2");
  check(/from CA\$4/.test(await B.page.textContent("#pErr")), "too small a custom amount is explained");
  await B.page.fill("#pCustom", "12");
  check((await B.page.textContent("[data-once]")) === "CA$12", "the one-time price follows the custom amount");
  await B.page.click('[data-buy="once"]'); await B.page.waitForURL(/thanks=1/, { timeout: 15000 });
  const o = calls.at(-1);
  check(o.mode === "payment" && o["line_items[0][price_data][unit_amount]"] === "1200" && o["line_items[0][price_data][currency]"] === "cad", "one-time checkout asks for CA$12");
  check(B.errs.length === 0 && B.csp.length === 0, "no page errors or CSP violations while buying", (B.errs[0] || B.csp[0] || ""));
} catch (e) { check(false, "pricing flow", e.message.split("\n")[0]); }
finally { await browser.close(); api.kill(); web.kill(); stripe.close(); rmSync(persist, { recursive: true, force: true }); }
console.log(fails ? `${fails} check(s) failed` : "all checks passed");
process.exit(fails ? 1 : 0);
