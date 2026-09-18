#!/usr/bin/env bash
#
# End2end прогон SkillAgent из agent_oc: сборка задания, запуск и HTML-отчёт одной командой.
#
#   AGENT_OC_EPK_UL=… AGENT_OC_EPK_FL=… bash examples/agent-oc-e2e.sh
#
# Скрипт существует потому, что команды с флагами и heredoc не переживают копирование через
# мессенджер: двойной дефис приезжает длинным тире, кавычки — типографскими. Здесь всё это
# зафиксировано в файле, а от оператора нужны только два значения ЕПК в окружении.
#
# Необязательные переменные: AGENT_OC_ROOT (по умолчанию ../agent_oc), AGENT_LAB_RUN_DIR
# (куда положить сгенерированные файлы и отчёт, по умолчанию .agent-lab-run),
# AGENT_OC_SURFACE, AGENT_OC_AUTHORITY. DRY_RUN=1 останавливается после подготовки файлов.
#
# Переменные шлюза (AGENT_LAB_GATEWAY_*) должны быть в окружении: см. docs/REFERENCE.md.
set -euo pipefail

: "${AGENT_OC_EPK_UL:?Задайте AGENT_OC_EPK_UL: ЕПК юридического лица}"
: "${AGENT_OC_EPK_FL:?Задайте AGENT_OC_EPK_FL: ЕПК физического лица}"

lab_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
agent_root="$(cd "${AGENT_OC_ROOT:-${lab_root}/../agent_oc}" && pwd)"
run_dir="${AGENT_LAB_RUN_DIR:-${lab_root}/.agent-lab-run}"
surface="${AGENT_OC_SURFACE:-GIGAASSISTANT}"
authority="${AGENT_OC_AUTHORITY:-3}"

if [ ! -f "${agent_root}/src/tests/harness_core.py" ]; then
  echo "Не похоже на репозиторий agent_oc: ${agent_root}. Задайте AGENT_OC_ROOT." >&2
  exit 2
fi

mkdir -p "${run_dir}"
cd "${lab_root}"

# Пути в подключении считаются от каталога этого файла, поэтому они абсолютные: так прогон
# не зависит от того, где лежат репозитории друг относительно друга.
cat > "${run_dir}/connection.json" <<JSON
{
  "format": "agent-lab-connection-1",
  "target": {
    "kind": "command",
    "command": "python",
    "args": ["${lab_root}/examples/agent-oc-adapter.py", "${agent_root}"],
    "cwd": "${agent_root}",
    "timeoutMs": 180000
  },
  "targetVersion": "$(git -C "${agent_root}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
}
JSON

python3 - "$AGENT_OC_EPK_UL" "$AGENT_OC_EPK_FL" "$surface" "$authority" \
  "${lab_root}/examples/agent-oc-e2e/task.json" "${run_dir}/task.json" <<'PY'
import json, sys
epk_ul, epk_fl, surface, authority, template, output = sys.argv[1:7]
task = json.load(open(template, encoding='utf-8'))
for case in task['goldenCases']:
    session = case['initialState']['records']['session']
    session.update(epk_ul=epk_ul, epk_fl=epk_fl, surface=surface, authority=authority)
json.dump(task, open(output, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
PY

echo "Подготовлено: ${run_dir}/task.json и ${run_dir}/connection.json"
if [ "${DRY_RUN:-}" = "1" ]; then exit 0; fi

node dist/cli.js build --input "${run_dir}/task.json" --connection "${run_dir}/connection.json" > "${run_dir}/draft.json"
run_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "${run_dir}/draft.json")"
echo "Прогон ${run_id}"

node dist/cli.js run --id "${run_id}" --yes
node dist/cli.js export --id "${run_id}" --format html --output "${run_dir}/report.html"
echo "Отчёт: ${run_dir}/report.html"
