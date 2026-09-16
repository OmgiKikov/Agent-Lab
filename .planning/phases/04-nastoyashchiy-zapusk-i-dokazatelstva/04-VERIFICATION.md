---
phase: 04-nastoyashchiy-zapusk-i-dokazatelstva
verified: 2026-09-16
status: passed
score: 10/10
---

# Phase 4 verification

Все требования `LOOP-06..07` и `CUT-01..08` реализованы.

- `TargetSession` запускает подключённого агента; CLI JSON возвращает полный диалог, технический outcome, отдельный automatic verdict и cited proof.
- Информационная цель может быть решена по `reply`; действие требует наблюдаемого tool/state evidence и иначе остаётся `unknown`.
- Доска оставляет три экрана. Editor/preview/clarify/judge-audit и исследовательские scorecards удалены.
- Legacy JSON-поля продолжают читаться; текущие документы описывают MVP, исторические документы помечены и архивированы.

Доказательства: `test/workflow.test.ts`, `test/product-flow.test.ts`, `test/cards.test.ts`, `test/extension.test.ts`, `test/judge.test.ts`.
