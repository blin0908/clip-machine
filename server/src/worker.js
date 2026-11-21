// Clip Machine accounts API (Cloudflare Worker + D1).
//
// What it stores: an email, a password hash, session-token hashes, and one JSON document of settings the web app
// syncs (presets, last-used settings, brand logo, results log, YouTube Studio import). Videos, transcripts and clips
// never reach it. No IP addresses or user agents are stored; rate-limit keys are one-way hashes.
//
// Auth: a random bearer token (the browser keeps it in localStorage and sends `Authorization: Bearer …`). The site
// lives on github.io and the API on workers.dev, and third-party cookies are blocked in Safari and increasingly
// Chrome, so cookies are not an option across those origins. Bearer tokens are also immune to CSRF.

const V = "/v1";
const SESSION_DAYS = 60;
const PBKDF2_ITER = 100_000;              // the most Workers' WebCrypto allows
const MAX_BODY = 1_100_000;               // bytes, request body
const MAX_DATA = 1_000_000;               // bytes, the synced JSON document
const SYNC_KEYS = ["presets", "last", "logo", "log", "learnMetric", "studio"];
const COMMON = new Set(["password", "password1", "password123", "1234567890", "12345678910", "qwertyuiop", "iloveyou12",
  "letmein123", "clipmachine", "passw0rd12", "abc1234567", "0123456789", "qwerty1234", "1q2w3e4r5t", "aaaaaaaaaa"]);

// ---------------------------------------------------------------- helpers
const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const rand = n => crypto.getRandomValues(new Uint8Array(n));
const sha256 = async s => b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));

function eq(a, b) {                       // constant-time compare of two equal-purpose strings
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return b64url(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
}
async function hashPassword(pw) {
  const salt = rand(16);
  return `pbkdf2-sha256$${PBKDF2_ITER}$${b64url(salt)}$${await pbkdf2(pw, salt, PBKDF2_ITER)}`;
}
async function checkPassword(pw, stored) {
  const [alg, iter, salt, hash] = String(stored).split("$");
  if (alg !== "pbkdf2-sha256" || !hash) return false;
  return eq(await pbkdf2(pw, unb64url(salt), Math.min(+iter || PBKDF2_ITER, PBKDF2_ITER)), hash);
}
// Same work for an unknown email, so response time doesn't reveal which emails have accounts.
const DUMMY = "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

class Fail extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

function originOK(origin, env) {
  if (!origin) return false;
  const list = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (list.includes(origin)) return true;
  return env.DEV_ORIGINS === "1" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin);
}

function headers(origin, env, extra = {}) {
  const h = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "cross-origin-resource-policy": "cross-origin",
    vary: "Origin",
    ...extra,
  };
  if (originOK(origin, env)) {
    h["access-control-allow-origin"] = origin;
    h["access-control-allow-headers"] = "authorization, content-type";
    h["access-control-allow-methods"] = "GET, POST, PUT, DELETE, OPTIONS";
    h["access-control-max-age"] = "600";
  }
  return h;
}
const json = (body, status, origin, env) => new Response(JSON.stringify(body), { status, headers: headers(origin, env) });

const TOO_BIG = "That's too much data to save. Remove some old results or a large logo and try again.";
async function body(req) {
  const len = +req.headers.get("content-length") || 0;
  if (len > MAX_BODY) throw new Fail(413, TOO_BIG);
  if (!/^application\/json\b/i.test(req.headers.get("content-type") || "")) throw new Fail(415, "Send JSON.");
  // read at most MAX_BODY bytes, even when Content-Length is missing or wrong (chunked uploads)
  const parts = [];
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel().catch(() => {}); throw new Fail(413, TOO_BIG); }
      parts.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.byteLength; }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Fail(400, "The request wasn't valid JSON."); }
  try { const v = JSON.parse(text); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch {}
  throw new Fail(400, "The request wasn't valid JSON.");
}

