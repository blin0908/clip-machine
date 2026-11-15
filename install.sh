#!/bin/sh
# One-time setup for Linux (and macOS from a terminal). Then run ./start.sh
cd "$(dirname "$0")" || exit 1
PY=""
for c in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then PY=$c; break; fi
done
[ -z "$PY" ] && { echo "Clip Machine needs Python 3.10+ (python.org, or your package manager: python3 python3-venv)."; exit 1; }
echo "Using $($PY --version)"
$PY -m venv .venv || { echo "Couldn't create a virtual environment. On Debian/Ubuntu: sudo apt install python3-venv"; exit 1; }
.venv/bin/python -m pip install -q --upgrade pip
echo "Installing (speech engine, downloader, web app, portable ffmpeg)…"
.venv/bin/python -m pip install -q -r requirements.txt || exit 1
.venv/bin/python -c "import static_ffmpeg; static_ffmpeg.add_paths(weak=True)" >/dev/null
command -v node >/dev/null 2>&1 || echo "Tip: install Node.js if YouTube links fail (yt-dlp uses it for YouTube)."
chmod +x start.sh 2>/dev/null
echo "Done. Run ./start.sh"
