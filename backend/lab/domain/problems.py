"""Rules and problems of one check: every rule of its result with its verdicts in the logs and in one simulator run
of that check.

A rule is keyed by its source quote, as in results.summarize: the same rule restated in several topics is one rule.
A problem is a rule the judge found violated at least once. Logs and a run are two sides of a rule, counted apart:
other conversations, other customers. A side counts a rule only in the conversations its line counts as checked, so a
criterion never has more conversations than its check. One record per check.
"""

import hashlib
from collections import Counter

from . import quotes
from .personas import DEFAULT
from .scenarios import ANSWERS_THE_QUESTION, FOLLOWS_KNOWLEDGE

COUNTED = {'FAIL': 'failed', 'PASS': 'passed', 'UNKNOWN': 'unknown'}
WORSE = {'FAIL': 2, 'PASS': 1, 'UNKNOWN': 0}
ORDER = {'FAIL': 0, 'PASS': 1, 'UNKNOWN': 2}
MEASURED = ('PASS', 'FAIL', 'UNMEASURED')
DECIDED = ('PASS', 'FAIL')


def rule_key(quote: str) -> str:
    return 'r-' + hashlib.sha1(quotes.normalized(quote).encode()).hexdigest()[:10]


def second_of(
    second: dict | None, rule_id: str, status: str, dialogue_status: str
) -> tuple[str | None, str | None, str | None]:
    """The second judge on this verdict and what it said: per rule when it gave rows, else on the whole conversation
    (older records). Only two decided verdicts agree or disagree; a check that decided nothing is no second opinion."""
    if not second or second.get('status') not in MEASURED:
        return None, None, None
    rows = second.get('rules')
    if rows:
        row = next((r for r in rows if r.get('ruleId') == rule_id), None)
        if not row or row.get('status') not in DECIDED:
            return None, None, None
        return ('agree' if row['status'] == status else 'disagree'), 'rule', row['status']
    if second['status'] not in DECIDED or dialogue_status not in DECIDED:
        return None, None, None
    return ('agree' if second['status'] == dialogue_status else 'disagree'), 'dialogue', second['status']


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
        # The conversations each side's line counts as checked, as the verdicts of a rule are keyed (add): the audit's
        # with a verdict, the run's items it measured. A rule's counts are of these only (verdicts).
        self.checked: dict[str, set[str]] = {'log': set(), 'sim': set()}

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
                # The ids its verdicts carry in each stage: a verdict keeps the wording the judge saw, clarifications
                # included, so a screen finds the rule of a verdict by id, not by text.
                'ruleIds': {'log': set(), 'sim': set()},
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


def keys_of(analysis: dict) -> dict[str, str]:
    """The key (rule_key) of each criterion id of a result, as the book keys its rules."""
    return {
        rule['id']: rule_key(rule.get('quote') or rule['text'])
        for topic in analysis.get('topics') or []
        for rule in topic['rules']
    }


def serious_counts(analysis: dict, serious: set[str]) -> dict[str, int]:
    """Among the checked conversations of a result: those with an error by at least one criterion marked serious
    (`failed`), and those where at least one such criterion could be checked (`checked`; elsewhere it did not apply or
    could not be checked) — what that count rests on."""
    keys = keys_of(analysis)
    failed = checked = 0
    for result in analysis.get('results') or []:
        if result['status'] not in DECIDED:
            continue
        rows = [row for row in result.get('rules') or [] if keys.get(row.get('ruleId')) in serious]
        checked += any(row.get('status') in DECIDED for row in rows)
        failed += any(row.get('status') == 'FAIL' for row in rows)
    return {'failed': failed, 'checked': checked}


