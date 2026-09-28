"""Step 3: synthetic customer <-> real agent, judged against the card's frozen criteria.

Accuracy = scenarios where the agent met every applicable criterion / measured scenarios.
A scenario is "not measured" when the agent gave no client answer or the judge found
no evidence either way; it never counts as a pass or a failure.
"""
import asyncio
import time
import uuid

from . import llm, store, targets, workshop, world
from .discover import checked, verdict_note, verdict_of
from .prompts import JUDGE_RUN, SIMULATOR

MAX_AGENT_TURNS = 3
PARALLEL = 4
END = '[КОНЕЦ]'


def metric(items: list[dict]) -> dict:
    """Accuracy over conversations; second-judge agreement; stability of a scenario across its repeats."""
    done = [c for c in items if c.get('status') in ('PASS', 'FAIL', 'UNMEASURED')]
    passed = sum(1 for c in done if c['status'] == 'PASS')
    failed = sum(1 for c in done if c['status'] == 'FAIL')
    measured = passed + failed
    value = {'accuracy': round(100 * passed / measured) if measured else None, 'passed': passed, 'failed': failed,
             'unmeasured': len(done) - measured, 'measured': measured, 'total': len(done)}
    checked_twice = [c for c in done if (c.get('second') or {}).get('status') in ('PASS', 'FAIL', 'UNMEASURED')]
    if checked_twice:
        value['secondJudge'] = {'model': checked_twice[0]['second'].get('model'), 'checked': len(checked_twice),
                                'agree': sum(1 for c in checked_twice if c['second']['status'] == c['status'])}
    by_card = {}
    for c in done:
        by_card.setdefault(c['cardId'], []).append(c['status'])
    repeated = {k: v for k, v in by_card.items() if len(v) > 1}
    if repeated:
        value['repeats'] = {'scenarios': len(repeated), 'stable': sum(1 for v in repeated.values() if len(set(v)) == 1),
                            'attempts': max(len(v) for v in repeated.values())}
    reviewed = [c for c in done if c.get('review') in ('agree', 'disagree')]
    if reviewed:
        value['human'] = {'reviewed': len(reviewed), 'agree': sum(1 for c in reviewed if c['review'] == 'agree')}
    return value


def with_tools(message: dict) -> str:
    """The agent's reply plus the systems it called in this turn (known only where the mocks record them)."""
    calls = [e['tool'].replace('Система банка · ', '') + (f" ({e['article']})" if e.get('article') else '') for e in message.get('events') or []]
    return with_buttons(message) + ('\n[вызовы систем: ' + '; '.join(calls) + ']' if calls else '')


def with_buttons(message: dict) -> str:
    options = message.get('options') or []
    return message['text'] + ('\n[Кнопки: ' + ' | '.join(options) + ']' if options else '')


async def customer_says(card: dict, conversation: list[dict], customer: str = '') -> str:
    transcript = '\n\n'.join(('КЛИЕНТ (это ты): ' if m['role'] == 'customer' else 'АГЕНТ: ') + with_buttons(m)
                               for m in conversation)
    profile = f'Реквизиты (называй их, если агент спросит номер терминала, организацию или ИНН): {customer}' if customer else ''
    text = await llm.chat(SIMULATOR.format(situation=card['situation'], profile=profile),
                          f'Переписка в чате:\n\n{transcript}\n\nНапиши следующую реплику клиента в ответ на последнее сообщение агента или [КОНЕЦ].')
    return text.strip().strip('"«»').strip()


