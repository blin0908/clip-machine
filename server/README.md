# Clip Machine accounts API

Optional accounts for the website and desktop app. An account keeps a user's **presets, last-used settings, brand logo, results log and YouTube Studio import** in sync across devices. **Videos, transcripts and clips never reach this server.** It's a Cloudflare Worker with a D1 (SQLite) database, both on Cloudflare's free tier.

What it stores, and why, is spelled out for users in [`docs/privacy.html`](../docs/privacy.html). Keep that page in step with any change here.

## Endpoints (`/v1`)

| Method | Path | Auth | What it does |
|---|---|---|---|
| GET | `/health` | none | Liveness check (the app hides the account button if this fails) |
| POST | `/signup` | none | `{email, password}` → `{token, user}` (201). 5 per network per hour |
| POST | `/login` | none | `{email, password}` → `{token, user}`. 20 per network and 8 per account per 15 min. The message is the same for an unknown email and a wrong password |
| GET | `/me` | bearer | Account, number of active sessions, sync rev |
| POST | `/logout` | bearer | Ends this session; `{everywhere: true}` ends all of them |
| GET | `/sync` | bearer | `{rev, updated, data}` |
| PUT | `/sync` | bearer | `{rev, data}`: writes only if `rev` matches, else 409 with `current` so the client can merge. Only known keys are kept; the logo must be a PNG data URL; 1 MB cap |
| POST | `/password` | bearer | `{current, password}`: changes it and signs out other devices |
| GET | `/export` | bearer | Everything stored about the user (no hashes) |
| DELETE | `/account` | bearer | `{password}`: cancels an active subscription at Stripe first, then deletes the user, their sessions and their synced data |
| GET | `/billing/config` | none | `{enabled, test_mode, currencies}`. The pricing page hides checkout unless `enabled` |
| POST | `/billing/checkout` | bearer | `{currency: "usd"\|"cad", kind: "month"\|"year"\|"once", amount?}` → `{url}` of a Stripe Checkout page. Prices come from `PLANS` in the Worker, never from the client. 10 per account per hour |
| POST | `/billing/portal` | bearer | `{url}` of Stripe's billing portal (change card, cancel) |
| POST | `/stripe/webhook` | Stripe signature | Applies `checkout.session.completed` and `customer.subscription.*`. Checks the HMAC signature and a 5-minute timestamp window, refuses test/live mismatches, applies each event id once, and ignores subscription events older than the last one applied |

## Pricing and billing

Everything is free. Support is optional and unlocks nothing but a badge (see `docs/pricing.html`):

| | USD | CAD |
|---|---|---|
| Supporter, monthly | $3 | $4 |
| Supporter, yearly (2 months free) | $30 | $40 |
| One-time | any amount from $3 | any amount from $4 |

Prices live in `PLANS` in `src/worker.js` (cents) and are created inline at checkout, so no products need setting up in Stripe. The page reads them from `/billing/config`. Card details stay on Stripe's pages; the database keeps only Stripe's customer/subscription ids and the subscription status.

Billing is off unless both `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are set. A live key (`sk_live_…`) is also refused unless `BILLING_LIVE=1`, so test keys are the default.

## Security model

- **Passwords:** PBKDF2-SHA256, 100,000 iterations (the most Workers allows), with a 16-byte random salt per user. A login for an unknown email still runs a full hash, so response time doesn't reveal which emails exist. Minimum 10 characters, and obvious ones are refused.
- **Sessions:** a 256-bit random token, sent as `Authorization: Bearer`. Only its SHA-256 is stored, and it lasts 60 days. Bearer tokens, not cookies, because the site (github.io) and the API (workers.dev) are different sites and browsers block third-party cookies. They also make CSRF impossible. The token sits in the page's localStorage, which is why the site ships a strict Content-Security-Policy (no inline or third-party scripts apart from pinned jsDelivr files).
- **CORS:** only the origins in `ALLOWED_ORIGINS` (plus any localhost port when `DEV_ORIGINS=1`) get CORS headers. Browser requests from any other origin get a 403.
- **Rate limits** live in D1 under hashed keys (no raw IPs or emails) and are pruned after a day.
- **Every response** carries `cache-control: no-store`, `nosniff`, `no-referrer`, HSTS and `default-src 'none'`.
- **Not built yet:** email verification and password reset, because we don't send email. Adding them needs an email provider (for example Resend or Postmark) and a decision from Benny. Also missing: 2FA, and Cloudflare Turnstile on sign-up if bots show up.

## Run it locally

```bash
cd server
npm install
# Apple Silicon: npm sometimes skips workerd's platform binary. If `npx wrangler --version` fails:
#   npm install --no-save @cloudflare/workerd-darwin-arm64@$(node -p "require('./node_modules/workerd/package.json').version")
npx wrangler d1 execute clipmachine --local --env dev --file schema.sql
npx wrangler dev --local --env dev --port 8787
```

Point a local copy of the site at it: open the site on `http://localhost:…`, then in the browser console run `localStorage.setItem("clipmachine.api", "http://127.0.0.1:8787")` and reload. The override only works on localhost.

Tests:
- `npm test`: 18 API tests (5 for billing, against a stand-in Stripe) on a throwaway local database
- `node tests/web-pricing.mjs`: the pricing page and a full Supporter checkout in Chrome, run from the repo root
- `node tests/web-account.mjs`: two-device sync in Chrome, run from the repo root

## Deploy (needs Benny's Cloudflare account)

1. Create a free Cloudflare account at https://dash.cloudflare.com/sign-up (Benny does this, with his own email and password).
2. `cd server && npx wrangler login`. This opens a browser to approve access; Benny approves it.
3. `npx wrangler d1 create clipmachine`. Copy the printed `database_id` into `wrangler.toml` (top-level `[[d1_databases]]`).
4. `npx wrangler d1 execute clipmachine --remote --file schema.sql`
5. `npx wrangler deploy`. This prints the URL, e.g. `https://clip-machine-accounts.<subdomain>.workers.dev`.
6. Check it: `curl https://clip-machine-accounts.<subdomain>.workers.dev/v1/health` should print `{"ok":true}`.
7. Put that URL in `docs/index.html`: `<meta name="cm-api" content="https://clip-machine-accounts.<subdomain>.workers.dev">`. Then push. The account button appears on the site once the API answers.

Also put the same URL in `docs/pricing.html`'s `cm-api` meta.

Until step 7, the site behaves exactly as before: no button, no network calls to the API.

### Switching on payments (test mode first)

Needs a Stripe account owned by Benny (or, if he's under 18, a parent or guardian).
1. In Stripe's dashboard, stay in **Test mode**. Copy the secret key (`sk_test_…`).
2. Developers → Webhooks → add endpoint `https://<worker>/v1/stripe/webhook` with events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. Copy its signing secret (`whsec_…`).
3. `npx wrangler secret put STRIPE_SECRET_KEY` and `npx wrangler secret put STRIPE_WEBHOOK_SECRET`, pasting each when asked.
4. Turn on the customer portal (Settings → Billing → Customer portal) so **Manage billing** works.
5. Buy a Supporter plan on the site with Stripe's test card `4242 4242 4242 4242`. The account menu should show the badge.
6. Going live later: switch Stripe to live mode, repeat steps 1–4 with the live key and secret, and set `BILLING_LIVE = "1"` in `wrangler.toml`. Do that only after deciding refunds and taxes.
