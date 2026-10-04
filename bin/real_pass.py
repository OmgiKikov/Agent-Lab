#!/usr/bin/env python3
"""Проход на настоящих модели и агенте: один раз прогоняет через запущенный Agent Lab обе проверки, сборку сценариев
и прогон симуляции и печатает, что получилось на каждом шаге.

Запуск на рабочем компьютере, когда Agent Lab уже запущен (`sh bin/start.sh`):

    python3 bin/real_pass.py --export выгрузка.xlsx --rules правила.docx

Скрипт создаёт отдельного агента «Проход …» и работает только в нём: данные других агентов не трогает. Запросы идут
только в ваш Agent Lab, а он — в ту модель и того агента, что настроены у него. В выводе только шаги, числа и тексты
ошибок, без разговоров: его можно переслать. Стандартная библиотека Python, без зависимостей.
"""

import argparse
import contextlib
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

POLL = 2.0  # seconds between looks at a running job
STEP_TIMEOUT = 45 * 60  # a check of hundreds of conversations through a slow gateway still fits
Found = tuple[str, object]  # what a step says, and what it hands on (None: nothing)


class Lab:
    """The running Agent Lab, inside one agent (X-Agent) once it is created."""

    def __init__(self, base: str) -> None:
        self.base = base.rstrip('/')
        self.agent: str | None = None

    def call(self, method: str, path: str, body: object = None, raw: bytes | None = None) -> dict:
        headers = {'X-Agent': self.agent} if self.agent else {}
        data = raw
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode()
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=600) as response:
                text = response.read().decode() or '{}'
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors='replace')
            with contextlib.suppress(ValueError, AttributeError):
                detail = json.loads(detail).get('detail', detail)
            raise RuntimeError(f'HTTP {error.code}: {detail}') from None
        except urllib.error.URLError as error:
            raise RuntimeError(f'Agent Lab не отвечает на {self.base}: {error.reason}') from None
        return json.loads(text)

    def upload(self, path: str, file: Path) -> dict:
        return self.call('POST', f'{path}?name={urllib.parse.quote(file.name)}', raw=file.read_bytes())

    def state(self) -> dict:
        return self.call('GET', '/api/state')

    def job(self, kind: str, path: str, body: object = None) -> dict:
        """Start a job and wait for it: the state after it, or the job's own error."""
        self.call('POST', path, body)
        started = shown = time.monotonic()
        while True:
            time.sleep(POLL)
            state = self.state()
            job = state['job']
            if job.get('kind') == kind and not job.get('running'):
                if job.get('error'):
                    raise RuntimeError(job['error'])
                return state
            if time.monotonic() - started > STEP_TIMEOUT:
                raise RuntimeError(f'задание «{kind}» идёт дольше {STEP_TIMEOUT // 60} минут')
            if time.monotonic() - shown > 30:
                shown = time.monotonic()
                progress = job.get('progress') or {}
                done, total = progress.get('done'), progress.get('total')
                print(f'      … {progress.get("message") or "идёт"}' + (f' ({done} из {total})' if total else ''))


class Pass:
    """The steps of the pass and how each went."""

    def __init__(self) -> None:
        self.steps: list[tuple[str, bool, str]] = []

    def step(self, name: str, work: Callable[[], Found]) -> object:
        """Run one step: what it hands on (True when nothing), or None when it failed. The pass goes on where it can."""
        print(f'— {name}')
        started = time.monotonic()
        try:
            detail, value = work()
        except Exception as error:  # every failure is reported, none stops the report
            self.steps.append((name, False, str(error)))
            print(f'  ✗ {error}')
            return None
        took = f'{time.monotonic() - started:.0f} с'
        self.steps.append((name, True, f'{detail} · {took}'))
        print(f'  ✓ {detail} · {took}')
        return True if value is None else value

    def report(self) -> int:
        print('\nИтог прохода')
        for name, ok, detail in self.steps:
            print(f'  {"✓" if ok else "✗"} {name}: {detail}')
        failed = [name for name, ok, _ in self.steps if not ok]
        print('\nВсё прошло.' if not failed else f'\nНе прошло шагов: {len(failed)}.')
        return 1 if failed else 0