def from_logs(book: Book, analysis: dict, serious: set[str] = frozenset()) -> dict | None:
    """The audit's verdicts into the book; its line of counts, once a criterion is marked serious with the
    conversations that have a serious error (withSerious) and those where a serious criterion could be checked
    (seriousChecked); no such keys before."""
    if not analysis:
        return None
    rules = {}
    for topic in analysis.get('topics') or []:
        for rule in topic['rules']:
            book.entry(rule, topic['title'])['ruleIds']['log'].add(rule['id'])
            rules[rule['id']] = (topic['title'], rule)
    results = analysis.get('results') or []
    for result in results:
        for row in result.get('rules') or []:
            if row.get('status') not in COUNTED or row.get('ruleId') not in rules:
                continue
            topic, rule = rules[row['ruleId']]
            second, second_scope, second_status = second_of(
                result.get('second'), row['ruleId'], row['status'], result['status']
            )
            review, review_scope = review_of(row)
            example = {
                'source': 'log',
                'dialogueId': str(result['dialogueId']),
                'ruleId': row['ruleId'],
                'status': row['status'],
                'opening': result.get('opening', ''),
                'asked': row.get('asked', ''),
                'topic': topic,
                'agentQuote': row.get('agentQuote', ''),
                'reason': row.get('reason', ''),
                'second': second,
                'secondScope': second_scope,
                'secondStatus': second_status,
                'review': review,
                'reviewScope': review_scope,
            }
            book.add(book.entry(rule, topic), 'log', example['dialogueId'], example, row.get('title', ''))
    measured = [r for r in results if r['status'] in DECIDED]
    book.checked['log'] = {str(r['dialogueId']) for r in measured}
    sampled = analysis.get('sampled', len(results))
    line = {
        'sampled': sampled,
        'assessed': len(measured),
        'withViolations': sum(1 for r in measured if r['status'] == 'FAIL'),
        'unassessed': sampled - len(measured),
        'finishedAt': analysis.get('finishedAt'),
        'rulesSince': analysis.get('rulesSince'),
    }
    if not serious:
        return line
    counts = serious_counts(analysis, serious)
    return line | {'withSerious': counts['failed'], 'seriousChecked': counts['checked']}


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
        for builtin in (ANSWERS_THE_QUESTION, FOLLOWS_KNOWLEDGE):
            if row.get('ruleId') == builtin['id'] and quotes.normalized(text) == quotes.normalized(builtin['text']):
                return builtin
    return {'text': text, 'quote': ''}


def from_run(book: Book, run: dict | None, deck: list[dict], target: str = '') -> dict | None:
    """The run's verdicts into the book; its line of counts. A rule is the criterion frozen in the played item (else
    its scenario's), or the audit's rule with the same text. target: the way the run reached its agent, by its current
    name (agents.run_name)."""
    if not run:
        return None
    by_card = {card['id']: card.get('criteria') or [] for card in deck}
    items = run.get('items') or []
    for index, item in enumerate(items):
        frozen = item.get('criteria') if isinstance(item.get('criteria'), list) else by_card.get(item.get('cardId'), [])
        known = {criterion['id']: criterion for criterion in frozen}
        # A criterion of the played conversation was checked in it whatever its verdicts, as the audit's criteria are.
        for criterion in frozen:
            book.entry(criterion, item.get('topic', ''))['ruleIds']['sim'].add(criterion['id'])
        conversation = item.get('conversation') or []
        for row in item.get('rules') or []:
            rule = recorded_rule(book, row, known, isinstance(item.get('criteria'), list))
            if row.get('status') not in COUNTED or not rule:
                continue
            second, second_scope, second_status = second_of(
                item.get('second'), row['ruleId'], row['status'], item['status']
            )
            review, review_scope = review_of(row, item)
            example = {
                'source': 'sim',
                'runId': run['id'],
                'index': index,
                'ruleId': row['ruleId'],
                'status': row['status'],
                'opening': conversation[0]['text'] if conversation else item.get('name', ''),
                'asked': row.get('asked', ''),
                'topic': item.get('topic', ''),
                'name': item.get('name', ''),
                'persona': item.get('persona') or DEFAULT,
                'attempt': item.get('attempt', 1),
                'agentQuote': row.get('agentQuote', ''),
                'reason': row.get('reason', ''),
                'second': second,
                'secondScope': second_scope,
                'secondStatus': second_status,
                'review': review,
                'reviewScope': review_scope,
            }
            entry = book.entry(rule, item.get('topic', ''))
            entry['ruleIds']['sim'].add(row['ruleId'])
            book.add(entry, 'sim', f'{run["id"]}#{index}', example, row.get('title', ''))
    done = [i for i in items if i.get('status') in MEASURED]
    book.checked['sim'] = {f'{run["id"]}#{index}' for index, item in enumerate(items) if item.get('status') in DECIDED}
    assessed = len(book.checked['sim'])
    return {
        'runId': run['id'],
        'target': target,
        'version': run.get('version', ''),
        'dialogs': len(done),
        'assessed': assessed,
        'unassessed': len(done) - assessed,
        'withViolations': sum(1 for i in done if i['status'] == 'FAIL'),
        'finishedAt': run.get('finishedAt'),
    }


