---
phase: 03-poleznyy-test-i-ego-prinyatie
verified: 2026-09-16
status: passed
score: 14/14
---

# Phase 3 verification

Все требования `DISC-01..07`, `CARD-01..06` и `LOOP-04..05` реализованы.

- Discovery принимает до 300 диалогов, сохраняет полные разговоры, выполняет bounded coarse/deep отбор, представителей и контроли.
- Budget показывается до вызовов, checkpoints/resume сохраняют суммарные calls и elapsed time; исчерпание не маскируется как отсутствие гипотезы.
- Подтверждённая сохранённая гипотеза создаёт один заземлённый тест с owner-chosen `reply/tool/state` observation.
- Acceptance хранит `testId/definitionHash/acceptedAt` только для точного определения и не является gate для multi-test run/save.
- Терминология текущих поверхностей: тест в разговоре, карточка бизнес-сценария в контракте.

Доказательства: `test/experiment.test.ts`, `test/extension.test.ts`, `test/contracts.test.ts`, `test/product-flow.test.ts`, `test/workflow.test.ts`.
