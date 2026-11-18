# Clip Machine — Peak window

Selected by Benny on **November 18, 2026**: concept **A**. In and out brackets frame the strongest peak inside a longer recording. The mark expresses choosing a useful moment; it is not a promise of viral performance.

## The identity

The approved bracket-and-three-bar silhouette is preserved. The centre bar is the peak; the two shorter bars provide context. The mark is flat, with no gradient, shadow, mascot or 3D treatment.

The wordmark is **CLIPMACHINE**, Archivo Wide, weight 800, width axis 125, converted to SVG paths from the shipped font. The outlined files require no installed font or browser font request. The small negative tracking is fixed in the vector source. `identity.json` records font hash, axes and measurements. The font remains under the existing SIL Open Font License in `docs/fonts/OFL.txt`; source attribution is in `docs/fonts/ui/LICENSES.txt`.

Use `lockup-horizontal.svg` as the normal dark-surface logo. Use the navy `*-light.svg` assets on light surfaces. The default files and `*-dark.svg` are identical; “dark” describes the intended surface, not the colour of the mark. The monochrome mark inherits `currentColor`.

## Space, sizes and placement

- Let **H** be the visible bracket height, not the SVG artboard. Keep at least **0.25 H** of empty space around the visible mark or complete lockup. At tiny UI sizes allow at least 4 CSS px. Artboard padding may satisfy part of this; do not assume an image box supplies all clear space.
- Minimum mark artboard: **16×16 CSS px**. Prefer 24–32 px in navigation. Below 24 px, use the mark alone rather than an unreadable wordmark.
- Minimum outlined wordmark: **150 px wide**, about 12 px letter height. Minimum horizontal lockup: **200 px wide**. Minimum stacked lockup: **220 px wide**. Keep exact proportions and a level baseline.
- Top bar: mark artboard **26×26 px**, followed by 10 px or more before the wordmark. Keep labels and primary controls legible first.
- App icon: separate dark tile composition. Visible mark bounds are 22.5–77.5% of each dimension; its furthest bounding corner is at radius 38.891% around the centre, inside the **40% maskable safe circle**. Chrome raster alpha/colour checks in `icon-check.json` verify the rendered 512px mark, not only the geometry. The 16/32px favicon uses a larger optical composition; do not shrink the more padded app tile to make a favicon.

## Colour

All ratios below are computed against `#05070c` using WCAG relative luminance; see `identity.json`. A token below 4.5:1 is not approved as normal-sized text on that background. Surface and divider tokens are not text colours. Contrast must also be checked on the actual final surface.

| Token | Value | Contrast on ink | Role |
|---|---|---:|---|
| ink | #05070c | 1.00 | Main dark surface |
| panel | #0a1120 | 1.07 | Surface only |
| panel2 | #111b30 | 1.17 | Surface only |
| well | #03050a | 1.01 | Recessed surface only |
| line | #18233a | 1.29 | Decorative divider only |
| line2 | #26344f | 1.62 | Decorative divider only; not sufficient alone for a required control boundary |
| text | #e8edf6 | 17.15 | Primary text / CLIP on dark |
| mute | #9aa6bd | 8.22 | Secondary text |
| faint | #7e8aa2 | 5.80 | Quiet text, not reduced-opacity text |
| slate | #7aa7ff | 8.44 | Primary mark, MACHINE on dark, links and CTA surface |
| slate-ink | #04102a | 1.07 | Text **on slate**, not on ink |
| rec | #ff5a4e | 6.55 | Error / recording text with a label |
| good | #4cc38a | 9.10 | Success text with a label |
| warn | #f2a530 | 9.79 | Warning text with a label |
| light-mark | #142744 | 1.35 | Navy identity **on light surfaces only** |
| light-surface | #eef2f8 | 17.94 | Light review / print surface |

Navy `#142744` on light `#eef2f8`: **13.32:1**. Slate-ink text on slate CTA: **7.91:1**. The pale blue mark is not the text colour for a white surface; use the navy light variant. Colour must not be the only state indicator.

## Type roles

- **Archivo:** display headings and wordmark; wide, heavy uppercase for the identity. Use the outlined asset when distributing the logo.
- **Instrument Sans:** interface labels, descriptions and body text, sentence case.
- **IBM Plex Mono:** timestamps, compact numeric annotations and measurements.
- **Montserrat Black and script-specific caption fonts:** video captions. The identity task does not alter caption fonts or rendering.