def summary_line(result: dict | None) -> str:
    s = (result or {}).get('summary') or {}
    return (
        f'{s.get("failed", "?")} из {s.get("measured", "?")} проверенных разговоров — с ошибкой агента; '
        f'не удалось проверить: {s.get("unmeasured", "?")}'
    )


def start(lab: Lab, run: Pass) -> bool:
    """Agent Lab answers, a separate agent for the pass, the models answer."""

    def agent() -> Found:
        created = lab.call('POST', '/api/agents', {'name': f'Проход {datetime.now():%d.%m %H:%M}'})
        lab.agent = created['id']
        return f'агент «{created["name"]}» ({created["id"]})', None

    def models() -> Found:
        checked = lab.call('POST', '/api/models/check')
        main = checked.get('main') or {}
        if not main.get('ok'):
            raise RuntimeError(f'основная модель не отвечает: {main.get("error") or main}')
        line = f'разговоры уходят в {(lab.state().get("models") or {}).get("via") or "?"}'
        second = checked.get('second')
        if second is not None:
            line += ' · вторая модель ' + ('отвечает' if second.get('ok') else f'не отвечает: {second.get("error")}')
        return line, None

    return bool(
        run.step('Agent Lab отвечает', lambda: (lab.call('GET', '/health').get('product', 'ok'), None))
        and run.step('Отдельный агент для прохода', agent)
        and run.step('Модели отвечают', models)
    )


def tone_of_voice(lab: Lab, run: Pass, args: argparse.Namespace) -> None:
    """The export, the rules of communication, their criteria and the check by them."""

    def rules() -> Found:
        if args.rules.suffix.lower() in ('.txt', '.md'):
            text = args.rules.read_text(encoding='utf-8-sig')
        else:
            text = lab.upload('/api/tone-of-voice/read-file', args.rules)['text']
        lab.call('POST', '/api/tone-of-voice/policy', {'text': text, 'name': args.rules.name})
        return f'{len(text)} символов', None

    def criteria() -> Found:
        draft = lab.job('tone-criteria', '/api/tone-of-voice/criteria').get('toneOfVoice') or {}
        if not draft.get('criteria'):
            raise RuntimeError('критериев не нашлось')
        return f'{len(draft["criteria"])} критериев', draft

    run.step('Выгрузка загружена', lambda: (f'{lab.upload("/api/logs", args.export)["total"]} разговоров', None))
    run.step('Правила общения сохранены', rules)
    draft = run.step('Tone of voice: критерии собраны', criteria)
    if draft:

        def check() -> Found:
            body = {'ruleIds': [c['id'] for c in draft['criteria']][:20], 'count': args.count, 'propose': True}
            result = lab.job('tone-check', '/api/tone-of-voice/check', body | {'revision': draft['revision']})
            return summary_line(result['checks']['tone']), None

        if run.step('Tone of voice: разговоры проверены', check):
            run.step('Tone of voice: серьёзность предложена', lambda: severity_line(lab, 'tone'))


def severity_line(lab: Lab, check: str) -> Found:
    """What the model proposed after the check: how many criteria it called serious, and why the first of them."""
    found = lab.call('GET', f'/api/problems?check={check}')
    said = found.get('severity') or {}
    if said.get('error'):
        raise RuntimeError(said['error'])
    serious = [rule for rule in found['rules'] if rule['serious']]
    if not said.get('proposed') and not said.get('decided'):
        raise RuntimeError('модель ничего не предложила')
    first = serious[0] if serious else None
    reason = ((first or {}).get('severity') or {}).get('proposed') or {}
    why = f': «{first["title"]}» — {reason.get("reason", "")}' if first else ''
    return f'серьёзных {len(serious)} из {said["criteria"]} критериев{why}', None


