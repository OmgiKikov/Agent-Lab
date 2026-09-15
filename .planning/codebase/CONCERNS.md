---
last_mapped_commit: e23488a2711c80e9333f603d5c28d06ca85395ee
last_mapped_at: 2026-09-15
---
# Codebase Concerns

**Analysis Date:** 2026-09-15

## Tech Debt

**Монолитные модули доменной логики:**

- Issue: несколько файлов совмещают orchestration, схемы, сравнение и форматирование; наиболее крупные — `src/comparison.ts` (884 строки), `src/contracts.ts` (756 строк), `src/experiment.ts` (663 строки), `src/pi.ts` (633 строки) и `extensions/agent-lab.ts` (647 строк).
- Files: `src/comparison.ts`, `src/contracts.ts`, `src/experiment.ts`, `src/pi.ts`, `extensions/agent-lab.ts`
- Impact: изменения затрагивают много сценариев, сложнее локально проверить регрессии и удерживать границы ответственности.
- Fix approach: при следующем изменении выделять только реально повторяющиеся участки в отдельный модуль; сначала добавлять regression-тест на текущий flow.

**Дублирование процесса внешних целей:**

- Issue: запуск и убийство дочерних процессов реализованы отдельно для release hook и command adapter.
- Files: `src/targets.ts:86`, `src/targets.ts:224`
- Impact: таймауты, обработка сигналов, хвост stderr и detached process могут расходиться.
- Fix approach: при исправлении lifecycle синхронно покрывать оба пути одним минимальным helper или общими тестами.

## Known Bugs

**Недостоверное состояние внешнего агента:**

- Symptoms: адаптер может заменить `state.records` и сообщить `events`/`resetConfirmed`; runner сохраняет это как наблюдение, хотя оно не подтверждено доверенным кодом.
- Files: `src/targets.ts:135`, `src/evaluation.ts:185`, `src/connection.ts:109`
- Trigger: внешний HTTP/module/command адаптер возвращает `records` или неполную область событий.
- Workaround: рассматривать такие проверки как reported state; сверять реализацию harness отдельно.

## Security Considerations

**Выполнение произвольных команд подключения:**

- Risk: `command` и `release.command` запускаются с унаследованным `process.env`; конфигурация подключения фактически даёт возможность выполнить произвольный локальный процесс с доступом к окружению.
- Files: `src/targets.ts:89`, `src/targets.ts:229`, `src/connection.ts:20`
- Current mitigation: схемы валидируют форму, пути разрешаются относительно файла, процессы ограничены таймаутом и убиваются группой.
- Recommendations: явно предупреждать о доверии к connection-файлам, минимизировать env для child process и по возможности запускать внешние цели в изолированном профиле ОС.

**Локальный HTML-отчёт содержит данные трассы:**

- Risk: отчёт включает исходные задачи, состояния, ответы и release output; утечка возможна при публикации HTML/JSON как артефакта.
- Files: `src/report.ts:178`, `src/report.ts:206`, `src/artifacts.ts:26`
- Current mitigation: HTML-значения проходят `escape`, задан CSP, данные store пишутся с mode `0600`.
- Recommendations: считать экспорт чувствительным артефактом, отдельно redaction-ить внешние ответы и не публиковать `.json`/`.trace.jsonl` без проверки.

## Performance Bottlenecks

**Синхронная запись каждого события:**

- Problem: trace и audit journal пишутся через `appendFileSync` на каждом событии/ответе.
- Files: `src/store.ts:125`, `src/store.ts:137`, `src/judge-audit.ts:62`
- Cause: event loop блокируется диском, особенно при параллельных прогонах и больших трассах.
- Improvement path: сохранить атомарность, но перейти на открытый async file handle/очередь записи; измерять прежде чем усложнять.

**Полная сериализация больших снимков:**

- Problem: частые `structuredClone` и `JSON.stringify` копируют весь state/trial и отчёт строит один большой HTML.
- Files: `src/evaluation.ts:156`, `src/targets.ts:170`, `src/report.ts:178`
- Cause: трасса хранит полные snapshots state на событиях.
- Improvement path: ограничивать snapshot до нужных событий или хранить diff после измерения объёма; не менять формат без миграции.

## Fragile Areas

**Контракт и схемы данных:**

- Files: `src/contracts.ts`, `src/evaluation.ts`, `src/targets.ts`
- Why fragile: Zod-схемы являются одновременно форматом входа, persisted record и протоколом внешнего агента; изменение поля влияет на CLI, store, отчёты и тестовые fixtures.
- Safe modification: менять схему вместе с чтением старых снимков и contract-тестами в `test/contracts.test.ts` и `test/store.test.ts`.
- Test coverage: основные контракты покрыты, но совместимость будущих версий явно не выделена.

**Конкурентный store и recovery:**

- Files: `src/store.ts:40`, `src/store.ts:60`
- Why fragile: lock/recovery опираются на PID и локальные файлы; stale lock требует ручного решения, а параллельная запись journal остаётся чувствительной к сбоям процесса.
- Safe modification: сохранять `wx`, token-проверку и recovery gate; проверять crash/restart сценарии на реальной файловой системе.
- Test coverage: есть конкуренция и dead PID в `test/store.test.ts`, нет теста повреждения journal посреди записи.

## Scaling Limits

**Параллельные эксперименты:**

- Current capacity: `src/experiment.ts:550` ограничивает число worker-ов аргументом `parallel`, а каждый trial держит полную историю и snapshots.
- Limit: память и блокирующие записи растут вместе с числом trials и размером ответов; внешний HTTP body ограничен 200 000 байт в `src/targets.ts:193`.
- Scaling path: потоково писать трассу и вводить bounded queue/explicit concurrency limit прежде чем увеличивать `parallel`.

## Dependencies at Risk

**Not detected:** package versions зафиксированы в `package-lock.json`; отдельного автоматического аудита устаревших зависимостей не обнаружено.

## Missing Critical Features

**Автоматические quality gates:**

- Problem: в `package.json` есть build/typecheck/test, но отдельные lint, coverage threshold и CI workflow не обнаружены.
- Blocks: регрессии стиля, непокрытые ветви и ошибки на поддерживаемых Node-окружениях могут попасть в релиз незаметно.

## Test Coverage Gaps

**Граничные сбои внешнего транспорта:**

- What's not tested: медленный/частично закрытый HTTP stream, повреждённый JSONL после лимита, abort во время чтения и сигналы detached process.
- Files: `src/targets.ts`, `test/targets.test.ts`
- Risk: зависшие процессы или некорректное завершение сессии при сетевых сбоях.
- Priority: High

**HTML и экспорт при недоверенных данных:**

- What's not tested: property-based наборы для всех полей, включая control characters, огромные строки и URL-подобные значения.
- Files: `src/report.ts`, `src/artifacts.ts`, `test/artifacts.test.ts`
- Risk: регрессия escaping/CSP или чрезмерный размер артефакта.
- Priority: Medium

**Параллелизм и восстановление store:**

- What's not tested: повреждённая последняя строка journal, падение между временным файлом и rename, запись trace при одновременных workers.
- Files: `src/store.ts`, `test/store.test.ts`
- Risk: потеря измерений или невозможность открыть существующий run.
- Priority: High

---

*Concerns audit: 2026-09-15*
