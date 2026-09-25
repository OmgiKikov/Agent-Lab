# Исторический стресс-аудит

Скрипты сохранены из ветки `audit/agent-lab-stress-20260921` (ff087f0).
Они обращаются к удалённым API первого формата: `scenarioProposals`, `registerCandidate`, `agent_lab_scenarios`, `readIssues` и старому хранилищу variants.
Это исходники исторического аудита, а не тесты текущего продукта. Поэтому они находятся вне `test/` и не запускаются в CI. История ветки включена merge-коммитом. Текущие сценарии проверяются тестами `product-flow`, `card-commands`, `conversation`, `comparison` и `examples/scenario-lab-demo.mjs --verify`.
