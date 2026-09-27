#!/usr/bin/env python3
"""Install the review page on the running LangWatch host and start its loopback API."""
import json
import hashlib
import os
import plistlib
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOME = ROOT / 'langwatch/.local'
DIST = HOME / 'app/platform/app/dist/client'
LABEL = 'com.local.langwatch.review'


def main():
    if not DIST.is_dir():
        raise SystemExit('Сначала запустите LangWatch: ./scripts/start-langwatch.sh')
    for path in (ROOT / 'review-ui').iterdir():
        if path.suffix in {'.html', '.js', '.css'}:
            shutil.copyfile(path, DIST / path.name)
    app = DIST.parent.parent
    shell = DIST / 'index.html'
    shell_text = shell.read_text()
    if 'src="/review-entry.js"' not in shell_text:
        if '</body>' not in shell_text:
            raise SystemExit('HTML-оболочка LangWatch изменилась: точка подключения не найдена')
        shell.write_text(shell_text.replace('</body>', '<script src="/review-entry.js"></script></body>'))
    proxy = app / 'src/server/local-review-proxy.ts'
    desired = (ROOT / 'review-ui/local-review-proxy.ts').read_text()
    start = app / 'src/start.ts'
    source = start.read_text()
    changed = not proxy.exists() or proxy.read_text() != desired
    proxy.write_text(desired)
    if 'handleLocalReview' not in source:
        source = "import { handleLocalReview } from './server/local-review-proxy';\n" + source
        source = source.replace('      // MCP routes — intercept before everything',
                                '      if (await handleLocalReview(req, res)) return;\n\n      // MCP routes — intercept before everything')
        if 'await handleLocalReview(req, res)' not in source:
            raise SystemExit('Версия LangWatch изменилась: точка подключения API не найдена')
        start.write_text(source)
        changed = True
    build_hash = hashlib.sha256((desired + source).encode()).hexdigest()
    marker = HOME / 'review-build-hash'
    if changed or not marker.exists() or marker.read_text() != build_hash:
        node = '/opt/homebrew/bin/node' if Path('/opt/homebrew/bin/node').is_file() else shutil.which('node')
        build_env = {**os.environ, 'PATH': str(Path(node).parent) + os.pathsep + os.environ.get('PATH', '')}
        subprocess.run([node, 'scripts/build-server.mjs'], cwd=app, env=build_env, check=True)
        # Restart only the web app, keeping all databases and workers alive.
        environment = dict(os.environ)
        for line in (HOME / '.env').read_text().splitlines():
            if '=' in line and not line.startswith('#'):
                name, value = line.split('=', 1)
                environment[name] = value.strip('"')
        environment['NODE_ENV'] = 'production'
        pidfile = HOME / 'run/langwatch.pid'
        if pidfile.exists():
            pid = int(pidfile.read_text())
            children = subprocess.run(['pgrep', '-P', str(pid)], text=True, capture_output=True).stdout.split()
            # The tracked PID may be the pnpm wrapper; the listener is its Node child.
            listeners = subprocess.run(['lsof', '-t', '-iTCP:5560', '-sTCP:LISTEN'], text=True, capture_output=True).stdout.split()
            for item in set(children + listeners + [str(pid)]):
                try: os.kill(int(item), 15)
                except ProcessLookupError: pass
        import time
        for _ in range(40):
            listeners = subprocess.run(['lsof', '-t', '-iTCP:5560', '-sTCP:LISTEN'], text=True, capture_output=True).stdout.strip()
            if not listeners: break
            time.sleep(0.5)
        if listeners:
            raise SystemExit('Web-процесс не завершился. База данных и workers продолжают работать.')
        with (HOME / 'review-web.log').open('ab') as log:
            child = subprocess.Popen([node, '--enable-source-maps', 'dist/server/server.cjs'], cwd=app,
                                     env=environment, stdout=log, stderr=log, start_new_session=True)
        pidfile.write_text(str(child.pid))
        marker.write_text(build_hash)
    if sys.platform != 'darwin':
        raise SystemExit('Страница установлена. Запустите API: python3 scripts/review_server.py')
    plist = Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
    config = {'Label': LABEL, 'ProgramArguments': [sys.executable, str(ROOT / 'scripts/review_server.py')],
              'WorkingDirectory': str(ROOT), 'RunAtLoad': True, 'KeepAlive': True,
              'StandardOutPath': str(HOME / 'review-server.log'), 'StandardErrorPath': str(HOME / 'review-server.log'),
              'EnvironmentVariables': {'PYTHONUNBUFFERED': '1', 'PATH': os.environ.get('PATH', '/opt/homebrew/bin:/usr/bin:/bin')}}
    plist.parent.mkdir(parents=True, exist_ok=True)
    with plist.open('wb') as target:
        plistlib.dump(config, target)
    plist.chmod(0o600)
    domain = f'gui/{os.getuid()}'
    api_hash = hashlib.sha256((ROOT / 'scripts/review_server.py').read_bytes() + (ROOT / 'scripts/review_engine.py').read_bytes()).hexdigest()
    api_marker = HOME / 'review-api-hash'
    # Leave an active analysis running on repeated setup. Restart explicitly when changing the API code.
    try:
        with urllib.request.urlopen('http://127.0.0.1:11436/health', timeout=2) as response:
            if json.load(response).get('status') == 'ok':
                if not api_marker.exists() or api_marker.read_text() != api_hash:
                    active = [json.loads(p.read_text()) for p in (HOME / 'review').glob('*.json')]
                    if any(job['status'] == 'running' for job in active):
                        print('Страница обновлена. API обновится после завершения текущего разбора.')
                        return
                    subprocess.run(['launchctl', 'kickstart', '-k', domain + '/' + LABEL], check=True)
                    api_marker.write_text(api_hash)
                print('Страница обновлена; текущий API уже работает. http://localhost:5560/agent-review.html')
                return
    except Exception:
        pass
    subprocess.run(['launchctl', 'bootout', domain, str(plist)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True)
    api_marker.write_text(api_hash)
    print('Проверка агента: http://localhost:5560/agent-review.html')


if __name__ == '__main__':
    main()
