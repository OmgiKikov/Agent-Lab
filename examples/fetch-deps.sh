#!/usr/bin/env bash
#
# Ставит готовые node_modules из ветки deps/node_modules-1c6565a и собирает dist — без npm и реестра.
#
#   bash examples/fetch-deps.sh
#
# Имя ветки и контрольная сумма зашиты здесь: ручной ввод имени ломается при копировании через
# мессенджер, а клон с одной веткой не видит чужих веток через обычный git fetch. Явная refspec
# работает в любом клоне.
set -euo pipefail

branch="deps/node_modules-1c6565a"
archive="agent-lab-node_modules-1c6565a.tgz"
expected_sha="b6387d9969ddf4df"
lab_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${TMPDIR:-/tmp}/agent-lab-deps.tgz"

cd "${lab_root}"
git fetch origin "+refs/heads/${branch}:refs/remotes/origin/${branch}"
git show "origin/${branch}:${archive}" > "${target}"

actual_sha="$(shasum -a 256 "${target}" | cut -c1-16)"
if [ "${actual_sha}" != "${expected_sha}" ]; then
  echo "Контрольная сумма архива не совпала: ${actual_sha} вместо ${expected_sha}. Архив не распакован." >&2
  exit 1
fi

tar xzf "${target}"
# dist из архива собран под один коммит, а ветка уходит дальше: расширение Pi импортирует модули,
# которых в старом dist нет, и молча не загружается. Компилятор уже в node_modules, сеть не нужна.
npm run build --silent
echo "Готово: node_modules из архива ${actual_sha}, dist собран из $(git rev-parse --short HEAD)."
node dist/cli.js status