def accuracy(lab: Lab, run: Pass, args: argparse.Namespace) -> None:
    """The agent's code read, and the check by the criteria from it."""

    def code() -> Found:
        found = [s for s in lab.job('sources', '/api/sources').get('sources') or [] if s.get('id') != 'tone-of-voice']
        return f'{len(found)} источников: ' + ', '.join(s.get('origin', s['id']) for s in found[:5]), found

    def check() -> Found:
        result = lab.job('discover', '/api/discover', {'count': max(5, args.count), 'propose': True})
        return summary_line(result['checks']['code']), None

    if run.step('Точность: код агента прочитан', code) and run.step('Точность: разговоры проверены', check):
        run.step('Точность: серьёзность предложена', lambda: severity_line(lab, 'code'))


def simulations(lab: Lab, run: Pass, args: argparse.Namespace) -> None:
    """Scenarios from the errors of a check, played with the agent, and their cards."""

    def scenarios() -> Found:
        check = 'tone' if (lab.state().get('checks') or {}).get('tone') else 'code'
        state = lab.job('cards', '/api/cards', {'check': check})
        deck = (state.get('cards') or {}).get('cards') or []
        if not deck:
            raise RuntimeError('ни одного сценария')
        failed = (state['job'].get('progress') or {}).get('failed') or []
        return f'{len(deck)} сценариев из {check}' + (f', не собрано {len(failed)}' if failed else ''), deck

    deck = run.step('Симуляции: сценарии собраны', scenarios)
    if not deck:
        return

    def play() -> Found:
        ready = [t['id'] for t in lab.state()['targets'] if t.get('ready') and t['id'] != 'local-http']
        target = args.target or next(iter(ready), None)
        if target is None:
            raise RuntimeError('агент не подключён: задайте адрес на стенде или папку с кодом в разделе «Агент»')
        body = {'target': target, 'label': 'Проход', 'personas': ['default'], 'repeats': 1}
        record = lab.job('run', '/api/runs', body | {'cardIds': [c['id'] for c in deck[: args.scenarios]]})['runs'][0]
        m = record.get('metric') or {}
        line = (
            f'агент {target}: {m.get("total", "?")} разговоров, без ошибок {m.get("passed", "?")}, '
            f'не удалось проверить {m.get("unmeasured", "?")} · статус {record.get("status")}'
        )
        return line + (f' · {record["error"]}' if record.get('error') else ''), None

    def cards() -> Found:
        found = lab.call('GET', '/api/scenarios').get('cards') or []
        return f'{sum(1 for c in found if c.get("history"))} из {len(found)} сценариев с результатом на карточке', None

    if run.step('Симуляции: сценарии сыграны', play):
        run.step('Симуляции: карточки сценариев', cards)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--lab', default='http://127.0.0.1:5899', help='адрес Agent Lab (по умолчанию %(default)s)')
    parser.add_argument('--export', required=True, type=Path, help='выгрузка чата: .xlsx или .jsonl')
    parser.add_argument('--rules', required=True, type=Path, help='правила общения: .docx, .txt или .md')
    parser.add_argument('--count', type=int, default=20, help='сколько разговоров проверить (%(default)s)')
    parser.add_argument('--target', help='подключение агента: prod, local-http или local-code (первое настроенное)')
    parser.add_argument('--scenarios', type=int, default=4, help='сколько сценариев сыграть (%(default)s)')
    args = parser.parse_args()
    for path in (args.export, args.rules):
        if not path.is_file():
            parser.error(f'нет файла {path}')
    lab, run = Lab(args.lab), Pass()
    print(f'Проход Agent Lab · {args.lab} · {datetime.now():%d.%m.%Y %H:%M}\n')
    if start(lab, run):
        tone_of_voice(lab, run, args)
        accuracy(lab, run, args)
        simulations(lab, run, args)
    return run.report()


if __name__ == '__main__':
    sys.exit(main())
