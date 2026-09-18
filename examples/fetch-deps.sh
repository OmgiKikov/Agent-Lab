#!/usr/bin/env bash
#
# Ставит готовые node_modules и dist из ветки deps/node_modules-02e0a17 — без npm и реестра.
#
#   bash examples/fetch-deps.sh
#
# Имя ветки и контрольная сумма зашиты здесь: ручной ввод имени ломается при копировании через
# мессенджер, а клон с одной веткой не видит чужих веток через обычный git fetch. Явная refspec
# работает в любом клоне.
set -euo pipefail

branch="deps/node_modules-02e0a17"
archive="agent-lab-node_modules-02e0a17.tgz"
expected_sha="9e7061a259a73f5f"
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
echo "Готово: node_modules и dist на месте (архив ${actual_sha})."
node dist/cli.js status
