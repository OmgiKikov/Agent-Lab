#!/usr/bin/env python3
"""Подставляет ЕПК, поверхность и полномочия в шаблон карточки end2end.

Вынесено из скрипта отдельным файлом: heredoc внутри heredoc ломается незаметно, а ЕПК не должны
попадать в репозиторий — они приходят из окружения при запуске.

    python3 fill-task.py ЕПК_ЮЛ ЕПК_ФЛ ПОВЕРХНОСТЬ ПОЛНОМОЧИЯ шаблон.json результат.json
"""

import json
import sys


def main(argv: list[str]) -> int:
    if len(argv) != 7:
        print(__doc__, file=sys.stderr)
        return 2
    epk_ul, epk_fl, surface, authority, template, output = argv[1:7]
    with open(template, encoding="utf-8") as handle:
        task = json.load(handle)
    for case in task["goldenCases"]:
        case["initialState"]["records"]["session"].update(
            epk_ul=epk_ul, epk_fl=epk_fl, surface=surface, authority=authority)
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(task, handle, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
