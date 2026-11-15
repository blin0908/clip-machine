@echo off
rem One-time setup for Windows. Double-click, then use "Start Clip Machine.bat".
cd /d "%~dp0"
set PY=
where py >nul 2>nul && (py -3 -c "import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>nul && set PY=py -3)
if not defined PY (where python >nul 2>nul && (python -c "import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>nul && set PY=python))
if not defined PY (
  echo Clip Machine needs Python 3.10 or newer. Get it free at https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^) and run this again.
  pause
  exit /b 1
)
echo Using %PY%
%PY% -m venv .venv || (echo Could not create the environment. & pause & exit /b 1)
.venv\Scripts\python -m pip install -q --upgrade pip
echo Installing speech engine, downloader, web app and portable ffmpeg...
.venv\Scripts\python -m pip install -q -r requirements.txt || (echo Install failed. & pause & exit /b 1)
.venv\Scripts\python -c "import static_ffmpeg; static_ffmpeg.add_paths(weak=True)" >nul
where node >nul 2>nul || echo Tip: install Node.js from nodejs.org if YouTube links fail.
echo.
echo Done. Double-click "Start Clip Machine.bat" to run it.
pause
