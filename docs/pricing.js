// Pricing page: shows the plans, and starts a Stripe Checkout through the accounts API when payments are switched on.
// Prices shown here are only a display default; the server decides what's charged (see server/src/worker.js PLANS).

const DEFAULT = { usd: { month: 300, year: 3000, oneMin: 300 }, cad: { month: 400, year: 4000, oneMin: 400 } };
const SYM = { usd: "US$", cad: "CA$" };
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

const meta = document.querySelector('meta[name="cm-api"]')?.content.trim() || "";
const devApi = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? ls.get("clipmachine.api") : null;
const API = (devApi || meta).replace(/\/+$/, "");
const session = (() => { try { return JSON.parse(ls.get("clipmachine.session")); } catch { return null; } })();

let plans = DEFAULT, live = false, period = "year", amount = 10;
let cur = ls.get("clipmachine.currency") || (/-CA$/i.test(navigator.language || "") ? "cad" : "usd");
if (!DEFAULT[cur]) cur = "usd";

const money = (cents, c = cur, plain = false) => {
  const v = cents / 100, s = Number.isInteger(v) ? String(v) : v.toFixed(2);
  return (plain ? "$" : SYM[c]) + s;
};

function paint() {
  const p = plans[cur];
  $$("[data-period]").forEach(b => b.setAttribute("aria-checked", String(b.dataset.period === period)));
  $$("[data-cur]").forEach(b => b.setAttribute("aria-checked", String(b.dataset.cur === cur)));
  $("[data-free]").textContent = money(0, cur, true);
  $("[data-sub]").textContent = money(p[period]);
  $("[data-sub-unit]").textContent = period === "year" ? "a year" : "a month";
  $("[data-sub-sub]").textContent = period === "year"
    ? `That's ${money(Math.round(p.year / 12))} a month: two months free compared with monthly.`
    : `Or ${money(p.year)} a year, which gets you two months free.`;
  const min = p.oneMin / 100;
  $$("[data-amt]").forEach(b => { b.textContent = money(+b.dataset.amt * 100, cur, true); b.setAttribute("aria-checked", String(+b.dataset.amt === amount && !$("#pCustom").value)); });
  $("#pCustom").min = String(min);
  $("[data-once]").textContent = money(Math.round(amount * 100));
}

function status(text, kind = "") { const el = $("#pStatus"); el.textContent = text; el.dataset.kind = kind; el.hidden = !text; }
function err(text) { const el = $("#pErr"); el.textContent = text || ""; el.hidden = !text; }

function setBuyable(on) {
  $$("[data-buy]").forEach(b => {
    b.disabled = !on;
    if (!on) b.textContent = "Opens soon";
  });
}

async function api(path, body) {
  const r = await fetch(API + "/v1" + path, { method: body ? "POST" : "GET",
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(session?.token ? { authorization: "Bearer " + session.token } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `The server answered ${r.status}.`), { status: r.status });
  return j;
}

async function buy(kind, btn) {
  err("");
  if (!session?.token) { location.assign("workspace.html#signin"); return; }   // sign in (or sign up), then come back here
  const label = btn.innerHTML;
  btn.disabled = true; btn.textContent = "Opening checkout…";
  try {
    const body = kind === "once" ? { currency: cur, kind: "once", amount } : { currency: cur, kind: period };
    location.assign((await api("/billing/checkout", body)).url);
  } catch (e) {
    if (e.status === 401) { location.assign("workspace.html#signin"); return; }
    err(e.message); btn.disabled = false; btn.innerHTML = label;
  }
}

// ---- controls
$$("[data-period]").forEach(b => b.onclick = () => { period = b.dataset.period; paint(); });
$$("[data-cur]").forEach(b => b.onclick = () => { cur = b.dataset.cur; ls.set("clipmachine.currency", cur); paint(); });
$$("[data-amt]").forEach(b => b.onclick = () => { amount = +b.dataset.amt; $("#pCustom").value = ""; err(""); paint(); });
$("#pCustom").oninput = e => {
  const v = Math.round(+e.target.value), min = plans[cur].oneMin / 100;
  if (e.target.value && v >= min && v <= 500) { amount = v; err(""); }
  else if (e.target.value) err(`Pick an amount from ${money(min * 100)} to ${money(50000)}.`);
  paint();
};
$$("[data-buy]").forEach(b => b.onclick = () => buy(b.dataset.buy, b));

// ---- start
paint();
const q = new URLSearchParams(location.search);
if (q.has("thanks")) status("Thank you. Your support is confirmed as soon as Stripe tells us, usually within a few seconds. Your account shows the badge.", "ok");
else if (q.has("canceled")) status("Checkout canceled. Nothing was charged.");
(async () => {
  if (!API) { setBuyable(false); return; }
  try {
    const cfg = await api("/billing/config");
    if (!cfg.enabled) { setBuyable(false); return; }
    if (cfg.currencies) plans = { usd: { ...DEFAULT.usd, ...cfg.currencies.usd }, cad: { ...DEFAULT.cad, ...cfg.currencies.cad } };
    live = !cfg.test_mode;
    if (!live && !q.has("thanks")) status("Test mode: checkout uses Stripe's test cards and nothing is charged.", "test");
    paint();
  } catch { setBuyable(false); }
})();
