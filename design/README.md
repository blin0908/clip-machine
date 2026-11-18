# Homepage preview

An independently reviewable front page for Clip Machine, pending the chosen identity and Claude's accounts integration.

Serve the repository root with a localhost static server and visit `/design/homepage/`. `Try it out` opens the real app in `/docs/index.html`. This branch does not replace the deployed homepage, edit Claude's shared files, or add payment collection.

The process graphic is original HTML/CSS illustration, clearly labelled; it is not a simulated app screenshot. All product claims come from the README at base `f898bef`. No private videos or analytics are shown. Text-only wordmark is deliberate until Benny chooses a logo.

Motion: waveform, playhead, selected window, staggered output cards, rotating local-device ring, one-time section reveals and native click-to-scroll. Motion can be paused, pauses when the page is hidden and follows reduced-motion preferences. All content remains visible without JavaScript. No third-party animation package or autoplay media is loaded.

Run `node design/check-home.mjs` for desktop/mobile Chrome captures and interaction checks. See `INTEGRATION.md` for the routing changes Claude must apply after the accounts handoff. Task 14's final marketing images remain pending the task 13 selection.