## Do and don't

`identity.html` includes a correct header lockup and a deliberately compressed/low-opacity misuse example.

Do keep the two brackets, all three bars, original spacing, flat colours and proportions. Use the supplied light variant on a pale surface. Add clear space instead of making the logo compete with controls. Use the dedicated favicon at small sizes.

Do not stretch, rotate, squash, blur, fade, outline or add shadows to the mark. Do not animate the identity as if it were a real audio meter; decorative product motion belongs in the illustration beside it. Do not remove a bracket or change bar count to fit a container. Do not add a “viral” claim, fake play count or certification badge.

## Distinctness review and linked references

The original concepts are retained in `concepts/`; **A is the only selected identity**. These are design comparisons, not a trademark search or legal clearance. The references are linked to official product/brand pages checked November 18, 2026; competitors' logo files are not copied into this repository. A waveform and trim brackets are common visual vocabulary; do not claim exclusive rights to either in isolation.

| Official logo reference | A — Peak window (selected) | B — Splice (unselected) | C — Cue (unselected) |
|---|---|---|---|
| [OpusClip media kit](https://media.opus.pro/) | Opposing square brackets and three unequal vertical bars; no intertwined rounded letter symbol. | Two solid slate slabs; no interlocked letterform. | Open square C with a straight cue; no rounded paired motif. |
| [CapCut](https://www.capcut.com/) | Separated brackets and bars, with no crossing ribbon or X-shaped join. | A single cut, not crossed ribbons. | One open frame, without a crossing centre. |
| [Descript](https://www.descript.com/) | Audio association is shared vocabulary; the surrounding brackets and unequal vertical bars are the differentiator. | Solid diagonal slabs rather than horizontal audio strokes. | Open square outline and one cue, not a stacked-bar construction. |
| [Klap](https://klap.app/) | Explicit trim window around a peak rather than a clapper-style compact device symbol. | Closest generic slate category; do not promote B without closer comparison. | Open C silhouette rather than a slate. |
| [Vizard](https://vizard.ai/) | Two side brackets and a central peak, without a V-shaped letter/symbol. | No V or interlocking shape; two plain cut slabs. | A square C and one cue, not a V. |
| [Submagic](https://www.submagic.co/) | No sparkle, magic wand or caption-bubble imagery; a restrained editing window. | A plain slate cut without magic imagery. | A restrained cue inside a frame. |
| [Adobe Premiere](https://www.adobe.com/products/premiere.html) | No rounded app tile with a Pr monogram as the primary mark; waveform peak is the subject. | No Pr lettering. | No Pr lettering; avoid placing an Adobe-like monogram in the tile. |
| [Final Cut Pro](https://www.apple.com/final-cut-pro/) | No rainbow slate or diagonal clapper top; brackets frame a peak instead. | Common slate vocabulary, so weaker separation than A. | No slate or multicolour clapper motif. |

## Asset inventory and rebuild

- `logo-mark.svg`, `logo-mark-dark.svg`, `logo-mark-light.svg`, `logo-mark-mono.svg`
- `wordmark.svg`, `wordmark-dark.svg`, `wordmark-light.svg` — paths only
- `lockup-horizontal.svg`, `lockup-horizontal-dark.svg`, `lockup-horizontal-light.svg`
- `lockup-stacked.svg`, `lockup-stacked-dark.svg`, `lockup-stacked-light.svg`
- `icon.svg` and `../docs/icon.svg`; rendered `../docs/icon-180.png`, `../docs/icon-512.png`
- `favicon.svg`, `favicon-16.png`, `favicon-32.png`, `favicon.ico` (16+32 PNG entries)
- `identity.html`, `identity-preview.png`, `identity-mobile.png`, `identity.json`, `icon-check.json`
- `concepts/` — original studies and selected favicon zoom, retained as history
- `INTEGRATION.md` — exact shared-file handoff; does not edit Claude's shared sources

Rebuild vectors with `python brand/build_identity.py` in a separate tooling virtualenv installed from `brand/requirements-render.txt`. Then run `node brand/render.mjs` using the existing `tests/node_modules` and installed Chrome. Run `node brand/render.mjs --concepts-only` to rebuild only the historical comparison. The builder does not change any installed app or start a production server.
