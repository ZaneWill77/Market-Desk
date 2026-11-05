@echo off
cd /d "%~dp0"
if not exist .venv (
  echo Creating virtual environment...
  python -m venv .venv
  .venv\Scripts\python.exe -m pip install -r requirements.txt
)
if exist .env for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do set "%%a=%%b"
if not defined PORT set PORT=8765
start "" http://127.0.0.1:%PORT%
.venv\Scripts\python.exe -m app
