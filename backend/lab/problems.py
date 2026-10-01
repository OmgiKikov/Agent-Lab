"""Rules and problems: every rule of the log audit with its verdicts in the logs and in one simulator run.

A rule is keyed by its source quote, as in discover.summarize: the same rule restated in several topics is one rule.
A problem is a rule the judge found violated at least once. Logs and a run are two sides of a rule, counted apart:
other conversations, other customers. The record is described in section 8 of
docs/superpowers/specs/2026-09-30-agent-lab-unified-product-design.md.
"""

import hashlib
from collections import Counter

from . import cards, discover, personas, quotes, store
from .context import sources

COUNTED = {'FAIL': 'failed', 'PASS': 'passed', 'UNKNOWN': 'unknown'}
WORSE = {'FAIL': 2, 'PASS': 1, 'UNKNOWN': 0}
ORDER = {'FAIL': 0, 'PASS': 1, 'UNKNOWN': 2}
MEASURED = ('PASS', 'FAIL', 'UNMEASURED')


def rule_key(quote: str) -> str:
    return 'r-' + hashlib.sha1(quotes.normalized(quote).encode()).hexdigest()[:10]


def chosen_run(run_id: str | None) -> dict | None:
    """The run asked for, or the newest finished one that has conversations."""
    if run_id:
        return store.run(run_id)
    finished = (r for r in store.runs() if r.get('finishedAt') and r.get('status') != 'running' and r.get('items'))
    return next(finished, None)


def second_of(second: dict | None, rule_id: str, status: str, dialogue_status: str) -> tuple[str | None, str | None]:
    """The second judge on this verdict: per rule when it gave rows, else on the whole conversation (older records)."""
    if not second or second.get('status') not in MEASURED:
        return None, None
    rows = second.get('rules')
    if rows:
        row = next((r for r in rows if r.get('ruleId') == rule_id), None)
        if not row or row.get('status') not in ('PASS', 'FAIL'):
            return None, None
        return ('agree' if row['status'] == status else 'disagree'), 'rule'
    return ('agree' if second['status'] == dialogue_status else 'disagree'), 'dialogue'


def review_of(row: dict, item: dict | None = None) -> tuple[str | None, str | None]:
    """A person's decision on this verdict, or on the whole conversation (older simulator records)."""
    if row.get('review') in ('agree', 'disagree'):
        return row['review'], 'rule'
    if item and item.get('review') in ('agree', 'disagree'):
        return item['review'], 'dialogue'
    return None, None


def reliability(example: dict) -> int:
    """How well a violation is backed: confirmed by a person, both judges agree, one judge, judges split, refuted."""
    if example['review'] == 'disagree':
        return 4
    if example['review'] == 'agree':
        return 0
    return {'agree': 1, None: 2, 'disagree': 3}[example['second']]


class Book:
    """Rules by key, filled from the log audit and then from the run; a conversation counts once per rule."""

    def __init__(self, srcs: list[dict]) -> None:
        self.srcs = {s['id']: s for s in srcs}
        self.rules: dict[str, dict] = {}
        self.by_text: dict[str, dict] = {}

    def source(self, rule: dict) -> dict:
        known = self.srcs.get(rule.get('sourceId') or '')
        if known and quotes.found(rule.get('quote', ''), known['content']):
            return known
        return next((s for s in self.srcs.values() if quotes.found(rule.get('quote', ''), s['content'])), {})

    def entry(self, rule: dict, topic: str) -> dict:
        key = rule_key(rule.get('quote') or rule['text'])
        if key not in self.rules:
            source = self.source(rule)
            self.rules[key] = {
                'id': key,
                'rule': {
                    'name': rule.get('name', ''),
                    'text': rule['text'],
                    'quote': rule.get('quote', ''),
                    'sourceId': source.get('id'),
                    'origin': source.get('origin') or source.get('name') or '',
                    'kind': source.get('kind', ''),
                    'condition': rule.get('condition', ''),
                    'acceptable': rule.get('acceptable', ''),
                },
                'topics': [],
                'found': {'log': {}, 'sim': {}},
            }
            self.by_text[quotes.normalized(rule['text'])] = rule
        entry = self.rules[key]
        if not entry['rule']['name'] and rule.get('name'):
            entry['rule']['name'] = rule['name']
        if topic and topic not in entry['topics']:
            entry['topics'].append(topic)
        return entry

    def add(self, entry: dict, where: str, at: str, example: dict, title: str) -> None:
        """One verdict of one conversation; when a conversation has the rule twice, its worst verdict counts."""
        found = entry['found'][where]
        if at in found and WORSE[found[at][0]['status']] >= WORSE[example['status']]:
            return
        found[at] = (example, title)


