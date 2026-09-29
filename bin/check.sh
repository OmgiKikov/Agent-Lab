#!/bin/sh
# Shared checks for the team.
set -eu
LAB_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$LAB_ROOT"
uv run --locked --project backend --directory backend ruff check
uv run --locked --project backend --directory backend ruff format --check
uv run --locked --project backend --directory backend python -m unittest discover -s tests -v
npm --prefix frontend run build
