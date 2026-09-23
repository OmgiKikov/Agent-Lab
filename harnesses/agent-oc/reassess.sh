#!/usr/bin/env bash
#
# Пересчитывает оценки судьи по уже записанным диалогам прогона и выгружает отчёт.
#
#   bash harnesses/agent-oc/reassess.sh RUN_ID [criteria.json]
#
# criteria.json (harnesses/agent-oc/import-cases.py --criteria-output) заменяет критерии карточек: например,
# голый код ответа из разбора становится точной проверкой result.status_code вместо рубрики судьи.
# Точные проверки считаются по сохранённым фактам прогона.
#
# Агент и симулятор не вызываются: судья заново оценивает сохранённые трассы. Исходный прогон
# не меняется — появляется отдельная переоценка со ссылкой на него. Лимиты берутся из прогона.
# Код возврата: 0 - все оценки получены, 2 - остались ошибки оценщика или неполные данные.
set -euo pipefail

run_id="${1:?Укажите идентификатор прогона: bash harnesses/agent-oc/reassess.sh RUN_ID}"
lab_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
run_dir="${AGENT_LAB_RUN_DIR:-${lab_root}/.agent-lab-run}"

mkdir -p "${run_dir}"
cd "${lab_root}"

set +e
if [ -n "${2:-}" ]; then
  node dist/cli.js reassess --id "${run_id}" --input "$2" --yes > "${run_dir}/reassess.json"
else
  node dist/cli.js reassess --id "${run_id}" --yes > "${run_dir}/reassess.json"
fi
verdict=$?
set -e
new_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "${run_dir}/reassess.json")"
echo "Переоценка ${new_id} прогона ${run_id}"

node dist/cli.js export --id "${new_id}" --format html --output "${run_dir}/report.html"
node dist/cli.js export --id "${new_id}" --format markdown --output "${run_dir}/report.md"
# Короткая сводка качества: accuracy, покрытие, повторяющиеся причины провалов, судья.
node dist/cli.js summary --id "${new_id}" | tee "${run_dir}/summary.txt"
echo "Отчёт: ${run_dir}/report.html, report.md и summary.txt"
exit "${verdict}"
