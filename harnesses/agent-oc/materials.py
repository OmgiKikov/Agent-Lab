#!/usr/bin/env python3
"""Реестр скиллов agent_oc → готовый вход `build --input` для генератора карточек.

Генератору карточек нужен ответ на вопрос «что агент вообще умеет»: без него он придумывает
сценарии, которых в агенте нет. Полные тексты скиллов для этого не годятся — их около 420 000
символов при пределе Agent Lab в 300 000, и это инструкции модели, а не описание покрытия.
Поэтому здесь собирается реестр: имя скилла, заголовок и первые содержательные строки.

    python harnesses/agent-oc/materials.py --root ../agent_oc --output task-cards.json

Файл можно править руками: `task` — ваши вводные своими словами, `scenarioCount` — сколько
ситуаций писать по правилам, если логов нет. Дальше:

    node dist/cli.js build --input task-cards.json --dialogues-file dialogues.jsonl --connection connection.json --yes

Скрипт ничего не импортирует из agent_oc и ничего в нём не меняет: он только читает файлы скиллов.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Dict, List

SKILLS = Path("src/app/incass_ckr/new_agent_logic/dialogue_handler/agent/tools/read/skills")
# Скиллы — шаблоны Jinja: условия по поверхности и полномочиям в описание покрытия не нужны.
_JINJA = re.compile(r"\{%.*?%\}|\{\{.*?\}\}", re.DOTALL)
LINES_PER_SKILL = 3
LINE_LIMIT = 400
MATERIAL_LIMIT = 120000


def summarize(text: str) -> str:
    """Заголовок и первые содержательные строки скилла — без шаблонных вставок и цитат ответов."""
    clean = _JINJA.sub(" ", text)
    lines: List[str] = []
    for raw in clean.splitlines():
        line = raw.strip()
        if not line or line.startswith(("«", ">", "|", "```")):
            continue
        lines.append(line[:LINE_LIMIT])
        if len(lines) == LINES_PER_SKILL:
            break
    return "\n".join(lines)


def registry(root: Path) -> str:
    directory = root / SKILLS
    if not directory.is_dir():
        raise SystemExit(f"Не найден каталог скиллов: {directory}")
    blocks: List[str] = []
    for path in sorted(directory.glob("*.md")):
        summary = summarize(path.read_text(encoding="utf-8"))
        blocks.append(f"## {path.stem}\n{summary}" if summary else f"## {path.stem}")
    if not blocks:
        raise SystemExit(f"В {directory} нет файлов скиллов")
    content = "Скиллы агента инкассации: имя и первые строки инструкции.\n\n" + "\n\n".join(blocks)
    if len(content) > MATERIAL_LIMIT:
        raise SystemExit(f"Реестр не помещается в один материал: {len(content)} символов при пределе {MATERIAL_LIMIT}")
    return content


def task_input(content: str, args: argparse.Namespace) -> Dict[str, object]:
    return {
        "task": args.task,
        "mode": "live",
        "scenarioCount": args.scenarios,
        "materials": [{"name": "Реестр скиллов агента инкассации", "content": content}],
        # Агент подключается файлом подключения при сборке (--connection) или прямо перед прогоном.
        "target": {"kind": "unconnected"},
        "settings": {
            "provider": "giga",
            "model": args.model,
            "roles": {
                "builder": {"provider": "giga", "model": args.builder},
                "simulator": {"provider": "giga", "model": args.model},
                "judge": {"provider": "giga", "model": args.builder},
            },
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", required=True, help="Корень репозитория agent_oc")
    parser.add_argument("--output", required=True, help="Куда записать вход для build")
    parser.add_argument("--scenarios", type=int, default=10, help="Сколько ситуаций писать по правилам без логов (0–20)")
    parser.add_argument("--model", default="glm-5.2", help="Модель симулятора и общая по умолчанию")
    parser.add_argument("--builder", default="GigaChat-3-Ultra", help="Модель генератора карточек и судьи")
    parser.add_argument("--task", default=(
        "Собрать карточки бизнес-сценариев клиентов инкассации по реальным логам: "
        "какие задачи люди приносят, что они знают сами и чем заканчивается разговор."))
    args = parser.parse_args()

    content = registry(Path(args.root).expanduser().resolve())
    output = Path(args.output)
    output.write_text(json.dumps(task_input(content, args), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{output}: реестр на {len(content)} символов; допишите в task свои вводные")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
