@echo off
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (echo Run "Install (Windows).bat" first. & pause & exit /b 1)
set HF_HUB_DISABLE_PROGRESS_BARS=1
start /b "" .venv\Scripts\python -m pip install -q -U yt-dlp >nul 2>nul
.venv\Scripts\python app.py
pause
