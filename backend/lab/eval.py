"""How the Lab's own instruments do, from what the agents keep:

    uv run --directory backend python -m lab.eval judge [--agent <id>] [--json]
    uv run --directory backend python -m lab.eval calls [--agent <id>] [--json]

judge: how often people agree with the judge, per role, version of its instructions and check, from the answers they
gave on its verdicts (domain.instruments.agreement). calls: the calls to the models per role, version and model
(domain.instruments.usage). Without --agent, every agent of the Lab together: the judge is one instrument whatever the
agent. --json gives the rows as JSON.

Reads only: every database is opened read-only, never created nor brought to this version's schema (storage.db.
reading), so it runs beside a working Lab of any version. A database another version of the Lab wrote is named and
left unread: a Lab of this version brings it to this schema when it opens it.
"""

import argparse
import json
from collections.abc import Callable

from . import config, storage
from .domain import checks, instruments
from .flows import evaluation
from .storage import registry

# The database of a Lab without agents, as the report names it.
WITHOUT_AGENTS = 'Lab без агентов'


def report(what: str, agent_id: str | None = None, as_json: bool = False) -> str:
    """The report of the judge (`judge`) or of the calls to the models (`calls`), as text or as JSON. ValueError: no
    such agent."""
    read = evaluation.answered if what == 'judge' else evaluation.calls
    with storage.db.reading():
        names, unread, found = gathered(agent_id, read)
    rows = instruments.agreement(found) if what == 'judge' else instruments.usage(found)
    if as_json:
        return json.dumps({'agents': names, 'unread': unread, 'rows': rows}, ensure_ascii=False, indent=2)
    lines = ['Согласие людей с судьёй' if what == 'judge' else 'Вызовы моделей']
    if names:  # with every database unread there is nothing to say about what they hold
        lines += [_agents(names), '', *(_judge if what == 'judge' else _calls)(rows)]
    if unread:
        lines += ['', *_unread(unread)]
    return '\n'.join(lines)


def gathered(agent_id: str | None, read: Callable[[], list[dict]]) -> tuple[list[str], list[str], list[dict]]:
    """The names of the agents read, of those whose databases could not be read as they are (storage.db.Unreadable),
    and what read() found in the ones read, together. An agent that never opened its database is read: it has nothing
    yet. Without agents, the database of a Lab without them, named WITHOUT_AGENTS."""
    agents = registry.listed()
    if agent_id is not None:
        chosen = [agent for agent in agents if agent['id'] == agent_id]
        if not chosen:
            known = ', '.join(agent['id'] for agent in agents) or 'пока нет'
            raise ValueError(f'Нет агента «{agent_id}». Агенты: {known}.')
        agents = chosen
    places = [(agent['name'], registry.db_of(agent['id'])) for agent in agents]
    if not agents:
        places = [(WITHOUT_AGENTS, storage.db.default_database())]
    names: list[str] = []
    unread: list[str] = []
    found: list[dict] = []
    for name, database in places:
        token = storage.db.AGENT.set(database)
        try:
            found += read() if database.is_file() else []
            names.append(name)
        except storage.db.Unreadable:
            unread.append(name)
        finally:
            storage.db.AGENT.reset(token)
    return names, unread, found


def _judge(rows: list[dict]) -> list[str]:
    if not rows:
        return ['Люди ещё не ответили ни на один вердикт судьи. Ответы даются в разделе «Проверка ответов».']
    lines = []
    for row in rows:
        low, high = row['interval']
        lines.append(
            f'{row["role"]} · {_version(row["version"])} · {checks.NAMES.get(row["check"], "проверка не известна")}'
        )
        lines.append(
            f'  Ответили на {_count(row["answered"], "вердикт", "вердикта", "вердиктов")}, согласны '
            f'с\u00a0{row["agreed"]}: {_percent(row["share"])} (интервал {_percent(low, sign=False)}–{_percent(high)}).'
        )
        found = []
        if row['errors']['answered']:
            found.append(
                f'ошибки судьи подтвердили в\u00a0{row["errors"]["confirmed"]}\u00a0из\u00a0{row["errors"]["answered"]}'
            )
        if row['clean']['answered']:
            found.append(f'«без ошибки» — в\u00a0{row["clean"]["confirmed"]}\u00a0из\u00a0{row["clean"]["answered"]}')
        if found:
            sentence = ', '.join(found)
            lines.append(f'  {sentence[:1].upper()}{sentence[1:]}.')
        if row['few']:
            lines.append('  Ответов меньше 30: вывод предварительный.')
    return lines


