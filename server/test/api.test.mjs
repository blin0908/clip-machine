// End-to-end tests for the accounts API against a real local Worker (wrangler dev + local D1 in a temp dir).
//   cd server && npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8800 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}/v1`;
const SITE = "https://blin0908.github.io";
const persist = mkdtempSync(join(tmpdir(), "cm-d1-"));
const WR = join(ROOT, "node_modules", ".bin", "wrangler");
let dev, mock;
// a stand-in for api.stripe.com: records every call and answers like Stripe would
const MOCK_PORT = PORT + 200, WHSEC = "whsec_test_secret";
const stripeCalls = [];
const startMock = () => new Promise(res => {
  mock = createServer((req, r) => {
    let b = ""; req.on("data", c => b += c); req.on("end", () => {
      const params = Object.fromEntries(new URLSearchParams(b));
      stripeCalls.push({ method: req.method, path: req.url, params, auth: req.headers.authorization });
      r.setHeader("content-type", "application/json");
      if (req.url === "/v1/checkout/sessions") return r.end(JSON.stringify({ id: "cs_test_1", url: `http://127.0.0.1:${MOCK_PORT}/pay/cs_test_1` }));
      if (req.url === "/v1/billing_portal/sessions") return r.end(JSON.stringify({ id: "bps_1", url: `http://127.0.0.1:${MOCK_PORT}/portal` }));
      if (req.url.startsWith("/v1/subscriptions/")) return r.end(JSON.stringify({ id: req.url.split("/").pop(), status: "canceled" }));
      r.statusCode = 404; r.end(JSON.stringify({ error: { message: "no such route" } }));
    });
  }).listen(MOCK_PORT, "127.0.0.1", res);
});

