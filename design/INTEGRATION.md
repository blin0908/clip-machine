# Homepage integration handoff

This is a working standalone homepage preview at `design/homepage/index.html`, not a deployed change or an app screenshot. It uses the current palette/fonts and Benny’s selected A / Peak window outlined lockup. Its moving process diagram is explicitly labelled an illustration; it contains no fabricated metrics, testimonials or app captures.

## Safe current preview

Serve the repository root on a localhost-only port, then open `/design/homepage/`. All three Try it out links resolve to `/docs/index.html`, the actual unchanged app in this checkout. Click-to-scroll anchors use native smooth scrolling; people can interrupt it normally. Pause motion, reduced motion, keyboard focus, skip navigation, responsive layout and document-hidden animation pausing are included. No autoplay audio, third-party scripts, scroll hijacking or WebGL.

## Coordinated shared-route integration

Claude’s accounts API has merged at `aff46fe` and file locks are lifted; the source integration remains a separate reviewable change. Do not merge this preview by overwriting `docs/index.html` blindly: the desktop Flask root currently serves that file, and the service worker / PWA also refer to it.

First safe landing location: copy `design/homepage/{index.html,home.css,home.js}` to `docs/home/`. In that copy:

```diff
- href="../../docs/index.html"
+ href="../index.html"
- url('../../docs/fonts/ui/
+ url('../fonts/ui/
- src="../../brand/lockup-horizontal.svg"
+ src="../brand/lockup-horizontal.svg"
- src="../../brand/logo-mark.svg"
+ src="../brand/logo-mark.svg"
- href="../../brand/favicon.svg"
+ href="../brand/favicon.svg"
```

Copy those exact brand assets into `docs/brand/`; follow `brand/INTEGRATION.md` for the explicit desktop routes and release packaging.

Then add the public homepage link to the app's existing brand anchor in `docs/index.html` only when Claude is ready:

```html
<a class="brand" href="home/" aria-label="Clip Machine home">…chosen mark and wordmark…</a>
```

For the eventual root homepage requested by Benny, use a separate `docs/workspace.html` with the existing app markup and unchanged relative asset paths. Set the homepage's CTA to `workspace.html`. Update `app.py` so its desktop root still serves **workspace.html**, update the service-worker shell/offline fallback and PWA start URL deliberately, and verify direct links, shared desktop state, search, brand kit and existing query-string presets. Do these changes in one reviewed integration after the account branch lands. The preview does not perform this migration and does not change port 8765.

## Pending work

- Selected identity is applied to the preview; workspace/desktop logo integration is specified in `brand/INTEGRATION.md`.
- Real app captures and task 14 assets are now in `design/`. The homepage process illustration remains labelled and must never be described as an app screenshot.
- Free + Supporter is selected. Payment CTA still waits for implemented/tested billing and Stripe setup. No dead Buy button is included.
- Run the website and desktop regression suites after the route migration. This preview branch has no shared application changes.

## Marketing integration

`docs/og-image.png` is supplied at 1200 × 630. Add these tags in the app and public homepage head (with any existing duplicates replaced, not doubled):

```html
<meta property="og:type" content="website">
<meta property="og:title" content="Clip Machine — find the clips worth posting">
<meta property="og:description" content="Free. No watermark. On your device.">
<meta property="og:image" content="https://blin0908.github.io/clip-machine/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://blin0908.github.io/clip-machine/og-image.png">
```

For the shared root README, insert the following after the introduction, replacing earlier screenshots if necessary:

```markdown
![Clip Machine finds captioned clips from a recording](design/readme-hero.png)

![The real Clip Machine editor with a generated test clip](design/readme-studio.png)
```

The screenshots use generated test media, not customer footage. `find.png` shows a typed search query, not an invented successful match. All screen contents were produced by the actual native app. Screenshots record the workspace at accounts commit `aff46fe`; its old placeholder mark is not silently replaced inside the screenshots.

The YouTube banner/profile are for the **Building it / Clip Machine build-log** channel from `PLAN.md`, not Deciding Guess. `youtube-banner-safe-preview.png` is review-only; publish `youtube-banner.png` without the dashed guide. No channel art has been uploaded.
