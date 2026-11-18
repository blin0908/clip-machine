// Optional accounts: keep presets, last-used settings, brand logo, results log and the Studio import in sync across
// devices. Videos, transcripts and clips are never sent anywhere. The API address comes from <meta name="cm-api">;
// when it's empty (or unreachable) this whole feature stays hidden and the app works exactly as before.

const SESSION = "clipmachine.session", REV = "clipmachine.syncRev", BASE = "clipmachine.syncHash";
const KEYS = { presets: "clipmachine.presets", last: "clipmachine.last", logo: "clipmachine.logo", log: "clipmachine.log",
               learnMetric: "clipmachine.learnMetric", studio: "clipmachine.studio" };
const PRIVACY = "https://blin0908.github.io/clip-machine/privacy.html";

const meta = document.querySelector('meta[name="cm-api"]')?.content.trim() || "";
const devApi = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? lsGet("clipmachine.api") : null;   // local testing only
const API = (devApi || meta).replace(/\/+$/, "");

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const toast = t => { const el = document.getElementById("toast"); if (!el) return; el.textContent = t; el.classList.add("on"); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("on"), 2600); };
const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + ":" + s.length; };

let session = (() => { try { return JSON.parse(lsGet(SESSION)); } catch { return null; } })();
let state = "idle", lastSync = null, timer = null, busy = false;

