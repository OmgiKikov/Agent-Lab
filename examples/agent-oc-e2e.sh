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
# AGENT_LAB_TASK — готовое задание вместо шаблона одной карточки (examples/agent-oc-cases.py).
# Необязательные переменные: AGENT_OC_ROOT (по умолчанию ../agent_oc), AGENT_LAB_RUN_DIR
# (куда положить сгенерированные файлы и отчёт, по умолчанию .agent-lab-run),
# AGENT_OC_SURFACE, AGENT_OC_AUTHORITY. DRY_RUN=1 останавливается после подготовки файлов,
# BUILD_ONLY=1 - после сборки черновика: его карточки смотрят и запускают на доске /agent-lab.
#
# Переменные шлюза (AGENT_LAB_GATEWAY_*) должны быть в окружении: см. docs/REFERENCE.md.
set -euo pipefail

# Готовое задание (например, собранное examples/agent-oc-cases.py) берётся как есть: ЕПК и
# поверхность там уже стоят из разбора кейсов. Иначе они подставляются в шаблон одной карточки.
if [ -z "${AGENT_LAB_TASK:-}" ]; then
  : "${AGENT_OC_EPK_UL:?Задайте AGENT_OC_EPK_UL: ЕПК юридического лица, либо AGENT_LAB_TASK с готовым заданием}"
  : "${AGENT_OC_EPK_FL:?Задайте AGENT_OC_EPK_FL: ЕПК физического лица, либо AGENT_LAB_TASK с готовым заданием}"
fi

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

if [ -n "${AGENT_LAB_TASK:-}" ]; then
  cp "${AGENT_LAB_TASK}" "${run_dir}/task.json"
else
  python3 "${lab_root}/examples/agent-oc-e2e/fill-task.py" \
    "${AGENT_OC_EPK_UL}" "${AGENT_OC_EPK_FL}" "${surface}" "${authority}" \
    "${lab_root}/examples/agent-oc-e2e/task.json" "${run_dir}/task.json"
fi

echo "Подготовлено: ${run_dir}/task.json и ${run_dir}/connection.json"
if [ "${DRY_RUN:-}" = "1" ]; then exit 0; fi

node dist/cli.js build --input "${run_dir}/task.json" --connection "${run_dir}/connection.json" > "${run_dir}/draft.json"
run_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "${run_dir}/draft.json")"
echo "Черновик ${run_id}"

# Открытые бизнес-вопросы блокируют запуск: это решения владельца, а не догадка модели.
# Скрипт выкладывает их заготовкой, а с готовыми ответами сам делает clarify и берёт новый черновик.
answers="${AGENT_LAB_ANSWERS:-${run_dir}/answers.json}"
questions="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["questions"]))' "${run_dir}/draft.json")"
if [ "${questions}" != "0" ]; then
  if [ ! -s "${answers}" ] || ! python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d and all(a.get("answer","").strip() for a in d) else 1)' "${answers}"; then
    python3 -c 'import json,sys; json.dump([{"question": q, "answer": ""} for q in json.load(open(sys.argv[1]))["questions"]], open(sys.argv[2], "w"), ensure_ascii=False, indent=2)' \
      "${run_dir}/draft.json" "${answers}"
    echo
    echo "Черновик задаёт ${questions} вопрос(ов) владельцу. Заполните поля answer в ${answers} и запустите скрипт снова:"
    python3 -c 'import json,sys; [print(" -", q) for q in json.load(open(sys.argv[1]))["questions"]]' "${run_dir}/draft.json"
    exit 3
  fi
  node dist/cli.js clarify --id "${run_id}" --input "${answers}" > "${run_dir}/clarified.json"
  run_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "${run_dir}/clarified.json")"
  echo "Ответы учтены, новый черновик ${run_id}"
fi

if [ "${BUILD_ONLY:-}" = "1" ]; then
  echo "Черновик собран, не запущен. На доске: node dist/cli.js chat, затем /agent-lab ${run_id}"
  exit 0
fi

echo "Прогон ${run_id}"

# Код возврата run - это вердикт, а не сбой: 1 - есть провал, 2 - неопределённые оценки или
# неполные данные. Отчёт нужен именно в этих случаях, поэтому экспорт идёт при любом коде,
# а сам код отдаётся наружу последним.
set +e
node dist/cli.js run --id "${run_id}" --yes
verdict=$?
set -e
node dist/cli.js export --id "${run_id}" --format html --output "${run_dir}/report.html"
node dist/cli.js export --id "${run_id}" --format markdown --output "${run_dir}/report.md"
echo "Отчёт: ${run_dir}/report.html и ${run_dir}/report.md"
exit "${verdict}"
