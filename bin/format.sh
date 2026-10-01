#!/bin/sh
# Apply the project's safe fixes and formatting before running bin/check.sh.
set -eu
LAB_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$LAB_ROOT"
uv run --locked --directory backend ruff check --fix
uv run --locked --directory backend ruff format
npm --prefix frontend run lint -- --fix
npm --prefix frontend run format