def from_logs(book: Book, analysis: dict) -> dict | None:
    """The audit's verdicts into the book; its line of counts."""
    if not analysis:
        return None
    rules = {}
    for topic in analysis.get('topics') or []:
        for rule in topic['rules']:
            book.entry(rule, topic['title'])
            rules[rule['id']] = (topic['title'], rule)
    results = analysis.get('results') or []
    for result in results:
        for row in result.get('rules') or []:
            if row.get('status') not in COUNTED or row.get('ruleId') not in rules:
                continue
            topic, rule = rules[row['ruleId']]
            second, second_scope = second_of(result.get('second'), row['ruleId'], row['status'], result['status'])
            review, review_scope = review_of(row)
            example = {
                'source': 'log',
                'dialogueId': str(result['dialogueId']),
                'ruleId': row['ruleId'],
                'status': row['status'],
                'opening': result.get('opening', ''),
                'topic': topic,
                'agentQuote': row.get('agentQuote', ''),
                'reason': row.get('reason', ''),
                'second': second,
                'secondScope': second_scope,
                'review': review,
                'reviewScope': review_scope,
            }
            book.add(book.entry(rule, topic), 'log', example['dialogueId'], example, row.get('title', ''))
    measured = [r for r in results if r['status'] in ('PASS', 'FAIL')]
    sampled = analysis.get('sampled', len(results))
    return {
        'sampled': sampled,
        'assessed': len(measured),
        'withViolations': sum(1 for r in measured if r['status'] == 'FAIL'),
        'unassessed': sampled - len(measured),
        'finishedAt': analysis.get('finishedAt'),
        'rulesSince': analysis.get('rulesSince'),
    }


def recorded_rule(book: Book, row: dict, known: dict, has_snapshot: bool) -> dict | None:
    """Keep legacy verdicts even when their deck is gone; never invent their missing source quote."""
    rule = known.get(row.get('ruleId'))
    if rule:
        return rule
    text = row.get('rule', '')
    if not text:
        return None
    if not has_snapshot:
        rule = book.by_text.get(quotes.normalized(text))
        if rule:
            return rule
        for builtin in (cards.ANSWERS_THE_QUESTION, cards.FOLLOWS_KNOWLEDGE):
            if row.get('ruleId') == builtin['id'] and quotes.normalized(text) == quotes.normalized(builtin['text']):
                return builtin
    return {'text': text, 'quote': ''}


