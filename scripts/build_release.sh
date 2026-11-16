#!/bin/sh
# Packages the desktop app (macOS / Windows / Linux) into dist/Clip-Machine-desktop.zip
set -e
cd "$(dirname "$0")/.."
PY=.venv/bin/python; [ -x "$PY" ] || PY=python3
"$PY" scripts/export_formula.py --check || exit 1   # web + desktop must score clips the same way
rm -rf dist/stage && mkdir -p "dist/stage/Clip Machine/fonts"
cp clipper.py app.py search.py mcp_server.py index.html requirements.txt README.md FORMULA.md LICENSE \
   Install.command "Start Clip Machine.command" install.sh start.sh \
   "Install (Windows).bat" "Start Clip Machine.bat" "dist/stage/Clip Machine/"
cp docs/fonts/Montserrat-Black.ttf docs/fonts/OFL.txt "dist/stage/Clip Machine/fonts/"
# the browser UI (the desktop app serves the same pages as the website, backed by its native engine)
mkdir -p "dist/stage/Clip Machine/web"
cp docs/index.html docs/app.js docs/studio.js docs/zip.js docs/formula.js docs/formula.json docs/asr-worker.js docs/search.js docs/search-worker.js docs/sw.js \
   docs/icon-180.png docs/icon-512.png "dist/stage/Clip Machine/web/"
cp -R docs/fonts docs/vendor "dist/stage/Clip Machine/web/"
chmod +x "dist/stage/Clip Machine/"*.command "dist/stage/Clip Machine/"*.sh
rm -f dist/Clip-Machine-desktop.zip
(cd dist/stage && if command -v ditto >/dev/null; then ditto -c -k --norsrc --noextattr --keepParent "Clip Machine" ../Clip-Machine-desktop.zip; else zip -qr ../Clip-Machine-desktop.zip "Clip Machine"; fi)
rm -rf dist/stage
ls -la dist/Clip-Machine-desktop.zip