before(async () => {
  await startMock();
  execFileSync(WR, ["d1", "execute", "clipmachine", "--local", "--env", "dev", "--persist-to", persist, "--file", "schema.sql"],
               { cwd: ROOT, stdio: "ignore", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  dev = spawn(WR, ["dev", "--local", "--env", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", persist, "--show-interactive-dev-session=false",
                     "--var", "STRIPE_SECRET_KEY:sk_test_mock", "--var", `STRIPE_WEBHOOK_SECRET:${WHSEC}`, "--var", `STRIPE_API:http://127.0.0.1:${MOCK_PORT}`],
              { cwd: ROOT, stdio: "ignore", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE + "/health")).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("wrangler dev didn't start");
});
after(() => { dev?.kill(); mock?.close(); rmSync(persist, { recursive: true, force: true }); });

let ipN = 0;   // each signup comes from its own (pretend) address so the per-network signup limit doesn't trip
const call = async (path, { method = "GET", body, token, origin = SITE, raw, ip } = {}) => {
  const h = { "cf-connecting-ip": ip || (path === "/signup" ? `10.0.0.${++ipN}` : "10.9.9.9") };
  if (origin) h.origin = origin;
  if (token) h.authorization = "Bearer " + token;
  if (body !== undefined) h["content-type"] = "application/json";
  const r = await fetch(BASE + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  return { status: r.status, h: r.headers, j: await r.json().catch(() => null) };
};
const email = n => `user${n}-${Date.now()}@example.com`;
const PW = "correct horse battery";

test("signup → me → logout; token is single-use after logout", async () => {
  const e = email(1);
  const s = await call("/signup", { method: "POST", body: { email: e.toUpperCase(), password: PW } });
  assert.equal(s.status, 201);
  assert.match(s.j.token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(s.j.user.email, e, "email stored lower-case");
  const me = await call("/me", { token: s.j.token });
  assert.equal(me.status, 200); assert.equal(me.j.user.email, e); assert.equal(me.j.sessions, 1);
  assert.equal((await call("/logout", { method: "POST", body: {}, token: s.j.token })).status, 200);
  assert.equal((await call("/me", { token: s.j.token })).status, 401);
});

test("signup rejects bad email, short/common password, and duplicates", async () => {
  assert.equal((await call("/signup", { method: "POST", body: { email: "nope", password: PW } })).status, 400);
  assert.match((await call("/signup", { method: "POST", body: { email: email(2), password: "short" } })).j.error, /10 characters/);
  assert.match((await call("/signup", { method: "POST", body: { email: email(3), password: "password123" } })).j.error, /easy to guess/);
  const e = email(4);
  assert.equal((await call("/signup", { method: "POST", body: { email: e, password: PW } })).status, 201);
  assert.equal((await call("/signup", { method: "POST", body: { email: e, password: PW } })).status, 409);
});

test("login: same message for unknown email and wrong password; right password works", async () => {
  const e = email(5);
  await call("/signup", { method: "POST", body: { email: e, password: PW } });
  const wrong = await call("/login", { method: "POST", body: { email: e, password: "wrong password!!" } });
  const unknown = await call("/login", { method: "POST", body: { email: "ghost-" + e, password: PW } });
  assert.equal(wrong.status, 401); assert.equal(unknown.status, 401);
  assert.equal(wrong.j.error, unknown.j.error, "no account enumeration through login");
  const ok = await call("/login", { method: "POST", body: { email: e, password: PW } });
  assert.equal(ok.status, 200); assert.ok(ok.j.token);
});

test("login is rate limited per account", async () => {
  const e = email(6);
  await call("/signup", { method: "POST", body: { email: e, password: PW } });
  let last;
  for (let i = 0; i < 9; i++) last = await call("/login", { method: "POST", body: { email: e, password: "nope nope nope" } });
  assert.equal(last.status, 429);
  assert.match(last.j.error, /15 minutes/);
});

test("signup is rate limited per network", async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await call("/signup", { method: "POST", ip: "10.7.7.7", body: { email: email(100 + i), password: PW } });
  assert.equal(last.status, 429);
  assert.match(last.j.error, /an hour/);
});

test("sync: empty → put → get; stale rev is a 409 with the current copy", async () => {
  const { j } = await call("/signup", { method: "POST", body: { email: email(7), password: PW } });
  const t = j.token;
  const g0 = await call("/sync", { token: t });
  assert.deepEqual(g0.j, { rev: 0, updated: null, data: {} });
  const data = { presets: [{ name: "Podcast", o: { n: 3 } }], last: { n: 5 }, junk: "dropped", logo: "data:image/png;base64,iVBORw0KGgo=" };
  const p1 = await call("/sync", { method: "PUT", token: t, body: { rev: 0, data } });
  assert.equal(p1.status, 200); assert.equal(p1.j.rev, 1);
  const g1 = await call("/sync", { token: t });
  assert.equal(g1.j.rev, 1); assert.equal(g1.j.data.junk, undefined, "unknown keys are not stored");
  assert.equal(g1.j.data.presets[0].name, "Podcast");
  const stale = await call("/sync", { method: "PUT", token: t, body: { rev: 0, data: { last: { n: 1 } } } });
  assert.equal(stale.status, 409); assert.equal(stale.j.current.rev, 1); assert.equal(stale.j.current.data.last.n, 5);
});

test("sync rejects a non-PNG logo and an oversized document", async () => {
  const { j } = await call("/signup", { method: "POST", body: { email: email(8), password: PW } });
  const svg = await call("/sync", { method: "PUT", token: j.token, body: { rev: 0, data: { logo: "data:image/svg+xml;base64,PHN2Zz4=" } } });
  assert.equal(svg.status, 400);
  const big = await call("/sync", { method: "PUT", token: j.token, body: { rev: 0, data: { log: "x".repeat(1_050_000) } } });
  assert.equal(big.status, 413);
});

test("the other user's data is never visible", async () => {
  const a = (await call("/signup", { method: "POST", body: { email: email(9), password: PW } })).j.token;
  const b = (await call("/signup", { method: "POST", body: { email: email(10), password: PW } })).j.token;
  await call("/sync", { method: "PUT", token: a, body: { rev: 0, data: { last: { secret: "A" } } } });
  const gb = await call("/sync", { token: b });
  assert.deepEqual(gb.j.data, {});
});

test("password change signs out other devices; export; delete needs the password and removes everything", async () => {
  const e = email(11);
  const t1 = (await call("/signup", { method: "POST", body: { email: e, password: PW } })).j.token;
  const t2 = (await call("/login", { method: "POST", body: { email: e, password: PW } })).j.token;
  await call("/sync", { method: "PUT", token: t1, body: { rev: 0, data: { last: { n: 8 } } } });
  assert.equal((await call("/password", { method: "POST", token: t1, body: { current: "bad", password: "a new long pass" } })).status, 403);
  assert.equal((await call("/password", { method: "POST", token: t1, body: { current: PW, password: "a new long pass" } })).status, 200);
  assert.equal((await call("/me", { token: t2 })).status, 401, "other device signed out");
  assert.equal((await call("/me", { token: t1 })).status, 200, "this device stays signed in");
  const ex = await call("/export", { token: t1 });
  assert.equal(ex.j.account.email, e); assert.equal(ex.j.synced.last.n, 8); assert.equal(JSON.stringify(ex.j).includes("pbkdf2"), false);
  assert.equal((await call("/account", { method: "DELETE", token: t1, body: { password: PW } })).status, 403);
  assert.equal((await call("/account", { method: "DELETE", token: t1, body: { password: "a new long pass" } })).status, 200);
  assert.equal((await call("/me", { token: t1 })).status, 401);
  assert.equal((await call("/login", { method: "POST", body: { email: e, password: "a new long pass" } })).status, 401);
});

test("CORS: allowed origin echoed, other sites refused, preflight works", async () => {
  const ok = await call("/health", {});
  assert.equal(ok.h.get("access-control-allow-origin"), SITE);
  const local = await call("/health", { origin: "http://localhost:8765" });
  assert.equal(local.h.get("access-control-allow-origin"), "http://localhost:8765");
  const evil = await call("/health", { origin: "https://evil.example" });
  assert.equal(evil.status, 403); assert.equal(evil.h.get("access-control-allow-origin"), null);
  const pre = await fetch(BASE + "/sync", { method: "OPTIONS", headers: { origin: SITE, "access-control-request-method": "PUT" } });
  assert.equal(pre.status, 204); assert.match(pre.headers.get("access-control-allow-headers"), /authorization/);
  assert.equal(ok.h.get("cache-control"), "no-store"); assert.equal(ok.h.get("x-content-type-options"), "nosniff");
});

test("bad requests: no token, junk token, non-JSON, unknown route", async () => {
  assert.equal((await call("/me", {})).status, 401);
  assert.equal((await call("/me", { token: "x".repeat(43) })).status, 401);
  const r = await fetch(BASE + "/signup", { method: "POST", headers: { origin: SITE, "content-type": "text/plain" }, body: "hi" });
  assert.equal(r.status, 415);
  assert.equal((await call("/signup", { method: "POST", raw: "{not json", body: undefined })).status, 415);
  const t = (await call("/signup", { method: "POST", body: { email: email(12), password: PW } })).j.token;
  assert.equal((await call("/nope", { token: t })).status, 404);
});

test("rate limits hold under a parallel burst (count and insert are one statement)", async () => {
  const ip = "10.77.0.1";
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    call("/signup", { method: "POST", ip, body: { email: email("burst" + i), password: PW } })));
  assert.equal(rs.filter(r => r.status === 201).length, 5, rs.map(r => r.status).join(","));
  assert.equal(rs.filter(r => r.status === 429).length, 7);
});

test("a body with no Content-Length is cut off at the cap", async () => {
  const chunk = new Uint8Array(64 * 1024).fill(32);   // spaces: valid JSON padding
  let sent = 0;
  const stream = new ReadableStream({ pull(c) { if (sent >= 2 * 1024 * 1024) return c.close(); sent += chunk.length; c.enqueue(chunk); } });
  const r = await fetch(BASE + "/login", { method: "POST", body: stream, duplex: "half",
    headers: { origin: SITE, "content-type": "application/json", "cf-connecting-ip": "10.78.0.1" } });
  assert.equal(r.status, 413);
  assert.equal(r.headers.get("access-control-allow-origin"), SITE);
});


// ---------------------------------------------------------------- billing
const sign = (payload, t = Math.floor(Date.now() / 1000), secret = WHSEC) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
const hook = async (ev, sig) => {
  const raw = JSON.stringify(ev);
  const r = await fetch(BASE + "/stripe/webhook", { method: "POST", body: raw, headers: { "content-type": "application/json", "stripe-signature": sig ?? sign(raw) } });
  return { status: r.status, j: await r.json().catch(() => null) };
};
let evN = 0;
const event = (type, object, created = Math.floor(Date.now() / 1000)) => ({ id: `evt_${Date.now()}_${++evN}`, type, created, livemode: false, data: { object } });
const signup = async n => (await call("/signup", { method: "POST", body: { email: email(n), password: PW } })).j.token;

test("billing config: test mode, prices in cents", async () => {
  const c = await call("/billing/config");
  assert.equal(c.status, 200); assert.equal(c.j.enabled, true); assert.equal(c.j.test_mode, true);
  assert.equal(c.j.currencies.usd.month, 300); assert.equal(c.j.currencies.cad.year, 4000);
});

test("checkout: validates the choice, builds the right Stripe session, never trusts a client price", async () => {
  const token = await signup("pay1");
  assert.equal((await call("/billing/checkout", { method: "POST", token, body: { currency: "eur", kind: "month" } })).status, 400);
  assert.equal((await call("/billing/checkout", { method: "POST", token, body: { currency: "usd", kind: "weekly" } })).status, 400);
  assert.equal((await call("/billing/checkout", { method: "POST", token, body: { currency: "usd", kind: "once", amount: 1 } })).status, 400);
  assert.equal((await call("/billing/checkout", { method: "POST", body: { currency: "usd", kind: "month" } })).status, 401);
  const r = await call("/billing/checkout", { method: "POST", token, body: { currency: "usd", kind: "month", unit_amount: 1 } });
  assert.equal(r.status, 200); assert.match(r.j.url, /\/pay\/cs_test_1$/);
  const c = stripeCalls.at(-1);
  assert.equal(c.auth, "Bearer sk_test_mock");
  assert.equal(c.params.mode, "subscription");
  assert.equal(c.params["line_items[0][price_data][unit_amount]"], "300");
  assert.equal(c.params["line_items[0][price_data][recurring][interval]"], "month");
  assert.match(c.params.customer_email, /^userpay1-/);
  assert.equal(c.params.success_url, "https://blin0908.github.io/clip-machine/pricing.html?thanks=1");
  assert.ok(c.params.client_reference_id && c.params.client_reference_id === c.params["subscription_data[metadata][user_id]"]);
  const once = await call("/billing/checkout", { method: "POST", token, body: { currency: "cad", kind: "once", amount: 12.5 } });
  assert.equal(once.status, 200);
  assert.equal(stripeCalls.at(-1).params.mode, "payment");
  assert.equal(stripeCalls.at(-1).params["line_items[0][price_data][unit_amount]"], "1250");
  assert.equal(stripeCalls.at(-1).params["line_items[0][price_data][currency]"], "cad");
});

test("webhook: signature, freshness and mode are checked; events apply once and in order", async () => {
  const token = await signup("pay2");
  await call("/billing/checkout", { method: "POST", token, body: { currency: "usd", kind: "year" } });
  const uid = stripeCalls.at(-1).params.client_reference_id;
  const done = event("checkout.session.completed", { mode: "subscription", payment_status: "paid", client_reference_id: uid, customer: "cus_2", subscription: "sub_2" });
  const raw = JSON.stringify(done);
  assert.equal((await hook(done, "t=1,v1=deadbeef")).status, 400, "bad signature");
  assert.equal((await hook(done, sign(raw, Math.floor(Date.now() / 1000) - 900))).status, 400, "old timestamp");
  assert.equal((await hook(done, sign(raw, undefined, "whsec_wrong"))).status, 400, "wrong secret");
  assert.equal((await hook({ ...done, livemode: true })).status, 400, "live event on a test key");
  assert.equal((await hook(done)).status, 200);
  assert.equal((await hook(done)).j.duplicate, true, "a retried delivery is ignored");
  const t0 = Math.floor(Date.now() / 1000);
  const sub = (status, extra = {}) => ({ id: "sub_2", customer: "cus_2", status, cancel_at_period_end: false, metadata: { user_id: uid },
    items: { data: [{ current_period_end: t0 + 365 * 86400, price: { recurring: { interval: "year" } } }] }, ...extra });
  assert.equal((await hook(event("customer.subscription.updated", sub("active"), t0))).status, 200);
  let me = (await call("/me", { token })).j.billing;
  assert.equal(me.supporter, true); assert.equal(me.subscription.status, "active"); assert.equal(me.subscription.interval, "year");
  assert.equal(me.subscription.renews, t0 + 365 * 86400); assert.equal(me.manage, true);
  // an older "incomplete" event arriving late must not undo the newer "active" one
  await hook(event("customer.subscription.updated", sub("incomplete"), t0 - 60));
  assert.equal((await call("/me", { token })).j.billing.subscription.status, "active");
  // a second subscription is refused while one is active
  assert.equal((await call("/billing/checkout", { method: "POST", token, body: { currency: "usd", kind: "month" } })).status, 409);
  // cancel at period end, then deleted: no longer subscribed, still remembered as a backer
  await hook(event("customer.subscription.updated", sub("active", { cancel_at_period_end: true }), t0 + 1));
  assert.equal((await call("/me", { token })).j.billing.subscription.cancel_at_period_end, true);
  await hook(event("customer.subscription.deleted", sub("canceled"), t0 + 2));
  me = (await call("/me", { token })).j.billing;
  assert.equal(me.subscription.status, "canceled"); assert.equal(me.backer, true);
});

test("one-time support marks a backer; events with no matching user are ignored", async () => {
  const token = await signup("pay3");
  await call("/billing/checkout", { method: "POST", token, body: { currency: "usd", kind: "once", amount: 5 } });
  const uid = stripeCalls.at(-1).params.client_reference_id;
  assert.equal((await call("/me", { token })).j.billing.supporter, false);
  await hook(event("checkout.session.completed", { mode: "payment", payment_status: "unpaid", client_reference_id: uid, customer: "cus_3" }));
  assert.equal((await call("/me", { token })).j.billing.backer, false, "an unpaid (delayed) payment isn't counted yet");
  await hook(event("checkout.session.completed", { mode: "payment", payment_status: "paid", client_reference_id: uid, customer: "cus_3" }));
  const b = (await call("/me", { token })).j.billing;
  assert.equal(b.backer, true); assert.equal(b.supporter, true); assert.equal(b.subscription, null);
  assert.equal((await hook(event("customer.subscription.updated", { id: "sub_x", customer: "cus_nobody", status: "active" }))).status, 200);
});

test("billing portal needs a Stripe customer; deleting an account cancels its subscription first", async () => {
  const token = await signup("pay4");
  assert.equal((await call("/billing/portal", { method: "POST", token, body: {} })).status, 404);
  await call("/billing/checkout", { method: "POST", token, body: { currency: "cad", kind: "month" } });
  const uid = stripeCalls.at(-1).params.client_reference_id;
  await hook(event("checkout.session.completed", { mode: "subscription", payment_status: "paid", client_reference_id: uid, customer: "cus_4", subscription: "sub_4" }));
  await hook(event("customer.subscription.created", { id: "sub_4", customer: "cus_4", status: "active", metadata: { user_id: uid },
    items: { data: [{ current_period_end: 2e9, price: { recurring: { interval: "month" } } }] } }));
  const portal = await call("/billing/portal", { method: "POST", token, body: {} });
  assert.equal(portal.status, 200); assert.equal(stripeCalls.at(-1).params.customer, "cus_4");
  const del = await call("/account", { method: "DELETE", token, body: { password: PW } });
  assert.equal(del.status, 200);
  assert.ok(stripeCalls.some(c => c.method === "DELETE" && c.path === "/v1/subscriptions/sub_4"), "subscription canceled at Stripe");
});