class Live:
    """Streams one conversation into Workshop turn by turn, so it can be watched while it runs."""

    def __init__(self, run: dict, item: dict, use_workshop: bool):
        self.run, self.item = run, item
        self.history = []
        self.title = item['name'] + (f" · повтор {item['attempt']}" if item.get('attempt', 1) > 1 else '')
        self.trace = workshop.Trace(f"● {self.title}", convo_id=item['conversationId'], user_id=run['targetName'],
                                    properties={'agent': run['targetName'], 'agent_version': run['version'],
                                                'card': item['cardId'], 'run': run['id']}, enabled=use_workshop)
        if self.trace.enabled:
            item.update(runId=self.trace.run_id, url=self.trace.url)

    def customer(self, message: dict) -> None:
        source = 'дословно из лога' if message.get('fromLog') else 'сгенерирована симулятором'
        self.trace.tool('Синтетический клиент', time.time_ns(), {'ситуация': self.item['situation'], 'реплика': source},
                        message['text'])
        self.history.append({'role': 'user', 'content': message['text']})

    def agent(self, message: dict, started: int | None = None) -> None:
        for event in message.get('events') or []:
            self.trace.tool(event['tool'], time.time_ns(), {k: v for k, v in event.items() if k != 'tool'},
                            event.get('article') or 'вызов выполнен')
        shown = with_buttons(message) if message.get('ok', True) else f"[служебный статус {message.get('status')}: передача оператору] {message['text']}"
        self.trace.agent_turn(started or time.time_ns(), list(self.history), shown,
                              f"{self.run['targetName']} · {self.run['version']}")
        self.history.append({'role': 'assistant', 'content': message['text']})

    def finish(self) -> None:
        item, run = self.item, self.run
        status = item['status']
        if item.get('rules'):
            self.trace.tool('Судья', time.time_ns(), {'критерии': [r['rule'] for r in item['rules']]},
                            {r['ruleId']: {'статус': r['status'], 'почему': r['reason']} for r in item['rules']})
        self.trace.properties['verdict'] = status
        self.trace.finish(status)
        mark = {'PASS': '✓', 'FAIL': '✗', 'UNMEASURED': '?'}.get(status, '…')
        self.trace.rename(f"{mark} {self.title}")
        title = {'PASS': 'Сценарий пройден', 'FAIL': 'Сценарий не пройден', 'UNMEASURED': 'Не измерено'}.get(status, status)
        note = verdict_note(status, f"Сценарий «{self.title}» · {run['targetName']} ({run['version']})",
                            item.get('rules') or [], item.get('error'), item.get('second'))
        self.trace.annotate('issue' if status == 'FAIL' else 'note', note)
        self.trace.save_to(f"Agent Lab · {run['targetName']} · {run['startedAt'][:16].replace('T', ' ')}",
                           item['conversation'][0]['text'] if item['conversation'] else '', status, title)


def emit(run: dict, item: dict, use_workshop: bool) -> dict:
    """Write a finished conversation into Workshop (runs imported from another computer)."""
    live = Live(run, item, use_workshop)
    for message in item['conversation']:
        (live.customer if message['role'] == 'customer' else live.agent)(message)
    live.finish()
    return {'runId': live.trace.run_id, 'url': live.trace.url} if live.trace.enabled else {}


def own_words(rows: list[dict], conversation: list[dict]) -> list[dict]:
    """Evidence must be the agent's own words. A quote taken from our handoff marker is replaced by the
    agent's service reply itself (the handoff is the evidence); anything else unverifiable becomes UNKNOWN."""
    agents = [m for m in conversation if m['role'] == 'agent']
    raw = '\n'.join(with_tools(m) for m in agents)
    for row in rows:
        if row['status'] not in ('PASS', 'FAIL') or store.quote_found(row['agentQuote'], raw):
            continue
        handoff = next((m for m in agents if not m.get('ok', True)), None)
        if handoff:
            row['agentQuote'] = f"служебный ответ {handoff['status']}: {handoff['text']}"
        else:
            row.update(status='UNKNOWN', agentQuote='', reason='Цитата судьи не найдена в ответах агента; вывод не засчитан. ' + row['reason'])
    return rows


