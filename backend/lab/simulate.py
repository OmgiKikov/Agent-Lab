"""Play scenarios against an agent; persist each conversation and evaluation in the Lab."""

import asyncio
import time
import uuid
from collections import Counter
from collections.abc import Callable
from copy import deepcopy

from . import agents, cards, checks, judge, llm, personas, store
from .agents import world
from .prompts import PERSONA_OPENING, SIMULATOR
from .transcript import with_buttons

MAX_AGENT_TURNS = 3
PARALLEL = 4
END = '[КОНЕЦ]'
NO_REPLIES = 'Агент не ответил ни в одном разговоре'
JUDGED = ('status', 'rules', 'model', 'second', 'error', 'criteria')  # what a re-judge changes in a conversation
Progress = Callable[..., None]


async def customer_says(card: dict, conversation: list[dict], details: str = '', persona: str | None = None) -> str:
    transcript = '\n\n'.join(
        ('КЛИЕНТ (это ты): ' if message['role'] == 'customer' else 'АГЕНТ: ') + with_buttons(message)
        for message in conversation
    )
    profile = ''
    if details:
        profile = f'Реквизиты (называй их, если агент спросит номер терминала, организацию или ИНН): {details}'
    request = (
        f'Переписка в чате:\n\n{transcript}\n\n'
        'Напиши следующую реплику клиента в ответ на последнее сообщение агента или [КОНЕЦ].'
    )
    manner = personas.style(persona)
    manner = f'Твоя манера общения (она важнее правил о длине и стиле ниже): {manner}' if manner else ''
    answer = await llm.chat(SIMULATOR.format(situation=card['situation'], profile=profile, persona=manner), request)
    return answer.value.strip().strip('"«»').strip()


async def prepare_openings(chosen: list[dict], persona_ids: list[str], progress: Progress) -> None:
    """Rewrite once per scenario/customer type, so later runs remain comparable."""
    missing = [
        (card, key)
        for card in chosen
        for key in persona_ids
        if key != personas.DEFAULT and not (card.get('openings') or {}).get(key)
    ]
    if not missing:
        return
    progress(done=0, total=len(missing), message='Переписываем первые реплики под типы клиентов')

    async def rewrite(card: dict, key: str) -> None:
        answer = await llm.chat(PERSONA_OPENING.format(style=personas.style(key)), card['opening'])
        card.setdefault('openings', {})[key] = answer.value.strip().strip('"«»').strip()

    async with asyncio.TaskGroup() as group:
        for card, key in missing:
            group.create_task(rewrite(card, key))
    cards.remember_openings({card['id']: card['openings'] for card, _ in missing})


def opening(card: dict, persona: str) -> str:
    return card['opening'] if persona == personas.DEFAULT else card['openings'][persona]


async def play(card: dict, agent: agents.HttpAgent, record: dict, item: dict, changed: Callable[[], None]) -> None:
    conversation = item['conversation']
    test_data = world.overrides(card.get('world')) if agent.mocked else {}
    details = world.customer_profile(card.get('world')) if test_data else record.get('customer', '')
    # Whether the conversation ran to its end: only such a conversation may be judged again (ended).
    item.update(world=bool(test_data), ended=False)
    persona = item.get('persona') or personas.DEFAULT
    message, from_log = opening(card, persona), persona == personas.DEFAULT
    try:
        for turn in range(1, MAX_AGENT_TURNS + 1):
            conversation.append(
                {'role': 'customer', 'text': message, 'fromLog': from_log, 'rewritten': turn == 1 and not from_log}
            )
            item['stage'] = f'ход {turn}: агент отвечает'
            changed()
            reply = await agent.say(item['conversationId'], message, test_data)
            conversation.append({'role': 'agent', **reply})
            changed()
            if not reply['text']:
                raise agents.AgentError(f'Агент не прислал текст ответа (статус {reply["status"]}).')
            if not reply['ok'] or turn == MAX_AGENT_TURNS:
                break
            item['stage'] = f'ход {turn + 1}: клиент пишет'
            changed()
            message, from_log = await customer_says(card, conversation, details, persona), False
            if END in message or not message:
                break
        item['ended'] = True
        item['stage'] = 'модель оценивает'
        changed()
        await judge.evaluate(card, item)
    except (agents.AgentError, llm.ModelError) as error:
        item.update(status='UNMEASURED', error=str(error))
    item['stage'] = ''
    changed()


def new_run(key: str, config: dict, label: str, repeats: int, persona_ids: list[str]) -> dict:
    return {
        'id': f'{time.strftime("%Y%m%d-%H%M%S")}-{uuid.uuid4().hex[:8]}',
        'target': key,
        'targetName': config['name'],
        'version': '…',
        'label': label,
        'customer': config.get('customer', ''),
        'startedAt': store.now(),
        'finishedAt': None,
        'model': llm.MODEL,
        'status': 'running',
        'items': [],
        'metric': None,
        'error': None,
        'repeats': repeats,
        'personas': persona_ids,
    }


def new_item(card: dict, persona: str, attempt: int) -> dict:
    return {
        'cardId': card['id'],
        'persona': persona,
        'name': card['name'],
        'topic': card['topic'],
        'attempt': attempt,
        'origin': card['origin'],
        'situation': card['situation'],
        'criteria': deepcopy(card['criteria']),
        'status': 'RUNNING',
        'stage': 'в очереди',
        'conversationId': str(uuid.uuid4()),
        'conversation': [],
        'rules': [],
        'error': None,
    }


def _error_message(error: Exception) -> str:
    if isinstance(error, ExceptionGroup):
        return '; '.join(_error_message(child) for child in error.exceptions)
    return str(error) or type(error).__name__


