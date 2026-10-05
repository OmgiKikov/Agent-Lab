"""How the Lab's own instruments do, from what the agents keep:

    uv run --directory backend python -m lab.eval judge [--agent <id>] [--json]
    uv run --directory backend python -m lab.eval calls [--agent <id>] [--json]

judge: how often people agree with the judge, per role, version of its instructions and check, from the answers they
gave on its verdicts (domain.instruments.agreement). calls: the calls to the models per role, version and model
(domain.instruments.usage). Without --agent, every agent of the Lab together: the judge is one instrument whatever the
agent. --json gives the rows as JSON. Reads only, so it runs beside a working Lab too.
"""

import argparse
import json
from collections.abc import Callable

from . import config, storage
from .domain import checks, instruments
from .flows import evaluation
from .storage import registry


def report(what: str, agent_id: str | None = None, as_json: bool = False) -> str:
    """The report of the judge (`judge`) or of the calls to the models (`calls`), as text or as JSON. ValueError: no
    such agent."""
    read = evaluation.answered if what == 'judge' else evaluation.calls
    names, found = gathered(agent_id, read)
    rows = instruments.agreement(found) if what == 'judge' else instruments.usage(found)
    if as_json:
        return json.dumps({'agents': names, 'rows': rows}, ensure_ascii=False, indent=2)
    return (_judge if what == 'judge' else _calls)(names, rows)


def gathered(agent_id: str | None, read: Callable[[], list[dict]]) -> tuple[list[str], list[dict]]:
    """The names of the agents read and what read() found in each of them, together. Without agents, the database of a
    Lab without them, when there is one."""
    agents = registry.listed()
    if agent_id is not None:
        chosen = [agent for agent in agents if agent['id'] == agent_id]
        if not chosen:
            known = ', '.join(agent['id'] for agent in agents) or 'пока нет'
            raise ValueError(f'Нет агента «{agent_id}». Агенты: {known}.')
        agents = chosen
    if not agents:
        return [], read() if storage.db.default_database().exists() else []
    found: list[dict] = []
    for agent in agents:
        with registry.using(agent['id']):
            found += read()
    return [agent['name'] for agent in agents], found


def _judge(names: list[str], rows: list[dict]) -> str:
    lines = ['Согласие людей с судьёй', _agents(names), '']
    if not rows:
        lines.append('Люди ещё не ответили ни на один вердикт судьи. Ответы даются в разделе «Проверка ответов».')
        return '\n'.join(lines)
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
    return '\n'.join(lines)


def _calls(names: list[str], rows: list[dict]) -> str:
    lines = ['Вызовы моделей', _agents(names), '']
    if not rows:
        lines.append('Журнал вызовов пуст.')
        return '\n'.join(lines)
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
    return '\n'.join(lines)


def _agents(names: list[str]) -> str:
    return f'Агенты: {", ".join(names)}.' if names else 'Lab без агентов.'


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