function cleanEmail(e) {
  const s = String(e || "").trim().toLowerCase();
  if (s.length > 254 || !/^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]{2,}$/.test(s)) throw new Fail(400, "Enter a valid email address.");
  return s;
}
function cleanPassword(pw, email) {
  const s = String(pw ?? "");
  if (s.length < 10) throw new Fail(400, "Use a password of at least 10 characters.");
  if (s.length > 200) throw new Fail(400, "Use a password of 200 characters or fewer.");
  const low = s.toLowerCase();
  if (COMMON.has(low) || (email && low === email) || (email && low === email.split("@")[0]) || /^(.)\1+$/.test(s))
    throw new Fail(400, "That password is too easy to guess. Try a short sentence or a few random words.");
  return s;
}

// ---------------------------------------------------------------- rate limiting
async function limit(env, key, max, windowSec, message) {
  const k = await sha256("rl:" + key), t = now();
  // one statement, so the count and the insert can't interleave with a parallel request (D1 runs each statement atomically)
  const r = await env.DB.prepare(
    "INSERT INTO attempts (k, at) SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM attempts WHERE k = ?1 AND at > ?3) < ?4")
    .bind(k, t, t - windowSec, max).run();
  if (!r.meta || !r.meta.changes) throw new Fail(429, message);
  if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM attempts WHERE at < ?").bind(t - 86400).run();
}
const ipOf = req => req.headers.get("cf-connecting-ip") || "local";

// ---------------------------------------------------------------- sessions
async function newSession(env, userId) {
  const token = b64url(rand(32)), t = now();
  await env.DB.prepare("INSERT INTO sessions (token, user_id, created, expires, last_seen) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256(token), userId, t, t + SESSION_DAYS * 86400, t).run();
  return token;
}
async function authed(req, env) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.get("authorization") || "");
  if (!m) throw new Fail(401, "Sign in to continue.");
  const th = await sha256(m[1]), t = now();
  const row = await env.DB.prepare(
    "SELECT s.token, s.user_id, s.expires, s.last_seen, u.email, u.created FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?")
    .bind(th).first();
  if (!row || row.expires < t) {
    if (row) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(th).run();
    throw new Fail(401, "Your sign-in expired. Sign in again.");
  }
  if (t - row.last_seen > 3600) await env.DB.prepare("UPDATE sessions SET last_seen = ? WHERE token = ?").bind(t, th).run();
  return { id: row.user_id, email: row.email, created: row.created, token: th };
}

// ---------------------------------------------------------------- sync document
function cleanData(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Fail(400, "Sync data must be an object.");
  const out = {};
  for (const k of SYNC_KEYS) if (d[k] !== undefined && d[k] !== null) out[k] = d[k];
  if (typeof out.logo === "string" && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(out.logo))
    throw new Fail(400, "The brand logo must be a PNG.");
  const text = JSON.stringify(out);
  if (enc.encode(text).length > MAX_DATA)
    throw new Fail(413, "Your synced settings are over 1 MB. Use a smaller logo or clear old results, then sync again.");
  return text;
}
async function getData(env, userId) {
  const row = await env.DB.prepare("SELECT data, rev, updated FROM user_data WHERE user_id = ?").bind(userId).first();
  return row ? { rev: row.rev, updated: row.updated, data: JSON.parse(row.data) } : { rev: 0, updated: null, data: {} };
}

