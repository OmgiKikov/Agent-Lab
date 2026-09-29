"""Play scenarios against an agent; persist each conversation and evaluation in the Lab."""

import asyncio
import time
import uuid
from collections.abc import Callable

from . import agents, cards, judge, llm, personas, store
from .agents import world
from .prompts import PERSONA_OPENING, SIMULATOR
from .transcript import with_buttons

MAX_AGENT_TURNS = 3
PARALLEL = 4
END = '[КОНЕЦ]'
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
    text = await llm.chat(SIMULATOR.format(situation=card['situation'], profile=profile, persona=manner), request)
    return text.strip().strip('"«»').strip()


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
    progress(done=0, total=len(missing), message='Переписываю первые реплики под типы клиентов')

    async def rewrite(card: dict, key: str) -> None:
        text = await llm.chat(PERSONA_OPENING.format(style=personas.style(key)), card['opening'])
        card.setdefault('openings', {})[key] = text.strip().strip('"«»').strip()

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
    item['world'] = bool(test_data)
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
        item['stage'] = 'судья оценивает'
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
        raise RuntimeError('Нет карточек для прогона')
    persona_ids = [p for p in personas.PERSONAS if p in (persona_ids or [personas.DEFAULT])] or [personas.DEFAULT]
    config = agents.configs()[key]
    record = new_run(key, config, label, repeats, persona_ids)
    plan = [(card, persona, attempt) for attempt in range(1, repeats + 1) for persona in persona_ids for card in chosen]
    record['items'] = [new_item(card, persona, attempt) for card, persona, attempt in plan]
    store.create_run(record)
    agent = None

    def changed(index: int) -> None:
        store.update_item(record['id'], index, record['items'][index])
        done = sum(item['status'] != 'RUNNING' for item in record['items'])
        progress(run=record['id'], done=done, total=len(plan), message=f'{record["targetName"]}: прогон')

    progress(run=record['id'], done=0, total=len(plan), message=f'Запускаю: {config["name"]}')
    try:
        await prepare_openings(chosen, persona_ids, progress)
        agent = agents.create(key)
        await agent.open()
        record['version'] = agent.version
        store.update_run(record['id'], version=agent.version)
        gate = asyncio.Semaphore(PARALLEL)

        async def one(card: dict, index: int) -> None:
            async with gate:
                await play(card, agent, record, record['items'][index], lambda: changed(index))

        async with asyncio.TaskGroup() as group:
            for index, (card, _, _) in enumerate(plan):
                group.create_task(one(card, index))
        record['status'] = 'done'
    except asyncio.CancelledError:
        record.update(status='stopped', error='Прогон остановлен')
        raise
    except Exception as error:
        record.update(status='failed', error=_error_message(error))
    finally:
        # TaskGroup has joined every conversation before the agent is closed.
        cancelled_during_close = False
        try:
            if agent is not None:
                close_task = asyncio.create_task(agent.close())
                while not close_task.done():
                    try:
                        await asyncio.shield(close_task)
                    except asyncio.CancelledError:
                        cancelled_during_close = True
                        record.update(status='stopped', error='Прогон остановлен')
                close_task.result()
        except Exception as error:
            if record['status'] != 'stopped':
                record.update(status='failed', error=_error_message(error))
        finally:
            for index, item in enumerate(record['items']):
                if item['status'] == 'RUNNING':
                    item.update(status='UNMEASURED', stage='', error=record['error'])
                    changed(index)
            store.update_run(
                record['id'],
                status=record['status'],
                error=record['error'],
                finishedAt=store.now(),
                model=llm.model_label,
            )
        if cancelled_during_close:
            raise asyncio.CancelledError
    return store.run(record['id'])


async def rejudge(record: dict, progress: Progress = lambda **_: None) -> dict:
    """Patch evaluations only. Concurrent human reviews remain owned by the reviewer."""
    by_id = {card['id']: card for card in cards.deck()}
    items = [
        (index, item)
        for index, item in enumerate(record['items'])
        if item['cardId'] in by_id
        and any(message['role'] == 'agent' and message.get('text') for message in item['conversation'])
    ]
    done = 0

    async def one(index: int, item: dict) -> None:
        nonlocal done
        try:
            await judge.evaluate(by_id[item['cardId']], item)
            item['error'] = None
        except llm.ModelError as error:
            item.update(status='UNMEASURED', error=str(error), rules=[], second=None)
        store.update_item(record['id'], index, item)
        done += 1
        progress(done=done, total=len(items), message='Переоценка разговоров')

    async with asyncio.TaskGroup() as group:
        for index, item in items:
            group.create_task(one(index, item))
    return store.update_run(record['id'], rejudgedAt=store.now())
