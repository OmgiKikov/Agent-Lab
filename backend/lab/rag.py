"""The knowledge-base (RAG) criteria of a replayed step and what the judge sees of the agent's trace
(spec 2026-10-05-voice360-replay-design.md). The trace comes from the local agent:
aigw-local local/agent_lab_trace.py."""

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
    """The bank systems the step called, one name a line: a tool verdict quotes the name (prompts.JUDGE_RUN)."""
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
