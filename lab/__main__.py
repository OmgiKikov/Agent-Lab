"""Agent Lab command line.

  python -m lab serve                      page at http://127.0.0.1:5901
  python -m lab discover --count 60        evaluate real logs
  python -m lab cards                      build business scenario cards
  python -m lab run --target prod          run the cards against an agent
  python -m lab import runs/<file>.json    bring a run made on another computer
  python -m lab clean                      delete all runs (files, Workshop traces and folders)
  python -m lab bundle                     zip for running the prod agent on the work computer
  python -m lab ping --target prod         one message to the agent, raw request and response
  python -m lab gateway --url … --cert … --key … [--ca …]   the bank's model gateway over certificates
  python -m lab gateway --model … --second-model …           judge / simulator models from its catalog
"""
import argparse
import asyncio
import json
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(prog='lab', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    serve = sub.add_parser('serve')
    serve.add_argument('--port', type=int, default=5901)
    d = sub.add_parser('discover')
    d.add_argument('--count', type=int, default=60)
    d.add_argument('--replan', action='store_true', help='заново выделить правила из промпта владельца')
    sub.add_parser('cards')
    r = sub.add_parser('run')
    r.add_argument('--target', required=True, help='prod | local-http | local-code')
    r.add_argument('--label', default='')
    r.add_argument('--repeats', type=int, default=1, help='сколько раз прогнать каждый сценарий')
    r.add_argument('--judge-later', action='store_true',
                   help='нет доступа к модели: отправить только первые реплики, оценить при импорте в Lab')
    i = sub.add_parser('import')
    i.add_argument('file', type=Path)
    sub.add_parser('clean')
    sub.add_parser('bundle')
    sub.add_parser('renote')
    rj = sub.add_parser('rejudge')
    rj.add_argument('run', nargs='?', help='id прогона; без него — все прогоны')
    so = sub.add_parser('sources')
    so.add_argument('--repo', type=Path, help='репозиторий агента: промпты и инструменты из кода')
    so.add_argument('--file', action='append', default=[], help='файл владельца: путь[:prompt|knowledge]')
    w = sub.add_parser('gateway')
    w.add_argument('--url')
    w.add_argument('--cert', help='клиентский сертификат (PEM)')
    w.add_argument('--key', help='закрытый ключ (PEM)')
    w.add_argument('--ca', help='корневой сертификат шлюза (PEM), если он не в системном хранилище')
    w.add_argument('--insecure', action='store_true', help='не проверять сертификат шлюза')
    w.add_argument('--model', help='модель судьи и симулятора')
    w.add_argument('--second-model', help='модель второго судьи (другой вендор)')
    g = sub.add_parser('ping')
    g.add_argument('--target', required=True)
    g.add_argument('--text', default='Какой процент эквайринга?')
    args = parser.parse_args()

    def show(**values):
        print(values.get('message', ''), f"{values.get('done', '')}/{values.get('total', '')}", flush=True)

    if args.command == 'serve':
        import uvicorn
        uvicorn.run('lab.server:app', host='127.0.0.1', port=args.port, log_level='warning')
    elif args.command == 'discover':
        from . import discover
        value = asyncio.run(discover.run(args.count, show, args.replan))
        print(json.dumps({k: value['summary'][k] for k in ('checked', 'failed', 'passed', 'unmeasured')}, ensure_ascii=False))
    elif args.command == 'cards':
        from . import cards
        print(len(asyncio.run(cards.run(show))), 'карточек')
    elif args.command == 'run':
        from . import simulate, store
        record = asyncio.run(simulate.run(args.target, None, args.label, show, judge_later=args.judge_later,
                                          repeats=max(1, args.repeats)))
        if record.get('judgeLater'):
            print(f"Записано разговоров: {sum(1 for i in record['items'] if i['status'] == 'PENDING')}; оценка — при импорте в Lab.")
        else:
            print(json.dumps(record['metric'], ensure_ascii=False))
        print('Файл прогона:', store.RUNS / (record['id'] + '.json'))
        if record['error']:
            print('Ошибка:', record['error'], file=sys.stderr)
            sys.exit(1)
    elif args.command == 'clean':
        from . import store, workshop
        for record in store.runs():
            for item in record.get('items') or []:
                if item.get('runId'):
                    workshop.forget(item['runId'])
            (store.RUNS / (record['id'] + '.json')).unlink(missing_ok=True)
        workshop.drop_folders('Agent Lab · ', keep=('Agent Lab · Логи',))
        print('Прогоны удалены; логи и сценарии сохранены.')
    elif args.command == 'gateway':
        import os
        from . import llm, store
        if args.url or args.cert or args.key:
            if not (args.url and args.cert and args.key):
                sys.exit('Нужны все три: --url, --cert, --key')
            paths = {name: os.path.abspath(os.path.expanduser(value)) for name, value in
                     (('certPath', args.cert), ('keyPath', args.key), ('caPath', args.ca)) if value}
            for name, path in paths.items():
                if not os.access(path, os.R_OK):
                    sys.exit(f'Файл не читается: {name}')
            settings = {'format': 'agent-lab-gateway-1', 'url': args.url, **paths}
            if args.insecure:
                settings['insecure'] = True
            llm.GATEWAY_FILE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            llm.GATEWAY_FILE.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            llm.GATEWAY_FILE.chmod(0o600)
            print('Настройка шлюза сохранена:', llm.GATEWAY_FILE, '(только пути, не содержимое ключа)')
        if args.model or args.second_model:
            models = store.load('models.json', {}) or {}
            models.update({k: v for k, v in (('model', args.model), ('second', args.second_model)) if v})
            store.save('models.json', models)
        config = llm.gateway_config()
        if not config:
            sys.exit(f'Шлюз не настроен: {llm.GATEWAY_FILE} или переменные AGENT_LAB_GATEWAY_URL / _CERT_PATH / _KEY_PATH')
        print('Шлюз:', config['url'], '| CA:', 'свой файл' if config.get('ca') else 'системный', '| проверка сертификата шлюза:', 'выключена' if config.get('insecure') else 'включена')
        try:
            catalog = asyncio.run(llm.gateway_catalog())
        except (llm.ModelError, Exception) as error:
            sys.exit(f'Шлюз недоступен: {type(error).__name__}: {error}')
        print('Модели в каталоге:', ', '.join(catalog) or '—')
        models = store.load('models.json', {}) or {}
        for role, key in (('судья и симулятор', 'model'), ('второй судья', 'second')):
            chosen = os.environ.get('LAB_MODEL' if key == 'model' else 'LAB_SECOND_MODEL') or models.get(key)
            state = 'не выбрана' if not chosen else ('есть в каталоге' if chosen in catalog else 'НЕТ в каталоге')
            print(f'{role}: {chosen or "—"} ({state})')
    elif args.command == 'ping':
        import uuid
        import httpx
        from . import targets
        agent = targets.create(args.target)
        build = targets._prod_request if agent.profile == 'prod' else targets._local_request
        headers, body = build(str(uuid.uuid4()), args.text)
        print('POST', agent.url)
        print(json.dumps({'headers': headers, 'body': body}, ensure_ascii=False, indent=2))
        try:
            response = httpx.post(agent.url, json=body, headers=headers, timeout=targets.TIMEOUT)
        except httpx.HTTPError as error:
            sys.exit(f'Нет соединения: {type(error).__name__}: {error}')
        print('HTTP', response.status_code)
        try:
            data = response.json()
            print(json.dumps(data, ensure_ascii=False, indent=2)[:6000])
            content = (data.get('message') or {}).get('content') or {}
            print('\nLab прочитает: статус', content.get('status_code'), '| ответ:', (content.get('result') or content.get('reason') or '—')[:300],
                  '| кнопки:', [o.get('text') for o in data.get('suggestions') or [] if isinstance(o, dict)])
        except ValueError:
            print(response.text[:3000])
    elif args.command == 'sources':
        from . import sources
        files = [(Path(v.rsplit(':', 1)[0]).expanduser(), v.rsplit(':', 1)[1] if v.rsplit(':', 1)[-1] in ('prompt', 'knowledge') else 'prompt')
                 for v in args.file]
        collected = sources.build(args.repo.expanduser() if args.repo else None, files)
        for s in collected:
            print(f"{s['id']:4} {s['kind']:9} {len(s['content']):6} зн.  {s['origin']}")
        print('Источники сохранены. Правила из них: python -m lab discover --replan')
    elif args.command == 'rejudge':
        from . import simulate, store
        for record in store.runs():
            if args.run and record['id'] != args.run:
                continue
            record = asyncio.run(simulate.rejudge(record))
            print(record['targetName'], json.dumps(record['metric'], ensure_ascii=False))
        print('Заметки судьи: python -m lab renote')
    elif args.command == 'renote':
        import httpx
        from . import store, workshop
        from .discover import verdict_note
        count = 0
        analysis = store.load('discover.json') or {'results': [], 'topics': []}
        topics = {t['id']: t['title'] for t in analysis['topics']}
        for r in analysis['results']:
            if r.get('runId'):
                note = verdict_note(r['status'], f"Записанный разговор из логов · тема «{topics.get(r['topicId'], '')}»",
                                    r['rules'], r.get('error'), r.get('second'), recorded=True)
                workshop.annotate(r['runId'], 'issue' if r['status'] == 'FAIL' else 'note', note, replace=True)
                count += 1
        for record in store.runs():
            for item in record['items']:
                if item.get('runId') and item['status'] not in ('RUNNING', 'PENDING'):
                    title = item['name'] + (f" · повтор {item['attempt']}" if item.get('attempt', 1) > 1 else '')
                    note = verdict_note(item['status'], f"Сценарий «{title}» · {record['targetName']} ({record['version']})",
                                        item['rules'], item.get('error'), item.get('second'))
                    workshop.annotate(item['runId'], 'issue' if item['status'] == 'FAIL' else 'note', note, replace=True)
                    mark = {'PASS': '✓', 'FAIL': '✗', 'UNMEASURED': '?'}.get(item['status'], '…')
                    httpx.patch(f"{workshop.URL}/api/runs/{item['runId']}", json={'name': f'{mark} {title}'[:200]}, timeout=5)
                    count += 1
        print('Заметок судьи обновлено:', count)
    elif args.command == 'bundle':
        import zipfile
        from . import store
        root = Path(__file__).resolve().parent
        out = store.DATA / 'agent-lab-work-kit.zip'
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as kit:
            for path in sorted(root.glob('*.py')):
                kit.write(path, f'agent-lab-work-kit/lab/{path.name}')
            for name in ('cards.json', 'targets.json', 'sources.json', 'discover.json', 'logs.jsonl'):
                if (store.DATA / name).exists():
                    kit.write(store.DATA / name, f'agent-lab-work-kit/lab/data/{name}')
            kit.write(root / 'WORK-COMPUTER.md', 'agent-lab-work-kit/README.md')
            kit.write(root / 'run-prod.sh', 'agent-lab-work-kit/run-prod.sh')
            kit.write(root / 'run-prod.bat', 'agent-lab-work-kit/run-prod.bat')
            kit.writestr('agent-lab-work-kit/certs/README.txt',
                         'url.txt — адрес шлюза моделей (одна строка, например https://…/v2)\n'
                         'сертификат и ключ — .pem/.crt и .key, или один .p12/.pfx (пароль — в password.txt)\n'
                         'ca.pem или root.pem — корневой сертификат банка, только если без него не пускает\n')
        print('Архив для рабочего компьютера:', out)
    elif args.command == 'import':
        from . import simulate
        record = asyncio.run(simulate.import_run(json.loads(args.file.read_text(encoding='utf-8')), show))
        print('Импортировано:', record['id'], json.dumps(record['metric'], ensure_ascii=False))


if __name__ == '__main__':
    main()