async def verdict(card: dict, conversation: list[dict], endpoint: tuple[str, str] | None = None) -> tuple[list[dict], str]:
    shown = [{'role': m['role'].upper(), 'text': with_tools(m) if m.get('ok', True) else
              f"[служебный статус {m['status']}: бот не ответил сам, разговор передан оператору] {m['text']}"}
             for m in conversation]
    agent_text = '\n'.join(m['text'] for m in shown if m['role'] == 'AGENT')
    value = await llm.structured(JUDGE_RUN, {'expectations': card['criteria'], 'conversation': shown,
                                             'toolCallsObserved': any(m.get('events') for m in conversation if m['role'] == 'agent')},
                                 check=lambda v: v['rules'], endpoint=endpoint)
    rows = own_words(checked(value.get('rules') or [], card['criteria'], agent_text), conversation)
    return rows, verdict_of(rows)


async def judge(card: dict, item: dict) -> None:
    """Main judge, then an independent second judge on another vendor's model over the same conversation."""
    item['rules'], item['status'] = await verdict(card, item['conversation'])
    if not llm.SECOND:
        return
    try:
        rows, status = await verdict(card, item['conversation'], llm.SECOND)
        item['second'] = {'model': llm.SECOND[1], 'status': status, 'rules': rows}
    except llm.ModelError as error:
        item['second'] = {'model': llm.SECOND[1], 'status': 'ERROR', 'error': str(error)}


async def play(card: dict, agent, run: dict, item: dict, changed) -> None:
    conversation = item['conversation']
    conversation_id = item['conversationId']
    live = await asyncio.to_thread(Live, run, item, run['workshop'])
    tools = world.overrides(card.get('world')) if agent.mocked else {}
    customer = world.customer_profile(card.get('world')) if tools else run.get('customer', '')
    item['world'] = bool(tools)
    message = card['opening']
    from_log = True
    try:
        for turn in range(1, MAX_AGENT_TURNS + 1):
            conversation.append({'role': 'customer', 'text': message, 'fromLog': from_log})
            await asyncio.to_thread(live.customer, conversation[-1])
            item['stage'] = f'ход {turn}: агент отвечает'
            changed()
            started = time.time_ns()
            reply = await agent.say(conversation_id, message, tools)
            conversation.append({'role': 'agent', 'text': reply['text'], 'status': reply['status'], 'ok': reply['ok'],
                                 'options': reply['options'], 'seconds': reply['seconds'], 'events': reply['events']})
            await asyncio.to_thread(live.agent, conversation[-1], started)
            changed()
            if not reply['text']:
                raise targets.TargetError(f"Агент не прислал текст ответа (статус {reply['status']}).")
            if not reply['ok']:
                break  # service status: the bot stops and the conversation goes to a human operator
            if turn == MAX_AGENT_TURNS or run.get('judgeLater'):
                break
            item['stage'] = f'ход {turn + 1}: клиент пишет'
            changed()
            message = await customer_says(card, conversation, customer)
            from_log = False
            if END in message or not message:
                break
        if run.get('judgeLater'):
            item['status'], item['stage'] = 'PENDING', ''  # judged on the Lab computer when imported
        else:
            item['stage'] = 'судья оценивает'
            changed()
            await judge(card, item)
    except (targets.TargetError, llm.ModelError) as error:
        item['status'] = 'UNMEASURED'
        item['error'] = str(error)
    item['stage'] = ''
    if item['status'] != 'PENDING':
        await asyncio.to_thread(live.finish)
    changed()


