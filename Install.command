#!/bin/zsh
# One-time setup. Double-click, wait a few minutes, then use "Start Clip Machine.command".
cd "$(dirname "$0")"
set -e
PY=""
for c in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v $c >/dev/null 2>&1 && $c -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then PY=$c; break; fi
done
if [ -z "$PY" ]; then
  echo "Clip Machine needs Python 3.10 or newer. Get it free at https://www.python.org/downloads/ and run this again."
  read -k1 "?Press any key to close."; exit 1
fi
echo "Using $($PY --version)"
$PY -m venv .venv
.venv/bin/pip install -q --upgrade pip
echo "Installing (speech model engine, downloader, web app)…"
.venv/bin/pip install -q -r requirements.txt
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo "Fetching a portable ffmpeg…"
  .venv/bin/pip install -q static-ffmpeg
  .venv/bin/python -c "import static_ffmpeg; static_ffmpeg.add_paths()"
fi
command -v node >/dev/null 2>&1 || echo "Tip: install Node.js (nodejs.org) if YouTube downloads fail. yt-dlp uses it for YouTube."
chmod +x "Start Clip Machine.command"
echo ""
echo "Done. Double-click 'Start Clip Machine.command' to run it."
read -k1 "?Press any key to close."
