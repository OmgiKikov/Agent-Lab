#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
local_home="$repo_dir/langwatch/.local"
app_dir="$local_home/app/platform/app"
seed_script="$app_dir/scripts/seed-local-admin.ts"

if ! test -f "$seed_script" || ! test -f "$local_home/.env"; then
  echo "LangWatch must finish starting before the local workspace is created." >&2
  exit 1
fi

umask 077
if ! test -f "$local_home/local-admin-password"; then
  openssl rand -hex 24 > "$local_home/local-admin-password"
fi

# The published seed includes a development enterprise license. The local
# workspace uses the community edition, so remove only those two lines.
if grep -q 'LOCAL_DEV_ENTERPRISE_LICENSE_KEY' "$seed_script"; then
  patched_seed="$(mktemp "$local_home/seed-local-admin.XXXXXX")"
  awk '!/LOCAL_DEV_ENTERPRISE_LICENSE_KEY/' "$seed_script" > "$patched_seed"
  mv "$patched_seed" "$seed_script"
fi

tsx_bin="$(cd "${TMPDIR:-/tmp}" && npm exec --yes --package=tsx@4.21.0 -- which tsx)"
node_bin="$(command -v node)"
if test -x /opt/homebrew/bin/node; then
  node_bin=/opt/homebrew/bin/node
elif test -x /usr/local/bin/node; then
  node_bin=/usr/local/bin/node
fi
cd "$app_dir"
NODE_ENV=production \
SEED_USER_EMAIL=local@langwatch.dev \
SEED_USER_PASSWORD="$(cat "$local_home/local-admin-password")" \
SEED_USER_NAME='Local User' \
SEED_ORG_NAME='Рабочее пространство' \
SEED_TEAM_NAME='Команда' \
SEED_PROJECT_NAME='Диалоги' \
TSX_TSCONFIG_PATH="$app_dir/tsconfig.json" \
"$node_bin" --env-file="$local_home/.env" "$tsx_bin" scripts/seed-local-admin.ts \
  > "$local_home/seed.log" 2>&1

echo "Local workspace «Диалоги» is ready."
