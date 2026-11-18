# Clip Machine design assets

Selected identity: A / Peak window. This branch contains the standalone animated homepage plus task 14 graphics. Nothing has been deployed or uploaded to a channel.

| Asset | Dimensions | Use |
|---|---|---|
| `og-image.png` (also `docs/og-image.png`) | 1200 × 630 | Social link preview |
| `readme-hero.png` | 1600 × 900 | README introduction |
| `readme-studio.png` | 1600 × 1200 | Actual clip-editor screenshot |
| `release-banner.png` | 1280 × 640 | GitHub release; version is a rebuild variable |
| `feature-queue.png` | 1080 × 1350 | Bring a recording / queue |
| `feature-studio.png` | 1080 × 1350 | Trim and refine |
| `feature-find.png` | 1080 × 1350 | Find by description input, not a fabricated search result |
| `feature-handoff.png` | 1080 × 1350 | Premiere / Resolve hand-off |
| `youtube-banner.png` | 2560 × 1440 | Clip Machine build-log channel art |
| `youtube-banner-safe-preview.png` | 2560 × 1440 | Review only, 1546 × 423 safe-area guide |
| `youtube-profile.png` | 800 × 800 | Build-log profile icon, checked at 98px |

`captures/` contains real 2× Chrome screenshots of the running desktop app with a real native job on `tests/media/talk_80s.mp4`. This fixture is made by `tests/make_media.sh` from ffmpeg testsrc2 and system speech. There are no private jobs or external creator clips. `captures/provenance.json` records the source hash, app base, capture dimensions and browser errors. Test-fixture speech is example content, not a testimonial or performance claim. The screenshots show the actual app's pre-integration placeholder logo; the surrounding graphics use the selected identity.

Every PNG has a same-name HTML source (the banner guide uses the banner source with a preview class). Shared styles/content are reproducible from `build_assets.py`. `previews/marketing.html` and `previews/marketing-small.png` show the smallest intended display sizes. Do not publish review-guide images as masters.

Rebuild from the repository root with the existing Python/Playwright dependencies:

```sh
# Optional recapture; refuses an occupied 8790, uses synthetic scratch jobs only.
# No changes to Benny's app at 8765.
node design/capture-app.mjs
python3 design/build_assets.py --version 1.8.4
node design/render.mjs
node design/check-home.mjs
```

`capture-app.mjs` creates an isolated server on 127.0.0.1:8790, fresh random key and temporary jobs/log directory, then stops that server and Chrome. Its source recording stays outside Git; only screenshots/provenance are included. Search capture records only the visible typed input. Feature cards use actual screenshot crops: find zooms the typed query; hand-off focuses the subtitle/editor controls in the original capture. No UI is reconstructed. It doesn't fake network/model results or claims of search accuracy.

Homepage: serve the repo root locally and open `design/homepage/`. Native smooth anchor scrolling, explanatory motion, pause/resume, document-hidden pause, reduced-motion and 320px+ layouts are included. Try it out opens the actual `docs/index.html` workspace. `previews/homepage-*` are captures of this labelled process illustration, separate from real app screenshots.

Colours follow `brand/BRAND.md`: normal text uses light text/muted text or accent on ink (minimum 8.22:1 for these text colours). Small screenshot UI is existing product UI, not newly authored marketing text. No speed, accuracy, customer-count or popularity claim is included.

See `INTEGRATION.md` for exact OG, README, homepage-route and PWA/desktop changes. Shared source files were not edited by this design asset task. Billing and security review are separate work.
