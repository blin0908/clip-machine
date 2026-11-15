#!/bin/sh
cd "$(dirname "$0")" || exit 1
[ -x .venv/bin/python ] || { echo "Run ./install.sh first."; exit 1; }
export HF_HUB_DISABLE_PROGRESS_BARS=1
.venv/bin/python -m pip install -q -U yt-dlp >/dev/null 2>&1 &
exec .venv/bin/python app.py
