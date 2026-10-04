#!/bin/sh
# Shared checks for the team.
set -eu
LAB_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$LAB_ROOT"
uv run --locked --directory backend ruff check
uv run --locked --directory backend ruff format --check
uv run --locked --directory backend python -m unittest discover -s tests -v
# The texts people read keep the rules of docs/WRITING.md.
uv run --locked --directory backend python ../bin/copy_check.py
npm --prefix frontend run lint
npm --prefix frontend run format:check
npm --prefix frontend run build
