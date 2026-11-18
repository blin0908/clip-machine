# Selected Peak window integration

Benny selected A on November 18, 2026. This branch replaces only the three explicitly allowed `docs/icon*` files and adds assets in `brand/`. It does not edit Claude's shared application files. The accounts commit `aff46fe` is included by rebase; production port 8765 is untouched.

## Top bar: exact HTML and CSS for Claude

Replace the current `.mark` span in `docs/index.html` with:

```html
<svg class="mark" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true" focusable="false"><path d="M5 5h6v3H8v16h3v3H5zM21 5h6v22h-6v-3h3V8h-3z"/><path d="M11 14h3v7h-3zM15 10h3v15h-3zM19 15h3v5h-3z"/></svg>
```

Replace its old diagonal-stripe `.mark` CSS with:

```css
.mark {
  display: block;
  width: 26px;
  height: 26px;
  flex: 0 0 26px;
  color: var(--slate);
  background: none;
  border-radius: 0;
  box-shadow: none;
}
.brand { gap: 10px; }
.brand .word {
  font-family: Archivo, sans-serif;
  font-weight: 800;
  font-stretch: 125%;
  text-transform: uppercase;
  letter-spacing: -.035em;
}
```

Keep the existing accessible brand link name and heading structure. The inline mark is decorative. Distributed wordmarks/marketing assets should use the supplied outlined SVG, rather than retyping the name in another font.

## Favicon and install icons

Copy `brand/favicon.svg`, `brand/favicon-32.png` and `brand/favicon.ico` to a public `docs/brand/` folder during integration. The extra public routes/cache shell are Claude's changes, not silently added by this task.

```html
<link rel="icon" href="brand/favicon.svg" type="image/svg+xml">
<link rel="icon" href="brand/favicon-32.png" sizes="32x32" type="image/png">
<link rel="alternate icon" href="brand/favicon.ico">
<link rel="apple-touch-icon" href="icon-180.png">
```

The existing names `docs/icon.svg`, `docs/icon-180.png`, `docs/icon-512.png` are replaced in this branch. In the static `docs/manifest.json`, the 512px PNG can now declare `"purpose": "any maskable"`; do this with the shared shell update. The raster check in `brand/icon-check.json` verifies all foreground pixels fit the centre 80% circle.

## Desktop route mismatch: must integrate explicitly

`app.py` currently generates an old yellow icon in its `/icon.svg` route instead of serving `docs/icon.svg`. Replacing the asset alone does **not** update that desktop route. Replace the icon function with this exact implementation:

```python
@app.get("/icon.svg")
def icon():
    for directory in (HERE / "docs", HERE / "web"):
        if (directory / "icon.svg").is_file():
            return send_from_directory(directory, "icon.svg")
    abort(404)
```

Keep the existing public-icon authentication exception. For the new public favicon paths, register explicit routes and add exact allowed filenames; do not broaden the static server to serve arbitrary repository files. Update `scripts/build_release.sh` to copy any new public favicon directory into `web/`. The current desktop manifest includes only the SVG; add the same PNG install entries with purpose if desired after verifying the release zip.

## Cache and checks

Bump the existing `docs/sw.js` shell cache version and include new public favicon files so an old cached icon cannot survive a deployment. Shared file edits belong to Claude's integration. Test the website and desktop (including the released ZIP) after applying the snippets, then verify the actual icon responses and fresh/offline PWA installation. Do not report those application routes as updated from this asset branch alone.

No main push, deployment, account migration or payment activation is included. Claude’s November 18 handoff confirms Free + Supporter separately; it is not part of this identity change. The accounts handoff has lifted shared-file locks, but this branch intentionally delivers assets and exact integration instructions as task 13 specifies.
