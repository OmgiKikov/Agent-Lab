#!/usr/bin/env python3
"""Start the local HTTP bridge when the existing AIGW installation is present."""
import os, subprocess, time, urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
HOME=ROOT/'langwatch/.local'
SOURCE=Path(os.environ.get('AIGW_LOCAL_REPO',str(Path.home()/'Desktop/aigw-local')))
PYTHON=SOURCE/'.venv/bin/python'
SCRIPT=ROOT/'scripts/aigw-langwatch-bridge.py'
if not PYTHON.exists() or not (SOURCE/'local/langwatch_target.py').exists():raise SystemExit(0)
PIDFILE=HOME/'run/aigw-target.pid'
if PIDFILE.exists():
 try:
  pid=int(PIDFILE.read_text());command=subprocess.run(['ps','-p',str(pid),'-o','command='],text=True,capture_output=True).stdout
  if str(SCRIPT) in command:raise SystemExit(0)
  if 'uvicorn local.langwatch_target:app' in command:
   os.kill(pid,15)
   for _ in range(40):
    if not subprocess.run(['ps','-p',str(pid),'-o','pid='],text=True,capture_output=True).stdout.strip():break
    time.sleep(.1)
 except (ValueError,ProcessLookupError):pass
if subprocess.run(['lsof','-t','-iTCP:8092','-sTCP:LISTEN'],text=True,capture_output=True).stdout.strip():
 print('Порт 8092 занят другим процессом; мост AIGW не заменён.');raise SystemExit(0)
HOME.mkdir(parents=True,exist_ok=True);PIDFILE.parent.mkdir(parents=True,exist_ok=True)
with (HOME/'aigw-target.log').open('ab') as log:
 child=subprocess.Popen([str(PYTHON),str(SCRIPT)],cwd=ROOT,env={**os.environ,'AIGW_LOCAL_REPO':str(SOURCE)},stdout=log,stderr=log,start_new_session=True)
PIDFILE.write_text(str(child.pid))
for _ in range(50):
 try:
  urllib.request.urlopen('http://127.0.0.1:8092/health',timeout=2).read();print('Мост LangWatch → AIGW готов');break
 except Exception:pass
 if child.poll() is not None:raise SystemExit('Мост AIGW не запустился: смотрите aigw-target.log')
 time.sleep(.1)
