"""Agent testing: the synthetic customer plays each card with the real agent, then the judge gives a verdict.

A run lives in data/runs/<id>.json; each conversation streams into Workshop turn by turn, so it can be watched live.
"""

import asyncio
import time
import uuid
from collections.abc import Callable

from . import agents, cards, judge, llm, personas, store, workshop
from .agents import world
from .metric import metric
from .prompts import PERSONA_OPENING, SIMULATOR
from .transcript import for_trace, with_buttons

MAX_AGENT_TURNS = 3
PARALLEL = 4
END = '[КОНЕЦ]'
FOLDER_PREFIX = 'Agent Lab · '
Progress = Callable[..., None]


def title(item: dict) -> str:
    persona = item.get('persona') or personas.DEFAULT
    return (
        item['name']
        + (f' · {personas.name(persona)}' if persona != personas.DEFAULT else '')
        + (f' · повтор {item["attempt"]}' if item.get('attempt', 1) > 1 else '')
    )


def note(run: dict, item: dict) -> str:
    context = f'Сценарий «{title(item)}» · {run["targetName"]} ({run["version"]})'
    return judge.note(item['status'], context, item.get('rules') or [], item.get('error'), item.get('second'))


async def customer_says(card: dict, conversation: list[dict], details: str = '', persona: str | None = None) -> str:
    """The synthetic customer's next message, or END."""
    transcript = '\n\n'.join(
        ('КЛИЕНТ (это ты): ' if m['role'] == 'customer' else 'АГЕНТ: ') + with_buttons(m) for m in conversation
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
    """The logged opening rewritten for every customer type, once per card: later runs reuse the same words,
    so runs with customer types stay comparable."""
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

    await asyncio.gather(*(rewrite(card, key) for card, key in missing))
    cards.remember_openings({card['id']: card['openings'] for card, _ in missing})


def opening(card: dict, persona: str) -> str:
    if persona == personas.DEFAULT:
        return card['opening']
    return card['openings'][persona]


class Live:
    """One conversation in Workshop, written turn by turn."""

    def __init__(self, run: dict, item: dict, use_workshop: bool):
        self.run, self.item = run, item
        self.history: list[dict] = []
        self.trace = workshop.Trace(
            f'● {title(item)}',
            convo_id=item['conversationId'],
            user_id=run['targetName'],
            properties={
                'agent': run['targetName'],
                'agent_version': run['version'],
                'card': item['cardId'],
                'run': run['id'],
            },
            enabled=use_workshop,
        )
        if self.trace.enabled:
            item.update(runId=self.trace.run_id, url=self.trace.url)

    def customer(self, message: dict) -> None:
        source = 'сгенерирована симулятором'
        if message.get('fromLog'):
            source = 'дословно из лога'
        elif message.get('rewritten'):
            source = f'реплика из лога, переписанная: {personas.name(self.item.get("persona"))} клиент'
        payload = {'ситуация': self.item['situation'], 'реплика': source}
        self.trace.tool('Синтетический клиент', time.time_ns(), payload, message['text'])
        self.history.append({'role': 'user', 'content': message['text']})

    def agent(self, message: dict, started: int | None = None) -> None:
        for event in message.get('events') or []:
            details = {k: v for k, v in event.items() if k != 'tool'}
            self.trace.tool(event['tool'], time.time_ns(), details, event.get('article') or 'вызов выполнен')
        model = f'{self.run["targetName"]} · {self.run["version"]}'
        self.trace.agent_turn(started or time.time_ns(), list(self.history), for_trace(message), model)
        self.history.append({'role': 'assistant', 'content': message['text']})

    def finish(self) -> None:
        item, run = self.item, self.run
        status = item['status']
        if item.get('rules'):
            self.trace.tool(
                'Судья',
                time.time_ns(),
                {'критерии': [r['rule'] for r in item['rules']]},
                {r['ruleId']: {'статус': r['status'], 'почему': r['reason']} for r in item['rules']},
            )
        self.trace.properties['verdict'] = status
        self.trace.finish(status)
        self.trace.rename(f'{judge.MARKS.get(status, "…")} {title(item)}')
        self.trace.annotate(workshop.kind_of(status), note(run, item))
        summary = {'PASS': 'Сценарий пройден', 'FAIL': 'Сценарий не пройден', 'UNMEASURED': 'Не измерено'}.get(
            status, status
        )
        folder = f'{FOLDER_PREFIX}{run["targetName"]} · {run["startedAt"][:16].replace("T", " ")}'
        opening = item['conversation'][0]['text'] if item['conversation'] else ''
        self.trace.save_to(folder, opening, status, summary)


async def play(card: dict, agent: agents.HttpAgent, run: dict, item: dict, changed: Callable[[], None]) -> None:
    """One conversation: the logged opening, then up to MAX_AGENT_TURNS agent replies, then the judge."""
    conversation = item['conversation']
    live = await asyncio.to_thread(Live, run, item, run['workshop'])
    test_data = world.overrides(card.get('world')) if agent.mocked else {}
    details = world.customer_profile(card.get('world')) if test_data else run.get('customer', '')
    item['world'] = bool(test_data)
    persona = item.get('persona') or personas.DEFAULT
    message, from_log = opening(card, persona), persona == personas.DEFAULT
    try:
        for turn in range(1, MAX_AGENT_TURNS + 1):
            first_rewritten = turn == 1 and not from_log
            conversation.append(
                {'role': 'customer', 'text': message, 'fromLog': from_log, 'rewritten': first_rewritten}
            )
            await asyncio.to_thread(live.customer, conversation[-1])
            item['stage'] = f'ход {turn}: агент отвечает'
            changed()
            started = time.time_ns()
            reply = await agent.say(item['conversationId'], message, test_data)
            conversation.append({'role': 'agent', **reply})
            await asyncio.to_thread(live.agent, conversation[-1], started)
            changed()
            if not reply['text']:
                raise agents.AgentError(f'Агент не прислал текст ответа (статус {reply["status"]}).')
            if not reply['ok'] or turn == MAX_AGENT_TURNS:
                break  # a service status hands the conversation to a human operator
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
    await asyncio.to_thread(live.finish)
    changed()


def new_run(key: str, config: dict, label: str, repeats: int, persona_ids: list[str]) -> dict:
    return {
        'id': f'{time.strftime("%Y%m%d-%H%M%S")}-{uuid.uuid4().hex[:4]}',
        'target': key,
        'targetName': config['name'],
        'version': '…',
        'label': label,
        'customer': config.get('customer', ''),
        'startedAt': store.now(),
        'finishedAt': None,
        'model': llm.MODEL,
        'workshop': workshop.available(),
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


async def run(
    key: str,
    card_ids: list[str] | None = None,
    label: str = '',
    progress: Progress = lambda **_: None,
    repeats: int = 1,
    persona_ids: list[str] | None = None,
) -> dict:
    """Every card (or the chosen ones) against one agent, played by each chosen customer type, `repeats` times."""
    chosen = [c for c in cards.deck() if not card_ids or c['id'] in card_ids]
    if not chosen:
        raise RuntimeError('Нет карточек для прогона')
    persona_ids = [key for key in personas.PERSONAS if key in (persona_ids or [personas.DEFAULT])] or [personas.DEFAULT]
    await prepare_openings(chosen, persona_ids, progress)
    config = agents.configs()[key]
    agent = agents.create(key)
    record = await asyncio.to_thread(new_run, key, config, label, repeats, persona_ids)
    plan = [(card, persona, attempt) for attempt in range(1, repeats + 1) for persona in persona_ids for card in chosen]
    record['items'] = [new_item(card, persona, attempt) for card, persona, attempt in plan]

    def changed() -> None:
        record['metric'] = metric([i for i in record['items'] if i['status'] != 'RUNNING'])
        store.save_run(record)
        done = sum(1 for i in record['items'] if i['status'] != 'RUNNING')
        progress(run=record['id'], done=done, total=len(plan), message=f'{record["targetName"]}: прогон')

    progress(run=record['id'], done=0, total=len(plan), message=f'Запускаю: {config["name"]}')
    store.save_run(record)
    try:
        await agent.open()
        record['version'] = agent.version
        changed()
        gate = asyncio.Semaphore(PARALLEL)

        async def one(card: dict, item: dict) -> None:
            async with gate:
                await play(card, agent, record, item, changed)

        await asyncio.gather(*(one(card, item) for (card, _, _), item in zip(plan, record['items'], strict=True)))
        record['status'] = 'done'
    except agents.AgentError as error:
        record.update(status='failed', error=str(error))
        for item in record['items']:
            if item['status'] == 'RUNNING':
                item.update(status='UNMEASURED', stage='', error=str(error))
    except asyncio.CancelledError:
        record.update(status='stopped', error='Прогон остановлен')
        for item in record['items']:
            if item['status'] == 'RUNNING':
                item.update(status='UNMEASURED', stage='', error='Прогон остановлен до конца разговора')
        raise
    finally:
        await agent.close()
        record['finishedAt'] = store.now()
        record['model'] = llm.model_label
        changed()
    return record


async def rejudge(record: dict, progress: Progress = lambda **_: None) -> dict:
    """Judge the recorded conversations again with the current cards and judges; the agent is not called."""
    by_id = {c['id']: c for c in cards.deck()}
    items = [i for i in record['items'] if i['conversation'] and i['cardId'] in by_id and not i.get('error')]
    done = 0

    async def one(item: dict) -> None:
        nonlocal done
        try:
            await judge.evaluate(by_id[item['cardId']], item)
        except llm.ModelError as error:
            item.update(status='UNMEASURED', error=str(error))
        done += 1
        progress(done=done, total=len(items), message='Переоценка разговоров')

    await asyncio.gather(*(one(i) for i in items))
    record['metric'] = metric(record['items'])
    record['rejudgedAt'] = store.now()
    store.save_run(record)
    await asyncio.to_thread(renote, record)
    return record


def renote(record: dict) -> None:
    """Write the verdicts into the run's Workshop traces again: names with ✓/✗/? and the judge's notes."""
    for item in record['items']:
        if item.get('runId') and item['status'] != 'RUNNING':
            workshop.annotate(item['runId'], workshop.kind_of(item['status']), note(record, item), replace=True)
            workshop.rename(item['runId'], f'{judge.MARKS.get(item["status"], "…")} {title(item)}')
