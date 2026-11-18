# Homepage integration handoff

This is a working standalone homepage preview at `design/homepage/index.html`, not a deployed change or an app screenshot. It uses the current palette/fonts and a text-only wordmark while the task 13 logo is undecided. Its moving process diagram is explicitly labelled an illustration; it contains no fabricated metrics, testimonials or app captures.

## Safe current preview

Serve the repository root on a localhost-only port, then open `/design/homepage/`. All three Try it out links resolve to `/docs/index.html`, the actual unchanged app in this checkout. Click-to-scroll anchors use native smooth scrolling; people can interrupt it normally. Pause motion, reduced motion, keyboard focus, skip navigation, responsive layout and document-hidden animation pausing are included. No autoplay audio, third-party scripts, scroll hijacking or WebGL.

## After accounts merge and the logo is selected

Claude owns the shared files. Do not merge this preview by overwriting `docs/index.html` blindly: the desktop Flask root currently serves that file, and the service worker / PWA also refer to it.

First safe landing location: copy `design/homepage/{index.html,home.css,home.js}` to `docs/home/`. In that copy:

```diff
- href="../../docs/index.html"
+ href="../index.html"
- url('../../docs/fonts/ui/
+ url('../fonts/ui/
```

Then add the public homepage link to the app's existing brand anchor in `docs/index.html` only when Claude is ready:

```html
<a class="brand" href="home/" aria-label="Clip Machine home">…chosen mark and wordmark…</a>
```

For the eventual root homepage requested by Benny, use a separate `docs/workspace.html` with the existing app markup and unchanged relative asset paths. Set the homepage's CTA to `workspace.html`. Update `app.py` so its desktop root still serves **workspace.html**, update the service-worker shell/offline fallback and PWA start URL deliberately, and verify direct links, shared desktop state, search, brand kit and existing query-string presets. Do these changes in one reviewed integration after the account branch lands. The preview does not perform this migration and does not change port 8765.

## Pending work

- Replace text-only wordmark with the selected task 13 identity.
- Capture the real app with cleared synthetic/NASA media for task 14's marketing assets. The process illustration must never be described as a screenshot.
- Payment CTA waits for Benny's selected plan, completed accounts API, Stripe test setup and passing security checks. No dead Buy button is included.
- Run the website and desktop regression suites after the route migration. This preview branch has no shared application changes.