def _calls(rows: list[dict]) -> list[str]:
    if not rows:
        return ['Журнал вызовов пуст.']
    lines = []
    said = {'answered': 'ответ', 'unusable': 'ответ не разобран', 'refused': 'отказ', 'failed': 'ошибка'}
    for row in rows:
        outcomes = ', '.join(f'{said.get(key, key)}\u00a0— {value}' for key, value in row['outcomes'].items() if value)
        lines.append(f'{row["role"] or "роль не записана"} · {_version(row["version"])} · {row["model"]}')
        seconds = f'{row["medianMs"] / 1000:.1f}'.replace('.', ',')
        lines.append(f'  {_count(row["calls"], "вызов", "вызова", "вызовов")}: {outcomes}. Медиана {seconds}\u00a0с.')
        spent = []
        if row['inputTokens'] or row['outputTokens']:
            spent.append(f'Токенов: {_number(row["inputTokens"])} на входе, {_number(row["outputTokens"])} на выходе.')
        if row['cost'] is not None:
            cost = f'{row["cost"]:.2f}'.replace('.', ',')
            priced = _count(row['priced'], 'вызову', 'вызовам', 'вызовам')
            spent.append(f'Стоимость {cost}\u00a0$ по {priced}, где модель её назвала.')
        if spent:
            lines.append(f'  {" ".join(spent)}')
    return lines


def _agents(names: list[str]) -> str:
    return f'{WITHOUT_AGENTS}.' if names == [WITHOUT_AGENTS] else f'Агенты: {", ".join(names)}.'


def _unread(unread: list[str]) -> list[str]:
    """Whose databases another version of the Lab wrote, and how they come into the report: a Lab of this version
    brings a database to its schema when it opens it."""
    if unread == [WITHOUT_AGENTS]:
        return [
            'Не прочитана база Lab: её записала другая версия.',
            'Откройте Lab этой версии, он обновит базу. Потом повторите отчёт.',
        ]
    if len(unread) == 1:
        return [
            f'Не прочитан агент: {unread[0]}. Его базу записала другая версия Lab.',
            'Откройте агента в Lab этой версии, Lab обновит базу. Потом повторите отчёт.',
        ]
    return [
        f'Не прочитаны агенты: {", ".join(unread)}. Их базы записала другая версия Lab.',
        'Откройте их в Lab этой версии, Lab обновит базы. Потом повторите отчёт.',
    ]


def _version(version: str | None) -> str:
    return f'версия {version[:8]}' if version else 'версия не записана'


def _percent(share: float, sign: bool = True) -> str:
    return f'{round(100 * share)}{"%" if sign else ""}'


def _number(value: int) -> str:
    return f'{value:,}'.replace(',', '\u00a0')


def _count(value: int, one: str, few: str, many: str) -> str:
    if value % 10 == 1 and value % 100 != 11:
        form = one
    elif value % 10 in (2, 3, 4) and value % 100 not in (12, 13, 14):
        form = few
    else:
        form = many
    return f'{_number(value)}\u00a0{form}'


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description='Как работают приборы Lab: судья и вызовы моделей.')
    parser.add_argument(
        'what', choices=('judge', 'calls'), help='judge — согласие людей с судьёй, calls — вызовы моделей'
    )
    parser.add_argument('--agent', help='id агента, как в адресе /a/<id>. Без него — все агенты')
    parser.add_argument('--json', action='store_true', help='строки отчёта в JSON')
    args = parser.parse_args(argv)
    with config.using(config.Settings.from_environment()):
        try:
            print(report(args.what, args.agent, args.json))
        except ValueError as error:
            parser.error(str(error))


if __name__ == '__main__':
    main()
