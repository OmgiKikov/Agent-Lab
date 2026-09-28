#!/bin/sh
# Work computer: put the gateway files into certs/ (url.txt, certificate, key; ca.pem if needed) and run this.
set -e
cd "$(dirname "$0")"
[ -x .venv/bin/python ] || { python3 -m venv .venv && .venv/bin/pip install -q httpx; }
JUDGE=""
.venv/bin/python -m lab gateway || { echo "Шлюз моделей недоступен: прогон без оценки, оценка на маке при импорте"; JUDGE="--judge-later"; }
.venv/bin/python -m lab ping --target prod | tail -2
.venv/bin/python -m lab run --target prod --repeats 2 $JUDGE
echo "Файл прогона — в lab/data/runs/. Перенесите его на мак: Workshop → agent lab → прогон → «импорт прогона»."
