#!/bin/zsh
# Double-click to start. Keep this window open while you use the app.
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH" HF_HUB_DISABLE_PROGRESS_BARS=1
[ -x .venv/bin/python ] || { echo "Run Install.command first."; read -k1; exit 1; }
.venv/bin/pip install -q -U yt-dlp >/dev/null 2>&1 &   # keep the downloader fresh (sites change often)
exec .venv/bin/python app.py