// ---------------------------------------------------------------- API
async function api(path, { method = "GET", body } = {}) {
  let r;
  try {
    r = await fetch(API + "/v1" + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(session?.token ? { authorization: "Bearer " + session.token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw Object.assign(new Error("Couldn't reach the account server. Check your connection and try again."), { offline: true }); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && session) signedOut("Your sign-in expired. Sign in again to keep syncing.");
  if (!r.ok) throw Object.assign(new Error(j.error || `The account server answered ${r.status}.`), { status: r.status, current: j.current });
  return j;
}

// ---------------------------------------------------------------- what syncs
function snapshot() {
  const d = {};
  for (const [k, ls] of Object.entries(KEYS)) { const v = lsGet(ls); if (v != null) try { d[k] = JSON.parse(v); } catch {} }
  return d;
}
function apply(d) {                               // write synced values into this browser; returns true if anything changed
  let changed = false;
  for (const [k, ls] of Object.entries(KEYS)) {
    const next = d[k] === undefined ? null : JSON.stringify(d[k]);
    if (next !== lsGet(ls) && next !== null) { lsSet(ls, next); changed = true; }
  }
  return changed;
}
// Merge two copies. Presets join by name and results-log rows join by id (a row deleted on one device can come back
// if the other device had unsynced edits at the same moment; that's preferred to losing a row), so neither device loses work; for the rest,
// `prefer` wins when both sides have a value.
function merge(local, remote, prefer = "remote") {
  const [a, b] = prefer === "remote" ? [local, remote] : [remote, local];   // b wins ties
  const out = { ...a, ...b };
  const byKey = (x, y, key) => {
    if (!Array.isArray(x) || !Array.isArray(y)) return y ?? x;
    const m = new Map(); for (const it of [...x, ...y]) m.set(key(it), it); return [...m.values()];
  };
  const plain = v => v && typeof v === "object" && !Array.isArray(v);
  out.presets = plain(a.presets) && plain(b.presets) ? { ...a.presets, ...b.presets }       // presets: { name: settings }
              : byKey(a.presets, b.presets, p => p?.name ?? JSON.stringify(p));
  out.log = byKey(a.log, b.log, r => r?.id ?? JSON.stringify(r));
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

// ---------------------------------------------------------------- sync
async function pull({ first = false } = {}) {
  const r = await api("/sync");
  const local = snapshot(), localHash = hash(JSON.stringify(local));
  const unsynced = localHash !== lsGet(BASE);
  const merged = first || unsynced ? merge(local, r.data, "remote") : r.data;
  const changed = apply(merged);
  lsSet(REV, String(r.rev));
  if (hash(JSON.stringify(merged)) !== hash(JSON.stringify(r.data)) || r.rev === 0) await push(merged);
  else lsSet(BASE, hash(JSON.stringify(snapshot())));
  lastSync = Date.now(); setState("ok");
  return changed;
}
async function push(data = snapshot(), retry = true) {
  try {
    const r = await api("/sync", { method: "PUT", body: { rev: +(lsGet(REV) || 0), data } });
    lsSet(REV, String(r.rev)); lsSet(BASE, hash(JSON.stringify(snapshot()))); lastSync = Date.now(); setState("ok");
  } catch (e) {
    if (e.status === 409 && e.current && retry) {          // another device saved first: keep both, this device's edits win ties
      const merged = merge(e.current.data, snapshot(), "remote");
      apply(merged); lsSet(REV, String(e.current.rev));
      return push(merged, false);
    }
    setState(e.offline ? "offline" : "error", e.message); throw e;
  }
}
async function tick() {                            // push local edits a few seconds after they happen
  if (!session || busy || document.hidden) return;
  if (hash(JSON.stringify(snapshot())) === lsGet(BASE)) return;
  busy = true; setState("syncing");
  try { await push(); } catch {} finally { busy = false; }
}
function startLoop() { clearInterval(timer); timer = setInterval(tick, 4000); }

// ---------------------------------------------------------------- session
async function signedIn(j) {
  session = { token: j.token, email: j.user.email }; lsSet(SESSION, JSON.stringify(session)); lsSet(REV, "0"); lsSet(BASE, null);
  setState("syncing");
  const changed = await pull({ first: true }).catch(e => { setState("error", e.message); return false; });
  startLoop(); render();
  if (changed) { toast("Signed in. Loading your synced settings…"); setTimeout(() => location.reload(), 700); }
  else toast("Signed in. Your settings will stay in sync.");
}
function signedOut(msg) {
  session = null; clearInterval(timer); [SESSION, REV, BASE].forEach(k => lsSet(k, null));
  setState("idle"); render(); if (msg) toast(msg);
}

// ---------------------------------------------------------------- UI
const btn = document.createElement("button");
btn.className = "acct-btn hide"; btn.type = "button"; btn.id = "acctBtn";
const dlg = document.createElement("dialog");
dlg.id = "acct"; dlg.setAttribute("aria-labelledby", "acctTitle");
document.querySelector(".top .toplink")?.before(btn);
document.body.append(dlg);

function setState(s, msg) { state = s; btn.dataset.state = s; btn.title = msg || ({ ok: "Synced", syncing: "Syncing…", offline: "Offline: changes sync when you're back", error: msg || "Sync problem" }[s] || ""); if (dlg.open && session) paintAccount(); }
function render() {
  btn.classList.remove("hide");
  btn.innerHTML = session
    ? `<span class="acct-av" aria-hidden="true">${esc(session.email[0].toUpperCase())}</span><span class="acct-dot" aria-hidden="true"></span><span class="sr">Account: ${esc(session.email)}</span>`
    : `<span>Sign in</span>`;
  btn.setAttribute("aria-label", session ? `Account and sync (${session.email})` : "Sign in to sync your settings");
}
const field = (id, label, type, auto, extra = "") =>
  `<label class="acct-f" for="${id}"><span>${label}</span><input class="in" id="${id}" name="${id}" type="${type}" autocomplete="${auto}" required ${extra}></label>`;
function paintAuth(mode = "signin") {
  const up = mode === "signup";
  dlg.innerHTML = `<div class="dlg-h"><h2 id="acctTitle">${up ? "Create an account" : "Sign in"}</h2><button class="ib" data-close aria-label="Close"><svg class="i"><use href="#i-x"/></svg></button></div>
    <form class="acct-body" id="acctForm" novalidate>
      <div class="seg" role="tablist" aria-label="Account"><button type="button" role="tab" data-mode="signin" aria-selected="${!up}">Sign in</button><button type="button" role="tab" data-mode="signup" aria-selected="${up}">Create account</button></div>
      <p class="acct-why">Optional. An account keeps your <b>presets, brand logo and results log</b> the same on every device. <b>Your videos never leave your device.</b></p>
      ${field("acctEmail", "Email", "email", "email", 'inputmode="email" maxlength="254"')}
      ${field("acctPw", "Password", "password", up ? "new-password" : "current-password", up ? 'minlength="10" maxlength="200" aria-describedby="acctPwHint"' : 'maxlength="200"')}
      ${up ? `<p class="acct-hint" id="acctPwHint">At least 10 characters. A short sentence works well.</p>` : ""}
      <p class="acct-err" id="acctErr" role="alert" hidden></p>
      <button class="btn pri acct-go" type="submit">${up ? "Create account" : "Sign in"}</button>
      <p class="acct-fine">${up ? `By creating an account you agree to how we handle the little we store: see the <a href="${PRIVACY}" target="_blank" rel="noopener">privacy page</a>. ` : ""}There's no password reset by email yet, so keep your password somewhere safe.</p>
    </form>`;
  dlg.querySelector("#acctEmail").value = dlg.dataset.email || "";
  dlg.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => { dlg.dataset.email = dlg.querySelector("#acctEmail").value; paintAuth(b.dataset.mode); dlg.querySelector("#acctEmail").focus(); });
  dlg.querySelector("#acctForm").onsubmit = async e => {
    e.preventDefault();
    const go = dlg.querySelector(".acct-go"), err = dlg.querySelector("#acctErr");
    const email = dlg.querySelector("#acctEmail").value.trim(), password = dlg.querySelector("#acctPw").value;
    err.hidden = true;
    if (!email || !password) { err.textContent = "Enter your email and a password."; err.hidden = false; return; }
    go.disabled = true; go.textContent = up ? "Creating…" : "Signing in…";
    try { const j = await api(up ? "/signup" : "/login", { method: "POST", body: { email, password } }); dlg.close(); await signedIn(j); }
    catch (x) { err.textContent = x.message; err.hidden = false; go.disabled = false; go.textContent = up ? "Create account" : "Sign in"; }
  };
}
const ago = t => { if (!t) return "not yet"; const s = Math.round((Date.now() - t) / 1000); return s < 10 ? "just now" : s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`; };
function paintAccount() {
  const label = { ok: `Synced ${ago(lastSync)}`, syncing: "Syncing…", offline: "Offline. Changes sync when you're back online.", error: btn.title, idle: "Not synced yet" }[state];
  dlg.innerHTML = `<div class="dlg-h"><h2 id="acctTitle">Account</h2><button class="ib" data-close aria-label="Close"><svg class="i"><use href="#i-x"/></svg></button></div>
    <div class="acct-body">
      <div class="acct-who"><span class="acct-av lg" aria-hidden="true">${esc(session.email[0].toUpperCase())}</span><div><b>${esc(session.email)}</b><span class="acct-st" data-state="${state}">${esc(label)}</span></div></div>
      <p class="acct-why">Syncing: presets, last-used settings, brand logo, results log and your YouTube Studio import. <b>Videos, transcripts and clips stay on this device.</b></p>
      <div class="acct-row"><button class="btn" id="acctSync">Sync now</button><button class="btn" id="acctExport">Download my data</button><button class="btn" id="acctOut">Sign out</button></div>
      <details class="acct-more"><summary>Change password</summary>
        <form id="acctPwForm" novalidate>${field("acctCur", "Current password", "password", "current-password")}${field("acctNew", "New password", "password", "new-password", 'minlength="10"')}
        <p class="acct-err" id="acctPwErr" role="alert" hidden></p><button class="btn" type="submit">Change password</button>
        <p class="acct-fine">Other devices are signed out when you change it.</p></form></details>
      <details class="acct-more"><summary>Sign out everywhere</summary><p class="acct-fine">Ends every session on every device, including this one.</p><button class="btn" id="acctOutAll">Sign out on all devices</button></details>
      <details class="acct-more danger"><summary>Delete account</summary>
        <form id="acctDelForm" novalidate><p class="acct-fine">Deletes your account and everything synced from our server, right away. Settings already in this browser stay here. This can't be undone.</p>
        ${field("acctDelPw", "Password", "password", "current-password")}<p class="acct-err" id="acctDelErr" role="alert" hidden></p><button class="btn danger" type="submit">Delete my account</button></form></details>
      <p class="acct-fine"><a href="${PRIVACY}" target="_blank" rel="noopener">What we store and why</a></p>
    </div>`;
  const $ = s => dlg.querySelector(s);
  $("#acctSync").onclick = async () => { setState("syncing"); try { const ch = await pull(); if (ch) { toast("Updated from your other devices. Reloading…"); setTimeout(() => location.reload(), 700); } else toast("Everything is in sync."); } catch (e) { toast(e.message); } };
  $("#acctExport").onclick = async () => {
    try { const j = await api("/export"); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(j, null, 2)], { type: "application/json" }));
          a.download = "clip-machine-account.json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 30000); } catch (e) { toast(e.message); } };
  $("#acctOut").onclick = async () => { await api("/logout", { method: "POST", body: {} }).catch(() => {}); dlg.close(); signedOut("Signed out. Your settings stay in this browser."); };
  $("#acctOutAll").onclick = async () => { try { await api("/logout", { method: "POST", body: { everywhere: true } }); dlg.close(); signedOut("Signed out on every device."); } catch (e) { toast(e.message); } };
  $("#acctPwForm").onsubmit = async e => { e.preventDefault(); const er = $("#acctPwErr"); er.hidden = true;
    try { await api("/password", { method: "POST", body: { current: $("#acctCur").value, password: $("#acctNew").value } }); toast("Password changed. Other devices were signed out."); paintAccount(); }
    catch (x) { er.textContent = x.message; er.hidden = false; } };
  $("#acctDelForm").onsubmit = async e => { e.preventDefault(); const er = $("#acctDelErr"); er.hidden = true;
    if (!confirm("Delete your Clip Machine account and all synced data? This can't be undone.")) return;
    try { await api("/account", { method: "DELETE", body: { password: $("#acctDelPw").value } }); dlg.close(); signedOut("Account deleted. Nothing about you is left on our server."); }
    catch (x) { er.textContent = x.message; er.hidden = false; } };
}
dlg.addEventListener("click", e => { if (e.target.closest("[data-close]") || e.target === dlg) dlg.close(); });
btn.onclick = () => { session ? paintAccount() : paintAuth(); dlg.showModal(); (dlg.querySelector("#acctEmail") || dlg.querySelector("#acctSync"))?.focus(); };
addEventListener("visibilitychange", () => { if (document.hidden) tick(); });
addEventListener("pagehide", () => tick());

// ---------------------------------------------------------------- start
(async () => {
  if (!API) return;                                 // accounts not configured for this copy of the app
  try { await fetch(API + "/v1/health", { cache: "no-store" }).then(r => { if (!r.ok) throw 0; }); } catch { return; }   // server unreachable: stay hidden
  render();
  if (!session) return;
  setState("syncing"); startLoop();
  try {
    const changed = await pull();
    if (changed && !sessionStorage.getItem("cm.syncReload")) { sessionStorage.setItem("cm.syncReload", "1"); location.reload(); }
    else sessionStorage.removeItem("cm.syncReload");
  } catch {}
})();