async def run(target_key: str, card_ids: list[str] | None = None, label: str = '', progress=lambda **_: None,
              judge_later: bool = False, repeats: int = 1) -> dict:
    """judge_later: no model on this computer (e.g. the work laptop) - only the logged opening is sent,
    the conversation is judged when the run file is imported into the Lab."""
    deck = (store.load('cards.json') or {}).get('cards') or []
    cards = [c for c in deck if not card_ids or c['id'] in card_ids]
    if not cards:
        raise RuntimeError('Нет карточек для прогона')
    config = targets.configs()[target_key]
    agent = targets.create(target_key)
    record = {'id': time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:4], 'target': target_key,
              'targetName': config['name'], 'version': '…', 'label': label, 'startedAt': store.now(),
              'customer': config.get('customer', ''),
              'finishedAt': None, 'model': llm.MODEL, 'workshop': await asyncio.to_thread(workshop.available),
              'status': 'running', 'items': [], 'metric': None, 'error': None, 'judgeLater': judge_later,
              'repeats': repeats}
    path = f"runs/{record['id']}.json"

    def changed():
        record['metric'] = metric([i for i in record['items'] if i['status'] not in ('RUNNING', 'PENDING')])
        store.save(path, record)
        progress(run=record['id'], done=sum(1 for i in record['items'] if i['status'] != 'RUNNING'),
                 total=len(record['items']), message=f"{record['targetName']}: прогон")

    plan = [(card, attempt) for attempt in range(1, repeats + 1) for card in cards]
    for card, attempt in plan:
        record['items'].append({'cardId': card['id'], 'name': card['name'], 'topic': card['topic'], 'attempt': attempt,
                                'origin': card['origin'], 'situation': card['situation'], 'status': 'RUNNING',
                                'stage': 'в очереди', 'conversationId': str(uuid.uuid4()), 'conversation': [],
                                'rules': [], 'error': None})
    progress(run=record['id'], done=0, total=len(plan), message=f"Запускаю: {config['name']}")
    store.save(path, record)
    try:
        await agent.open()
        record['version'] = agent.version
        changed()
        gate = asyncio.Semaphore(PARALLEL)

        async def one(card, item):
            async with gate:
                await play(card, agent, record, item, changed)

        await asyncio.gather(*(one(c, i) for (c, _), i in zip(plan, record['items'])))
        record['status'] = 'done'
    except targets.TargetError as error:
        record['status'] = 'failed'
        record['error'] = str(error)
        for item in record['items']:
            if item['status'] == 'RUNNING':
                item.update(status='UNMEASURED', stage='', error=str(error))
    finally:
        await agent.close()
        record['finishedAt'] = store.now()
        record['model'] = llm.model_label
        changed()
    return record


async def rejudge(record: dict, progress=lambda **_: None) -> dict:
    """Judge recorded conversations again with the current cards and judges; the agent is not called."""
    deck = {c['id']: c for c in ((store.load('cards.json') or {}).get('cards') or [])}
    items = [i for i in record['items'] if i['conversation'] and i['cardId'] in deck and not i.get('error')]
    done = 0

    async def one(item):
        nonlocal done
        try:
            await judge(deck[item['cardId']], item)
        except llm.ModelError as error:
            item.update(status='UNMEASURED', error=str(error))
        done += 1
        progress(done=done, total=len(items), message='Переоценка разговоров')

    await asyncio.gather(*(one(i) for i in items))
    record['metric'] = metric(record['items'])
    record['rejudgedAt'] = store.now()
    store.save(f"runs/{record['id']}.json", record)
    return record


async def import_run(record: dict, progress=lambda **_: None) -> dict:
    """Bring a run made on another computer (e.g. prod from the work laptop) into this Lab and Workshop.
    Conversations recorded without a model are judged here against the same frozen cards."""
    deck = {c['id']: c for c in ((store.load('cards.json') or {}).get('cards') or [])}
    pending = [i for i in record['items'] if i['status'] == 'PENDING']
    for n, item in enumerate(pending, 1):
        progress(done=n - 1, total=len(pending), message='Судья оценивает импортированные разговоры')
        card = deck.get(item['cardId'])
        try:
            if not card:
                raise targets.TargetError('Карточки этого сценария нет в Lab: импортируйте прогон туда, где собраны эти сценарии.')
            await judge(card, item)
        except (targets.TargetError, llm.ModelError) as error:
            item.update(status='UNMEASURED', error=str(error))
    use = await asyncio.to_thread(workshop.available)
    record['workshop'] = use
    for item in record['items']:
        if item['conversation']:
            item.update(await asyncio.to_thread(emit, record, item, use))
    record['metric'] = metric(record['items'])
    record['imported'] = True
    store.save(f"runs/{record['id']}.json", record)
    return record
