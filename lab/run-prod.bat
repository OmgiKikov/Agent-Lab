@echo off
cd /d %~dp0
if not exist .venv\Scripts\python.exe (python -m venv .venv && .venv\Scripts\pip install -q httpx)
set JUDGE=
.venv\Scripts\python -m lab gateway || set JUDGE=--judge-later
.venv\Scripts\python -m lab ping --target prod
.venv\Scripts\python -m lab run --target prod --repeats 2 %JUDGE%
echo File: lab\data\runs\ - import it on the Mac.
pause