// ---------------------------------------------------------------- routes
async function route(req, env, url) {
  const p = url.pathname, m = req.method;

  if (p === `${V}/health` && m === "GET") return { ok: true };

  if (p === `${V}/signup` && m === "POST") {
    await limit(env, "signup:" + ipOf(req), 5, 3600, "Too many new accounts from this network. Try again in an hour.");
    const b = await body(req);
    const email = cleanEmail(b.email), pw = cleanPassword(b.password, email);
    const exists = await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first();
    if (exists) throw new Fail(409, "There's already an account with that email. Sign in instead.");
    const id = b64url(rand(16)), t = now();
    await env.DB.prepare("INSERT INTO users (id, email, pw, created) VALUES (?, ?, ?, ?)").bind(id, email, await hashPassword(pw), t).run();
    return { status: 201, body: { token: await newSession(env, id), user: { email, created: t } } };
  }

  if (p === `${V}/login` && m === "POST") {
    const b = await body(req);
    const email = String(b.email || "").trim().toLowerCase().slice(0, 254), pw = String(b.password ?? "").slice(0, 200);
    await limit(env, "login-ip:" + ipOf(req), 20, 900, "Too many sign-in attempts. Wait 15 minutes and try again.");
    await limit(env, "login-email:" + email, 8, 900, "Too many sign-in attempts for this account. Wait 15 minutes and try again.");
    const u = await env.DB.prepare("SELECT id, pw, created FROM users WHERE email = ?").bind(email).first();
    const ok = await checkPassword(pw, u ? u.pw : DUMMY);
    if (!u || !ok) throw new Fail(401, "That email and password don't match an account.");
    return { token: await newSession(env, u.id), user: { email, created: u.created } };
  }

  // everything below needs a signed-in user
  const user = await authed(req, env);

  if (p === `${V}/me` && m === "GET") {
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires > ?").bind(user.id, now()).first();
    const d = await getData(env, user.id);
    return { user: { email: user.email, created: user.created }, sessions: n, sync: { rev: d.rev, updated: d.updated } };
  }

  if (p === `${V}/logout` && m === "POST") {
    const b = await body(req).catch(() => ({}));
    if (b.everywhere) await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id).run();
    else await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(user.token).run();
    return { ok: true };
  }

  if (p === `${V}/sync` && m === "GET") return getData(env, user.id);

  if (p === `${V}/sync` && m === "PUT") {
    const b = await body(req);
    const text = cleanData(b.data), base = Number.isInteger(b.rev) ? b.rev : -1, t = now();
    const cur = await getData(env, user.id);
    if (base !== cur.rev) throw new Fail(409, "These settings changed on another device. Merge and try again.", cur);
    const res = cur.rev === 0
      ? await env.DB.prepare("INSERT OR IGNORE INTO user_data (user_id, data, rev, updated) VALUES (?, ?, 1, ?)").bind(user.id, text, t).run()
      : await env.DB.prepare("UPDATE user_data SET data = ?, rev = rev + 1, updated = ? WHERE user_id = ? AND rev = ?").bind(text, t, user.id, cur.rev).run();
    if (!res.meta.changes) throw new Fail(409, "These settings changed on another device. Merge and try again.", await getData(env, user.id));
    return { rev: cur.rev + 1, updated: t };
  }

  if (p === `${V}/password` && m === "POST") {
    const b = await body(req);
    const u = await env.DB.prepare("SELECT pw FROM users WHERE id = ?").bind(user.id).first();
    if (!(await checkPassword(String(b.current ?? ""), u.pw))) throw new Fail(403, "Your current password isn't right.");
    const pw = cleanPassword(b.password, user.email);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET pw = ? WHERE id = ?").bind(await hashPassword(pw), user.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").bind(user.id, user.token),   // sign out other devices
    ]);
    return { ok: true };
  }

  if (p === `${V}/export` && m === "GET") {
    const d = await getData(env, user.id);
    return { exported: new Date().toISOString(), account: { email: user.email, created: new Date(user.created * 1000).toISOString() },
             synced: d.data, sync_rev: d.rev, note: "This is everything Clip Machine's server stores about you, apart from the password hash and session-token hashes." };
  }

  if (p === `${V}/account` && m === "DELETE") {
    const b = await body(req);
    const u = await env.DB.prepare("SELECT pw FROM users WHERE id = ?").bind(user.id).first();
    if (!(await checkPassword(String(b.password ?? ""), u.pw))) throw new Fail(403, "That password isn't right, so the account wasn't deleted.");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM user_data WHERE user_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
    ]);
    return { ok: true };
  }

  throw new Fail(404, "Not found.");
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get("origin");
    if (req.method === "OPTIONS") return new Response(null, { status: originOK(origin, env) ? 204 : 403, headers: headers(origin, env) });
    // Browsers always send Origin on cross-origin requests; refuse other sites outright (curl/tests without Origin still work).
    if (origin && !originOK(origin, env)) return json({ error: "This site isn't allowed to use the Clip Machine API." }, 403, origin, env);
    try {
      const r = await route(req, env, url);
      return r && r.status && r.body ? json(r.body, r.status, origin, env) : json(r, 200, origin, env);
    } catch (e) {
      if (e instanceof Fail) return json({ error: e.message, ...(e.extra ? { current: e.extra } : {}) }, e.status, origin, env);
      console.error(e);
      return json({ error: "Something went wrong on the server. Try again in a minute." }, 500, origin, env);
    }
  },
};
