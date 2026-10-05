"""Explicit, repeatable import of legacy Lab JSON files into SQLite."""

import argparse
import json
from contextlib import nullcontext
from pathlib import Path

from . import checks, config, discover, logs, registry, store
from .domain import verdicts
from .metric import metric


def _recompute_verdict(value: dict) -> tuple[int, int]:
    """Reaggregate existing evidence; migration never asks a model for new evidence."""
    changed = 0
    status = verdicts.verdict_of(value.get('rules') or [])
    if status != value.get('status'):
        changed += 1
    reset = int(bool(changed and value.get('review') in ('agree', 'disagree')))
    if changed and 'review' in value:
        value['review'] = None
    value['status'] = status
    second = value.get('second')
    # Older second judges gave one verdict on the whole conversation, without rows: nothing to reaggregate.
    if second and second.get('status') != 'ERROR' and second.get('rules'):
        second_changed, second_reset = _recompute_verdict(second)
        changed += second_changed
        reset += second_reset
    return changed, reset


def _load_documents(source: Path) -> dict:
    """Read legacy documents and normalize the optional log export before any database write. A tone-of-voice result
    from the time both checks shared one place goes to its own, and a deck names its check (checks.separated)."""
    documents = {path.name: json.loads(path.read_text(encoding='utf-8')) for path in sorted(source.glob('*.json'))}
    for name, value in checks.separated(documents).items():
        if value is None:
            del documents[name]
        else:
            documents[name] = value
    log_file = source / 'logs.jsonl'
    if logs.FILE in documents:
        log_data = '\n'.join(json.dumps(row, ensure_ascii=False) for row in documents[logs.FILE]).encode('utf-8')
        documents[logs.FILE] = logs.prepare('logs.jsonl', log_data) if log_data.strip() else []
    elif log_file.exists():
        log_data = log_file.read_bytes()
        documents[logs.FILE] = logs.prepare('logs.jsonl', log_data) if log_data.strip() else []
    return documents


def migrate(source: Path) -> dict[str, int]:
    if not source.is_dir():
        raise ValueError(f'Нет папки с данными: {source}')
    documents = _load_documents(source)
    records = [json.loads(path.read_text(encoding='utf-8')) for path in sorted((source / 'runs').glob('*.json'))]
    recomputed, reset_reviews = 0, 0
    for record in records:
        if not record.get('id') or not isinstance(record.get('items'), list):
            raise ValueError('В старом прогоне нет id или items.')
        if record.get('status') == 'running':
            record.update(status='stopped', finishedAt=store.now(), error='Прогон остановился до переноса данных.')
            for item in record['items']:
                if item.get('status') == 'RUNNING':
                    reset_reviews += int(item.get('review') in ('agree', 'disagree'))
                    item.update(status='UNMEASURED', stage='', error='Прогон остановился до переноса данных.')
                    if 'review' in item:
                        item['review'] = None
        for item in record['items']:
            changed, reset = _recompute_verdict(item)
            recomputed += changed
            reset_reviews += reset
        record['metric'] = metric(record['items'])
    for analysis in filter(None, (documents.get(name) for name in checks.RESULTS.values())):
        for result in analysis['results']:
            result['dialogueId'] = str(result['dialogueId'])
            changed, reset = _recompute_verdict(result)
            recomputed += changed
            reset_reviews += reset
        analysis['summary'] = discover.summarize(analysis['results'], analysis['topics'], analysis.get('sampled'))
    return {**store.import_legacy(documents, records), 'recomputedVerdicts': recomputed, 'resetReviews': reset_reviews}


def target(agent_id: str | None) -> str | None:
    """The agent whose database the app reads the import from: the one named, or the only one. None while there are no
    agents: the default database, which the next start adopts as the first agent."""
    agents = [agent['id'] for agent in registry.listed()]
    if agent_id is None and len(agents) < 2:
        return agents[0] if agents else None
    if agent_id in agents:
        return agent_id
    listed = ', '.join(agents) or 'пока нет'
    if agent_id is None:
        raise ValueError(f'Агентов несколько. Укажите, в какого импортировать: --agent <id>. Агенты: {listed}.')
    raise ValueError(f'Нет агента «{agent_id}». Агенты: {listed}.')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path, help='Папка старых data/*.json, logs.jsonl и runs/*.json')
    parser.add_argument('--agent', help='id агента, как в адресе /a/<id>. Без него — единственный агент')
    args = parser.parse_args()
    with config.using(config.Settings.from_environment()):
        try:
            agent = target(args.agent)
        except ValueError as error:
            parser.error(str(error))
        with registry.using(agent) if agent else nullcontext():
            report = migrate(args.source)
    print(json.dumps({**report, 'agent': agent}, ensure_ascii=False))


if __name__ == '__main__':
    main()
