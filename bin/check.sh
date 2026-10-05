#!/bin/sh
# Shared checks for the team.
set -eu
LAB_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$LAB_ROOT"
uv run --locked --directory backend ruff check
uv run --locked --directory backend ruff format --check
# The tests ask no model: an address nobody answers on, so a key in the environment is never spent.
LAB_MODEL_URL=http://127.0.0.1:9/v1 uv run --locked --directory backend python -m unittest discover -s tests -v
# The texts people read carry no signs of machine-written text.
uv run --locked --directory backend python ../bin/copy_check.py
npm --prefix frontend run lint
npm --prefix frontend run format:check
npm --prefix frontend run build
