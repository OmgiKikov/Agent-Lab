"""The knowledge-base (RAG) criteria of a replayed step and what the judge sees of the agent's trace
(spec 2026-10-05-voice360-replay-design.md). The trace comes from the agent's recorder:
aigw-local replay/recorder.py."""

from . import match

CHAIN_OUTPUT = 2000  # an internal step's answer as the judge sees it; the prompts stay out
NOT_CALLED = 'На этом шаге агент не обращался к базе знаний.'


def _criterion(key: str, name: str, observation: str, condition: str, text: str, acceptable: str = '') -> dict:
    return {
        'id': f'rag:{key}',
        'family': 'rag',
        'name': name,
        'observation': observation,
        'condition': condition,
        'text': text,
        'acceptable': acceptable,
        'quote': '',
    }


CALLED = 'Агент обращался к базе знаний на этом шаге.'
CRITERIA = [
    _criterion(
        'query',
        'Запрос в базу знаний',
        'rag',
        CALLED,
        'Запрос, который агент отправил в базу знаний, передаёт вопрос клиента с учётом истории разговора: '
        'ничего не теряет и не добавляет.',
        'Перефразирование, удалённые персональные данные и числа.',
    ),
    _criterion(
        'relevant',
        'Найдено нужное',
        'rag',
        CALLED,
        'Среди найденных фрагментов есть те, что отвечают на вопрос клиента.',
    ),
    _criterion(
        'grounded',
        'Ответ опирается на найденное',
        'reply',
        CALLED,
        'Каждое утверждение ответа агента о шагах, разделах, сроках, суммах и условиях есть в найденных фрагментах '
        'или в данных систем банка.',
        'Данные клиента из систем банка: номера терминалов, статусы, договоры.',
    ),
    _criterion(
        'answers',
        'Ответ на вопрос',
        'reply',
        CALLED,
        'Ответ агента отвечает на вопрос клиента на этом шаге, а не на другой вопрос.',
    ),
    _criterion(
        'nothing-found',
        'Нет ответа в базе знаний',
        'reply',
        'База знаний не нашла подходящих фрагментов или не дала ответа.',
        'Агент не отвечает по существу: говорит, что не может помочь, или переводит на оператора.',
    ),
]


def called(trace: dict | None) -> bool:
    return bool(trace and trace.get('rag'))


def evidence(trace: dict | None) -> str:
    """The text a knowledge-base verdict may quote: queries, passages and the knowledge base's own answers."""
    if not trace:
        return ''
    lines = []
    for call in trace.get('rag') or []:
        lines.append(call.get('query') or '')
        lines.extend(passage.get('text') or '' for passage in call.get('passages') or [])
        lines.append(call.get('answer') or '')
    return '\n'.join(lines)


def tools(trace: dict | None) -> str:
    """The bank systems the step called, one name a line: a tool verdict quotes the name (judge.replay.txt)."""
    return '\n'.join(str(call.get('tool')) for call in (trace or {}).get('systems') or [])


def for_judge(trace: dict | None) -> dict:
    trace = trace or {}
    return {
        'chains': [
            {'name': chain.get('name'), 'output': (chain.get('output') or '')[:CHAIN_OUTPUT]}
            for chain in trace.get('chains') or []
        ],
        'rag': [
            {key: call.get(key) for key in ('source', 'status', 'query', 'filter', 'passages', 'answer', 'reason')}
            for call in trace.get('rag') or []
        ],
        'systems': [
            {key: call.get(key) for key in ('tool', 'arguments', 'response')} for call in trace.get('systems') or []
        ],
    }


def skipped(rule: dict) -> dict:
    """A knowledge-base criterion on a step without a knowledge-base call: the moment did not arise."""
    return {
        'ruleId': rule['id'],
        'rule': rule['text'],
        'status': 'NOT_APPLICABLE',
        'reason': NOT_CALLED,
        'agentQuote': '',
        'title': '',
    }


def summary(dialogues: list[dict]) -> dict:
    """What a replay says about the knowledge base (spec 2026-10-07-replay-knowledge-base-breakdown-design.md): how
    many steps used it, how many of them matched production, and each criterion's counts with the steps that failed
    it. Only the main model's verdicts count, as in flows.replay.metric."""
    steps = [(dialogue['dialogueId'], step) for dialogue in dialogues for step in dialogue['steps']]
    used = [(dialogue_id, step) for dialogue_id, step in steps if called(step.get('trace'))]
    production = _tally(match.CRITERION['id'], used)
    return {
        'steps': len(steps),
        'called': len(used),
        'match': {
            'same': production['pass'],
            'different': production['fail'],
            'unknown': production['unknown'],
            'differentSteps': production['failed'],
        },
        'criteria': [{'id': rule['id'], 'name': rule['name'], **_tally(rule['id'], used)} for rule in CRITERIA],
    }


def _tally(rule_id: str, used: list[tuple[str, dict]]) -> dict:
    """One criterion over the steps that used the knowledge base: PASS, FAIL and UNKNOWN apart, and where it failed."""
    verdicts = [
        ({'dialogueId': dialogue_id, 'step': step['index']}, _status(step, rule_id)) for dialogue_id, step in used
    ]
    return {
        'pass': sum(status == 'PASS' for _, status in verdicts),
        'fail': sum(status == 'FAIL' for _, status in verdicts),
        'unknown': sum(status == 'UNKNOWN' for _, status in verdicts),
        'failed': [ref for ref, status in verdicts if status == 'FAIL'],
    }


def _status(step: dict, rule_id: str) -> str | None:
    return next((row['status'] for row in step.get('rules') or [] if row['ruleId'] == rule_id), None)