async def run(
    key: str,
    card_ids: list[str] | None = None,
    label: str = '',
    progress: Progress = lambda **_: None,
    repeats: int = 1,
    persona_ids: list[str] | None = None,
) -> dict:
    chosen = [card for card in cards.deck() if not card_ids or card['id'] in card_ids]
    if not chosen:
        raise RuntimeError('Нет сценариев для прогона. Сначала соберите сценарии.')
    persona_ids = [p for p in personas.PERSONAS if p in (persona_ids or [personas.DEFAULT])] or [personas.DEFAULT]
    config = agents.configs()[key]
    record = new_run(key, config, label, repeats, persona_ids)
    plan = [(card, persona, attempt) for attempt in range(1, repeats + 1) for persona in persona_ids for card in chosen]
    record['items'] = [new_item(card, persona, attempt) for card, persona, attempt in plan]
    # The run is measured by the criteria of the check its deck was built from, and remembers it.
    record['check'] = cards.check() or checks.of_run(record)
    store.create_run(record)

    def changed(index: int) -> None:
        """A conversation's turns stay in memory, in the job's progress; it is written once, when it ends with a
        verdict or an error. A write rereads and rewrites the whole run, on the event loop that stop also needs."""
        if record['items'][index]['status'] != 'RUNNING':
            store.update_item(record['id'], index, record['items'][index])
        done = sum(item['status'] != 'RUNNING' for item in record['items'])
        progress(run=record['id'], done=done, total=len(plan), message=f'Играем сценарии · {record["targetName"]}')

    progress(run=record['id'], done=0, total=len(plan), message=f'Подключаемся к агенту · {config["name"]}')
    try:
        await prepare_openings(chosen, persona_ids, progress)
        async with agents.session(agents.create(key)) as agent:
            record['version'] = agent.version
            store.update_run(record['id'], version=agent.version)
            gate = asyncio.Semaphore(PARALLEL)

            async def one(card: dict, index: int) -> None:
                async with gate:
                    await play(card, agent, record, record['items'][index], lambda: changed(index))

            async with asyncio.TaskGroup() as group:
                for index, (card, _, _) in enumerate(plan):
                    group.create_task(one(card, index))
        # A run the agent answered in no conversation has nothing to judge, now or later: it failed, and says why.
        silent = unanswered(record['items'])
        record.update(status='failed' if silent else 'done', error=silent)
    except asyncio.CancelledError:
        record.update(status='stopped', error='Прогон остановлен')
        raise
    except Exception as error:
        record.update(status='failed', error=_error_message(error))
    finally:
        # What the stop or the failure cut short, with the final status, in one write: not one per conversation.
        cut = {}
        for index, item in enumerate(record['items']):
            if item['status'] == 'RUNNING':
                item.update(status='UNMEASURED', stage='', error=record['error'])
                cut[index] = item
        store.update_items(
            record['id'],
            cut,
            status=record['status'],
            error=record['error'],
            finishedAt=store.now(),
            model=llm.models_used(record['items']),
        )
    return store.run(record['id'])


def ended(item: dict) -> bool:
    """The conversation ran to its end, so it can be judged again. One cut short (the agent failed, the customer's
    model failed, the run was stopped) keeps its status and its error: judging half a conversation would count it.
    A record from before play() marked this is read from its last message: a whole conversation ends on the agent's
    reply, one the agent broke on the customer's turn."""
    if 'ended' in item:
        return bool(item['ended'])
    last = (item.get('conversation') or [{}])[-1]
    return last.get('role') == 'agent' and bool(last.get('text'))


def unanswered(items: list[dict]) -> str | None:
    """Why a run has nothing to judge: no conversation ran to its end (ended, as rejudge reads it), with what most of
    them broke on («Нет связи с агентом (ConnectError).»). None when the agent answered in some."""
    if not items or any(ended(item) for item in items):
        return None
    reasons = Counter(item['error'] for item in items if item.get('error'))
    return f'{NO_REPLIES}. {reasons.most_common(1)[0][0]}' if reasons else f'{NO_REPLIES}.'


async def rejudge(record: dict, progress: Progress = lambda **_: None) -> dict:
    """Rejudge the recorded conversations that ran to their end against the criteria frozen when they were played.

    The new verdicts replace the old ones together, after the whole pass: a stopped or failed pass leaves the run as
    it was, never half re-judged under a final status."""
    items = [(index, item) for index, item in enumerate(record['items']) if ended(item)]
    if not items:
        raise RuntimeError('В прогоне нет записанных ответов агента: ни один разговор не дошёл до конца.')
    legacy = [(index, item) for index, item in items if not isinstance(item.get('criteria'), list)]
    if legacy:
        by_id = {card['id']: card for card in cards.deck()}
        for _, item in legacy:
            card = by_id.get(item['cardId'])
            if card is None:
                raise RuntimeError(
                    'В старом прогоне не сохранены критерии, а его сценария больше нет. '
                    'Сыграйте текущие сценарии заново.'
                )
            item['criteria'] = deepcopy(card['criteria'])
    done = 0

    async def one(item: dict) -> None:
        nonlocal done
        try:
            await judge.evaluate(item, item)
            item['error'] = None
        except llm.ModelError as error:
            item.update(status='UNMEASURED', error=str(error), rules=[], second=None)
        done += 1
        progress(done=done, total=len(items), message='Оцениваем разговоры заново')

    async with asyncio.TaskGroup() as group:
        for _, item in items:
            group.create_task(one(item))
    verdicts = {index: {key: item[key] for key in JUDGED if key in item} for index, item in items}
    return store.update_items(record['id'], verdicts, rejudgedAt=store.now(), model=llm.models_used(record['items']))