def verdicts(book: Book, entry: dict, where: str) -> tuple[dict, list[str]]:
    """Counts and examples of one side. The counts are of the conversations the side's line counts as checked
    (Book.checked): with an error, without one, not decided, and not applicable, the checked ones without a verdict of
    the rule (none on a side that never checked it). The examples are every verdict: violations first, the best backed
    first, then fulfilled, then unchecked."""
    found = entry['found'][where]
    examples = sorted(
        ({**e, 'title': t} for e, t in found.values()),
        key=lambda e: (ORDER[e['status']], reliability(e) if e['status'] == 'FAIL' else 0),
    )
    checked = book.checked[where]
    counts = Counter(COUNTED[e['status']] for at, (e, _) in found.items() if at in checked)
    titles = [t for e, t in found.values() if e['status'] == 'FAIL' and t]
    side = {
        'failed': counts['failed'],
        'passed': counts['passed'],
        'unknown': counts['unknown'],
        'notApplicable': len(checked) - counts.total() if entry['ruleIds'][where] else 0,
        'examples': examples,
        'ruleIds': sorted(entry['ruleIds'][where]),
    }
    return side, titles


def finish(
    book: Book,
    entry: dict,
    deck: list[dict],
    serious: set[str] = frozenset(),
    marks: dict[str, bool] | None = None,
    proposals: dict[str, dict] | None = None,
) -> dict:
    """One rule of the record. `serious`: its errors are serious, by a person's decision (`marks`), else by the model's
    proposal (`proposals`); `severity` says whose it is and what the model proposed, with its reason."""
    marks, proposals = marks or {}, proposals or {}
    log, log_titles = verdicts(book, entry, 'log')
    sim, sim_titles = verdicts(book, entry, 'sim')
    failed = [e for e in log['examples'] + sim['examples'] if e['status'] == 'FAIL']
    judged = [e for e in failed if e['second']]
    reviewed = [e['review'] for e in failed if e['review']]
    dialogues = {e['dialogueId'] for e in log['examples'] if e['status'] == 'FAIL'}
    common = Counter(log_titles).most_common(1) or Counter(sim_titles).most_common(1)
    title = common[0][0] if common else entry['rule']['text']
    # The first violation shown is one the title names and nobody refuted; the rest keep their order (stable sort).
    for side in (log, sim):
        side['examples'].sort(key=lambda e: e['status'] != 'FAIL' or e['title'] != title or e['review'] == 'disagree')
    return {
        'id': entry['id'],
        'title': title,
        'serious': entry['id'] in serious,
        'severity': {
            'by': 'person' if entry['id'] in marks else 'model' if entry['id'] in proposals else None,
            'proposed': proposals.get(entry['id']),
        },
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


def serious_by_person(rule: dict) -> bool:
    """Whether a person marked a rule of the record (finish) serious: only their decision puts its problem first,
    the model's proposal informs."""
    return rule['serious'] and rule['severity']['by'] == 'person'
