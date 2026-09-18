#!/usr/bin/env bash
#
# Пересчитывает оценки судьи по уже записанным диалогам прогона и выгружает отчёт.
#
#   bash examples/agent-oc-reassess.sh RUN_ID
#
# Агент и симулятор не вызываются: судья заново оценивает сохранённые трассы. Исходный прогон
# не меняется — появляется отдельная переоценка со ссылкой на него. Лимиты берутся из прогона.
# Код возврата: 0 - все оценки получены, 2 - остались ошибки оценщика или неполные данные.
set -euo pipefail

run_id="${1:?Укажите идентификатор прогона: bash examples/agent-oc-reassess.sh RUN_ID}"
lab_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_dir="${AGENT_LAB_RUN_DIR:-${lab_root}/.agent-lab-run}"

mkdir -p "${run_dir}"
cd "${lab_root}"

set +e
node dist/cli.js reassess --id "${run_id}" --yes > "${run_dir}/reassess.json"
verdict=$?
set -e
new_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "${run_dir}/reassess.json")"
echo "Переоценка ${new_id} прогона ${run_id}"

node dist/cli.js export --id "${new_id}" --format html --output "${run_dir}/report.html"
node dist/cli.js export --id "${new_id}" --format markdown --output "${run_dir}/report.md"
echo "Отчёт: ${run_dir}/report.html и ${run_dir}/report.md"
exit "${verdict}"
