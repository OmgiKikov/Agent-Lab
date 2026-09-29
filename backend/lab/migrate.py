"""Explicit, repeatable import of legacy Lab JSON files into SQLite."""

import argparse
import json
from pathlib import Path

from . import discover, judge, logs, store
from .metric import metric


def _recompute_verdict(value: dict) -> tuple[int, int]:
    """Reaggregate existing evidence; migration never asks a model for new evidence."""
    changed = 0
    status = judge.verdict_of(value.get('rules') or [])
    if status != value.get('status'):
        changed += 1
    reset = int(bool(changed and value.get('review') in ('agree', 'disagree')))
    if changed and 'review' in value:
        value['review'] = None
    value['status'] = status
    second = value.get('second')
    if second and second.get('status') != 'ERROR':
        second_changed, second_reset = _recompute_verdict(second)
        changed += second_changed
        reset += second_reset
    return changed, reset


def migrate(source: Path) -> dict[str, int]:
    if not source.is_dir():
        raise ValueError(f'Нет папки с данными: {source}')
    documents = {path.name: json.loads(path.read_text(encoding='utf-8')) for path in sorted(source.glob('*.json'))}
    log_file = source / 'logs.jsonl'
    if logs.FILE in documents:
        log_data = '\n'.join(json.dumps(row, ensure_ascii=False) for row in documents[logs.FILE]).encode('utf-8')
        documents[logs.FILE] = logs.prepare('logs.jsonl', log_data) if log_data.strip() else []
    elif log_file.exists():
        log_data = log_file.read_bytes()
        documents[logs.FILE] = logs.prepare('logs.jsonl', log_data) if log_data.strip() else []
    records = [json.loads(path.read_text(encoding='utf-8')) for path in sorted((source / 'runs').glob('*.json'))]
    recomputed, reset_reviews = 0, 0
    for record in records:
        if not record.get('id') or not isinstance(record.get('items'), list):
            raise ValueError('В старом прогоне отсутствуют id или items')
        if record.get('status') == 'running':
            record.update(status='stopped', finishedAt=store.now(), error='Прогон прерван до переноса данных')
            for item in record['items']:
                if item.get('status') == 'RUNNING':
                    reset_reviews += int(item.get('review') in ('agree', 'disagree'))
                    item.update(status='UNMEASURED', stage='', error='Прогон прерван до переноса данных')
                    if 'review' in item:
                        item['review'] = None
        for item in record['items']:
            changed, reset = _recompute_verdict(item)
            recomputed += changed
            reset_reviews += reset
        record['metric'] = metric(record['items'])
    analysis = documents.get(discover.RESULT)
    if analysis:
        for result in analysis['results']:
            result['dialogueId'] = str(result['dialogueId'])
            changed, reset = _recompute_verdict(result)
            recomputed += changed
            reset_reviews += reset
        analysis['summary'] = discover.summarize(analysis['results'], analysis['topics'])
    return {**store.import_legacy(documents, records), 'recomputedVerdicts': recomputed, 'resetReviews': reset_reviews}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path, help='Папка старых data/*.json, logs.jsonl и runs/*.json')
    args = parser.parse_args()
    print(json.dumps(migrate(args.source), ensure_ascii=False))


if __name__ == '__main__':
    main()