def from_run(book: Book, run: dict | None, deck: list[dict]) -> dict | None:
    """The run's verdicts into the book; its line of counts. A rule is the criterion frozen in the played item (else
    its scenario's), or the audit's rule with the same text."""
    if not run:
        return None
    by_card = {card['id']: card.get('criteria') or [] for card in deck}
    items = run.get('items') or []
    for index, item in enumerate(items):
        frozen = item.get('criteria') if isinstance(item.get('criteria'), list) else by_card.get(item.get('cardId'), [])
        known = {criterion['id']: criterion for criterion in frozen}
        conversation = item.get('conversation') or []
        for row in item.get('rules') or []:
            rule = recorded_rule(book, row, known, isinstance(item.get('criteria'), list))
            if row.get('status') not in COUNTED or not rule:
                continue
            second, second_scope = second_of(item.get('second'), row['ruleId'], row['status'], item['status'])
            review, review_scope = review_of(row, item)
            example = {
                'source': 'sim',
                'runId': run['id'],
                'index': index,
                'ruleId': row['ruleId'],
                'status': row['status'],
                'opening': conversation[0]['text'] if conversation else item.get('name', ''),
                'topic': item.get('topic', ''),
                'name': item.get('name', ''),
                'persona': item.get('persona') or personas.DEFAULT,
                'attempt': item.get('attempt', 1),
                'agentQuote': row.get('agentQuote', ''),
                'reason': row.get('reason', ''),
                'second': second,
                'secondScope': second_scope,
                'review': review,
                'reviewScope': review_scope,
            }
            entry = book.entry(rule, item.get('topic', ''))
            book.add(entry, 'sim', f'{run["id"]}#{index}', example, row.get('title', ''))
    done = [i for i in items if i.get('status') in MEASURED]
    assessed = sum(1 for i in done if i['status'] in ('PASS', 'FAIL'))
    return {
        'runId': run['id'],
        'target': run.get('targetName', ''),
        'version': run.get('version', ''),
        'dialogs': len(done),
        'assessed': assessed,
        'unassessed': len(done) - assessed,
        'withViolations': sum(1 for i in done if i['status'] == 'FAIL'),
        'finishedAt': run.get('finishedAt'),
    }


def verdicts(entry: dict, where: str) -> tuple[dict, list[str]]:
    """Counts and examples of one side: violations first, the best backed first, then fulfilled, then unchecked."""
    rows = list(entry['found'][where].values())
    examples = sorted(
        (e for e, _ in rows), key=lambda e: (ORDER[e['status']], reliability(e) if e['status'] == 'FAIL' else 0)
    )
    counts = Counter(COUNTED[e['status']] for e in examples)
    titles = [t for e, t in rows if e['status'] == 'FAIL' and t]
    side = {'failed': counts['failed'], 'passed': counts['passed'], 'unknown': counts['unknown'], 'examples': examples}
    return side, titles


def finish(entry: dict, deck: list[dict]) -> dict:
    log, log_titles = verdicts(entry, 'log')
    sim, sim_titles = verdicts(entry, 'sim')
    failed = [e for e in log['examples'] + sim['examples'] if e['status'] == 'FAIL']
    judged = [e for e in failed if e['second']]
    reviewed = [e['review'] for e in failed if e['review']]
    dialogues = {e['dialogueId'] for e in log['examples'] if e['status'] == 'FAIL'}
    common = Counter(log_titles).most_common(1) or Counter(sim_titles).most_common(1)
    return {
        'id': entry['id'],
        'title': common[0][0] if common else entry['rule']['text'],
        'rule': entry['rule'],
        'topics': entry['topics'],
        'log': log,
        'sim': sim,
        'secondJudge': {
            'checked': len(judged),
            'agree': sum(1 for e in judged if e['second'] == 'agree'),
            'byDialogue': sum(1 for e in judged if e['secondScope'] == 'dialogue'),
        },
        'human': {'agree': reviewed.count('agree'), 'disagree': reviewed.count('disagree')},
        'scenarioIds': [c['id'] for c in deck if str(c.get('sourceDialogueId')) in dialogues],
    }


def build(run_id: str | None = None) -> dict:
    deck = cards.deck()
    book = Book(sources.load())
    log = from_logs(book, store.load(discover.RESULT) or {})
    sim = from_run(book, chosen_run(run_id), deck)
    rules = [finish(entry, deck) for entry in book.rules.values()]
    rules.sort(key=lambda r: (-r['log']['failed'], -r['sim']['failed'], r['rule']['text']))
    return {
        'log': log,
        'sim': sim,
        'rules': rules,
        'problems': [r['id'] for r in rules if r['log']['failed'] or r['sim']['failed']],
    }
