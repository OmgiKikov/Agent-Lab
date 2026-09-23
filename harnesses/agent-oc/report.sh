#!/usr/bin/env bash
#
# Выгружает отчёт уже завершённого прогона, не вызывая ни агента, ни модели.
#
#   bash harnesses/agent-oc/report.sh RUN_ID
#
# Отдельный скрипт по той же причине, что и e2e.sh: флаги с двойным дефисом не
# переживают копирование через мессенджер. RUN_ID печатает сам прогон («Прогон …»).
set -euo pipefail

run_id="${1:?Укажите идентификатор прогона: bash harnesses/agent-oc/report.sh RUN_ID}"
lab_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
run_dir="${AGENT_LAB_RUN_DIR:-${lab_root}/.agent-lab-run}"

mkdir -p "${run_dir}"
cd "${lab_root}"
node dist/cli.js export --id "${run_id}" --format html --output "${run_dir}/report.html"
node dist/cli.js export --id "${run_id}" --format markdown --output "${run_dir}/report.md"
# Короткая сводка качества: accuracy, покрытие, повторяющиеся причины провалов, судья.
node dist/cli.js summary --id "${run_id}" | tee "${run_dir}/summary.txt"
echo "Отчёт: ${run_dir}/report.html, report.md и summary.txt"
