# Clip Machine identity

**Selected: A — Peak window, November 18, 2026.** The full vector identity, outlined Archivo Wide wordmark, lockups, install icons and favicon are ready for integration.

Open `identity.html` for the selected identity. Original A/B/C concepts are retained under `concepts/` as history. See `BRAND.md` for sizes, spacing, palette, reference comparisons and the asset inventory; see `INTEGRATION.md` for the exact shared-file changes Claude needs to apply.

Rebuild with a separate tooling environment (do not modify Claude's shared Python environment):

```sh
python3 -m venv /tmp/clip-machine-brand-tools
/tmp/clip-machine-brand-tools/bin/python -m pip install -r brand/requirements-render.txt
/tmp/clip-machine-brand-tools/bin/python brand/build_identity.py
node brand/render.mjs
```

`node brand/render.mjs --concepts-only` rebuilds the original concept comparison. PNGs use installed Chrome through the existing Playwright test dependency; ICO wraps the exact rendered 16px and 32px PNGs. No third-party logo asset, cloud image generation or private footage is included.

The desktop's generated `/icon.svg` is still the old identity until Claude applies the explicit route handoff. No shared source or live deployment is changed by the asset commit.
